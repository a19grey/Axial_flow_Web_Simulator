/* Rasterizing a traced footprint onto a cylindrical mesh, exactly.
 *
 * The generality that `curves.js` adds looks like it must cost the engine its best property. Every
 * region today is a coordinate box in (r, theta, z), so a cell's volume fraction is a product of
 * three closed-form one-dimensional overlaps, and that is why the rasterization audit reports
 * rounding rather than tenths of a percent. A spline edge is not a coordinate surface, so the
 * obvious fallback is angular supersampling — a staircase whose error depends on where the cell
 * boundaries happen to fall.
 *
 * It does not have to cost that, because of where the footprint is authored. A control point is
 * [u, v]; the map to physical coordinates is r = r0 + u*dr, theta = centre + v*pitch. That is
 * *affine*, so a footprint drawn in normalized wedge coordinates is a closed polygon in the
 * (r, theta) plane — and cylindrical cells are axis-aligned rectangles in that same plane. Two
 * standard pieces then give the answer with no sampling at all:
 *
 *   - clip the polygon to the cell rectangle (Sutherland-Hodgman, four half-planes);
 *   - integrate the volume element over what is left, by Green's theorem:
 *
 *         integral of r dr dtheta  =  contour integral of (r^2 / 2) dtheta
 *
 *     which on an edge that is linear in (r, theta) is exactly (dtheta / 6) * (r1^2 + r1 r2 + r2^2).
 *
 * So the cell fraction of a polygonal footprint is exact to round-off, and the *only* error left is
 * the chord tolerance of the spline tessellation — which is a number we choose, can tighten, and
 * report, rather than a property of the grid. That is a much better trade than supersampling: the
 * error is in the shape description, where the author can see it, instead of in the discretization,
 * where they cannot.
 *
 * One convention worth being explicit about: an edge is linear in (r, theta), not a straight chord
 * in the plane. Two tessellation points a millimetre apart differ by microns between the two
 * readings, and the (r, theta) convention is the one that makes the cell integral exact, so it is
 * the one used — and the closed-form spline area in `curves.js` is what it gets audited against.
 *
 * Lengths are millimetres, angles radians.
 */

import { curveAt, loftAt, toPolar, polarToXY } from "./curves.js";

/* ---- tessellation in the (r, theta) plane ------------------------------------------------------ */

/* The footprint as a closed polygon of [r, theta] pairs.
 *
 * Adaptive on *physical* deviation: a span is bisected while the true curve at the mid-parameter
 * sits more than `tolerance_mm` from where the (r, theta)-linear edge puts it. Measuring the error
 * in millimetres rather than in parameter space is what makes the tolerance mean something at both
 * the bore and the rim, where the same angular step is a very different distance.
 */
export function polygonRT(curve, frame, { loft = null, s = 0, tolerance_mm = 0.02, maxPoints = 3000 } = {}) {
  const m = loftAt(loft, s);
  const at = t => { const q = curveAt(curve, t); const { r, th } = toPolar(frame, q.u, q.v, m); return [r, th]; };
  const pts = [];
  let budgeted = false;
  const push = p => { if (pts.length >= maxPoints) budgeted = true; else pts.push(p); };
  const walk = (t0, p0, t1, p1, depth) => {
    if (depth >= 8 || pts.length >= maxPoints) { push(p1); return; }
    const tm = 0.5 * (t0 + t1), pm = at(tm);
    // The edge's own midpoint, in the same (r, theta)-linear reading the cell integral assumes.
    const er = 0.5 * (p0[0] + p1[0]), et = 0.5 * (p0[1] + p1[1]);
    const a = polarToXY(pm[0], pm[1]), b = polarToXY(er, et);
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= tolerance_mm) { push(p1); return; }
    walk(t0, p0, tm, pm, depth + 1);
    walk(tm, pm, t1, p1, depth + 1);
  };
  const n = curve.spans, first = at(0);
  push(first);
  for (let i = 0; i < n; i++) {
    const p0 = i === 0 ? first : at(i), p1 = i === n - 1 ? first : at(i + 1);
    if (curve.degree === 1) push(p1); else walk(i, p0, i + 1, p1, 0);
  }
  if (pts.length > 1) {
    const a = pts[0], b = pts[pts.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-12 && Math.abs(a[1] - b[1]) < 1e-12) pts.pop();
  }
  return { points: pts, budgeted };
}

/* The area one polygon encloses, weighted by the volume element — the numerator of a cell fraction
 * before it is divided by the cell's own measure. Exact for edges linear in (r, theta). */
export function polygonMeasure(poly) {
  let I = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    I += (b[1] - a[1]) * (a[0] * a[0] + a[0] * b[0] + b[0] * b[0]);
  }
  return I / 6;
}

/* ---- clipping ---------------------------------------------------------------------------------- */

/* Sutherland-Hodgman against one half-plane of the cell rectangle: axis 0 is r, axis 1 is theta;
 * `keepAbove` selects which side of `bound` survives. A concave polygon comes out with degenerate
 * edges along the clip line, which the Green integral is indifferent to — it is the same contour.
 */
function clipHalf(poly, axis, bound, keepAbove) {
  const out = [];
  const inside = p => keepAbove ? p[axis] >= bound : p[axis] <= bound;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const ia = inside(a), ib = inside(b);
    if (ia) out.push(a);
    if (ia !== ib) {
      const t = (bound - a[axis]) / (b[axis] - a[axis]);
      out.push(axis === 0 ? [bound, a[1] + t * (b[1] - a[1])] : [a[0] + t * (b[0] - a[0]), bound]);
    }
  }
  return out;
}

export function clipToBand(poly, axis, lo, hi) {
  if (!poly.length) return poly;
  const a = clipHalf(poly, axis, lo, true);
  return a.length ? clipHalf(a, axis, hi, false) : a;
}

const extent = (poly, axis) => {
  let lo = Infinity, hi = -Infinity;
  for (const p of poly) { if (p[axis] < lo) lo = p[axis]; if (p[axis] > hi) hi = p[axis]; }
  return [lo, hi];
};

/* ---- the coverage table ------------------------------------------------------------------------ */

/* Every copy of the footprint that shows up in the mesh's angular window.
 *
 * The footprint repeats `count` times about the axis, and the mesh may model only a sector of the
 * machine. A copy is included if its angular extent overlaps the window, trying the +-2*pi shifts
 * too so a wedge straddling theta = 0 is not lost. On a full-turn mesh with the window closed by
 * periodicity, a copy that pokes out one end is *also* emitted shifted to the other, because the
 * cells there are the same cells.
 */
export function footprintCopies(base, { count, phase, pitch }, y0, y1) {
  const [t0, t1] = extent(base, 1);
  const out = [];
  const span = y1 - y0;
  for (let k = 0; k < count; k++) {
    const shift0 = phase + k * pitch;
    for (const wrap of [0, 2 * Math.PI, -2 * Math.PI]) {
      const d = shift0 + wrap;
      if (t1 + d < y0 - 1e-12 || t0 + d > y1 + 1e-12) continue;
      out.push(base.map(p => [p[0], p[1] + d]));
      if (Math.abs(span - 2 * Math.PI) > 1e-9) break;   // a sector window does not wrap
    }
  }
  return out;
}

/* Coverage fraction of each (r, theta) cell, for one footprint at one height.
 *
 * Returns a dense nr x nt table plus the measure it accounted for, so the caller can compare what
 * was laid down against the closed-form area without a second pass. Cost is one clip of the whole
 * polygon per angular band, then a clip per radial cell the band actually reaches — not per cell of
 * the mesh, which is what makes this affordable inside a z-loop.
 */
export function coverageTable(polys, mesh, { into = null, weight = 1, reset = true } = {}) {
  const { nx: nr, ny: nt, xe: re, ye: the, rArea } = mesh;
  const tab = into || new Float64Array(nr * nt);
  if (reset) tab.fill(0);
  let measure = 0;
  for (let j = 0; j < nt; j++) {
    const t0 = the[j], t1 = the[j + 1], dth = t1 - t0;
    const bands = [];
    for (const poly of polys) {
      const c = clipToBand(poly, 1, t0, t1);
      if (c.length >= 3) bands.push(c);
    }
    if (!bands.length) continue;
    for (const band of bands) {
      const [rlo, rhi] = extent(band, 0);
      let i0 = 0, i1 = nr - 1;
      while (i0 < nr - 1 && re[i0 + 1] <= rlo) i0++;
      while (i1 > 0 && re[i1] >= rhi) i1--;
      for (let i = i0; i <= i1; i++) {
        const c = clipToBand(band, 0, re[i], re[i + 1]);
        if (c.length < 3) continue;
        const I = Math.abs(polygonMeasure(c));
        if (!(I > 0)) continue;
        measure += I;
        tab[i * nt + j] += weight * I / (rArea[i] * dth);
      }
    }
  }
  return { table: tab, measure: weight * measure };
}

/* Clamp a finished table into [0, 1] and report the worst overshoot.
 *
 * A single footprint inside its own pitch cannot cover a cell twice, so an overshoot means either
 * copies that overlap each other — a rotor with no gap between its poles — or an outline that
 * crosses itself. Both are authoring faults, and the series permeability blend would turn either
 * into a plausible wrong answer, so the number is returned for the caller to report rather than
 * quietly absorbed. */
export function clampTable(tab) {
  let overshoot = 0;
  for (let k = 0; k < tab.length; k++) {
    if (tab[k] > 1) { overshoot = Math.max(overshoot, tab[k] - 1); tab[k] = 1; }
    else if (tab[k] < 0) tab[k] = 0;
  }
  return overshoot;
}

/* Is a point inside the footprint? The Cartesian rasterizer's path, which samples rather than
 * clips. The angle is reduced into one pitch about the copy's centre, so one polygon serves every
 * copy — legitimate exactly when the footprint stays inside its own pitch, which is the condition
 * `inspectSolid` reports as `overlaps`. */
export function pointInPolygonRT(poly, r, th) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > th) !== (b[1] > th) &&
        r < a[0] + (th - a[1]) * (b[0] - a[0]) / (b[1] - a[1])) inside = !inside;
  }
  return inside;
}
