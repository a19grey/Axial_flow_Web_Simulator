/* Parametric geometry -> solver job.
 *
 * A "job" is everything the solver needs and nothing it doesn't: a mesh, the per-cell relative
 * permeability field, and the current-carrying line segments. No DOM, no GPU.
 *
 * Lengths here are millimetres, except segment coordinates, which are metres because that is what
 * the Biot-Savart shader wants.
 */

import { LAYER_Z, RASTER_SUPERSAMPLE } from "./constants.js";
import { makeMesh, uniformMesh, cellsAcross, CYLINDRICAL } from "./mesh.js";
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
  const mode = p.mesh?.mode;
  if (mode === "cylindrical") return cylindricalMotorMesh(p);
  if (mode === "graded") return gradedMotorMesh(p);
  return uniformMotorMesh(p);
}

/* The angular period of the machine, in mechanical radians, and how many copies make a full turn.
 *
 * The rotor repeats every pole pitch, 2*pi/P. The stator has 1.5*P concentrated coils with phase
 * k mod 3 and a common winding sense, so coils k and k+3 carry the same current and the winding
 * repeats every 3 coils, which is 4*pi/P — two pole pitches. The coarser of the two governs, so
 * the whole machine, currents included, repeats every 4*pi/P: one pole pair, three coils.
 *
 * The repeat is plain periodicity rather than anti-periodicity, because same-phase coils here are
 * wound the same way round rather than alternating.
 */
export function angularPeriod(p) {
  const sectors = Math.max(1, Math.round(p.poles / 2));
  return { span: 2 * Math.PI / sectors, sectors };
}

/* A cylindrical (r, theta, z) mesh.
 *
 * This is the coordinate system the machine is actually built in. The bore, the outer rim and the
 * pole arcs all become coordinate surfaces, so the material fractions are exact instead of
 * staircased; the far field costs almost nothing because the cells grow with radius anyway; and
 * one pole pair can stand in for the whole machine.
 */
function cylindricalMotorMesh(p) {
  const m = p.mesh, { g, zmin, zmax, L } = motorBox(p);
  const growth = m.growthRatio;
  // Radial cell size over the active annulus, matched to the same knob the graded mode uses.
  const hActive = 2 * g.Rro / m.activeCellsAcrossDiameter;
  const hFar = hActive * m.farFieldCellFactor;

  /* Radius runs from the axis to the far field. The bore carries return flux but no structure, so
   * it is allowed to coarsen; the annulus and a margin either side of it are resolved. */
  const rMax = L;
  const re = gradedAxis(0, rMax,
    [{ from: Math.max(0, g.Rri - 2 * hActive), to: Math.min(rMax, g.Rro + 2 * hActive), h: hActive }],
    [g.Rri, g.Rro, p.ri, p.ro], hFar, growth);

  /* Angle. Uniform cells, because the rotor turns and any grading would have to turn with it,
   * which would throw away the cached Biot-Savart field on every step of an angle sweep. */
  const { span, sectors } = angularPeriod(p);
  const useSector = m.sector !== false && sectors > 1;
  const thSpan = useSector ? span : 2 * Math.PI;
  const thCount = useSector ? sectors : 1;
  // Resolve the pole arc and the coil sides: both are angular features of the pole pitch.
  const perPole = Math.max(4, Math.round(m.cellsAcrossPoleArc ?? 12));
  const nth = Math.max(8, Math.round(perPole * p.poles * thSpan / (2 * Math.PI)));
  const the = new Float64Array(nth + 1);
  for (let j = 0; j <= nth; j++) the[j] = thSpan * j / nth;

  // z is graded exactly as in the Cartesian case: the interfaces are planes either way.
  const { ze } = axialGrading(p, g, zmin, zmax, hFar, growth);

  const N = (re.length - 1) * nth * (ze.length - 1);
  if (N > m.maxCells) throw new Error(
    `This mesh would need ${(N / 1e6).toFixed(1)} M cells, past the ${(m.maxCells / 1e6).toFixed(0)} M budget in ` +
    `mesh.maxCells. Lower mesh.activeCellsAcrossDiameter (now ${m.activeCellsAcrossDiameter}) or ` +
    `mesh.cellsAcrossPoleArc (now ${perPole}), or raise the budget.`);

  return makeMesh(re, the, ze, { kind: CYLINDRICAL, periodicY: true, sectors: useSector ? thCount : 1 });
}

/* Axial grading, shared by the Cartesian and cylindrical builders: the z interfaces are planes in
 * both, so the same constraints and hard points apply. */
function axialGrading(p, g, zmin, zmax, hFar, growth) {
  const m = p.mesh;
  const zCons = [
    { from: g.pcbHalf, to: g.zTB, h: p.gap / m.cellsAcrossAirGap },
    { from: g.zTB, to: g.zTT, h: p.tooth / m.cellsAcrossPoleHeight },
    { from: g.zTT, to: g.zYT, h: p.yoke / m.cellsAcrossYoke },
    { from: -g.pcbHalf, to: g.pcbHalf, h: p.pcbT / m.cellsAcrossPcb }
  ];
  const zHard = [-g.pcbHalf, g.pcbHalf, g.zTB, g.zTT, g.zYT];
  if (p.back) {
    zCons.push({ from: g.zBB, to: g.zBT, h: p.backT / m.cellsAcrossBackPlate });
    if (p.backGap > 0) zCons.push({ from: g.zBT, to: -g.pcbHalf, h: p.backGap / m.cellsAcrossBackGap });
    zHard.push(g.zBT, g.zBB);
  }
  return { ze: gradedAxis(zmin, zmax, zCons, zHard, hFar, growth) };
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

  const { ze } = axialGrading(p, g, zmin, zmax, hFar, growth);

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
  return mesh.kind === CYLINDRICAL ? rasterizeCylindrical(mesh, p) : rasterizeCartesian(mesh, p);
}

/* Total overlap of the angular interval [t0, t1] with the union of the pole arcs. */
function arcOverlap(t0, t1, th0, poles, halfArc) {
  const pitch = 2 * Math.PI / poles;
  const kmin = Math.floor((t0 - th0 - halfArc) / pitch) - 1;
  const kmax = Math.ceil((t1 - th0 + halfArc) / pitch) + 1;
  let total = 0;
  for (let k = kmin; k <= kmax; k++) {
    const c = th0 + k * pitch;
    total += Math.max(0, Math.min(t1, c + halfArc) - Math.max(t0, c - halfArc));
  }
  return total;
}

/* Cylindrical rasterization is *exact*.
 *
 * Every part of this machine is a product of intervals in (r, theta, z): an annular sector
 * extruded in z. A cell is the same shape. So the occupied volume fraction is the product of three
 * one-dimensional overlaps, each computable in closed form — the radial one area-weighted, because
 * the volume element is r dr dtheta dz.
 *
 * That removes the staircase entirely. The Cartesian rasterizer has to supersample 4x4 in plane and
 * still leaves the bore, the rim and the pole edges as a jagged approximation whose error depends
 * on where the cell boundaries happen to fall.
 */
function rasterizeCylindrical(mesh, p) {
  const { nx: nr, ny: nt, nz, xe: re, ye: the, ze } = mesh;
  const g = motorGeom(p);
  const { zTB, zTT, zYT, zBT, zBB, Rri, Rro } = g;
  const mu = new Float32Array(mesh.N).fill(1);
  const th0 = p.theta * Math.PI / 180, halfArc = p.arc * Math.PI / p.poles;

  // Radial area fraction of each cell that lies inside the annulus Rri..Rro. Exact and independent
  // of theta and z, so it is computed once per radial index.
  const fRad = new Float64Array(nr);
  for (let i = 0; i < nr; i++) {
    const a = Math.max(re[i], Rri), b = Math.min(re[i + 1], Rro);
    fRad[i] = b > a ? (b * b - a * a) / (re[i + 1] * re[i + 1] - re[i] * re[i]) : 0;
  }
  // Angular fraction covered by a pole, likewise independent of r and z.
  const fArc = new Float64Array(nt);
  for (let j = 0; j < nt; j++) fArc[j] = arcOverlap(the[j], the[j + 1], th0, p.poles, halfArc) / (the[j + 1] - the[j]);

  for (let iz = 0; iz < nz; iz++) {
    const za = ze[iz], zb = ze[iz + 1], dz = zb - za;
    const fPole = overlap(za, zb, zTB, zTT) / dz;
    const fYoke = overlap(za, zb, zTT, zYT) / dz;
    const fBack = p.back ? overlap(za, zb, zBB, zBT) / dz : 0;
    if (!fPole && !fYoke && !fBack) continue;
    for (let j = 0; j < nt; j++) {
      const rotorZ = fPole * fArc[j] + fYoke;
      const base = (iz * nt + j) * nr;
      for (let i = 0; i < nr; i++) {
        const fr = fRad[i];
        if (fr <= 0) continue;
        const fRot = fr * rotorZ, fBk = fr * fBack;
        if (fRot + fBk > 0) mu[base + i] = 1 / ((1 - fRot - fBk) + fRot / p.murRot + fBk / p.murBack);
      }
    }
  }
  return mu;
}

/* Per-cell relative permeability on a Cartesian mesh.
 *
 * Exact overlap in z, supersampling in plane. A partially filled cell gets a series blend,
 * 1/mu = (1-f) + f/mu_r. Arithmetic averaging of mu would make a partly filled cell behave as solid
 * iron and silently shrink the air gap.
 *
 * With a graded mesh the z interfaces land exactly on faces, so the z fractions are 0 or 1 and the
 * only partial filling left is the in-plane staircase at the pole edges and the bore.
 */
function rasterizeCartesian(mesh, p) {
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
  const segKey = JSON.stringify([mesh.kind, mesh.nx, mesh.ny, mesh.nz, mesh.x0, mesh.x1, mesh.y0, mesh.y1,
                                 mesh.z0, mesh.hMin, mesh.hMax, mesh.sectors,
                                 p.poles, p.ri, p.ro, p.turns, p.layers, p.pitch, p.edge]);
  return { kind: "motor", p, mesh, mu, polys, segs, segKey, zLay, g };
}

/* Resolution actually achieved, for the quality flags and AFS.plan(). */
export function meshResolution(mesh, p) {
  const g = motorGeom(p);
  const cyl = mesh.kind === CYLINDRICAL;
  const res = {
    airGap: cellsAcross(mesh.ze, mesh.nz, g.pcbHalf, g.zTB),
    poleHeight: cellsAcross(mesh.ze, mesh.nz, g.zTB, g.zTT),
    yoke: cellsAcross(mesh.ze, mesh.nz, g.zTT, g.zYT),
    pcb: cellsAcross(mesh.ze, mesh.nz, -g.pcbHalf, g.pcbHalf),
    backPlate: p.back ? cellsAcross(mesh.ze, mesh.nz, g.zBB, g.zBT) : 0,
    // The radial axis runs 0..Rmax in cylindrical and -L..L in Cartesian, so the diameter is
    // counted twice over in one and directly in the other.
    activeDiameter: cyl ? 2 * cellsAcross(mesh.xe, mesh.nx, 0, g.Rro)
                        : cellsAcross(mesh.xe, mesh.nx, -g.Rro, g.Rro),
    radialSpan: cellsAcross(mesh.xe, mesh.nx, p.ri, p.ro)
  };
  if (cyl) {
    // Angular cells spanning one pole arc: the feature the theta mesh exists to resolve.
    const arcSpan = p.arc * 2 * Math.PI / p.poles;
    res.poleArc = arcSpan / ((mesh.y1 - mesh.y0) / mesh.ny);
    res.polePitch = (2 * Math.PI / p.poles) / ((mesh.y1 - mesh.y0) / mesh.ny);
  }
  return res;
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
