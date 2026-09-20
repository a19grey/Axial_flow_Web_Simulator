/* Derived motor metrics: everything that turns a solved field into engineering numbers.
 *
 * Nothing here re-solves. These are pure functions of one solution plus the spec, so they cost
 * nothing next to the solve and can be reported on every run. The quantities that genuinely need
 * more than one solve — virtual-work torque, the inductance matrix, ripple, core loss — live in
 * studies.js, because a caller should be able to see what it is paying for.
 *
 * Two conventions that matter throughout:
 *
 *  - A sector mesh models 1/sectors of the machine. Every extensive quantity computed by summing
 *    over cells is therefore multiplied by mesh.sectors. Intensive ones are not.
 *  - Currents in the spec are *peak* phase currents. RMS is peak/sqrt(2), so the copper loss of
 *    three phases is 3 (I/sqrt2)^2 R = 1.5 I^2 R.
 */

import { MU0, MATERIALS } from "./constants.js";
import { volumeM, CYLINDRICAL } from "./mesh.js";
import { motorRegions, regionVolume, windingLayout } from "./geometry.js";

const MM3 = 1e-9;   // cubic millimetres -> cubic metres

/* ---- winding ------------------------------------------------------------------------------- */

/* Conductor length per phase, from the actual trace outlines the solver used as current sources.
 *
 * Each polygon in job.polys is one turn of one coil, and segsFromPolys replicates it at every
 * copper layer, so the conductor length of a phase is the summed perimeter of its turns times the
 * layer count. What this does *not* include is the radial run-outs, the vias and the star point:
 * the solver does not model them either, so the resistance is the resistance of what was solved,
 * and is an underestimate of a real board by the length of its interconnect.
 */
export function windingGeometry(job) {
  const p = job.p, { count } = windingLayout(p);
  const perPhase = [0, 0, 0], turnsPerPhase = [0, 0, 0];
  for (const poly of job.polys) {
    const pts = poly.pts;
    let per = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      per += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    perPhase[poly.ph] += per * p.layers;
    turnsPerPhase[poly.ph] += p.layers;
  }
  const area_mm2 = p.traceW * p.copperT;
  const rho = MATERIALS.copperResistivity_ohm_m * (1 + MATERIALS.copperTempCoeff_perK * (p.tempC - 20));
  const R = perPhase.map(L_mm => rho * (L_mm * 1e-3) / (area_mm2 * 1e-6));
  return {
    coils: count,
    coilsPerPhase: [0, 1, 2].map(j => windingLayout(p).phase.filter(x => x === j).length),
    turnsPerPhase,
    conductorLength_m: perPhase.map(v => v * 1e-3),
    conductorArea_mm2: area_mm2,
    copperVolume_mm3: perPhase.reduce((a, b) => a + b, 0) * area_mm2,
    resistivity_ohm_m: rho,
    phaseResistance_ohm: R,
    temperature_C: p.tempC
  };
}

/* ---- mass ---------------------------------------------------------------------------------- */

/* Masses from the region list — the same geometry the rasterizer discretized, evaluated in closed
 * form. Comparing that against the volume the rasterizer actually laid down is a direct check on
 * the discretization, independent of any field. */
export function massBreakdown(job) {
  const p = job.p, regions = motorRegions(p), w = windingGeometry(job);
  const byGroup = {}, byRegion = {};
  for (const r of regions) {
    const v = regionVolume(r);
    byRegion[r.name] = v;
    byGroup[r.group] = (byGroup[r.group] ?? 0) + v * (r.rho ?? MATERIALS.ironDensity_kg_m3) * MM3;
  }
  const copper_kg = w.copperVolume_mm3 * MM3 * MATERIALS.copperDensity_kg_m3;
  // Board substrate over the annulus the coils occupy, less the copper it carries.
  const boardVolume = Math.PI * ((p.ro + 3) ** 2 - Math.max(0, p.ri - 3) ** 2) * p.pcbT;
  const board_kg = Math.max(0, boardVolume - w.copperVolume_mm3) * MM3 * p.boardRho;

  const rotor_kg = (byGroup.rotorTop ?? 0) + (byGroup.rotorBottom ?? 0);
  const stator_kg = copper_kg + board_kg + (byGroup.stator ?? 0);
  return {
    regionVolume_mm3: byRegion,
    rotor_kg, copper_kg, board_kg,
    backPlate_kg: byGroup.stator ?? 0,
    stator_kg,
    total_kg: rotor_kg + stator_kg
  };
}

/* How much of each region the mesh actually holds, against its exact volume. A few tenths of a
 * percent is the in-plane staircase of a Cartesian mesh; a cylindrical mesh should be exact to
 * rounding, because every region is a coordinate box there. */
export function rasterizationCheck(job) {
  if (!job.volumes) return null;
  const regions = motorRegions(job.p);
  // A sector mesh holds its own share of each region.
  const s = job.mesh.sectors;
  const out = [];
  for (let i = 0; i < regions.length; i++) {
    const exact = regionVolume(regions[i]), got = job.volumes[i] * s;
    out.push({
      region: regions[i].name,
      exactVolume_mm3: exact,
      meshedVolume_mm3: got,
      error_pct: exact > 0 ? (got - exact) / exact * 100 : null
    });
  }
  return out;
}

/* ---- energy and flux linkage, on faces ------------------------------------------------------- */

/* Both of these are integrals of products of H and B, and both have to be taken on *faces* rather
 * than at cell centres. That is not a refinement, it is the difference between a right answer and
 * a meaningless one, for two reasons.
 *
 * First, the solver's own unknowns live on faces: what it balances is the flux
 * B_f = mu0 mu_f (Hs_f - dphi/dn) through each face. The discrete statement that div B = 0 is a
 * statement about those face fluxes and nothing else. Summing on faces therefore inherits it
 * exactly, and with it the identity
 *
 *     sum_faces A_f d_f (dphi/dn) B_f = sum_cells phi_c (net flux out of c) = 0,
 *
 * which is what makes integral H.B and integral Hs.B equal — the step that turns the reciprocity
 * identity for flux linkage into something computable. Reconstructed cell-centre B satisfies no
 * such identity, and the two integrals then disagree by a large amount that looks like physics.
 *
 * Second, Hs is singular at the trace filaments, softened only by the Biot-Savart core radius.
 * Cell-centre B and cell-centre Hs sample that singularity differently, so their difference near a
 * trace is the difference of two large mis-matched numbers. On faces, B_f and Hs_f are built from
 * the *same* Hs_f, so the singular part cancels identically and only the physics is left.
 *
 * Getting this wrong is not subtle in its effects: with cell-centre sums the material inductance of
 * an 80 mm PCB motor came out at 37 mH against a free-space 29 uH, a factor of a thousand, and the
 * energy computed two ways disagreed by 25%. On faces the two agree to the solver's tolerance.
 */
function faceIntegrals(sol, H) {
  const job = sol.job, m = job.mesh, mu = job.mu, { nx, ny, nz, sy, sz, periodicY } = m;
  const { Hs, phi } = sol;
  const A = m.areaM, D = m.distM;
  const wantLinkage = !!H;

  let W = 0, W0 = 0;
  const lam = [0, 0, 0];

  // One pass per face direction. Each direction carries only its own component of H, so the three
  // together make up |H|^2 exactly once.
  for (let dir = 0; dir < 3; dir++) {
    for (let iz = 0; iz < nz; iz++) {
      if (dir === 2 && iz === nz - 1) continue;
      const ak = A[dir].k[iz], dk = D[dir].k[iz];
      for (let iy = 0; iy < ny; iy++) {
        const lastY = iy === ny - 1;
        if (dir === 1 && lastY && !periodicY) continue;
        const step = dir === 0 ? 1 : dir === 1 ? (lastY ? sy - sz : sy) : sz;
        const ajk = A[dir].j[iy] * ak, djk = D[dir].j[iy] * dk;
        const base = (iz * ny + iy) * nx;
        for (let ix = 0; ix < nx; ix++) {
          if (dir === 0 && ix === nx - 1) continue;
          const k = base + ix, kn = k + step;
          const Af = A[dir].i[ix] * ajk, df = D[dir].i[ix] * djk;
          if (!(Af > 0) || !(df > 0)) continue;           // the r = 0 face has no area
          const V = Af * df;
          const a = mu[k], b = mu[kn], mf = 2 * a * b / (a + b);
          const hs = 0.5 * (Hs[3 * k + dir] + Hs[3 * kn + dir]);
          const hf = hs - (phi[kn] - phi[k]) / df;
          const bf = MU0 * mf * hf;
          W += 0.5 * bf * hf * V;
          W0 += 0.5 * MU0 * hs * hs * V;
          if (wantLinkage) {
            const d = (bf - MU0 * hs) * V;
            const o = 9 * k + dir, on = 9 * kn + dir;
            for (let j = 0; j < 3; j++) lam[j] += 0.5 * (H[o + 3 * j] + H[on + 3 * j]) * d;
          }
        }
      }
    }
  }
  const s = m.sectors;
  return { total_J: W * s, freeSpace_J: W0 * s, material_J: (W - W0) * s, linkage_Wb: lam.map(v => v * s) };
}

/* Magnetic co-energy, and the part of it the material is responsible for.
 *
 *   W  = 1/2 integral B.H dV
 *   dW = W - 1/2 mu0 integral |Hs|^2 dV
 *
 * Only dW is a meaningful number. The absolute W is dominated by the coils' own free-space energy,
 * which is logarithmically divergent at a filament and is therefore set by the Biot-Savart core
 * radius rather than by anything physical; most of what is left lies outside the solve box. In dW
 * both of those cancel to the last digit, because the same Hs_f appears in both terms.
 *
 * dW is what torque, inductance and every other useful derivative depend on, so it is the only one
 * quoted. The free-space inductance, when it is wanted, comes from freeSpaceInductance() and a
 * closed-form integral over the filaments instead.
 *
 * In linear material co-energy and energy are equal; they part company only once mu depends on B.
 */
export function coEnergy(sol) {
  return faceIntegrals(sol, null);
}

/* Flux linkage of each phase from the material response, by the reciprocity identity
 *
 *     lambda_j = (1/I_j) integral A . J_j dV = (1/I_j) integral H_sj . B dV,
 *
 * which follows from integrating A.(curl H_sj) by parts, H_sj being the free-space field of coil j
 * alone. The surface term vanishes only at infinity — exactly the part a finite box cannot supply
 * — so it is applied to the material response alone:
 *
 *     dlambda_j = integral H_sj . (B - mu0 Hs) dV.
 *
 * Away from the machine B tends to mu0 Hs, so the integrand decays as the product of two dipole
 * fields and the box truncation barely touches it. The free-space half, which does not decay, is
 * computed in closed form from the filaments instead.
 *
 * `H` is the per-phase source field at unit current, 9 floats per cell, exactly as the Biot-Savart
 * kernel leaves it: components 3j..3j+2 are phase j.
 */
export function materialLinkage(sol, H) {
  return faceIntegrals(sol, H).linkage_Wb;
}

/* ---- dq ------------------------------------------------------------------------------------ */

/* Amplitude-invariant Park transform at rotor electrical angle theta_e.
 *
 * The d axis is the pole centre line: phaseCurrents drives phase A at cos((P/2)theta + gamma), so
 * gamma = 0 puts the current vector on the d axis and this transform returns (i_d, i_q) = (A, 0)
 * for that case. Peak quantities in, peak quantities out.
 */
export function park(abc, thetaE) {
  const k = 2 * Math.PI / 3;
  let d = 0, q = 0;
  for (let i = 0; i < 3; i++) { d += abc[i] * Math.cos(thetaE - i * k); q -= abc[i] * Math.sin(thetaE - i * k); }
  return [d * 2 / 3, q * 2 / 3];
}

export const electricalAngle = p => (p.poles / 2) * p.theta * Math.PI / 180;

/* ---- the block that goes into every result --------------------------------------------------- */

export function derivedMetrics(sol) {
  const job = sol.job, p = job.p, m = sol.m;
  const winding = windingGeometry(job);
  const mass = massBreakdown(job);
  const energy = coEnergy(sol);

  // Copper loss from peak phase currents. Only the phases that carry current contribute.
  const irms = p.amps / Math.SQRT2;
  const copper_W = winding.phaseResistance_ohm.reduce((a, R) => a + irms * irms * R, 0);

  const fElec = Math.abs(p.rpm) / 60 * p.poles / 2;
  const omega = Math.abs(p.rpm) * 2 * Math.PI / 60;
  const T = m.torque;
  const shaft_W = T === null ? null : T * omega;

  return {
    winding: {
      coils: winding.coils,
      coilsPerPhase: winding.coilsPerPhase,
      conductorLength_m: winding.conductorLength_m,
      conductorArea_mm2: winding.conductorArea_mm2,
      phaseResistance_ohm: winding.phaseResistance_ohm,
      temperature_C: winding.temperature_C,
      /* The traces only; no run-outs, vias or star point, because the solver's current sources do
       * not include them either. */
      includesInterconnect: false
    },
    mass_kg: {
      rotor: mass.rotor_kg, copper: mass.copper_kg, board: mass.board_kg,
      backPlate: mass.backPlate_kg, stator: mass.stator_kg, total: mass.total_kg
    },
    /* Only the material part is reported. The absolute co-energy is set by the Biot-Savart core
     * radius and by where the solve box happens to end, and means nothing. */
    energy_J: { material: energy.material_J },
    losses_W: { copper: copper_W, core: null, total: copper_W },
    electrical: {
      speed_rpm: p.rpm,
      frequency_Hz: fElec,
      shaftPower_W: shaft_W,
      // Efficiency needs core loss, which needs an angle sweep; studies.js fills it in.
      efficiency: null
    },
    perUnit: {
      torqueDensity_Nm_per_kg: T === null || mass.total_kg <= 0 ? null : T / mass.total_kg,
      torquePerRootWatt_Nm_per_sqrtW: T === null || copper_W <= 0 ? null : T / Math.sqrt(copper_W),
      torquePerAmp_mNm_per_A: T === null || p.amps === 0 ? null : T * 1e3 / p.amps
    },
    rasterization: rasterizationCheck(job)
  };
}

/* ---- free-space inductance ------------------------------------------------------------------ */

/* The part of the inductance matrix that does not involve the material at all, from Neumann's
 * double integral over the same filaments the Biot-Savart kernel used:
 *
 *     L0_jk = (mu0/4pi) integral_j integral_k  dl_j . dl_k / |r_j - r_k|
 *
 * This is computed in closed form over all space rather than over the solve box, which is the
 * point: it is the slowly-decaying half of the inductance, the half a finite box cannot supply.
 * The material half comes from the solve (materialLinkage) and converges quickly.
 *
 * Two approximations, both stated rather than buried:
 *
 *  - The conductor is a filament with a finite geometric mean distance. A rectangular trace w by t
 *    has GMD ~ 0.2235 (w + t), and the kernel is regularized as 1/sqrt(r^2 + gmd^2). That is the
 *    standard partial-inductance treatment and is good to a few percent for a trace whose width is
 *    small against its length. Measured against a circular loop, for which L = mu0 R (ln(8R/gmd)
 *    - 2) is exact, this reproduces the analytic value to 0.2% once the loop is discretized finely
 *    enough that the polygon perimeter has converged (see the loopInductance validation case).
 *  - The double integral is midpoint quadrature over segments, refined adaptively when two
 *    segments are close compared with their length. Far pairs, which are most of them, stay at one
 *    point each.
 *
 * So L0 is an estimate of the winding's air-core inductance, not a converged solver output. The
 * torque never depends on it — the winding does not move, so dL0/dtheta is zero — and neither does
 * any saliency quantity. It matters only when an absolute Ld or Lq is wanted.
 */
export function freeSpaceInductance(job, { subdivideLimit = 12 } = {}) {
  const segs = job.segs, ns = segs.length / 8;
  const p = job.p;
  const gmd = 0.2235 * (p.traceW + p.copperT) * 1e-3;   // metres
  const g2 = gmd * gmd;

  // Midpoint, direction vector and length of every segment, in metres.
  const mx = new Float64Array(ns), my = new Float64Array(ns), mz = new Float64Array(ns);
  const dx = new Float64Array(ns), dy = new Float64Array(ns), dz = new Float64Array(ns);
  const len = new Float64Array(ns), ph = new Int32Array(ns);
  for (let i = 0; i < ns; i++) {
    const o = 8 * i;
    dx[i] = segs[o + 4] - segs[o]; dy[i] = segs[o + 5] - segs[o + 1]; dz[i] = segs[o + 6] - segs[o + 2];
    mx[i] = segs[o] + 0.5 * dx[i]; my[i] = segs[o + 1] + 0.5 * dy[i]; mz[i] = segs[o + 2] + 0.5 * dz[i];
    len[i] = Math.hypot(dx[i], dy[i], dz[i]);
    ph[i] = segs[o + 3] | 0;
  }

  const L = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const K = MU0 / (4 * Math.PI);

  for (let i = 0; i < ns; i++) {
    for (let l = i; l < ns; l++) {
      const dot = dx[i] * dx[l] + dy[i] * dy[l] + dz[i] * dz[l];
      if (dot === 0) continue;
      const rx = mx[l] - mx[i], ry = my[l] - my[i], rz = mz[l] - mz[i];
      const d = Math.hypot(rx, ry, rz), lmax = Math.max(len[i], len[l]);
      let sum;
      if (d > 4 * lmax) {
        sum = dot / Math.sqrt(d * d + g2);
      } else {
        // Close or coincident: split both segments until the sub-segments are short against their
        // separation, so the 1/r kernel is sampled where it actually varies.
        const n = Math.min(subdivideLimit, Math.max(2, Math.ceil(4 * lmax / Math.max(d, gmd))));
        const w = dot / (n * n);
        sum = 0;
        for (let a = 0; a < n; a++) {
          const ta = (a + 0.5) / n - 0.5;
          const ax = mx[i] + ta * dx[i], ay = my[i] + ta * dy[i], az = mz[i] + ta * dz[i];
          for (let b = 0; b < n; b++) {
            const tb = (b + 0.5) / n - 0.5;
            const bx = mx[l] + tb * dx[l] - ax, by = my[l] + tb * dy[l] - ay, bz = mz[l] + tb * dz[l] - az;
            sum += w / Math.sqrt(bx * bx + by * by + bz * bz + g2);
          }
        }
      }
      const v = K * sum * (i === l ? 1 : 2);
      L[ph[i]][ph[l]] += v;
      if (ph[i] !== ph[l]) L[ph[l]][ph[i]] += v;
    }
  }
  return { L, gmd_m: gmd, segments: ns };
}
