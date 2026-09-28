/* Solids: the intermediate representation the rest of the engine asks questions of.
 *
 * Until now the machine was a fixed list. `motorRegions()` returned four hard-coded annular-sector
 * extrusions and everything downstream knew which was which. This module is the layer that replaces
 * "is this the yoke?" with a question about a *solid*: what are your z faces, how far out do you
 * reach, how wide do you get, what volume should you occupy, and can you be rasterized exactly.
 *
 * A solid has one of two footprints, and the distinction is the whole design:
 *
 *   wedge   bounded by two angles at every radius, from a `shapes.js` width/offset profile. This is
 *           a coordinate sector: the rasterizer's closed-form product path applies, and the result
 *           is exact to round-off. Everything the tool could express before is this.
 *   traced  a closed control-point curve from `curves.js`, optionally swept with a loft schedule.
 *           Expresses shapes no pair of angles can — a hook, a comma that doubles back, a pole that
 *           flares on the way up and closes at the top. Rasterized by polygon clipping, which on a
 *           cylindrical mesh is *also* exact (see raster.js); the residual error is the chord
 *           tolerance of the tessellation, which is reported per solid rather than absorbed.
 *
 * Both answer the same questions, and the three properties the engine is arranged around survive:
 * exactness where the footprint is a coordinate sector, hard points supplied *by* the solid so the
 * mesher can snap interfaces onto faces, and a closed-form volume so the rasterizer keeps an
 * independent audit of itself.
 *
 * Lengths are millimetres, angles radians.
 */

import { shapeAreaFraction, shapeMaxHalf } from "./shapes.js";
import { curveFrame, curveArea, loftVolume, loftAt, curveAt, loftSchedule, closedCurve,
         splineThrough, twoSidedCurve, CurveError } from "./curves.js";
import { polygonRT, polygonMeasure } from "./raster.js";

export const DEFAULT_CHORD_TOLERANCE_MM = 0.001;

/* ---- constructors ------------------------------------------------------------------------------ */

/* A solid whose footprint is a wedge profile: today's region, unchanged in every field the
 * rasterizers already read. */
export function wedgeSolid(fields) {
  return { ...fields, footprint: null, loft: null, exact: true };
}

/* A solid whose footprint is a traced curve.
 *
 *   count, phase   how many copies go round and where the first one sits
 *   curve          a closedCurve in normalized wedge coordinates
 *   loft           a loftSchedule, or null for a prism
 */
export function tracedSolid(fields, { count, phase = 0, curve, loft = null, flip = false,
                                      tolerance_mm = DEFAULT_CHORD_TOLERANCE_MM }) {
  const n = Math.max(1, Math.round(count));
  const solid = { ...fields,
           arc: null,
           // `flip` runs the loft's height fraction from z1 to z0 instead, so a mirrored copy of a
           // solid flares away from the air gap rather than towards it. The volume is the same
           // either way, so only the rasterizer and the renderer read it.
           footprint: { count: n, phase, pitch: 2 * Math.PI / n, curve, tolerance_mm, flip: !!flip },
           loft: loft && !loft.constant ? loft : null,
           exact: false };
  /* The radii the footprint actually reaches. A loft that flares can push it outside the r0..r1 the
   * solid is declared in — r0..r1 define the u mapping, they are not a clip — so the reach is
   * recorded separately and is what the mesher snaps to and the Cartesian sampler bounds against.
   * The two rasterizers and the closed-form volume must agree about this or the audit is a lie. */
  const [rLo, rHi] = solidRadialExtent(solid);
  solid.rLo = rLo; solid.rHi = rHi;
  return solid;
}

/* The frame a solid's normalized footprint is read in. */
export const solidFrame = s => curveFrame({ r0: s.r0, r1: s.r1, centre: s.footprint.phase,
                                            count: s.footprint.count });

/* ---- the questions --------------------------------------------------------------------------- */

/* Exact volume, cubic millimetres, computed without reference to any mesh — which is what makes
 * comparing it against the volume the rasterizer laid down a real audit rather than a tautology.
 *
 * Both paths are closed form. A wedge's swept area is piecewise quadratic and integrates exactly; a
 * traced footprint's is a polar Green's-theorem integral over a polynomial, and the height integral
 * under a Bezier loft likewise. Neither is a quadrature that might be under-resolved.
 */
export function solidVolume(s) {
  const h = s.z1 - s.z0;
  if (s.footprint) return s.footprint.count * loftVolume(s.footprint.curve, solidFrame(s), s.loft, s.z0, s.z1);
  const annulus = Math.PI * (s.r1 * s.r1 - s.r0 * s.r0);
  const frac = s.arc ? shapeAreaFraction(s.arc.shape, s.r0, s.r1) : 1;
  return annulus * frac * h;
}

/* The z coordinates the mesher must put a face on. A solid's own faces, always; a loft adds no
 * interfaces of its own, because a smoothly swept side is not a discontinuity in z. */
export const solidStations = s => [s.z0, s.z1];

/* The widest angular half-extent the solid ever reaches, radians — the feature the angular mesh has
 * to resolve, and the number that says whether neighbouring copies collide. For a loft this is
 * taken over height, because a shape that clears its neighbour at the gap face can run into it at
 * the top. */
export function solidAngularHalf(s, { heights = 9 } = {}) {
  if (!s.footprint) return s.arc ? shapeMaxHalf(s.arc.shape) : Math.PI;
  const { curve, pitch } = s.footprint;
  const levels = s.loft ? Math.max(2, heights) : 1;
  let worst = 0;
  for (let L = 0; L < levels; L++) {
    const m = loftAt(s.loft, levels === 1 ? 0 : L / (levels - 1));
    for (let i = 0; i < curve.spans * 4; i++) {
      const q = curveAt(curve, i / 4);
      const v = m ? m.widen * q.v + m.twist : q.v;
      worst = Math.max(worst, Math.abs(v));
    }
  }
  return worst * pitch;
}

/* The radial extent the solid actually occupies, which a loft can pull inside its own r0..r1. */
export function solidRadialExtent(s, { heights = 9 } = {}) {
  if (!s.footprint) return [s.r0, s.r1];
  const { curve } = s.footprint, f = solidFrame(s);
  const levels = s.loft ? Math.max(2, heights) : 1;
  let lo = Infinity, hi = -Infinity;
  for (let L = 0; L < levels; L++) {
    const m = loftAt(s.loft, levels === 1 ? 0 : L / (levels - 1));
    for (let i = 0; i < curve.spans * 4; i++) {
      const q = curveAt(curve, i / 4);
      const u = m ? m.pivot + m.scale * (q.u - m.pivot) + m.shift : q.u;
      lo = Math.min(lo, u); hi = Math.max(hi, u);
    }
  }
  return [f.r0 + lo * f.dr, f.r0 + hi * f.dr];
}

/* Which rasterization path this solid takes, and what it costs.
 *
 * Reported per solid by `plan()` so an author knows the trade they made. The message for a traced
 * solid is a *note*, not a warning: tracing a shape an arc cannot draw is the point of the feature,
 * and the tessellation error is a knob, not a defect. `volumeError_pct` is the polygon's area
 * against the curve's closed form — the whole of the extra error, since the cell integral over that
 * polygon is exact.
 */
export function solidProvenance(s) {
  if (!s.footprint) return { path: "exact", reason: s.arc ? "wedge profile: a coordinate sector in (r, theta, z)"
                                                          : "full annulus" };
  const f = solidFrame(s), tol = s.footprint.tolerance_mm;
  const levels = s.loft ? 5 : 1;
  let worst = 0, points = 0;
  for (let L = 0; L < levels; L++) {
    const sFrac = levels === 1 ? 0 : L / (levels - 1), m = loftAt(s.loft, sFrac);
    const poly = polygonRT(s.footprint.curve, f, { loft: s.loft, s: sFrac, tolerance_mm: tol });
    const exact = curveArea(s.footprint.curve, f, m).area;
    points = Math.max(points, poly.points.length);
    if (exact > 0) worst = Math.max(worst, Math.abs(Math.abs(polygonMeasure(poly.points)) - exact) / exact);
    if (poly.budgeted) worst = Infinity;
  }
  return { path: "traced", reason: "control-point curve: clipped and integrated per cell",
           chordTolerance_mm: tol, polygonPoints: points, volumeError_pct: worst * 100 };
}

/* Everything a validator or an optimizer's feasibility gate wants, with no mesh and no solve. */
export function inspectSolid(s) {
  const half = solidAngularHalf(s);
  const [rLo, rHi] = solidRadialExtent(s);
  const pitch = s.footprint ? s.footprint.pitch : s.arc ? 2 * Math.PI / s.arc.count : 2 * Math.PI;
  return {
    name: s.name, group: s.group,
    volume_mm3: solidVolume(s), stations: solidStations(s),
    radialExtent_mm: [rLo, rHi], angularHalf_deg: half * 180 / Math.PI,
    clearance_deg: (pitch - 2 * half) * 180 / Math.PI,
    overlaps: 2 * half > pitch + 1e-12,
    withinDeclaredRadii: rLo >= s.r0 - 1e-9 && rHi <= s.r1 + 1e-9,
    provenance: solidProvenance(s)
  };
}

/* The loft's height fraction for a point at height z inside the solid, honouring `flip`. */
export function solidHeightFraction(s, z) {
  const t = (z - s.z0) / Math.max(1e-12, s.z1 - s.z0);
  const c = Math.min(1, Math.max(0, t));
  return s.footprint && s.footprint.flip ? 1 - c : c;
}

/* ---- authoring ------------------------------------------------------------------------------- */

/* A footprint from the spec's three authoring forms, in normalized wedge coordinates.
 *
 *   { "controlPoints": [[u, v], ...], "degree": 3, "interpolate": true }
 *   { "through":       [[u, v], ...] }                  same thing, said the obvious way
 *   { "trailing": [v, ...], "leading": [v, ...] }       the two-chain layout, which cannot self-cross
 *
 * Errors name the field and say what would fix it, because the customer for this is a model writing
 * JSON and reading the reply.
 */
export function footprintCurve(spec, path = "poleCurve") {
  if (!spec) return null;
  const degree = spec.degree === undefined ? 3 : Math.round(+spec.degree);
  try {
    if (Array.isArray(spec.trailing) && Array.isArray(spec.leading))
      return twoSidedCurve(spec.trailing, spec.leading,
                           { u0: spec.u0 ?? 0.02, u1: spec.u1 ?? 0.98, degree });
    const pts = spec.through || spec.controlPoints || (Array.isArray(spec) ? spec : null);
    if (!pts) throw new CurveError(
      "needs controlPoints [[u, v], ...], or through [[u, v], ...], or a trailing/leading pair");
    return (spec.through || spec.interpolate) && degree === 3 ? splineThrough(pts) : closedCurve(pts, { degree });
  } catch (e) {
    throw new CurveError(`${path}: ${e.message}`);
  }
}

/* A loft from the spec, or null. Every channel is a Bezier control list against normalized height:
 * one value is a constant, two a ramp, three the quadratic flare or waist. */
export function footprintLoft(spec) {
  if (!spec) return null;
  const l = loftSchedule(spec);
  return l.constant ? null : l;
}
