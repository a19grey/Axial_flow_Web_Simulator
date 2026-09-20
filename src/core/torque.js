/* Torque from the Maxwell stress tensor, and the derived motor metrics.
 *
 *   T_ij = (1/mu0)(B_i B_j - 1/2 delta_ij B^2),   tau_z = closed_integral (r x (T.n))_z dA
 *
 * The integration surface is a box in air around the rotor whose bottom face sits in the air gap.
 * Two boxes with bottom faces at different gap heights give two independent estimates; their
 * agreement is the practical check on whether the mesh resolves the gap.
 *
 * On a graded mesh every face area has to be looked up rather than assumed, which is the only
 * change from the uniform version. Face-centred values interpolate the two adjacent cells at the
 * midpoint of the face, which is where the face sits regardless of grading.
 *
 * (P4 adds a virtual-work torque as a genuinely independent second method.)
 */

import { MU0 } from "./constants.js";
import { locate, cellsAcross, planeAreaM, CYLINDRICAL } from "./mesh.js";

const MM = 1e-3;

/* Torque on everything between the two z-planes at mesh nodes kb and kt, out to a cylinder /
 * box that encloses the machine radially.
 *
 * Which planes those are is the caller's business: for the single rotor of a conventional machine
 * kb sits in the air gap and kt above the yoke, and for the lower rotor of a dual-sided machine it
 * is the other way round. Either way the surface is closed and the sign follows the outward
 * normals, so a rotor that drags the other way reports a negative torque rather than an absolute
 * value that hides it.
 */
export function torque(sol, kb, kt) {
  return sol.job.mesh.kind === CYLINDRICAL ? torqueCylindrical(sol, kb, kt) : torqueCartesian(sol, kb, kt);
}

/* Torque on a closed surface in cylindrical coordinates: an annular disc in the air gap, the
 * cylinder at the outer radius, and an annular disc above the rotor.
 *
 * In this basis the Maxwell stress collapses. For a surface with normal z-hat the azimuthal
 * traction is T_theta_z = B_theta B_z / mu0, and the moment arm is r, so
 *
 *     tau_z = (1/mu0) * integral r B_theta B_z dA
 *
 * and for the cylinder at radius R, T_theta_r = B_theta B_r / mu0 gives
 *
 *     tau_z = (1/mu0) * integral r B_theta B_r dA .
 *
 * No B^2 terms survive at all — they are isotropic and carry no moment about the axis. Compare the
 * Cartesian version below, which needs six faces and the full tensor.
 *
 * A sector mesh integrates its own share, so the result is scaled by the number of sectors.
 */
function torqueCylindrical(sol, kb, kt) {
  const { job, Bx: Br, By: Bt, Bz } = sol, m = job.mesh;
  const { nx: nr, ny: nt, nz, sz, xc: rc, xe: re, ze, dy: dth, dz, rArea } = m;

  // Outer cylinder: far enough out to enclose the rotor, inside the mesh.
  const iOut = Math.min(nr - 1, locate(re, nr, job.g.Rro + 2) + 1);
  if (!(kt > kb && kb >= 1 && kt <= nz - 1 && iOut > 1)) return NaN;

  const idx = (i, j, k) => (k * nt + j) * nr + i;
  const avg = (a, b) => 0.5 * (a + b);
  let T = 0;

  // Bottom disc (normal -z) and top disc (normal +z), r = 0 .. r_out.
  for (let j = 0; j < nt; j++) for (let i = 0; i < iOut; i++) {
    // Area element r dr dtheta = rArea[i] * dtheta; the moment arm r and the area both live in
    // the same integral, so the combined weight is (integral of r^2 dr) * dtheta.
    const w = (re[i + 1] ** 3 - re[i] ** 3) / 3 * dth[j] * MM * MM * MM;
    const a = idx(i, j, kb - 1), b = idx(i, j, kb);
    T -= avg(Bt[a], Bt[b]) * avg(Bz[a], Bz[b]) * w;
    const c = idx(i, j, kt - 1), d = idx(i, j, kt);
    T += avg(Bt[c], Bt[d]) * avg(Bz[c], Bz[d]) * w;
  }

  // Outer cylinder (normal +r) at r = re[iOut].
  const R = re[iOut] * MM;
  for (let k = kb; k < kt; k++) for (let j = 0; j < nt; j++) {
    const dA = R * dth[j] * (dz[k] * MM);
    const a = idx(iOut - 1, j, k), b = idx(iOut, j, k);
    T += R * avg(Bt[a], Bt[b]) * avg(Br[a], Br[b]) * dA;
  }

  return m.sectors * T / MU0;
}

/* Torque on a box whose bottom face is the z-plane at mesh node kb. */
function torqueCartesian(sol, kb, kt) {
  const { job, Bx, By, Bz } = sol, m = job.mesh;
  const { nx, ny, nz, sy, sz, xe, ye, ze, xc, yc, dx, dy, dz } = m;

  // A box that comfortably encloses the rotor, clipped to the mesh interior.
  const Rb = job.g.Rro + 2;
  const ia = Math.max(1, locate(xe, nx, -Rb));
  const ib = Math.min(nx - 1, locate(xe, nx, Rb) + 1);
  const ja = Math.max(1, locate(ye, ny, -Rb));
  const jb = Math.min(ny - 1, locate(ye, ny, Rb) + 1);
  if (!(ib > ia && jb > ja && kt > kb && kb >= 1 && kt <= nz - 1)) return NaN;

  const idx = (ix, iy, iz) => (iz * ny + iy) * nx + ix;
  const avg = (k1, k2) => [(Bx[k1] + Bx[k2]) / 2, (By[k1] + By[k2]) / 2, (Bz[k1] + Bz[k2]) / 2];
  // Node and centre coordinates in metres.
  const X = i => xe[i] * MM, Xc = i => xc[i] * MM, Y = j => ye[j] * MM, Yc = j => yc[j] * MM;

  let T = 0;

  // Bottom face (normal -z) and top face (normal +z).
  for (let iy = ja; iy < jb; iy++) for (let ix = ia; ix < ib; ix++) {
    const dA = dx[ix] * dy[iy] * MM * MM;
    let [bx, by, bz] = avg(idx(ix, iy, kb - 1), idx(ix, iy, kb));
    T += (Xc(ix) * (-by * bz) - Yc(iy) * (-bx * bz)) * dA;
    [bx, by, bz] = avg(idx(ix, iy, kt - 1), idx(ix, iy, kt));
    T += (Xc(ix) * (by * bz) - Yc(iy) * (bx * bz)) * dA;
  }

  // The four side faces.
  for (let iz = kb; iz < kt; iz++) {
    for (let iy = ja; iy < jb; iy++) for (const [ixp, s] of [[ia, -1], [ib, 1]]) {
      const dA = dy[iy] * dz[iz] * MM * MM;
      const [bx, by, bz] = avg(idx(ixp - 1, iy, iz), idx(ixp, iy, iz)), B2 = bx * bx + by * by + bz * bz;
      const fx = s * (bx * bx - B2 / 2), fy = s * bx * by;
      T += (X(ixp) * fy - Yc(iy) * fx) * dA;
    }
    for (let ix = ia; ix < ib; ix++) for (const [iyp, s] of [[ja, -1], [jb, 1]]) {
      const dA = dx[ix] * dz[iz] * MM * MM;
      const [bx, by, bz] = avg(idx(ix, iyp - 1, iz), idx(ix, iyp, iz)), B2 = bx * bx + by * by + bz * bz;
      const fx = s * bx * by, fy = s * (by * by - B2 / 2);
      T += (Xc(ix) * fy - Y(iyp) * fx) * dA;
    }
  }
  return T / MU0;
}

/* Candidate Maxwell-stress planes inside one air gap, and the mean torque over them.
 *
 * A single stress surface is surprisingly sensitive to where it lands relative to the copper and
 * the pole face: refining only z, with the in-plane mesh held fixed, moved the torque of the 80 mm
 * machine by up to 2% as the plane hopped between mesh nodes, without the field itself changing
 * meaningfully. Averaging over every plane that fits removes most of that, and the spread across
 * them is an honest error bar — unlike two adjacent planes, which agree almost by construction.
 *
 * Planes at the extremes of the gap are worse than the middle: right against the copper the field
 * still carries the trace-by-trace structure, and right under a pole face it carries the pole-edge
 * singularity. On a finely resolved gap those disagreed with the middle by nearly 20% while the
 * converged torque was settled to under 1%. Hence the clearance band.
 */
const EDGE_CLEARANCE = 0.18;
const MAX_PLANES = 12;

function gapPlanes(m, gapLo, gapHi) {
  const gapH = gapHi - gapLo;
  const lo = gapLo + EDGE_CLEARANCE * gapH, hi = gapHi - EDGE_CLEARANCE * gapH;
  const cands = [], wide = [];
  for (let kb = 1; kb < m.nz - 1; kb++) {
    const zp = m.ze[kb];
    // The plane has to sit in the gap with its neighbouring cell centres either side of it.
    if (!(zp - 0.5 * m.dz[kb - 1] > gapLo && zp + 0.5 * m.dz[kb] < gapHi)) continue;
    wide.push(kb);
    if (zp >= lo && zp <= hi) cands.push(kb);
  }
  // A coarse gap may have no node in the central band; fall back to whatever fits.
  let planes = cands.length ? cands : wide;
  if (planes.length > MAX_PLANES) {
    const pick = [];
    for (let i = 0; i < MAX_PLANES; i++) pick.push(planes[Math.round(i * (planes.length - 1) / (MAX_PLANES - 1))]);
    planes = [...new Set(pick)];
  }
  return { planes: planes.slice().sort((a, b) => a - b), wide };
}

/* Torque on one rotor.
 *
 * `far` is the plane on the rotor's outer side, beyond its yoke; the gap planes are on the other.
 * The enclosing surface always runs from the lower index to the higher, so the sign is consistent
 * whichever side of the stator the rotor is on.
 */
function rotorTorque(sol, name, gapLo, gapHi, farZ, farSide) {
  const m = sol.job.mesh;
  const { planes, wide } = gapPlanes(m, gapLo, gapHi);
  const far = farSide > 0
    ? Math.min(m.nz - 1, locate(m.ze, m.nz, farZ) + 3)
    : Math.max(1, locate(m.ze, m.nz, farZ) - 2);
  const pair = kb => (farSide > 0 ? [kb, far] : [far, kb]);
  const planeTorque = planes.map(kb => {
    const v = torque(sol, ...pair(kb));
    return Number.isFinite(v) ? v : null;
  });
  const good = planeTorque.filter(v => v !== null);
  const mean = good.length ? good.reduce((a, b) => a + b, 0) / good.length : null;
  return {
    name, planes, wide, far,
    planeZ_mm: planes.map(k => m.ze[k]),
    planeTorque,
    T: good,
    torque: mean,
    spread_pct: good.length > 1 && mean ? (Math.max(...good) - Math.min(...good)) / Math.abs(mean) * 100 : null,
    midGapZ_mm: 0.5 * (gapLo + gapHi),
    gap: [gapLo, gapHi]
  };
}

export function motorMetrics(sol) {
  const { job } = sol, m = job.mesh, g = job.g;
  const copperTop = Math.max(...job.zLay), copperBottom = Math.min(...job.zLay);

  /* One rotor per working gap. A dual-sided machine has two, on the same shaft, so their torques
   * add — and because they are mirror images of each other, their disagreement is a free check on
   * the mesh and on the stress integration. */
  const rotors = [rotorTorque(sol, "upper", copperTop, g.zTB, g.zYT, +1)];
  if (g.dual) rotors.push(rotorTorque(sol, "lower", g.zMB, copperBottom, g.zMY, -1));

  const metrics = { rotors };
  const means = rotors.map(r => r.torque).filter(v => v !== null);
  metrics.torque = means.length ? means.reduce((a, b) => a + b, 0) : null;
  metrics.T = rotors.flatMap(r => r.T);
  metrics.planes = rotors[0].planes;
  metrics.planeZ_mm = rotors.flatMap(r => r.planeZ_mm);
  metrics.planeTorque = rotors.flatMap(r => r.planeTorque);
  const spreads = rotors.map(r => r.spread_pct).filter(v => v !== null);
  metrics.torqueSpread_pct = spreads.length ? Math.max(...spreads) : null;
  // How far the two rotors of a dual-sided machine disagree. They are mirror images, so anything
  // beyond the single-rotor surface spread is a meshing asymmetry rather than physics.
  metrics.rotorImbalance_pct = rotors.length === 2 && metrics.torque
    ? Math.abs(rotors[0].torque - rotors[1].torque) / Math.abs(metrics.torque / 2) * 100 : null;

  /* The two planes nearest mid-gap of the upper rotor, the pre-multi-plane definition. Retained so
   * the regression against the original single-file build keeps comparing like with like. */
  const up = rotors[0], zmid = up.midGapZ_mm;
  const nearest = up.wide.slice().sort((a, b) => Math.abs(m.ze[a] - zmid) - Math.abs(m.ze[b] - zmid)).slice(0, 2).sort((a, b) => a - b);
  metrics.legacyPlanes = nearest;
  metrics.legacyT = nearest.map(kb => {
    const i = up.planes.indexOf(kb);
    return i >= 0 ? up.planeTorque[i] : torque(sol, kb, up.far);
  }).filter(Number.isFinite);

  /* Mean |B_z| at exactly mid-gap over the annulus the coils occupy.
   *
   * Sampling the nearest cell layer made this jump by up to 3% as the mesh changed, purely because
   * the layer moved. Interpolating between the two layers that straddle mid-gap makes the metric a
   * property of the field rather than of the mesh. */
  metrics.gapBz = meanGapBz(sol, zmid);
  if (rotors.length === 2) metrics.gapBzLower = meanGapBz(sol, rotors[1].midGapZ_mm);

  let bmax = 0;
  for (let k = 0; k < job.mu.length; k++) if (job.mu[k] > 1.5) bmax = Math.max(bmax, Math.hypot(sol.Bx[k], sol.By[k], sol.Bz[k]));
  metrics.bmaxMat = bmax;
  metrics.midGapZ_mm = zmid;
  metrics.cellsAcrossAirGap = cellsAcross(m.ze, m.nz, copperTop, g.zTB);
  return metrics;
}

function meanGapBz(sol, zmid) {
  const m = sol.job.mesh, job = sol.job;
  const kg = Math.min(m.nz - 2, Math.max(0, locate(m.zc, m.nz, zmid)));
  const z0 = m.zc[kg], z1 = m.zc[kg + 1];
  const w = z1 > z0 ? Math.min(1, Math.max(0, (zmid - z0) / (z1 - z0))) : 0;
  const cyl = m.kind === CYLINDRICAL;
  let s = 0, wsum = 0;
  for (let iy = 0; iy < m.ny; iy++) for (let ix = 0; ix < m.nx; ix++) {
    const r = cyl ? m.xc[ix] : Math.hypot(m.xc[ix], m.yc[iy]);
    if (r > job.p.ri && r < job.p.ro) {
      // Area-weighted: cells differ in size on a graded mesh, and in cylindrical coordinates a
      // cell's footprint grows with radius.
      const a = planeAreaM(m, ix, iy);
      const k0 = (kg * m.ny + iy) * m.nx + ix, k1 = k0 + m.sz;
      s += Math.abs(sol.Bz[k0] * (1 - w) + sol.Bz[k1] * w) * a;
      wsum += a;
    }
  }
  return wsum > 0 ? s / wsum : 0;
}

/* Value on the axis at z-layer iz, from the four cells surrounding it. The mesh is symmetric about
 * the axis, so the four cells adjoining x = y = 0 are the right ones. */
export function interpCentre(A, job, iz) {
  const m = job.mesh, i = m.nx >> 1, j = m.ny >> 1;
  return (A[(iz * m.ny + j - 1) * m.nx + i - 1] + A[(iz * m.ny + j - 1) * m.nx + i]
        + A[(iz * m.ny + j) * m.nx + i - 1] + A[(iz * m.ny + j) * m.nx + i]) / 4;
}
