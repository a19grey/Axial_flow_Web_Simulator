/* Control-point curves: the general footprint, and how it sweeps in z.
 *
 * `shapes.js` describes a repeated feature as a half-width and a centre offset against radius. That
 * covers a trapezoid, an arc, and a comma, and it cannot cover a shape that doubles back — the
 * outline of a YASA coil, a hook-shaped printed pole, anything whose boundary is not two angles at
 * every radius. This module is the general version: the footprint is a *closed curve through control
 * points*, and the solid is that curve swept between two heights with its own schedule of flare,
 * pinch and twist.
 *
 *   footprint   a closed curve, 3 to ~30 control points, in normalized wedge coordinates
 *   loft        a low-order Bezier per channel (scale, widen, twist, shift) against height
 *
 * Four decisions in here are worth stating, because each one is the difference between a shape
 * language that is fun to demo and one an optimizer can actually search.
 *
 * **Normalized wedge coordinates, not millimetres.** A control point is [u, v]: u is 0 at the
 * feature's inner radius and 1 at its outer, v is the angle in units of the feature's *pitch*, so
 * v = +-0.5 is exactly the line where this wedge would touch its neighbour. This is not tidying. It
 * makes the design box *feasible by construction*: any control polygon with u in [0,1] and |v| <= 0.5
 * is a shape that stays in its annulus and cannot collide with the next pole. An optimizer can draw
 * uniformly from that box and get a legal machine nearly every time, which is the only way a
 * thirty-dimensional shape space is searchable at a few seconds an evaluation.
 *
 * **Periodic cubic B-spline, not one high-degree Bezier.** Fifteen points on a single Bezier is a
 * degree-14 Bernstein basis: every control point pulls on the whole curve, the basis functions are
 * nearly linearly dependent, and an optimizer moving one variable changes the shape everywhere. A
 * closed uniform B-spline of degree 3 has the same control points and the same smoothness, but each
 * one only touches four spans. Local support is what makes the sensitivity of each design variable
 * mean something. `splineThrough` is there for authors who want the curve to pass through their
 * points rather than be pulled by them.
 *
 * **Refinement is exact.** `refine()` doubles the control points and returns *the same curve*, to
 * the last bit — Lane-Riesenfeld, duplicate then average d times. So a coarse optimum is not a
 * starting guess for the finer parameterization, it is a member of it. Optimize four points, refine
 * to eight, carry on from where you were. That is the ladder that makes an infinite space finite.
 *
 * **Areas and volumes stay closed-form.** The whole engine's independent audit of its own rasterizer
 * is `regionVolume()` computed without reference to the mesh. A spline footprint keeps that: the
 * polar Green's-theorem integral A = (1/2) integral of r^2 dtheta has a piecewise *polynomial*
 * integrand, so Gauss-Legendre with enough nodes is exact rather than approximate, and the same holds
 * for the lofted volume. Generality costs exactness in the *rasterizer* (a spline edge is not a
 * coordinate surface) but it must not cost us the yardstick we measure that error against.
 *
 * Angles are radians. Nothing here touches the mesh, the GPU, or the DOM.
 */

/* ---- Gauss-Legendre ---------------------------------------------------------------------------- */

/* Nodes and weights on [0,1], by Newton iteration on the Legendre polynomial. Computed rather than
 * tabulated so the integration order can follow the polynomial degree of whatever is being
 * integrated, which is what lets the area and volume claims say "exact" and mean it. */
const gaussCache = new Map();
export function gauss(n) {
  n = Math.max(1, Math.min(32, Math.round(n)));
  const hit = gaussCache.get(n);
  if (hit) return hit;
  const x = new Float64Array(n), w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let t = Math.cos(Math.PI * (i + 0.75) / (n + 0.5)), dp = 0;
    for (let it = 0; it < 100; it++) {
      let p0 = 1, p1 = t;
      for (let k = 2; k <= n; k++) { const p2 = ((2 * k - 1) * t * p1 - (k - 1) * p0) / k; p0 = p1; p1 = p2; }
      dp = n * (t * p1 - p0) / (t * t - 1);
      const dt = -p1 / dp;
      t += dt;
      if (Math.abs(dt) < 1e-15) break;
    }
    // Map [-1,1] -> [0,1].
    x[i] = 0.5 * (1 + t);
    w[i] = 1 / ((1 - t * t) * dp * dp);
  }
  const out = { x, w };
  gaussCache.set(n, out);
  return out;
}

/* ---- Bezier channels -------------------------------------------------------------------------- */

/* A channel is a list of control values read against a normalized height s in [0,1], as a Bezier of
 * whatever degree the list implies: one value is a constant, two is a ramp, three is the quadratic
 * flare-or-waist that a printed pole wants, more is available and rarely needed. De Casteljau, so
 * the evaluation is stable at any degree and the endpoints are hit exactly.
 */
export function bezierAt(control, s) {
  const c = Array.isArray(control) ? control : [control ?? 0];
  const n = c.length;
  if (!n) return 0;
  if (n === 1) return +c[0];
  const b = c.map(Number);
  for (let k = n - 1; k > 0; k--) for (let i = 0; i < k; i++) b[i] = b[i] + s * (b[i + 1] - b[i]);
  return b[0];
}

export const bezierDegree = control => Math.max(0, (Array.isArray(control) ? control.length : 1) - 1);

/* ---- Closed control-point curves --------------------------------------------------------------- */

const MAX_DEGREE = 3;

/* Uniform B-spline basis and its derivative, degree 1..3, on one span. Written out rather than
 * recursed: these three are the whole vocabulary, and a reader should be able to check them. */
function basis(d, t) {
  const t2 = t * t, t3 = t2 * t;
  if (d === 1) return { b: [1 - t, t], db: [-1, 1] };
  if (d === 2) return { b: [0.5 * (1 - t) * (1 - t), 0.5 * (-2 * t2 + 2 * t + 1), 0.5 * t2],
                        db: [t - 1, -2 * t + 1, t] };
  return { b: [(1 - t) * (1 - t) * (1 - t) / 6, (3 * t3 - 6 * t2 + 4) / 6, (-3 * t3 + 3 * t2 + 3 * t + 1) / 6, t3 / 6],
           db: [-(1 - t) * (1 - t) / 2, (9 * t2 - 12 * t) / 6, (-9 * t2 + 6 * t + 3) / 6, t2 / 2] };
}

/* A closed curve from a control polygon.
 *
 *   control   [[u, v], ...] in normalized wedge coordinates, at least degree+1 points
 *   degree    1 (the polygon itself), 2, or 3 (default)
 *
 * The curve has one span per control point, so `spans` is the natural parameter partition and t in
 * [0, spans) walks it once. A degree-1 curve is the control polygon exactly, which is the escape
 * hatch for an author who wants hard corners.
 */
export function closedCurve(control, { degree = 3 } = {}) {
  const pts = (Array.isArray(control) ? control : []).map(p => {
    const u = +(Array.isArray(p) ? p[0] : p?.u), v = +(Array.isArray(p) ? p[1] : p?.v);
    if (!Number.isFinite(u) || !Number.isFinite(v)) throw new CurveError("a control point is not a pair of finite numbers");
    return [u, v];
  });
  const d = Math.max(1, Math.min(MAX_DEGREE, Math.round(degree)));
  if (pts.length < d + 1) throw new CurveError(`a closed degree-${d} curve needs at least ${d + 1} control points, got ${pts.length}`);
  return { control: pts, degree: d, spans: pts.length };
}

export class CurveError extends Error {}

/* Position and tangent at curve parameter t, which runs 0..spans and wraps. */
export function curveAt(curve, t) {
  const { control: P, degree: d, spans: n } = curve;
  let s = t % n; if (s < 0) s += n;
  const i = Math.min(n - 1, Math.floor(s)), f = s - i;
  const { b, db } = basis(d, f);
  let u = 0, v = 0, du = 0, dv = 0;
  for (let k = 0; k <= d; k++) {
    const p = P[(i + k) % n];
    u += b[k] * p[0]; v += b[k] * p[1];
    du += db[k] * p[0]; dv += db[k] * p[1];
  }
  return { u, v, du, dv };
}

/* Double the control points without changing the curve.
 *
 * Lane-Riesenfeld: duplicate every point, then average neighbouring pairs `degree` times. The result
 * is a different, finer control polygon for the *identical* curve — which is the property the
 * multi-resolution search depends on, and which `tests/geometry.js` asserts pointwise rather than
 * taking on faith.
 */
export function refine(curve) {
  const { control: P, degree: d, spans: n } = curve;
  let Q = [];
  for (const p of P) { Q.push([p[0], p[1]]); Q.push([p[0], p[1]]); }
  for (let pass = 0; pass < d; pass++) {
    const m = Q.length, R = new Array(m);
    for (let i = 0; i < m; i++) {
      const a = Q[i], b = Q[(i + 1) % m];
      R[i] = [0.5 * (a[0] + b[0]), 0.5 * (a[1] + b[1])];
    }
    Q = R;
  }
  // Duplication and averaging leave the parameterization aligned: the refined curve at 2t is the
  // original at t, with no rotation to undo, which `tests/geometry.js` checks pointwise.
  void n;
  return { control: Q, degree: d, spans: Q.length };
}

/* The frame a normalized curve is read in: the annulus it spans, the angle of this copy, and the
 * pitch its v coordinate is measured in. */
export function curveFrame({ r0, r1, centre = 0, count = 1, pitch = null }) {
  const p = pitch ?? 2 * Math.PI / Math.max(1, count);
  return { r0: +r0, r1: +r1, dr: +r1 - +r0, centre: +centre, pitch: p, count };
}

/* Normalized point -> polar -> plane. `loft` is the schedule evaluated at this height, or null. */
export function toPolar(frame, u, v, m = null) {
  if (m) { const uu = m.pivot + m.scale * (u - m.pivot) + m.shift, vv = m.widen * v + m.twist; u = uu; v = vv; }
  return { r: frame.r0 + u * frame.dr, th: frame.centre + v * frame.pitch };
}
export const polarToXY = (r, th) => [r * Math.cos(th), r * Math.sin(th)];

/* ---- The loft ---------------------------------------------------------------------------------- */

/* How the footprint changes as it climbs from one face to the other.
 *
 *   scale   radial-and-angular size about the pivot: < 1 pinches, > 1 flares
 *   widen   extra angular-only factor, so a pole can fan out without growing radially
 *   twist   centre-line swing, in pitch units — the generalization of poleSkew_deg
 *   shift   radial translation, in normalized units
 *   pivot   the u the scaling is taken about; 0.5 is mid-radius
 *
 * Each is a Bezier control list against normalized height, so `{"scale": [1, 1.35, 0.9]}` is a shape
 * that bulges on the way up and closes at the top — the kind of thing only a printer makes.
 */
export function loftSchedule(spec = {}) {
  const ch = k => (spec[k] === undefined || spec[k] === null ? null : (Array.isArray(spec[k]) ? spec[k].map(Number) : [Number(spec[k])]));
  const sc = ch("scale") ?? [1], wd = ch("widen") ?? [1], tw = ch("twist") ?? [0], sh = ch("shift") ?? [0];
  const pivot = Number.isFinite(+spec.pivot) ? +spec.pivot : 0.5;
  const constant = [sc, wd, tw, sh].every(c => c.length === 1) && sc[0] === 1 && wd[0] === 1 && tw[0] === 0 && sh[0] === 0;
  const degree = Math.max(bezierDegree(sc), bezierDegree(wd), bezierDegree(tw), bezierDegree(sh));
  return { sc, wd, tw, sh, pivot, constant, degree };
}

export function loftAt(loft, s) {
  if (!loft || loft.constant) return null;
  return { scale: bezierAt(loft.sc, s), widen: bezierAt(loft.wd, s), twist: bezierAt(loft.tw, s),
           shift: bezierAt(loft.sh, s), pivot: loft.pivot };
}

/* ---- Exact area and volume --------------------------------------------------------------------- */

/* The area one copy of the footprint encloses, mm^2, by Green's theorem in polar coordinates:
 *
 *     A = (1/2) * closed integral of r^2 dtheta
 *
 * r and theta are the same degree-d polynomial in the span parameter as the curve, so the integrand
 * is a polynomial of degree 3d and a Gauss rule of ceil((3d+2)/2) nodes integrates it exactly. For a
 * cubic that is 6 nodes per span. Sign is positive for a counter-clockwise curve; the magnitude is
 * what callers want, so it is returned along with the orientation.
 */
export function curveArea(curve, frame, m = null) {
  const { spans: n, degree: d } = curve;
  const { x, w } = gauss(Math.ceil((3 * d + 2) / 2));
  let I = 0;
  for (let i = 0; i < n; i++) for (let q = 0; q < x.length; q++) {
    const { u, v, du, dv } = curveAt(curve, i + x[q]);
    let U = u, dU = du, dV = dv;
    if (m) { U = m.pivot + m.scale * (u - m.pivot) + m.shift; dU = m.scale * du; dV = m.widen * dv; }
    void dU;
    const r = frame.r0 + U * frame.dr;
    I += w[q] * r * r * dV * frame.pitch;
  }
  const signed = 0.5 * I;
  return { area: Math.abs(signed), signed, ccw: signed > 0 };
}

/* The fraction of the annulus r0..r1 that all `count` copies cover — the same quantity
 * `shapeAreaFraction` returns for a wedge profile, so the two shape languages are comparable and a
 * curve that reproduces a trapezoid can be checked against it. */
export function curveAreaFraction(curve, frame, m = null) {
  const annulus = Math.PI * (frame.r1 * frame.r1 - frame.r0 * frame.r0);
  if (!(annulus > 0)) return 0;
  return Math.min(1, frame.count * curveArea(curve, frame, m).area / annulus);
}

/* The volume the footprint sweeps between two heights, mm^3.
 *
 * A(s) is the area of the mapped footprint at height fraction s. Under a loft of Bezier degree p the
 * map is polynomial in s, so A(s) has degree at most 3p and the height integral is exact with
 * ceil((3p+2)/2) nodes. A constant loft is a prism and is taken directly.
 */
export function loftVolume(curve, frame, loft, z0, z1) {
  const h = Math.abs(z1 - z0);
  if (!loft || loft.constant) return curveArea(curve, frame).area * h;
  const { x, w } = gauss(Math.ceil((3 * Math.max(1, loft.degree) + 2) / 2));
  let I = 0;
  for (let q = 0; q < x.length; q++) I += w[q] * curveArea(curve, frame, loftAt(loft, x[q])).area;
  return I * h;
}

/* ---- Tessellation ------------------------------------------------------------------------------ */

/* The footprint as a closed polygon in the plane, millimetres, at height fraction s.
 *
 * Adaptive: each span is bisected while the midpoint of the curve sits further than `tolerance_mm`
 * off the chord, which puts vertices where the shape is actually curving. Biot-Savart cost is linear
 * in segment count, so there is also a hard budget; hitting it is reported rather than silently
 * coarsening, because a spline that costs more than the mesh is a decision the author should make.
 */
export function tessellate(curve, frame, { loft = null, s = 0, tolerance_mm = 0.05, maxPoints = 4000, minPerSpan = 1 } = {}) {
  const m = loftAt(loft, s);
  const at = t => { const { u, v } = curveAt(curve, t); const { r, th } = toPolar(frame, u, v, m); return polarToXY(r, th); };
  const pts = [];
  let budgeted = false;
  const push = p => { if (pts.length >= maxPoints) { budgeted = true; return; } pts.push(p); };
  const depthCap = 7;
  const walk = (t0, p0, t1, p1, depth) => {
    const tm = 0.5 * (t0 + t1), pm = at(tm);
    const cx = 0.5 * (p0[0] + p1[0]), cy = 0.5 * (p0[1] + p1[1]);
    const dev = Math.hypot(pm[0] - cx, pm[1] - cy);
    if (depth >= depthCap || dev <= tolerance_mm || pts.length >= maxPoints) { push(p1); return; }
    walk(t0, p0, tm, pm, depth + 1);
    walk(tm, pm, t1, p1, depth + 1);
  };
  const n = curve.spans, per = Math.max(1, Math.round(minPerSpan));
  const first = at(0);
  push(first);
  for (let i = 0; i < n; i++) for (let k = 0; k < per; k++) {
    const t0 = i + k / per, t1 = i + (k + 1) / per;
    const p0 = (i === 0 && k === 0) ? first : at(t0);
    const p1 = (i === n - 1 && k === per - 1) ? first : at(t1);
    if (curve.degree === 1 && per === 1) push(p1); else walk(t0, p0, t1, p1, 0);
  }
  // The walk closes the loop by landing back on the first point; drop the duplicate.
  if (pts.length > 1) {
    const a = pts[0], b = pts[pts.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9) pts.pop();
  }
  return { points: pts, budgeted };
}

/* ---- Validity ---------------------------------------------------------------------------------- */

const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

function segmentsCross(a, b, c, d) {
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

/* Does the outline cross itself? A control polygon drawn at random will sometimes do this, and a
 * self-crossing footprint is not a shape — it rasterizes to something with a hole in it and a mass
 * that matches nothing. Checked on the tessellation, which is what everything downstream actually
 * consumes, and with a bounding-box reject so a few hundred points is still instant. */
export function selfIntersects(points) {
  const n = points.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a = points[i], b = points[(i + 1) % n];
    const ax0 = Math.min(a[0], b[0]), ax1 = Math.max(a[0], b[0]);
    const ay0 = Math.min(a[1], b[1]), ay1 = Math.max(a[1], b[1]);
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;      // neighbours through the wrap
      const c = points[j], d = points[(j + 1) % n];
      if (Math.max(c[0], d[0]) < ax0 || Math.min(c[0], d[0]) > ax1) continue;
      if (Math.max(c[1], d[1]) < ay0 || Math.min(c[1], d[1]) > ay1) continue;
      if (segmentsCross(a, b, c, d)) return true;
    }
  }
  return false;
}

/* Everything an author — or a validator, or an optimizer's feasibility gate — wants to know about a
 * footprint, without meshing or solving it. The four numbers that matter are the extent in u (does it
 * stay in its annulus), the extent in v (does it clear the next copy), whether it is simple, and the
 * area fraction (is it a plausible amount of material). Overhang comes from the loft: the largest
 * lateral displacement between adjacent heights over the height step is the local overhang angle,
 * which is the check a printed rotor has to pass.
 */
export function inspectCurve(curve, frame, { loft = null, tolerance_mm = 0.05, heights = 9, z0 = 0, z1 = 1 } = {}) {
  const levels = (loft && !loft.constant) ? Math.max(2, heights) : 1;
  let uMin = Infinity, uMax = -Infinity, vAbs = 0, simple = true, budgeted = false;
  const rings = [];
  for (let L = 0; L < levels; L++) {
    const s = levels === 1 ? 0 : L / (levels - 1), m = loftAt(loft, s);
    for (let i = 0; i < curve.spans * 4; i++) {
      const { u, v } = curveAt(curve, i / 4);
      const U = m ? m.pivot + m.scale * (u - m.pivot) + m.shift : u;
      const V = m ? m.widen * v + m.twist : v;
      uMin = Math.min(uMin, U); uMax = Math.max(uMax, U); vAbs = Math.max(vAbs, Math.abs(V));
    }
    const t = tessellate(curve, frame, { loft, s, tolerance_mm });
    budgeted = budgeted || t.budgeted;
    if (selfIntersects(t.points)) simple = false;
    // A fixed parameter grid as well as the tessellation: the overhang check needs the *same*
    // material point at two heights, and two adaptive tessellations do not have corresponding
    // vertices.
    const walk = [];
    const K = curve.spans * 8;
    for (let i = 0; i < K; i++) {
      const q = curveAt(curve, i * curve.spans / K), pl = toPolar(frame, q.u, q.v, m);
      walk.push(polarToXY(pl.r, pl.th));
    }
    rings.push({ s, points: t.points, walk });
  }
  const h = Math.abs(z1 - z0);
  let overhang_deg = 0;
  for (let L = 1; L < rings.length; L++) {
    const a = rings[L - 1].walk, b = rings[L].walk;
    const dz = h * (rings[L].s - rings[L - 1].s);
    if (!(dz > 0)) continue;
    let lat = 0;
    for (let i = 0; i < a.length; i++) lat = Math.max(lat, Math.hypot(b[i][0] - a[i][0], b[i][1] - a[i][1]));
    overhang_deg = Math.max(overhang_deg, Math.atan2(lat, dz) * 180 / Math.PI);
  }
  const area = curveArea(curve, frame).area;
  return {
    uMin, uMax, maxAbsV: vAbs, simple, budgeted,
    insideAnnulus: uMin >= -1e-9 && uMax <= 1 + 1e-9,
    clearsNeighbour: vAbs <= 0.5 + 1e-9,
    area_mm2: area, areaFraction: curveAreaFraction(curve, frame),
    volume_mm3: loftVolume(curve, frame, loft, z0, z1),
    overhang_deg, points: rings[0].points.length
  };
}

/* ---- Bridges ----------------------------------------------------------------------------------- */

/* Interpolate: the closed cubic B-spline that passes *through* the given points.
 *
 * Authoring by pulling is unintuitive if what you have is a traced outline, and an agent handed a
 * list of coordinates means "go through these". For a closed uniform cubic the curve at a span
 * boundary is (P[i] + 4 P[i+1] + P[i+2]) / 6, so the control points come from a cyclic tridiagonal
 * [1,4,1]/6 system, and the solution is rotated by one to line the span boundaries up with the
 * points they were asked to hit.
 */
export function splineThrough(points, { degree = 3 } = {}) {
  const pts = points.map(p => [+(Array.isArray(p) ? p[0] : p.u), +(Array.isArray(p) ? p[1] : p.v)]);
  const n = pts.length;
  if (degree !== 3 || n < 3) return closedCurve(pts, { degree });
  const solve = comp => {
    // Cyclic tridiagonal with a = c = 1/6, b = 4/6. Small n, so a direct dense-free iteration is
    // clearer than a banded factorization and converges in a handful of passes (the system is
    // strongly diagonally dominant: 4 > 1 + 1).
    const rhs = pts.map(p => p[comp]);
    let x = rhs.slice();
    for (let it = 0; it < 200; it++) {
      let delta = 0;
      for (let i = 0; i < n; i++) {
        const xi = (6 * rhs[i] - x[(i - 1 + n) % n] - x[(i + 1) % n]) / 4;
        delta = Math.max(delta, Math.abs(xi - x[i]));
        x[i] = xi;
      }
      if (delta < 1e-15) break;
    }
    return x;
  };
  const U = solve(0), V = solve(1);
  const control = U.map((_, i) => { const j = (i - 1 + n) % n; return [U[j], V[j]]; });
  return closedCurve(control, { degree: 3 });
}

/* The control-point curve equivalent to a `shapes.js` width/offset profile.
 *
 * This is how today's machine enters the new language, and how the optimizer gets a warm start that
 * is the design we already believe in rather than a random polygon: sample the profile's two edges
 * at `perSide` radii and interpolate a closed curve through them. With degree 1 and two samples a
 * side it is the trapezoid, exactly.
 */
export function curveFromProfile(shapeAt, shape, { perSide = 6, degree = 3 } = {}) {
  const pitch = shape.pitch, pts = [];
  const N = Math.max(2, Math.round(perSide));
  for (let i = 0; i < N; i++) { const u = i / (N - 1), { half, off } = shapeAt(shape, u); pts.push([u, (off - half) / pitch]); }
  for (let i = N - 1; i >= 0; i--) { const u = i / (N - 1), { half, off } = shapeAt(shape, u); pts.push([u, (off + half) / pitch]); }
  return degree === 1 ? closedCurve(pts, { degree: 1 }) : splineThrough(pts, { degree });
}

/* ---- Layouts that cannot draw a broken shape -------------------------------------------------- */

/* Normalized coordinates make the *box* feasible — a control polygon inside it stays in its annulus
 * and clears its neighbour — but they do not make it *simple*. Eight points drawn uniformly and taken
 * in the order they were drawn cross themselves: measured over 4000 draws, 5.6 % of naive polygons
 * are simple outlines and the rest are bow ties. That rate would eat any search budget.
 *
 * The fix is a layout, not a rejection loop. A footprint is drawn as *two chains*: one walking
 * outward along the trailing edge, one walking back along the leading edge, with the trailing edge's
 * angles confined to v <= 0 and the leading edge's to v >= 0. Radially monotone chains whose angular
 * ranges do not overlap cannot cross, so every draw is a shape — measured at 100 % over the same
 * 4000 draws, at a mean area fraction of 0.36, which is a plausible amount of material rather than
 * slivers.
 *
 * This is also exactly the generalization of the width/offset profile in `shapes.js`: that profile is
 * this layout with the two chains tied together as centre +- half. The layout is therefore the low
 * rung of the search ladder, the one whose whole box is legal. Higher rungs use `refine()`, which
 * leaves the layout behind and takes the general polygon — legal by *locality* there, since the
 * search is perturbing a shape already known to be simple, and checked by `inspectCurve` regardless.
 */
export function twoSidedCurve(vTrail, vLead, { u0 = 0.05, u1 = 0.95, degree = 3 } = {}) {
  const n = Math.min(vTrail.length, vLead.length);
  if (n < 2) throw new CurveError("a two-sided footprint needs at least two radial stations per side");
  const u = i => u0 + (u1 - u0) * i / (n - 1);
  const control = [];
  for (let i = 0; i < n; i++) control.push([u(i), Math.min(0, +vTrail[i])]);
  for (let i = n - 1; i >= 0; i--) control.push([u(i), Math.max(0, +vLead[i])]);
  return closedCurve(control, { degree });
}

/* The layout's design vector: the trailing edge's angles then the leading edge's, so the box is
 * [-0.5, 0] for the first half and [0, 0.5] for the second and a sampler needs to know nothing else. */
export function twoSidedVector(vTrail, vLead) { return [...vTrail, ...vLead]; }

export function twoSidedFromVector(vec, opts = {}) {
  const n = vec.length / 2;
  if (!Number.isInteger(n)) throw new CurveError(`a two-sided footprint vector must be even, got ${vec.length}`);
  return twoSidedCurve(vec.slice(0, n), vec.slice(n), opts);
}

export function twoSidedBounds(n, { maxV = 0.5 } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) out.push([-maxV, 0]);
  for (let i = 0; i < n; i++) out.push([0, maxV]);
  return out;
}

/* ---- The optimizer's view ---------------------------------------------------------------------- */

/* A curve flattened to a design vector, and back. The box is the same for every entry of it — u in
 * [0,1], v in [-0.5, 0.5] — which is the point of the normalized coordinates and is what lets a
 * sampler draw a legal shape without knowing anything about motors.
 *
 * `fixU` pins the radial coordinates, halving the dimension: often the right first rung, since a
 * footprint whose control points slide only in angle still covers every shape the old width/offset
 * profile could draw, plus all the ones that double back.
 */
export function curveToVector(curve, { fixU = false } = {}) {
  const v = [];
  for (const [u, vv] of curve.control) { if (!fixU) v.push(u); v.push(vv); }
  return v;
}

export function curveFromVector(vec, template, { fixU = false } = {}) {
  const n = template.spans, per = fixU ? 1 : 2, control = [];
  if (vec.length !== n * per) throw new CurveError(`expected ${n * per} values for a ${n}-point curve, got ${vec.length}`);
  for (let i = 0; i < n; i++) control.push(fixU ? [template.control[i][0], vec[i]] : [vec[2 * i], vec[2 * i + 1]]);
  return closedCurve(control, { degree: template.degree });
}

export function curveBounds(curve, { fixU = false, uRange = [0, 1], vRange = [-0.5, 0.5] } = {}) {
  const out = [];
  for (let i = 0; i < curve.spans; i++) { if (!fixU) out.push(uRange.slice()); out.push(vRange.slice()); }
  return out;
}
