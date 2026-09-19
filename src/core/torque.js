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
import { locate, cellsAcross } from "./mesh.js";

const MM = 1e-3;

/* Torque on a box whose bottom face is the z-plane at mesh node kb. */
export function torque(sol, kb) {
  const { job, Bx, By, Bz } = sol, m = job.mesh;
  const { nx, ny, nz, sy, sz, xe, ye, ze, xc, yc, dx, dy, dz } = m;

  // A box that comfortably encloses the rotor, clipped to the mesh interior.
  const Rb = job.g.Rro + 2;
  const ia = Math.max(1, locate(xe, nx, -Rb));
  const ib = Math.min(nx - 1, locate(xe, nx, Rb) + 1);
  const ja = Math.max(1, locate(ye, ny, -Rb));
  const jb = Math.min(ny - 1, locate(ye, ny, Rb) + 1);
  // Top face: clear of the rotor yoke by a couple of cells.
  const kt = Math.min(nz - 2, locate(ze, nz, job.g.zYT) + 3);
  if (!(ib > ia && jb > ja && kt > kb)) return NaN;

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

export function motorMetrics(sol) {
  const { job } = sol, m = job.mesh, g = job.g;
  const top = Math.max(...job.zLay);

  /* Candidate stress planes: mesh nodes inside the air gap, clear of the copper and of the rotor
   * pole face.
   *
   * The clearance is a fraction of the gap as well as half a cell. Right next to the copper the
   * field still carries the trace-by-trace structure, and right under a pole face it carries the
   * pole-edge singularity; a stress integral taken there is dominated by whatever the mesh happens
   * to resolve of those. On a finely resolved gap, planes at the extremes disagreed with the
   * middle by nearly 20% while the converged torque was settled to under 1%. Keeping to the
   * central band makes both the mean and its spread mean something. */
  const EDGE_CLEARANCE = 0.18;
  const gapLo = top, gapHi = g.zTB, gapH = gapHi - gapLo;
  const lo = gapLo + EDGE_CLEARANCE * gapH, hi = gapHi - EDGE_CLEARANCE * gapH;
  const admissible = (zp, kb) => zp - 0.5 * m.dz[kb - 1] > gapLo && zp + 0.5 * m.dz[kb] < gapHi;
  const cands = [], wide = [];
  for (let kb = 1; kb < m.nz - 1; kb++) {
    const zp = m.ze[kb];
    if (!admissible(zp, kb)) continue;
    wide.push(kb);
    if (zp >= lo && zp <= hi) cands.push(kb);
  }
  // A coarse gap may have no node in the central band; fall back to whatever fits.
  if (!cands.length) cands.push(...wide);
  const zmid = (gapLo + gapHi) / 2;

  /* Integrate on every admissible plane, not two.
   *
   * A single Maxwell-stress surface is surprisingly sensitive to where it lands relative to the
   * copper and the pole face: refining only z, with the in-plane mesh held fixed, moved the torque
   * of the 80 mm machine by up to 2% as the plane hopped between mesh nodes, without the field
   * itself changing meaningfully. Averaging over all the planes that fit removes most of that, and
   * the spread across them is an honest error bar — unlike two adjacent planes, which agree with
   * each other almost by construction.
   *
   * Cost is bounded: the planes share the same top and side faces, and there are only ever a
   * handful of mesh nodes inside an air gap.
   */
  const MAX_PLANES = 12;
  let planes = cands.slice();
  if (planes.length > MAX_PLANES) {
    const pick = [];
    for (let i = 0; i < MAX_PLANES; i++) pick.push(planes[Math.round(i * (planes.length - 1) / (MAX_PLANES - 1))]);
    planes = [...new Set(pick)];
  }
  planes.sort((a, b) => a - b);

  const metrics = { planes };
  metrics.planeZ_mm = planes.map(k => m.ze[k]);
  metrics.planeTorque = planes.map(kb => torque(sol, kb)).map(v => (Number.isFinite(v) ? v : null));

  const good = metrics.planeTorque.filter(v => v !== null);
  metrics.T = good;
  metrics.torque = good.length ? good.reduce((a, b) => a + b, 0) / good.length : null;
  metrics.torqueSpread_pct = good.length > 1 && metrics.torque
    ? (Math.max(...good) - Math.min(...good)) / Math.abs(metrics.torque) * 100 : null;

  /* The two planes nearest mid-gap, the pre-multi-plane definition. Retained so the regression
   * against the original single-file build keeps comparing like with like. */
  const nearest = wide.slice().sort((a, b) => Math.abs(m.ze[a] - zmid) - Math.abs(m.ze[b] - zmid)).slice(0, 2).sort((a, b) => a - b);
  metrics.legacyPlanes = nearest;
  metrics.legacyT = nearest.map(kb => {
    const i = planes.indexOf(kb);
    return i >= 0 ? metrics.planeTorque[i] : torque(sol, kb);
  }).filter(Number.isFinite);

  /* Mean |B_z| at exactly mid-gap over the annulus the coils occupy.
   *
   * Sampling the nearest cell layer made this jump by up to 3% as the mesh changed, purely because
   * the layer moved. Interpolating between the two layers that straddle mid-gap makes the metric a
   * property of the field rather than of the mesh. */
  const kg = Math.min(m.nz - 2, Math.max(0, locate(m.zc, m.nz, zmid)));
  const z0 = m.zc[kg], z1 = m.zc[kg + 1];
  const w = z1 > z0 ? Math.min(1, Math.max(0, (zmid - z0) / (z1 - z0))) : 0;
  let s = 0, wsum = 0;
  for (let iy = 0; iy < m.ny; iy++) for (let ix = 0; ix < m.nx; ix++) {
    const r = Math.hypot(m.xc[ix], m.yc[iy]);
    if (r > job.p.ri && r < job.p.ro) {
      // Area-weighted, because on a graded mesh the cells are not all the same size.
      const a = m.dx[ix] * m.dy[iy];
      const k0 = (kg * m.ny + iy) * m.nx + ix, k1 = k0 + m.sz;
      s += Math.abs(sol.Bz[k0] * (1 - w) + sol.Bz[k1] * w) * a;
      wsum += a;
    }
  }
  metrics.gapBz = wsum > 0 ? s / wsum : 0;

  let bmax = 0;
  for (let k = 0; k < job.mu.length; k++) if (job.mu[k] > 1.5) bmax = Math.max(bmax, Math.hypot(sol.Bx[k], sol.By[k], sol.Bz[k]));
  metrics.bmaxMat = bmax;
  metrics.kg = kg;
  metrics.midGapZ_mm = zmid;
  metrics.cellsAcrossAirGap = cellsAcross(m.ze, m.nz, g.pcbHalf, g.zTB);
  return metrics;
}

/* Value on the axis at z-layer iz, from the four cells surrounding it. The mesh is symmetric about
 * the axis, so the four cells adjoining x = y = 0 are the right ones. */
export function interpCentre(A, job, iz) {
  const m = job.mesh, i = m.nx >> 1, j = m.ny >> 1;
  return (A[(iz * m.ny + j - 1) * m.nx + i - 1] + A[(iz * m.ny + j - 1) * m.nx + i]
        + A[(iz * m.ny + j) * m.nx + i - 1] + A[(iz * m.ny + j) * m.nx + i]) / 4;
}
