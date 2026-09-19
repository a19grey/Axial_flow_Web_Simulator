/* Parametric geometry -> solver job.
 *
 * A "job" is everything the solver needs and nothing it doesn't: grid extents, the per-cell relative
 * permeability field, and the current-carrying line segments. No DOM, no GPU.
 *
 * Lengths here are millimetres, except segment coordinates, which are metres because that is what
 * the Biot-Savart shader wants.
 */

import { LAYER_Z, RASTER_SUPERSAMPLE } from "./constants.js";

export const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/* Concentric trapezoidal turns, one group per coil, `layers` copies stacked in z.
 * Coil k carries phase k mod 3. */
export function coilPolys(p) {
  const Nc = 1.5 * p.poles, half = Math.PI / Nc;
  const pitch = p.pitch, edge = p.edge, nArc = p.arcSegments ?? 10;
  const polys = [];
  for (let k = 0; k < Nc; k++) {
    const th = k * 2 * Math.PI / Nc, ph = k % 3;
    for (let j = 0; j < p.turns; j++) {
      const d = edge + j * pitch, ri = p.ri + d, ro = p.ro - d;
      const ai = half - d / ri, ao = half - d / ro;
      if (ro - ri < 1 || ai < 0.02) break;
      const pts = [[ri * Math.cos(th - ai), ri * Math.sin(th - ai)]];
      for (let s = 0; s <= nArc; s++) { const a = th - ao + 2 * ao * s / nArc; pts.push([ro * Math.cos(a), ro * Math.sin(a)]); }
      for (let s = 0; s <= nArc; s++) { const a = th + ai - 2 * ai * s / nArc; pts.push([ri * Math.cos(a), ri * Math.sin(a)]); }
      polys.push({ pts, ph });
    }
  }
  return polys;
}

/* Flatten polygons at each layer height into the packed segment array the shader reads:
 * (ax, ay, az, phase, bx, by, bz, 0) per segment, in metres. */
export function segsFromPolys(polys, zs) {
  const out = [];
  for (const z of zs) for (const { pts, ph } of polys) for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) continue;
    out.push(a[0] * 1e-3, a[1] * 1e-3, z * 1e-3, ph, b[0] * 1e-3, b[1] * 1e-3, z * 1e-3, 0);
  }
  return new Float32Array(out);
}

/* Axial landmarks of the machine, mm, with the PCB mid-plane at z = 0. */
export function motorGeom(p) {
  const pcbHalf = p.pcbT / 2;
  const zTB = pcbHalf + p.gap, zTT = zTB + p.tooth, zYT = zTT + p.yoke;
  const zBT = -pcbHalf - p.backGap, zBB = zBT - p.backT;
  return { pcbHalf, zTB, zTT, zYT, zBT, zBB, Rri: Math.max(1, p.ri - 1), Rro: p.ro + 1 };
}

export function layerZ(p) {
  const base = LAYER_Z[p.layers] || LAYER_Z[2];
  // Layer positions scale with board thickness; the defaults reproduce a 1.6 mm board exactly.
  const k = (p.pcbT / 2) / 0.8;
  return base.map(z => z * k);
}

/* Grid extents alone — no rasterization. Lets the caller report cell count, memory and gap
 * resolution before committing to a solve. */
export function motorGrid(p) {
  const g = motorGeom(p);
  const margin = Math.max(p.marginMin ?? 12, (p.marginFactor ?? 0.4) * p.ro);
  const L = g.Rro + margin;
  const zmin = (p.back ? g.zBB : -g.pcbHalf) - margin, zmax = g.zYT + margin;
  const nx = p.grid, ny = nx, hm = 2 * L / nx, nz = Math.ceil((zmax - zmin) / hm);
  return { nx, ny, nz, hm, x0: -L, y0: -L, z0: zmin, L, margin, zmin, zmax, g };
}

export function buildMotor(p) {
  const zLay = layerZ(p);
  const { pcbHalf, zTB, zTT, zYT, zBT, zBB, Rri, Rro } = motorGeom(p);
  const { nx, ny, nz, hm, x0, y0, z0 } = motorGrid(p);
  const N = nx * ny * nz;
  const mu = new Float32Array(N).fill(1);
  const m = 2 * Math.PI / p.poles, halfArc = p.arc * m / 2, th0 = p.theta * Math.PI / 180;
  const S = RASTER_SUPERSAMPLE;
  for (let iz = 0; iz < nz; iz++) {
    const za = z0 + iz * hm, zb = za + hm;
    const ft = overlap(za, zb, zTB, zTT) / hm, fy = overlap(za, zb, zTT, zYT) / hm, fb = p.back ? overlap(za, zb, zBB, zBT) / hm : 0;
    if (!ft && !fy && !fb) continue;
    for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
      const cx = x0 + (ix + .5) * hm, cy = y0 + (iy + .5) * hm, rc = Math.hypot(cx, cy);
      if (rc > Rro + hm || rc < Rri - hm) continue;
      let nA = 0, nT = 0;
      for (let a = 0; a < S; a++) for (let b = 0; b < S; b++) {
        const sx = x0 + (ix + (a + .5) / S) * hm, sy = y0 + (iy + (b + .5) / S) * hm, r = Math.hypot(sx, sy);
        if (r < Rri || r > Rro) continue;
        nA++;
        if (ft) { let d = Math.atan2(sy, sx) - th0; d = ((d % m) + m + m / 2) % m - m / 2; if (Math.abs(d) < halfArc) nT++; }
      }
      // Series blending of the filled fraction: 1/mu = (1-f) + f/mu_r. Arithmetic averaging of mu
      // would make a partly filled cell behave as solid iron and silently shrink the air gap.
      const fr = ft * nT / (S * S) + fy * nA / (S * S), fbk = fb * nA / (S * S);
      if (fr + fbk > 0) mu[(iz * ny + iy) * nx + ix] = 1 / ((1 - fr - fbk) + fr / p.murRot + fbk / p.murBack);
    }
  }
  const polys = coilPolys(p);
  const segs = segsFromPolys(polys, zLay);
  // The trace field depends only on the winding and the grid, never on rotor angle or current.
  const segKey = JSON.stringify([nx, ny, nz, hm, z0, p.poles, p.ri, p.ro, p.turns, p.layers, p.pitch, p.edge]);
  return {
    kind: "motor", p, nx, ny, nz, hm, x0, y0, z0, mu, polys, segs, segKey, zLay,
    g: { zTB, zTT, zYT, zBT, zBB, Rri, Rro, pcbHalf }
  };
}

/* ---- validation geometries ---------------------------------------------------------------- */

function cubeJob(kind, p, nMax = 128) {
  const n = Math.min(p.grid, nMax), L = 40, hm = 2 * L / n;
  return { kind, p, nx: n, ny: n, nz: n, hm, x0: -L, y0: -L, z0: -L, mu: new Float32Array(n * n * n).fill(1) };
}

/* Sphere of radius a in a uniform H0 along z. Interior field is 3 mu_r/(mu_r+2) * mu0 H0. */
export function buildSphere(p, { radius_mm = 10, H0_Am = 1000 } = {}) {
  const j = cubeJob("sphere", p), { nx, hm, x0 } = j, a = radius_mm, S = RASTER_SUPERSAMPLE;
  for (let iz = 0; iz < nx; iz++) for (let iy = 0; iy < nx; iy++) for (let ix = 0; ix < nx; ix++) {
    const c = [ix, iy, iz].map(i => x0 + (i + .5) * hm), rc = Math.hypot(...c);
    let f;
    if (rc < a - hm) f = 1; else if (rc > a + hm) f = 0;
    else {
      let n = 0;
      for (let u = 0; u < S; u++) for (let v = 0; v < S; v++) for (let w = 0; w < S; w++)
        if (Math.hypot(x0 + (ix + (u + .5) / S) * hm, x0 + (iy + (v + .5) / S) * hm, x0 + (iz + (w + .5) / S) * hm) < a) n++;
      f = n / (S * S * S);
    }
    if (f > 0) j.mu[(iz * nx + iy) * nx + ix] = 1 / ((1 - f) + f / p.murRot);
  }
  j.a = a; j.H0 = H0_Am;
  return j;
}

/* Single circular filament of radius R at z = 0, carrying unit current on phase 0. */
export function buildLoop(p, { radius_mm = 15, segments = 128 } = {}) {
  const j = cubeJob("loop", p), R = radius_mm, pts = [];
  for (let i = 0; i < segments; i++) { const t = 2 * Math.PI * i / segments; pts.push([R * Math.cos(t), R * Math.sin(t)]); }
  j.polys = [{ pts, ph: 0 }];
  j.segs = segsFromPolys(j.polys, [0]);
  j.R = R;
  j.segKey = JSON.stringify(["loop", j.nx, j.hm, R, segments]);
  j.zLay = [0];
  return j;
}
