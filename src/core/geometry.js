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
import { DEG, resolveShape, shapeAt, shapeOutline, shapeAreaFraction, shapeMaxHalf } from "./shapes.js";

export const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/* The winding layout: how many coils, which phase each carries, and which way round it is wound.
 *
 * The default is the classical three-phase concentrated arrangement this tool has always used —
 * 1.5 x poles coils, phase k mod 3, all wound the same way. An explicit coilCount with a
 * phasePattern and/or coilSense describes anything else; short patterns repeat, so [0,1,2] and
 * [0,0,1,1,2,2] both read naturally.
 */
export function windingLayout(p) {
  const count = Math.max(1, Math.round(p.coilCount ?? 1.5 * p.poles));
  const pat = p.phasePattern && p.phasePattern.length ? p.phasePattern : null;
  const sen = p.coilSense && p.coilSense.length ? p.coilSense : null;
  const phase = [], sense = [];
  for (let k = 0; k < count; k++) {
    phase.push(pat ? pat[k % pat.length] : k % 3);
    sense.push(sen ? (sen[k % sen.length] < 0 ? -1 : 1) : 1);
  }
  return { count, phase, sense };
}

/* The outline one coil is wound along, as a shape profile.
 *
 * With no coilShape in the spec this is the wedge the tool has always wound: the full coil pitch
 * wide at every radius, centred on the coil's own angle, so successive turns nest inside each
 * other as straight-sided trapezoids. A profile replaces that with a width and a centre offset
 * that vary with radius, which is what a YASA-style coil needs — see src/core/shapes.js.
 */
export function coilShapeOf(p) {
  const { count } = windingLayout(p);
  return resolveShape({ count, fraction: p.coilSpan ?? 1, skew: (p.coilSkew || 0) * DEG, profile: p.coilShape });
}

/* Concentric turns, one group per coil, `layers` copies stacked in z.
 *
 * Turn j is the coil outline inset by j pitches plus the edge margin: the inset comes off the
 * radial ends directly and off the sides as inset/r, which is the angle that same clearance
 * subtends. A turn that the insets have closed up ends the coil, so a turns count that does not
 * fit in the copper produces fewer turns rather than crossed traces.
 *
 * A coil wound the other way round has its outline traversed in reverse, which reverses the
 * current direction in every one of its segments.
 */
export function coilPolys(p) {
  const { count: Nc, phase, sense } = windingLayout(p);
  const shape = coilShapeOf(p);
  const pitch = p.pitch, edge = p.edge, nArc = p.arcSegments ?? 10;
  /* A straight-sided coil has nothing between its corners, so its sides stay single chords — that
   * is the geometry, not a coarse sampling of it. A profiled coil's sides curve, and are sampled. */
  const sideSegs = shape.constant ? 1 : Math.max(2, Math.round(p.coilSideSegments ?? 12));
  const polys = [];
  for (let k = 0; k < Nc; k++) {
    const th = k * 2 * Math.PI / Nc, ph = phase[k];
    for (let j = 0; j < p.turns; j++) {
      const d = edge + j * pitch;
      const pts = shapeOutline(shape, { r0: p.ri + d, r1: p.ro - d, centre: th, inset: d,
                                        sideSegs, arcSegs: nArc });
      if (!pts) break;
      polys.push({ pts: sense[k] < 0 ? pts.slice().reverse() : pts, ph, coil: k, sense: sense[k] });
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

/* Axial landmarks of the machine, mm, with the PCB mid-plane at z = 0.
 *
 * A dual-sided machine carries a second rotor mirrored through z = 0, so the stator works into two
 * gaps and there is no flux-return plate to add: the opposite rotor is the return path. The back
 * plate is therefore ignored when dualSided is set (see backPlateActive).
 */
export function motorGeom(p) {
  const pcbHalf = p.pcbT / 2;
  const zTB = pcbHalf + p.gap, zTT = zTB + p.tooth, zYT = zTT + p.yoke;
  const zBT = -pcbHalf - p.backGap, zBB = zBT - p.backT;
  const dual = !!p.dual;
  return {
    pcbHalf, zTB, zTT, zYT, zBT, zBB,
    dual,
    // Mirror of the rotor, below the board. zMB is the face nearest the stator.
    zMB: -zTB, zMT: -zTT, zMY: -zYT,
    back: backPlateActive(p),
    Rri: Math.max(1, p.ri - 1), Rro: p.ro + 1
  };
}

/* The back plate exists only on a single-sided machine. */
export const backPlateActive = p => !!p.back && !p.dual;

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
    zmin: (g.dual ? g.zMY : g.back ? g.zBB : -g.pcbHalf) - margin,
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
 * Rotating by 2*pi/s must map the machine — rotor, winding, and the currents in it — onto itself.
 * That needs three things at once:
 *
 *   - the rotor poles to land on rotor poles, so s must divide the pole count;
 *   - the coils to land on coils, so s must divide the coil count;
 *   - each coil to land on one of the same phase and the same winding sense, so it carries the
 *     same current at the same instant.
 *
 * The last condition is the one that is easy to assume rather than check. For the default layout
 * (1.5*P coils, phase k mod 3, all wound alike) the largest valid s is P/2: one pole pair, three
 * coils, which is what the tool modelled before layouts were adjustable. Any other pattern is
 * tested here rather than assumed, and a layout with no symmetry simply falls back to the full
 * turn.
 *
 * The repeat is plain periodicity rather than anti-periodicity, because same-phase coils in the
 * default layout are wound the same way round rather than alternating. A layout that alternates
 * them has no plain period and is correctly reported as sectors = 1.
 */
export function angularPeriod(p) {
  const { count, phase, sense } = windingLayout(p);
  const poles = Math.round(p.poles);
  for (let s = Math.min(poles, count); s >= 2; s--) {
    if (poles % s || count % s) continue;
    const shift = count / s;
    let ok = true;
    for (let k = 0; k < count && ok; k++) {
      const j = (k + shift) % count;
      ok = phase[j] === phase[k] && sense[j] === sense[k];
    }
    if (ok) return { span: 2 * Math.PI / s, sectors: s };
  }
  return { span: 2 * Math.PI, sectors: 1 };
}

/* ---- regions ------------------------------------------------------------------------------- */

/* The rotor pole footprint, as a shape profile. `poleArcFraction` and `poleSkew_deg` describe a
 * straight-sided arc; `poleShape` replaces them with a free profile, which is how a 3D-printed
 * rotor gets a comma-shaped pole that a fraction and a skew cannot draw. */
export function poleShapeOf(p) {
  return resolveShape({ count: Math.round(p.poles), fraction: p.arc, skew: (p.skew || 0) * DEG,
                        profile: p.poleShape });
}

/* The magnetic parts of the machine, as a list rather than as branches in the rasterizer.
 *
 * Every part of an axial-flux machine is an annular sector extrusion: a radial interval, an axial
 * interval, and either a full annulus or a regularly repeated arc. Writing them as data means the
 * rasterizers loop over a list, a second rotor is another two entries rather than another branch,
 * and the mass calculation can use exactly the same geometry the field solve used.
 *
 * `arc` null means the region fills the whole annulus. Otherwise it is `count` copies of one
 * wedge, nominally centred at `phase` + k * pitch, whose width and centre offset are read off a
 * shape profile as a function of radius (src/core/shapes.js). A plain arc of constant width, with
 * or without linear skew, is the profile every design had before profiles existed.
 */
export function motorRegions(p) {
  const g = motorGeom(p), R = [];
  const th0 = p.theta * Math.PI / 180;
  const poleShape = poleShapeOf(p);
  const poleArc = { count: p.poles, phase: th0, shape: poleShape, pitchAngle: poleShape.pitch };
  const full = null;

  R.push({ name: "rotorPoles", mu_r: p.murRot, rho: p.rotorRho, group: "rotorTop",
           r0: g.Rri, r1: g.Rro, z0: g.zTB, z1: g.zTT, arc: poleArc });
  R.push({ name: "rotorYoke", mu_r: p.murRot, rho: p.rotorRho, group: "rotorTop",
           r0: g.Rri, r1: g.Rro, z0: g.zTT, z1: g.zYT, arc: full });

  if (g.dual) {
    R.push({ name: "rotorPolesLower", mu_r: p.murRot, rho: p.rotorRho, group: "rotorBottom",
             r0: g.Rri, r1: g.Rro, z0: g.zMT, z1: g.zMB, arc: poleArc });
    R.push({ name: "rotorYokeLower", mu_r: p.murRot, rho: p.rotorRho, group: "rotorBottom",
             r0: g.Rri, r1: g.Rro, z0: g.zMY, z1: g.zMT, arc: full });
  } else if (g.back) {
    R.push({ name: "backPlate", mu_r: p.murBack, rho: p.backRho, group: "stator",
             r0: g.Rri, r1: g.Rro, z0: g.zBB, z1: g.zBT, arc: full });
  }
  return R;
}

/* Exact volume of a region, cubic millimetres. Independent of the mesh, so comparing it with the
 * volume the rasterizer actually laid down is a direct check on the rasterizer. */
export function regionVolume(r) {
  const annulus = Math.PI * (r.r1 * r.r1 - r.r0 * r.r0);
  // The profile's swept area is closed-form, so this stays an independent check on the rasterizer
  // however complicated the footprint gets. Centre offsets move a wedge, they do not resize it.
  const frac = r.arc ? shapeAreaFraction(r.arc.shape, r.r0, r.r1) : 1;
  return annulus * frac * (r.z1 - r.z0);
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
  if (g.dual) {
    // The lower gap and rotor are the mirror image, and get the same resolution.
    zCons.push({ from: g.zMB, to: -g.pcbHalf, h: p.gap / m.cellsAcrossAirGap },
               { from: g.zMT, to: g.zMB, h: p.tooth / m.cellsAcrossPoleHeight },
               { from: g.zMY, to: g.zMT, h: p.yoke / m.cellsAcrossYoke });
    zHard.push(g.zMB, g.zMT, g.zMY);
  } else if (g.back) {
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

/* Per-cell relative permeability, built from the region list.
 *
 * Each cell accumulates the volume fraction it holds of every region, then a series blend
 *
 *     1/mu = (1 - sum_m f_m) + sum_m f_m / mu_m
 *
 * which is the reluctance of the parts in series along the flux path. Arithmetic averaging of mu
 * would make a partly filled cell behave as solid iron and silently shrink the air gap.
 *
 * Regions in this machine never overlap in z, so the accumulation needs no scratch arrays: the
 * rasterizers walk z-slabs and only the few regions that intersect the current slab are live.
 */
export function rasterizeMaterials(mesh, p) {
  const regions = motorRegions(p);
  /* The volume each region ends up occupying is accumulated as it goes. It costs one multiply per
   * filled cell and gives the mass calculation — and anyone auditing the rasterizer — a direct
   * comparison against the exact volume of the same region. */
  const volumes = new Float64Array(regions.length);
  const mu = mesh.kind === CYLINDRICAL
    ? rasterizeCylindrical(mesh, p, regions, volumes)
    : rasterizeCartesian(mesh, p, regions, volumes);
  return { mu, volumes: Array.from(volumes) };
}

/* Total overlap of the angular interval [t0, t1] with the union of `count` arcs of half-width
 * `halfArc` centred at th0 + k * pitch. */
function arcOverlap(t0, t1, th0, count, halfArc) {
  const pitch = 2 * Math.PI / count;
  const kmin = Math.floor((t0 - th0 - halfArc) / pitch) - 1;
  const kmax = Math.ceil((t1 - th0 + halfArc) / pitch) + 1;
  let total = 0;
  for (let k = kmin; k <= kmax; k++) {
    const c = th0 + k * pitch;
    total += Math.max(0, Math.min(t1, c + halfArc) - Math.max(t0, c - halfArc));
  }
  return total;
}

/* The wedge's half-width and centre angle at radius r, read off its profile. Normalized radius is
 * clamped, so a sample just outside the region reads the nearest end of the profile rather than
 * extrapolating it. */
function arcAt(arc, r0, r1, r) {
  const u = Math.min(1, Math.max(0, (r - r0) / Math.max(1e-12, r1 - r0)));
  const { half, off } = shapeAt(arc.shape, u);
  return { half, centre: arc.phase + off };
}

/* The angular fraction of one (r, theta) cell that a profiled wedge covers — exactly.
 *
 * The wedge's edges sweep across the cell as r increases, so the covered angle is a function of r
 * and the cell's fraction is its r-weighted average. Sampling that at the cell centre would be a
 * midpoint rule, which shows up in the volume audit at parts in 10^5 — small, but it would quietly
 * cost the cylindrical mesh the one property it exists for.
 *
 * Instead the radial span is cut at every radius where the answer stops being a quadratic in r:
 * the profile's own knots, and every radius where a wedge edge crosses one end of the cell. In
 * between, the edges are linear in r and the covered angle is linear in r, so the integrand —
 * covered angle times r — is quadratic and Simpson's rule is exact. The result is the true cell
 * fraction to round-off, for any piecewise-linear profile.
 */
function arcFractionOverCell(arc, r0, r1, ra, rb, t0, t1) {
  const cuts = [ra, rb];
  const push = r => { if (r > ra + 1e-12 && r < rb - 1e-12) cuts.push(r); };
  // The profile is flat outside r0..r1, so those two radii are kinks as much as the knots are.
  for (const q of arc.shape.pts) push(r0 + q.u * (r1 - r0));
  push(r0); push(r1);
  cuts.sort((a, b) => a - b);

  // Edge crossings, piece by piece: within a piece both edges are linear in r.
  const edges = r => { const { half, centre } = arcAt(arc, r0, r1, r); return [centre - half, centre + half]; };
  const crossings = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i], b = cuts[i + 1], ea = edges(a), eb = edges(b);
    for (let sgn = 0; sgn < 2; sgn++) {
      const va = ea[sgn], vb = eb[sgn];
      if (Math.abs(vb - va) < 1e-15) continue;
      const lo = Math.min(va, vb), hi = Math.max(va, vb);
      const kMin = Math.floor((t0 - hi) / arc.pitchAngle) - 1, kMax = Math.ceil((t1 - lo) / arc.pitchAngle) + 1;
      for (let k = kMin; k <= kMax; k++) for (const t of [t0, t1]) {
        const r = a + (t - k * arc.pitchAngle - va) * (b - a) / (vb - va);
        if (r > a + 1e-12 && r < b - 1e-12) crossings.push(r);
      }
    }
  }
  const all = [...cuts, ...crossings].sort((x, y) => x - y);

  const f = r => { const { half, centre } = arcAt(arc, r0, r1, r); return arcOverlap(t0, t1, centre, arc.count, half) * r; };
  let I = 0;
  for (let i = 0; i < all.length - 1; i++) {
    const a = all[i], b = all[i + 1];
    if (b - a < 1e-14) continue;
    I += (b - a) / 6 * (f(a) + 4 * f(0.5 * (a + b)) + f(b));   // exact: the integrand is quadratic here
  }
  return I / (0.5 * (rb * rb - ra * ra) * (t1 - t0));
}

/* Cylindrical rasterization is *exact*.
 *
 * Every region is a product of intervals in (r, theta, z): an annular sector extruded in z. A cell
 * is the same shape. So the occupied volume fraction is the product of three one-dimensional
 * overlaps, each computable in closed form — the radial one area-weighted, because the volume
 * element is r dr dtheta dz.
 *
 * Skew is the one thing that couples two of the axes: the arc centre moves with radius, so the
 * angular fraction becomes a table over (r, theta) rather than over theta alone. It is still exact
 * per cell, at the cost of an nr x ntheta table instead of an ntheta one.
 *
 * That removes the staircase entirely. The Cartesian rasterizer has to supersample 4x4 in plane and
 * still leaves the bore, the rim and the pole edges as a jagged approximation whose error depends
 * on where the cell boundaries happen to fall.
 */
function rasterizeCylindrical(mesh, p, regions, volumes) {
  const { nx: nr, ny: nt, nz, xe: re, ye: the, ze } = mesh;
  const mu = new Float32Array(mesh.N).fill(1);

  // Per-region radial and angular fraction tables. Both are independent of z.
  const tab = regions.map((reg, index) => {
    const fRad = new Float64Array(nr);
    for (let i = 0; i < nr; i++) {
      const a = Math.max(re[i], reg.r0), b = Math.min(re[i + 1], reg.r1);
      fRad[i] = b > a ? (b * b - a * a) / (re[i + 1] * re[i + 1] - re[i] * re[i]) : 0;
    }
    let fArc = null, fArcRT = null;
    if (reg.arc) {
      /* A wedge of constant width and no offset is the same in every ring, so it costs one
       * angular table. Anything that varies with radius — a skew, a comma, any profile — costs an
       * nr x ntheta table and is still exact per cell, because the wedge is still bounded by two
       * angles at every radius. */
      if (reg.arc.shape.constant) {
        const halfArc = reg.arc.shape.pts[0].half;
        fArc = new Float64Array(nt);
        for (let j = 0; j < nt; j++)
          fArc[j] = arcOverlap(the[j], the[j + 1], reg.arc.phase, reg.arc.count, halfArc) / (the[j + 1] - the[j]);
      } else {
        fArcRT = new Float64Array(nr * nt);
        for (let i = 0; i < nr; i++)
          for (let j = 0; j < nt; j++)
            fArcRT[i * nt + j] = arcFractionOverCell(reg.arc, reg.r0, reg.r1, re[i], re[i + 1], the[j], the[j + 1]);
      }
    }
    return { reg, index, fRad, fArc, fArcRT, inv: 1 / reg.mu_r };
  });

  for (let iz = 0; iz < nz; iz++) {
    const za = ze[iz], zb = ze[iz + 1], dz = zb - za;
    const live = [];
    for (const t of tab) {
      const fz = overlap(za, zb, t.reg.z0, t.reg.z1) / dz;
      if (fz > 0) live.push({ ...t, fz });
    }
    if (!live.length) continue;
    for (let j = 0; j < nt; j++) {
      const base = (iz * nt + j) * nr;
      const dthdz = mesh.dy[j] * dz;
      for (let i = 0; i < nr; i++) {
        let f = 0, inv = 0;
        const cellV = mesh.rArea[i] * dthdz;
        for (const t of live) {
          const fr = t.fRad[i];
          if (fr <= 0) continue;
          const fa = t.fArcRT ? t.fArcRT[i * nt + j] : t.fArc ? t.fArc[j] : 1;
          if (fa <= 0) continue;
          const ff = t.fz * fr * fa;
          f += ff; inv += ff * t.inv;
          volumes[t.index] += ff * cellV;
        }
        if (f > 0) mu[base + i] = 1 / ((1 - f) + inv);
      }
    }
  }
  return mu;
}

/* Per-cell relative permeability on a Cartesian mesh: exact overlap in z, supersampled in plane.
 *
 * With a graded mesh the z interfaces land exactly on faces, so the z fractions are 0 or 1 and the
 * only partial filling left is the in-plane staircase at the pole edges and the bore.
 */
function rasterizeCartesian(mesh, p, regions, volumes) {
  const { nx, ny, nz, xc, yc, ze } = mesh;
  const mu = new Float32Array(mesh.N).fill(1);
  const S = RASTER_SUPERSAMPLE, S2 = S * S;

  // Radial extent that any region reaches, so a cell far from the machine can be skipped at once.
  let rLo = Infinity, rHi = 0;
  for (const r of regions) { rLo = Math.min(rLo, r.r0); rHi = Math.max(rHi, r.r1); }
  if (!regions.length) return mu;

  for (let iz = 0; iz < nz; iz++) {
    const za = ze[iz], zb = ze[iz + 1], dz = zb - za;
    const live = [];
    for (let n = 0; n < regions.length; n++) {
      const reg = regions[n];
      const fz = overlap(za, zb, reg.z0, reg.z1) / dz;
      if (fz > 0) live.push({ reg, fz, index: n, inv: 1 / reg.mu_r,
                              pitch: reg.arc ? 2 * Math.PI / reg.arc.count : 0,
                              // Constant-width wedges skip the per-sample profile lookup entirely.
                              flat: reg.arc ? reg.arc.shape.constant : false,
                              halfArc: reg.arc && reg.arc.shape.constant ? reg.arc.shape.pts[0].half : 0 });
    }
    if (!live.length) continue;
    const hit = new Float64Array(live.length);

    for (let iy = 0; iy < ny; iy++) {
      const ya = mesh.ye[iy], dy = mesh.dy[iy], cy = yc[iy];
      for (let ix = 0; ix < nx; ix++) {
        const cx = xc[ix], dx = mesh.dx[ix];
        const rc = Math.hypot(cx, cy), rCell = 0.5 * Math.hypot(dx, dy);
        if (rc > rHi + rCell || rc < rLo - rCell) continue;
        const xa = mesh.xe[ix];
        hit.fill(0);
        for (let a = 0; a < S; a++) for (let b = 0; b < S; b++) {
          const sx = xa + (a + .5) / S * dx, sy = ya + (b + .5) / S * dy;
          const r = Math.hypot(sx, sy);
          if (r < rLo || r > rHi) continue;
          const th = Math.atan2(sy, sx);
          for (let n = 0; n < live.length; n++) {
            const L = live[n];
            if (r < L.reg.r0 || r > L.reg.r1) continue;
            if (L.reg.arc) {
              const m = L.pitch;
              let centre = L.reg.arc.phase, halfArc = L.halfArc;
              if (!L.flat) ({ half: halfArc, centre } = arcAt(L.reg.arc, L.reg.r0, L.reg.r1, r));
              let d = th - centre;
              d = ((d % m) + m + m / 2) % m - m / 2;
              if (Math.abs(d) >= halfArc) continue;
            }
            hit[n]++;
          }
        }
        let f = 0, inv = 0;
        const cellV = dx * dy * dz;
        for (let n = 0; n < live.length; n++) {
          if (!hit[n]) continue;
          const ff = live[n].fz * hit[n] / S2;
          f += ff; inv += ff * live[n].inv;
          volumes[live[n].index] += ff * cellV;
        }
        if (f > 0) mu[(iz * ny + iy) * nx + ix] = 1 / ((1 - f) + inv);
      }
    }
  }
  return mu;
}

export function buildMotor(p) {
  const mesh = buildMesh(p);
  const g = motorGeom(p);
  const { mu, volumes } = rasterizeMaterials(mesh, p);
  const zLay = layerZ(p);
  const polys = coilPolys(p);
  const segs = segsFromPolys(polys, zLay);
  // The trace field depends only on the winding and the mesh, never on rotor angle or current.
  const segKey = JSON.stringify([mesh.kind, mesh.nx, mesh.ny, mesh.nz, mesh.x0, mesh.x1, mesh.y0, mesh.y1,
                                 mesh.z0, mesh.hMin, mesh.hMax, mesh.sectors,
                                 p.poles, p.ri, p.ro, p.turns, p.layers, p.pitch, p.edge,
                                 p.coilCount, p.phasePattern, p.coilSense,
                                 p.coilShape, p.coilSpan, p.coilSkew, p.coilSideSegments]);
  return { kind: "motor", p, mesh, mu, volumes, polys, segs, segKey, zLay, g };
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
    backPlate: g.back ? cellsAcross(mesh.ze, mesh.nz, g.zBB, g.zBT) : 0,
    // The radial axis runs 0..Rmax in cylindrical and -L..L in Cartesian, so the diameter is
    // counted twice over in one and directly in the other.
    activeDiameter: cyl ? 2 * cellsAcross(mesh.xe, mesh.nx, 0, g.Rro)
                        : cellsAcross(mesh.xe, mesh.nx, -g.Rro, g.Rro),
    radialSpan: cellsAcross(mesh.xe, mesh.nx, p.ri, p.ro)
  };
  if (g.dual) {
    res.lowerAirGap = cellsAcross(mesh.ze, mesh.nz, g.zMB, -g.pcbHalf);
    res.lowerPoleHeight = cellsAcross(mesh.ze, mesh.nz, g.zMT, g.zMB);
  }
  if (cyl) {
    // Angular cells spanning one pole arc: the feature the theta mesh exists to resolve.
    // The widest the pole ever gets: the angular feature the theta mesh has to resolve.
    const arcSpan = 2 * shapeMaxHalf(poleShapeOf(p));
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
