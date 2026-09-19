/* Torque from the Maxwell stress tensor, and the derived motor metrics.
 *
 *   T_ij = (1/mu0)(B_i B_j - 1/2 delta_ij B^2),   tau_z = closed_integral (r x (T.n))_z dA
 *
 * The integration surface is a box in air around the rotor whose bottom face sits in the air gap.
 * Two boxes with bottom faces at different gap heights give two independent estimates; their
 * agreement is the practical check on whether the grid resolves the gap.
 *
 * (P4 adds a virtual-work torque as a genuinely independent second method.)
 */

import { MU0 } from "./constants.js";

export function torque(sol, kb) {
  const { job, Bx, By, Bz } = sol, { nx, ny, nz, x0, y0, z0 } = job, hm = job.hm, h = hm * 1e-3, sy = nx, sz = nx * ny, dA = h * h;
  const Rb = job.g.Rro + 2, ia = Math.max(1, Math.floor((-Rb - x0) / hm)), ib = Math.min(nx - 1, Math.ceil((Rb - x0) / hm));
  const ja = Math.max(1, Math.floor((-Rb - y0) / hm)), jb = Math.min(ny - 1, Math.ceil((Rb - y0) / hm));
  const kt = Math.min(nz - 2, Math.ceil((job.g.zYT - z0) / hm) + 2);
  const idx = (ix, iy, iz) => (iz * ny + iy) * nx + ix;
  const avg = (k1, k2) => [(Bx[k1] + Bx[k2]) / 2, (By[k1] + By[k2]) / 2, (Bz[k1] + Bz[k2]) / 2];
  const X = ix => (x0 + ix * hm) * 1e-3, Xc = ix => (x0 + (ix + .5) * hm) * 1e-3, Y = iy => (y0 + iy * hm) * 1e-3, Yc = iy => (y0 + (iy + .5) * hm) * 1e-3;
  let T = 0;
  for (let iy = ja; iy < jb; iy++) for (let ix = ia; ix < ib; ix++) {
    let [bx, by, bz] = avg(idx(ix, iy, kb - 1), idx(ix, iy, kb));
    T += (Xc(ix) * (-by * bz) - Yc(iy) * (-bx * bz)) * dA;
    [bx, by, bz] = avg(idx(ix, iy, kt - 1), idx(ix, iy, kt));
    T += (Xc(ix) * (by * bz) - Yc(iy) * (bx * bz)) * dA;
  }
  for (let iz = kb; iz < kt; iz++) {
    for (let iy = ja; iy < jb; iy++) for (const [ixp, s] of [[ia, -1], [ib, 1]]) {
      const [bx, by, bz] = avg(idx(ixp - 1, iy, iz), idx(ixp, iy, iz)), B2 = bx * bx + by * by + bz * bz;
      const fx = s * (bx * bx - B2 / 2), fy = s * bx * by;
      T += (X(ixp) * fy - Yc(iy) * fx) * dA;
    }
    for (let ix = ia; ix < ib; ix++) for (const [iyp, s] of [[ja, -1], [jb, 1]]) {
      const [bx, by, bz] = avg(idx(ix, iyp - 1, iz), idx(ix, iyp, iz)), B2 = bx * bx + by * by + bz * bz;
      const fx = s * bx * by, fy = s * (by * by - B2 / 2);
      T += (Xc(ix) * fy - Y(iyp) * fx) * dA;
    }
  }
  return T / MU0;
}
export function motorMetrics(sol) {
  const { job } = sol, { hm, z0, g } = job, top = Math.max(...job.zLay);
  const cands = [];
  for (let kb = 1; kb < job.nz - 1; kb++) { const zp = z0 + kb * hm; if (zp - 0.5 * hm > top && zp + 0.5 * hm < g.zTB) cands.push(kb); }
  const zmid = (top + g.zTB) / 2;
  cands.sort((a, b) => Math.abs(z0 + a * hm - zmid) - Math.abs(z0 + b * hm - zmid));
  const m = { planes: cands.slice(0, 2).sort((a, b) => a - b) };
  m.T = m.planes.map(kb => torque(sol, kb));
  const { nx, ny } = job, kg = Math.min(job.nz - 1, Math.max(0, Math.floor((zmid - z0) / hm)));
  let s = 0, n = 0, bmaxRot = 0;
  for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
    const r = Math.hypot(job.x0 + (ix + .5) * hm, job.y0 + (iy + .5) * hm);
    if (r > job.p.ri && r < job.p.ro) { s += Math.abs(sol.Bz[(kg * ny + iy) * nx + ix]); n++; }
  }
  m.gapBz = s / n;
  for (let k = 0; k < job.mu.length; k++) if (job.mu[k] > 1.5) bmaxRot = Math.max(bmaxRot, Math.hypot(sol.Bx[k], sol.By[k], sol.Bz[k]));
  m.bmaxMat = bmaxRot; m.kg = kg;
  return m;
}
export function interpCentre(A, job, iz) {
  const { nx, ny } = job, i = nx / 2, j = ny / 2;
  return (A[(iz * ny + j - 1) * nx + i - 1] + A[(iz * ny + j - 1) * nx + i] + A[(iz * ny + j) * nx + i - 1] + A[(iz * ny + j) * nx + i]) / 4;
}

