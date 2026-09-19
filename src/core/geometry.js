/* Parametric geometry -> solver job.
 *
 * A "job" is everything the solver needs and nothing it doesn't: a mesh, the per-cell relative
 * permeability field, and the current-carrying line segments. No DOM, no GPU.
 *
 * Lengths here are millimetres, except segment coordinates, which are metres because that is what
 * the Biot-Savart shader wants.
 */

import { LAYER_Z, RASTER_SUPERSAMPLE } from "./constants.js";
import { makeMesh, uniformMesh, cellsAcross } from "./mesh.js";
import { gradedAxis, symmetricAxis } from "./grading.js";

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

/* The solve box: the machine plus a margin on every side, held at phi = 0. */
export function motorBox(p) {
  const g = motorGeom(p);
  const margin = Math.max(p.marginMin ?? 12, (p.marginFactor ?? 0.4) * p.ro);
  return {
    g, margin,
    L: g.Rro + margin,
    zmin: (p.back ? g.zBB : -g.pcbHalf) - margin,
    zmax: g.zYT + margin
  };
}

/* ---- mesh construction --------------------------------------------------------------------- */

export function buildMesh(p) {
  return (p.mesh?.mode === "graded") ? gradedMotorMesh(p) : uniformMotorMesh(p);
}

function uniformMotorMesh(p) {
  const { L, zmin, zmax } = motorBox(p);
  const nx = p.grid, h = 2 * L / nx, nz = Math.ceil((zmax - zmin) / h);
  return uniformMesh({ x0: -L, y0: -L, z0: zmin, nx, ny: nx, nz, h });
}

/* Size the mesh from the geometry rather than from one number.
 *
 * In plane, the machine itself gets `activeCellsAcrossDiameter` cells across its outer diameter and
 * the far field coarsens away from it. Along z, every layer of the machine gets its own cell count,
 * which is what lets a 3 mm gap be resolved inside a 370 mm machine. */
function gradedMotorMesh(p) {
  const m = p.mesh, { g, L, zmin, zmax } = motorBox(p);
  const hActive = 2 * g.Rro / m.activeCellsAcrossDiameter;
  const hFar = hActive * m.farFieldCellFactor;
  const growth = m.growthRatio;

  // In plane: symmetric about the axis, so a rotor angle of zero is not biased by the grid.
  const inPlane = symmetricAxis(L, [{ from: 0, to: g.Rro, h: hActive }], [g.Rro, g.Rri], hFar, growth);

  const zCons = [
    { from: g.pcbHalf, to: g.zTB, h: p.gap / m.cellsAcrossAirGap },
    { from: g.zTB, to: g.zTT, h: p.tooth / m.cellsAcrossPoleHeight },
    { from: g.zTT, to: g.zYT, h: p.yoke / m.cellsAcrossYoke },
    { from: -g.pcbHalf, to: g.pcbHalf, h: p.pcbT / m.cellsAcrossPcb }
  ];
  const zHard = [-g.pcbHalf, g.pcbHalf, g.zTB, g.zTT, g.zYT];
  if (p.back) {
    zCons.push({ from: g.zBB, to: g.zBT, h: p.backT / m.cellsAcrossBackPlate });
    // The gap below the PCB carries flux the same way the main gap does, so resolve it too.
    if (p.backGap > 0) zCons.push({ from: g.zBT, to: -g.pcbHalf, h: p.backGap / m.cellsAcrossBackGap });
    zHard.push(g.zBT, g.zBB);
  }
  const ze = gradedAxis(zmin, zmax, zCons, zHard, hFar, growth);

  const N = (inPlane.length - 1) ** 2 * (ze.length - 1);
  if (N > m.maxCells) {
    throw new Error(
      `This mesh would need ${(N / 1e6).toFixed(1)} M cells, past the ${(m.maxCells / 1e6).toFixed(0)} M budget in ` +
      `mesh.maxCells. Lower mesh.activeCellsAcrossDiameter (now ${m.activeCellsAcrossDiameter}) or the ` +
      `per-layer cell counts, or raise the budget.`);
  }
  return makeMesh(inPlane, inPlane, ze);
}

/* ---- rasterization ------------------------------------------------------------------------- */

/* Per-cell relative permeability.
 *
 * Each cell gets the fraction of its volume occupied by each material, from exact overlap in z and
 * supersampling in plane, then a series blend: 1/mu = (1-f) + f/mu_r. Arithmetic averaging of mu
 * would make a partly filled cell behave as solid iron and silently shrink the air gap.
 *
 * With a graded mesh the z interfaces land exactly on faces, so the z fractions are 0 or 1 and the
 * only partial filling left is the in-plane staircase at the pole edges and the bore.
 */
export function rasterizeMaterials(mesh, p) {
  const { nx, ny, nz, xc, yc, ze } = mesh;
  const g = motorGeom(p);
  const { zTB, zTT, zYT, zBT, zBB, Rri, Rro } = g;
  const mu = new Float32Array(mesh.N).fill(1);
  const m = 2 * Math.PI / p.poles, halfArc = p.arc * m / 2, th0 = p.theta * Math.PI / 180;
  const S = RASTER_SUPERSAMPLE;

  for (let iz = 0; iz < nz; iz++) {
    const za = ze[iz], zb = ze[iz + 1], dz = zb - za;
    const ft = overlap(za, zb, zTB, zTT) / dz;
    const fy = overlap(za, zb, zTT, zYT) / dz;
    const fb = p.back ? overlap(za, zb, zBB, zBT) / dz : 0;
    if (!ft && !fy && !fb) continue;
    for (let iy = 0; iy < ny; iy++) {
      const ya = mesh.ye[iy], dy = mesh.dy[iy];
      const cy = yc[iy];
      for (let ix = 0; ix < nx; ix++) {
        const cx = xc[ix], dx = mesh.dx[ix];
        const rc = Math.hypot(cx, cy), rCell = 0.5 * Math.hypot(dx, dy);
        if (rc > Rro + rCell || rc < Rri - rCell) continue;
        const xa = mesh.xe[ix];
        let nA = 0, nT = 0;
        for (let a = 0; a < S; a++) for (let b = 0; b < S; b++) {
          const sx = xa + (a + .5) / S * dx, sy = ya + (b + .5) / S * dy, r = Math.hypot(sx, sy);
          if (r < Rri || r > Rro) continue;
          nA++;
          if (ft) { let d = Math.atan2(sy, sx) - th0; d = ((d % m) + m + m / 2) % m - m / 2; if (Math.abs(d) < halfArc) nT++; }
        }
        const fr = ft * nT / (S * S) + fy * nA / (S * S), fbk = fb * nA / (S * S);
        if (fr + fbk > 0) mu[(iz * ny + iy) * nx + ix] = 1 / ((1 - fr - fbk) + fr / p.murRot + fbk / p.murBack);
      }
    }
  }
  return mu;
}

export function buildMotor(p) {
  const mesh = buildMesh(p);
  const g = motorGeom(p);
  const mu = rasterizeMaterials(mesh, p);
  const zLay = layerZ(p);
  const polys = coilPolys(p);
  const segs = segsFromPolys(polys, zLay);
  // The trace field depends only on the winding and the mesh, never on rotor angle or current.
  const segKey = JSON.stringify([mesh.nx, mesh.ny, mesh.nz, mesh.x0, mesh.z0, mesh.hMin, mesh.hMax,
                                 p.poles, p.ri, p.ro, p.turns, p.layers, p.pitch, p.edge]);
  return { kind: "motor", p, mesh, mu, polys, segs, segKey, zLay, g };
}

/* Resolution actually achieved, for the quality flags and AFS.plan(). */
export function meshResolution(mesh, p) {
  const g = motorGeom(p);
  return {
    airGap: cellsAcross(mesh.ze, mesh.nz, g.pcbHalf, g.zTB),
    poleHeight: cellsAcross(mesh.ze, mesh.nz, g.zTB, g.zTT),
    yoke: cellsAcross(mesh.ze, mesh.nz, g.zTT, g.zYT),
    pcb: cellsAcross(mesh.ze, mesh.nz, -g.pcbHalf, g.pcbHalf),
    backPlate: p.back ? cellsAcross(mesh.ze, mesh.nz, g.zBB, g.zBT) : 0,
    activeDiameter: cellsAcross(mesh.xe, mesh.nx, -g.Rro, g.Rro),
    radialSpan: cellsAcross(mesh.xe, mesh.nx, p.ri, p.ro)
  };
}

/* ---- validation geometries ---------------------------------------------------------------- */

function cubeJob(kind, p, nMax = 128) {
  const n = Math.min(p.grid, nMax), L = 40;
  return { kind, p, mesh: uniformMesh({ x0: -L, y0: -L, z0: -L, nx: n, ny: n, nz: n, h: 2 * L / n }) };
}

/* Sphere of radius a in a uniform H0 along z. Interior field is 3 mu_r/(mu_r+2) * mu0 H0. */
export function buildSphere(p, { radius_mm = 10, H0_Am = 1000 } = {}) {
  const j = cubeJob("sphere", p), { mesh } = j, n = mesh.nx, hm = mesh.dx[0], x0 = mesh.x0;
  const a = radius_mm, S = RASTER_SUPERSAMPLE;
  j.mu = new Float32Array(mesh.N).fill(1);
  for (let iz = 0; iz < n; iz++) for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) {
    const rc = Math.hypot(mesh.xc[ix], mesh.yc[iy], mesh.zc[iz]);
    let f;
    if (rc < a - hm) f = 1; else if (rc > a + hm) f = 0;
    else {
      let c = 0;
      for (let u = 0; u < S; u++) for (let v = 0; v < S; v++) for (let w = 0; w < S; w++)
        if (Math.hypot(x0 + (ix + (u + .5) / S) * hm, x0 + (iy + (v + .5) / S) * hm, x0 + (iz + (w + .5) / S) * hm) < a) c++;
      f = c / (S * S * S);
    }
    if (f > 0) j.mu[(iz * n + iy) * n + ix] = 1 / ((1 - f) + f / p.murRot);
  }
  j.a = a; j.H0 = H0_Am;
  return j;
}

/* Single circular filament of radius R at z = 0, carrying unit current on phase 0. */
export function buildLoop(p, { radius_mm = 15, segments = 128 } = {}) {
  const j = cubeJob("loop", p), R = radius_mm, pts = [];
  j.mu = new Float32Array(j.mesh.N).fill(1);
  for (let i = 0; i < segments; i++) { const t = 2 * Math.PI * i / segments; pts.push([R * Math.cos(t), R * Math.sin(t)]); }
  j.polys = [{ pts, ph: 0 }];
  j.segs = segsFromPolys(j.polys, [0]);
  j.R = R;
  j.segKey = JSON.stringify(["loop", j.mesh.nx, j.mesh.dx[0], R, segments]);
  j.zLay = [0];
  return j;
}
