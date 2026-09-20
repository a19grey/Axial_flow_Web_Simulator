/* Characterizations that need more than one solve.
 *
 * Each of these is a deliberate, priced piece of work — three solves for the inductance matrix,
 * two extra for virtual-work torque, one per angle for ripple — so they are separate entry points
 * rather than part of every run. The Biot-Savart source field is cached across every solve in a
 * study, because none of them move the winding.
 *
 * The point of the file is cross-checking. Maxwell stress and virtual work are two independent
 * routes to torque; flux linkage and co-energy are two independent routes to the stored energy;
 * the inductance matrix has to be symmetric. Where they agree, the solve is probably right. Where
 * they do not, the disagreement is the error bar.
 */

import { normalizeSpec, specToParams, specHash, setPath } from "./spec.js";
import { buildMotor } from "./geometry.js";
import { solveJob, phaseCurrents } from "./solve.js";
import { motorMetrics } from "./torque.js";
import { coEnergy, materialLinkage, freeSpaceInductance, park, electricalAngle, derivedMetrics } from "./metrics.js";
import { CYLINDRICAL } from "./mesh.js";

const DEG = Math.PI / 180;

/* One solve at an explicit rotor angle and an explicit current vector. Everything in this file
 * fixes the currents by hand, because a virtual-work derivative has to be taken at constant
 * current while the rotor moves, and phaseCurrents() would otherwise move them together. */
async function solveAt(spec, theta_deg, currents, opts) {
  const p = specToParams({ ...spec, operatingPoint: { ...spec.operatingPoint, rotorAngle_deg: theta_deg } });
  const job = buildMotor(p);
  const sol = await solveJob(job, { ...opts, currents, solver: spec.solver });
  sol.I = currents;
  return sol;
}

/* ---- torque by virtual work ------------------------------------------------------------------ */

/* Torque as the rate of change of magnetic co-energy with rotor position at constant current:
 *
 *     T = dW'/dtheta |_I
 *
 * This shares nothing with the Maxwell stress tensor except the field itself. The stress integral
 * is a surface quantity in the air gap and is sensitive to how well the gap is resolved; co-energy
 * is a volume quantity over the whole domain and is sensitive to nothing in particular. Two
 * numbers this far apart in derivation agreeing is a much stronger statement than two stress
 * surfaces agreeing, which they largely do by construction.
 *
 * Only the material part of the co-energy is differenced. The free-space part is the coils' own
 * energy — divergent at a filament, mostly outside the box, and completely unchanged when the
 * rotor turns — so differencing it would add a large cancelling term for nothing.
 *
 * "At constant current" is the whole difficulty, and it is why this cannot piggyback on an angle
 * sweep: phaseCurrents() advances the currents with the rotor, and a derivative taken that way is
 * not a torque. The currents here are frozen at their operating-point values while the rotor moves
 * underneath them.
 *
 * The derivative is taken from a symmetric stencil rather than a single central difference. The
 * signal is small — over one degree of rotation the material co-energy changes by around a percent
 * — so a two-point difference sits uncomfortably close to the point where the step is either too
 * large to be a derivative or too small to be above the noise. Sampling 2n+1 points gives the
 * 2nd-, 4th- and 6th-order estimates at once, and their spread is a direct measurement of which
 * regime the step is actually in, instead of an assumption about it.
 */
const STENCILS = {
  2: [[1, 0.5]],
  4: [[1, 2 / 3], [2, -1 / 12]],
  6: [[1, 0.75], [2, -0.15], [3, 1 / 60]]
};

export async function virtualWorkTorque(specIn, opts = {}) {
  const { spec } = normalizeSpec(specIn);
  const p = specToParams(spec);
  const I = phaseCurrents(p);
  const period_deg = 720 / p.poles;
  const h = opts.step_deg ?? period_deg / 60;
  const orders = [2, 4, 6].filter(o => o <= (opts.maxOrder ?? 6));
  const reach = Math.max(...orders.map(o => STENCILS[o].length));

  const theta0 = p.theta;
  const W = new Map();
  const solves = [];
  const energyAt = async j => {
    if (!W.has(j)) {
      const th = theta0 + j * h;
      opts.onProgress && opts.onProgress({ phase: "virtualWork", angle_deg: th });
      const sol = await solveAt(spec, th, I, opts);
      W.set(j, coEnergy(sol).material_J);
      solves.push(j);
      if (j === 0) { sol.m = motorMetrics(sol); W.centre = sol; }
    }
    return W.get(j);
  };

  await energyAt(0);
  for (let j = 1; j <= reach; j++) { await energyAt(j); await energyAt(-j); }

  const estimates = orders.map(o => {
    let d = 0;
    for (const [j, c] of STENCILS[o]) d += c * (W.get(j) - W.get(-j));
    return { order: o, torque_Nm: d / (h * DEG) };
  });

  const best = estimates[estimates.length - 1].torque_Nm;
  const vals = estimates.map(e => e.torque_Nm);
  // How much the answer depends on the order of the stencil. Small means the step is in the sweet
  // spot; large means it is either resolving curvature badly or drowning in noise.
  const orderSpread = best ? (Math.max(...vals) - Math.min(...vals)) / Math.abs(best) * 100 : null;

  const centre = W.centre;
  const maxwell = centre.m.torque;

  return {
    specHash: specHash(spec),
    rotorAngle_deg: theta0,
    phaseCurrents_A: I,
    step_deg: h,
    torqueVirtualWork_mNm: best * 1e3,
    torqueMaxwellStress_mNm: maxwell === null ? null : maxwell * 1e3,
    /* The headline of this study: two methods with almost nothing in common, compared. */
    disagreement_pct: maxwell ? Math.abs(best - maxwell) / Math.abs(maxwell) * 100 : null,
    stencilEstimates: estimates.map(e => ({ order: e.order, torque_mNm: e.torque_Nm * 1e3 })),
    stencilSpread_pct: orderSpread,
    materialCoEnergy_J: W.get(0),
    maxwellSurfaceSpread_pct: centre.m.torqueSpread_pct,
    solves: solves.length
  };
}

/* ---- inductance ------------------------------------------------------------------------------- */

/* The 3x3 phase inductance matrix, split into the half that comes from the winding alone and the
 * half the material adds.
 *
 *   L = L0 + dL
 *   L0  Neumann's double integral over the filaments, in closed form over all space. Independent
 *       of the mesh, of the rotor angle, and of the solve entirely.
 *   dL  from the solved field, by reciprocity: dL_jk = integral H_sj . (B_k - mu0 Hs_k) dV with
 *       unit current in phase k alone. Decays like a dipole product, so the solve box holds it.
 *
 * Splitting them this way is not bookkeeping. The free-space part is large, slowly decaying, and
 * would be badly truncated by any finite box; the material part is the one the solver is actually
 * for, and it is the only part that varies with rotor angle. Saliency — Ld - Lq, and with it every
 * reluctance torque — lives entirely in dL, because L0 is a circulant matrix whose d and q
 * eigenvalues are equal.
 *
 * Three solves, one per phase at unit current. Linearity does the rest: the machine has a fixed mu
 * field, so superposition holds exactly and the matrix is the whole story.
 */
export async function inductance(specIn, opts = {}) {
  const { spec } = normalizeSpec(specIn);
  const p = specToParams(spec);
  const job0 = buildMotor(p);

  const dL = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  let H = null;
  for (let k = 0; k < 3; k++) {
    opts.onProgress && opts.onProgress({ phase: "inductance", index: k, total: 3 });
    const I = [0, 0, 0]; I[k] = 1;
    const job = buildMotor(p);
    // The per-phase source field depends only on the winding and the mesh, so it is read back once
    // and reused; the three solves differ only in which phase carries the current.
    const sol = await solveJob(job, { ...opts, currents: I, solver: spec.solver, withPhaseFields: !H });
    if (!H) H = sol.H;
    const lam = materialLinkage(sol, H);
    for (let j = 0; j < 3; j++) dL[j][k] = lam[j];
  }

  const fs = freeSpaceInductance(job0);
  const L = dL.map((row, j) => row.map((v, k) => v + fs.L[j][k]));

  /* Reciprocity. L_jk = L_kj is a theorem, not a modelling choice, so any asymmetry here is
   * numerical error in the solve and the linkage integral — a free accuracy estimate that costs
   * nothing beyond the three solves already done. */
  let asym = 0, scale = 0;
  for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) {
    asym = Math.max(asym, Math.abs(dL[j][k] - dL[k][j]));
    scale = Math.max(scale, Math.abs(dL[j][k]));
  }

  const thetaE = electricalAngle(p);
  const dq = mat => {
    // Drive a unit d-axis and a unit q-axis current vector through the matrix and read the result
    // back in dq. Amplitude-invariant, so these are the textbook Ld and Lq.
    const inv = (d, q) => [0, 1, 2].map(i => d * Math.cos(thetaE - i * 2 * Math.PI / 3) - q * Math.sin(thetaE - i * 2 * Math.PI / 3));
    const apply = i => [0, 1, 2].map(j => mat[j][0] * i[0] + mat[j][1] * i[1] + mat[j][2] * i[2]);
    const [dd, qd] = park(apply(inv(1, 0)), thetaE);
    const [dq_, qq] = park(apply(inv(0, 1)), thetaE);
    return { Ld: dd, Lq: qq, Ldq: dq_, Lqd: qd };
  };

  const total = dq(L), material = dq(dL);
  const I = phaseCurrents(p);
  const [id, iq] = park(I, thetaE);
  // The classical synchronous-reluctance expression. It assumes a sinusoidal, harmonic-free
  // saliency, so it is a sanity check on the order of magnitude and the sign, not an identity.
  const Trel = 1.5 * (p.poles / 2) * (total.Ld - total.Lq) * id * iq;

  return {
    specHash: specHash(spec),
    rotorAngle_deg: p.theta,
    electricalAngle_deg: thetaE / DEG,
    inductance_H: { total: L, material: dL, freeSpace: fs.L },
    dq_H: { total, material },
    saliencyRatio: total.Lq !== 0 ? total.Ld / total.Lq : null,
    currents_A: { abc: I, d: id, q: iq },
    torqueFromSaliency_mNm: Trel * 1e3,
    reciprocity: {
      /* Worst |dL_jk - dL_kj| as a fraction of the largest entry. */
      asymmetry_pct: scale > 0 ? asym / scale * 100 : null
    },
    freeSpaceModel: {
      method: "Neumann double integral over the trace filaments, GMD-regularized",
      gmd_mm: fs.gmd_m * 1e3,
      segments: fs.segments,
      note: "Filament estimate of the air-core inductance, good to about 1%. It carries no rotor-angle dependence, so it affects absolute Ld and Lq but never torque or saliency."
    }
  };
}

/* ---- torque against rotor angle ---------------------------------------------------------------- */

/* One electrical period of rotor rotation, which for this machine is 720/P mechanical degrees:
 * over that span the rotor returns to an identical position relative to the stator *and* the phase
 * currents, which advance by 2*pi, return to their starting values. So the torque waveform is
 * periodic over exactly that interval and its mean is the useful average torque.
 *
 * On a cylindrical sector mesh the period is also exactly the modelled angular span, and the mesh
 * has uniform angular cells, so stepping the rotor by a whole number of cells is an exact relabel
 * of the angular index. That is what makes rotor-frame core loss possible below.
 */
export async function torqueVsAngle(specIn, opts = {}) {
  const { spec } = normalizeSpec(specIn);
  const p = specToParams(spec);
  const period_deg = 720 / p.poles;
  const want = Math.max(4, Math.round(opts.count ?? 24));

  const probe = buildMotor(p);
  const cyl = probe.mesh.kind === CYLINDRICAL;
  // Snap the sample angles to whole angular cells when that is possible; a whole number of samples
  // per period is needed for the mean and the harmonics either way.
  let count = want, shift = 0;
  if (cyl && Math.abs((probe.mesh.y1 - probe.mesh.y0) - period_deg * DEG) < 1e-9) {
    const ny = probe.mesh.ny;
    shift = Math.max(1, Math.round(ny / want));
    while (shift < ny && ny % shift) shift++;
    count = ny / shift;
  }
  const dTheta = period_deg / count;

  const loss = cyl && shift ? newLossAccumulator(probe) : null;
  const points = [];
  for (let i = 0; i < count; i++) {
    const th = p.theta + i * dTheta;
    opts.onProgress && opts.onProgress({ phase: "angle", index: i, total: count, angle_deg: th });
    const pi = specToParams({ ...spec, operatingPoint: { ...spec.operatingPoint, rotorAngle_deg: th } });
    const sol = await solveAt(spec, th, phaseCurrents(pi), opts);
    sol.m = motorMetrics(sol);
    points.push({ rotorAngle_deg: th, torque_mNm: sol.m.torque === null ? null : sol.m.torque * 1e3,
                  gapBzMean_mT: sol.m.gapBz * 1e3, surfaceSpread_pct: sol.m.torqueSpread_pct });
    if (loss) loss.accumulate(sol, i * shift);
  }

  const T = points.map(q => q.torque_mNm).filter(v => v !== null);
  const mean = T.length ? T.reduce((a, b) => a + b, 0) / T.length : null;
  return {
    specHash: specHash(spec),
    period_deg, count, step_deg: dTheta,
    points,
    torqueMean_mNm: mean,
    torqueMin_mNm: T.length ? Math.min(...T) : null,
    torqueMax_mNm: T.length ? Math.max(...T) : null,
    /* Peak-to-peak as a fraction of the mean — the usual definition, and meaningless when the mean
     * is near zero, which is why it is null rather than enormous in that case. */
    ripple_pct: mean && Math.abs(mean) > 1e-9 ? (Math.max(...T) - Math.min(...T)) / Math.abs(mean) * 100 : null,
    harmonics: T.length === count ? harmonics(T, mean) : null,
    coreLoss: loss ? loss.report(spec, p) : {
      available: false,
      reason: cyl ? "The angular period and the modelled span do not line up, so the rotor frame cannot be recovered by an index shift."
                  : "Core loss is computed in the rotor frame, which needs the exact index shift a uniform angular mesh gives. Use mesh.mode = \"cylindrical\"."
    }
  };
}

/* Amplitude of each harmonic of the torque waveform, as a fraction of the mean. Index n is n
 * cycles per electrical period. */
function harmonics(T, mean) {
  const N = T.length, out = [];
  for (let n = 1; n <= Math.min(8, Math.floor(N / 2)); n++) {
    let re = 0, im = 0;
    for (let i = 0; i < N; i++) { const a = 2 * Math.PI * n * i / N; re += T[i] * Math.cos(a); im -= T[i] * Math.sin(a); }
    const amp = 2 * Math.hypot(re, im) / N;
    out.push({ order: n, amplitude_mNm: amp, ofMean_pct: mean ? amp / Math.abs(mean) * 100 : null });
  }
  return out;
}

/* ---- core loss --------------------------------------------------------------------------------- */

/* Core loss needs the flux waveform a lump of iron sees as it turns, which is a rotor-frame
 * quantity: a fixed cell in the laboratory frame is iron only part of the time, so tracking B
 * there would mix iron and air.
 *
 * On a cylindrical mesh with uniform angular cells the rotor frame is exactly one index shift away
 * — rotate by s cells and cell (i, j, k) of the rotor sits at angular index (j + s) mod ny — and
 * the (r, theta, z) components of B are already expressed in a basis that rotates with it. So the
 * waveform is recovered exactly, with no interpolation. On a Cartesian mesh it is not, and this
 * reports itself unavailable rather than guessing.
 *
 * The loss model is Steinmetz scaling of a datasheet figure, applied per component:
 *
 *     p = p_ref (B/B_ref)^beta (f/f_ref)^alpha   [W/kg]
 *
 * with B taken as the peak of each of the three components separately and the three losses added.
 * That is the standard decomposition of a rotating field into orthogonal alternating ones; it is
 * conservative for a circular locus and exact for a purely alternating one. It does not model
 * minor loops, and it assumes the whole core has the rotor's material properties.
 */
function newLossAccumulator(job) {
  const m = job.mesh, mu = job.mu, p = job.p;
  // Cells belonging to the rotor: magnetic, and inside the rotor's own z-band. The back plate is
  // stator-fixed, so its waveform is not a rotor-frame quantity and it is left out.
  const g = job.g;
  const bands = [[g.zTB, g.zYT]];
  if (g.dual) bands.push([g.zMY, g.zMB]);
  const inRotor = iz => bands.some(([a, b]) => m.zc[iz] > a && m.zc[iz] < b);

  const idx = [], frac = [], vol = [];
  const murRef = p.murRot, denom = 1 - 1 / murRef;
  for (let iz = 1; iz < m.nz - 1; iz++) {
    if (!inRotor(iz)) continue;
    for (let iy = 0; iy < m.ny; iy++) for (let ix = 0; ix < m.nx; ix++) {
      const k = (iz * m.ny + iy) * m.nx + ix;
      if (mu[k] <= 1.02) continue;
      idx.push(k);
      // Invert the series blend to recover the iron fraction the rasterizer put in this cell.
      frac.push(Math.min(1, Math.max(0, (1 - 1 / mu[k]) / denom)));
      vol.push(m.volM.i[ix] * m.volM.j[iy] * m.volM.k[iz]);
    }
  }
  const n = idx.length;
  const lo = [new Float32Array(n).fill(Infinity), new Float32Array(n).fill(Infinity), new Float32Array(n).fill(Infinity)];
  const hi = [new Float32Array(n).fill(-Infinity), new Float32Array(n).fill(-Infinity), new Float32Array(n).fill(-Infinity)];
  const cells = Int32Array.from(idx), f = Float32Array.from(frac), V = Float64Array.from(vol);

  return {
    /* `shift` is how many angular cells the rotor has turned since the reference position, so the
     * lab index of this rotor cell is its own index with the angular part advanced by that much. */
    accumulate(sol, shift) {
      const { Bx, By, Bz } = sol, nx = m.nx, ny = m.ny, sz = m.sz;
      const s = ((shift % ny) + ny) % ny;
      for (let c = 0; c < n; c++) {
        const k = cells[c];
        const ix = k % nx, iy = ((k / nx) | 0) % ny, iz = (k / sz) | 0;
        const kk = iz * sz + (((iy + s) % ny) * nx) + ix;
        const v = [Bx[kk], By[kk], Bz[kk]];
        for (let d = 0; d < 3; d++) { if (v[d] < lo[d][c]) lo[d][c] = v[d]; if (v[d] > hi[d][c]) hi[d][c] = v[d]; }
      }
    },
    report(spec, p) {
      const cl = p.coreLoss, rho = p.rotorRho;
      const f_elec = Math.abs(p.rpm) / 60 * p.poles / 2;
      if (!(f_elec > 0)) return { available: false, reason: "Core loss needs a speed; set operatingPoint.speed_rpm." };
      const fScale = Math.pow(f_elec / cl.atFrequency_Hz, cl.frequencyExponent);
      let W = 0, mass = 0, bpk = 0;
      for (let c = 0; c < n; c++) {
        const kg = V[c] * f[c] * rho;
        mass += kg;
        let sum = 0, b2 = 0;
        for (let d = 0; d < 3; d++) {
          const amp = 0.5 * (hi[d][c] - lo[d][c]);
          b2 += amp * amp;
          if (amp > 0) sum += cl.specificLoss_W_per_kg * Math.pow(amp / cl.atFlux_T, cl.fluxExponent) * fScale;
        }
        bpk = Math.max(bpk, Math.sqrt(b2));
        W += sum * kg;
      }
      // A sector mesh holds its own share of the rotor.
      const s = m.sectors;
      return {
        available: true,
        frequency_Hz: f_elec,
        coreLoss_W: W * s,
        ironMass_kg: mass * s,
        specificLoss_W_per_kg: mass > 0 ? W / mass : null,
        peakFluxAmplitude_T: bpk,
        model: `Steinmetz scaling of ${cl.specificLoss_W_per_kg} W/kg at ${cl.atFlux_T} T, ${cl.atFrequency_Hz} Hz, ` +
               `exponents beta=${cl.fluxExponent} (flux) alpha=${cl.frequencyExponent} (frequency), ` +
               `applied per field component in the rotor frame and summed.`,
        caveats: [
          "The exponents are textbook values, not a fit to a datasheet. Replace them before quoting a loss figure.",
          "Rotor iron only; a stator-fixed back plate is excluded because its waveform is not a rotor-frame quantity.",
          "No minor-loop or excess-loss term."
        ]
      };
    }
  };
}

/* ---- energy consistency ------------------------------------------------------------------------ */

/* Two independent routes to the same number, as a check on both.
 *
 *   route 1   the material co-energy, a volume integral of |B|^2/(2 mu0 mu) minus its free-space
 *             counterpart, from one solve at the operating point;
 *   route 2   1/2 sum_jk dL_jk I_j I_k, from the three unit-current solves and the reciprocity
 *             identity.
 *
 * Be clear about what this does and does not prove. In exact arithmetic the two are *equal by a
 * discrete identity*: summing on faces makes sum A_f d_f (dphi/dn) B_f vanish exactly, which is
 * precisely the step that turns integral H.B into integral Hs.B. So this is not an independent
 * check on the physics the way virtual work against Maxwell stress is.
 *
 * What it does check, and what nothing else does, is everything between the two expressions:
 * superposition across the three unit-current solves, the f32 accumulation of a difference of
 * large terms, the sector scaling applied twice by different code, and the face iteration in the
 * linkage integral matching the one the solver balanced. When the energy sums were taken at cell
 * centres instead of faces this check read 25% and correctly refused to pass.
 */
export async function energyConsistency(specIn, opts = {}) {
  const { spec } = normalizeSpec(specIn);
  const p = specToParams(spec);
  const ind = await inductance(spec, opts);
  const I = phaseCurrents(p);
  let viaL = 0;
  for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) viaL += 0.5 * ind.inductance_H.material[j][k] * I[j] * I[k];

  const sol = await solveAt(spec, p.theta, I, opts);
  sol.m = motorMetrics(sol);
  const viaField = coEnergy(sol).material_J;

  return {
    specHash: specHash(spec),
    materialCoEnergy_J: { fromField: viaField, fromInductance: viaL },
    disagreement_pct: viaField ? Math.abs(viaL - viaField) / Math.abs(viaField) * 100 : null,
    reciprocityAsymmetry_pct: ind.reciprocity.asymmetry_pct,
    torque_mNm: sol.m.torque === null ? null : sol.m.torque * 1e3,
    derived: derivedMetrics(sol)
  };
}
