/* Which heights of a lofted footprint are worth drawing.
 *
 * The plan view draws a pole's outline at the gap face and at the yoke, solid and dashed. Those are
 * the two a reader wants: the gap face is what the copper sees and the yoke is where the pole is
 * attached. But they are not always the whole shape, and the gap is not a detail.
 *
 * A loft channel is a Bezier against normalized height, and a Bezier interpolates its first and last
 * control values and nothing in between. So `scale: [1, 1.3, 1]` is a pole that bulges 15 % at
 * mid-height and comes back to its original size at both ends — and its two face outlines are
 * *identical*. Drawing only the faces shows that pole as having no loft at all, under a caption
 * saying it has one. The demo rotor is a milder version of the same thing: its widest section is at
 * mid-height, 4 % larger than either face, so the drawn pair understates the flare it exists to
 * demonstrate.
 *
 * So the interior extreme is found as well, and drawn when it is far enough from both faces to be a
 * different shape rather than a thicker line.
 *
 * The outlines are sampled at *fixed curve parameters* rather than tessellated adaptively, because
 * that makes the three sets point-for-point comparable: the deviation of a height from a face is
 * then the distance between corresponding points, which catches a twist that swings out and back —
 * something no single scalar like enclosed area would notice.
 */

import { curveAt, loftAt, toPolar, polarToXY } from "../core/curves.js";

const SAMPLES = 64;

/* One outline, in the frame's own millimetres, at a normalized height. */
export function outlineAt(curve, frame, loft, s, n = SAMPLES) {
  const m = loft ? loftAt(loft, s) : null;
  const out = [];
  for (let i = 0; i < n; i++) {
    const { u, v } = curveAt(curve, i / n * curve.spans);
    const { r, th } = toPolar(frame, u, v, m);
    out.push(polarToXY(r, th));
  }
  return out;
}

/* Distance from a point to a segment, which is the measure that makes this work.
 *
 * The question is not how far an interior section is from the two faces — it is whether it lies
 * *outside* them, because a reader can already interpolate between two drawn outlines. A monotone
 * taper, `scale: [1, 0.8]`, puts every interior section on the straight line between corresponding
 * face points; measuring to the nearer endpoint instead would report it as a third shape and clutter
 * the picture with a section the two faces already imply. Measuring to the segment reports it as
 * zero, and still catches the cases that matter: a bulge (where the segment degenerates to a point)
 * and a twist that swings out and comes back (where the section bows off the chord). */
function toSegment(p, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1], L2 = vx * vx + vy * vy;
  if (L2 < 1e-18) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p[0] - a[0] - t * vx, p[1] - a[1] - t * vy);
}

/* The heights to draw, as `{ s, kind }`. `face` is one of the two ends; `extreme` is an interior
 * height that lies outside both of them.
 *
 * `tolerance` is relative to the annulus the footprint spans, so the judgement is scale-free: a
 * section within 1 % of the radial span of what the two faces already imply is not a third shape.
 */
export function loftHeights(curve, frame, loft, { tolerance = 0.01, steps = 24 } = {}) {
  if (!curve) return [];
  if (!loft) return [{ s: 0, kind: "face" }];
  const faces = [outlineAt(curve, frame, loft, 0), outlineAt(curve, frame, loft, 1)];

  /* How far outside the pair a height gets: per sample point, its distance from the segment joining
   * the corresponding points of the two faces, and then the worst of those. A section that merely
   * sits between the two faces scores zero. */
  const deviation = s => {
    const P = outlineAt(curve, frame, loft, s);
    let worst = 0;
    for (let i = 0; i < P.length; i++) {
      const d = toSegment(P[i], faces[0][i], faces[1][i]);
      if (d > worst) worst = d;
    }
    return worst;
  };

  let at = null, best = 0;
  for (let i = 1; i < steps; i++) {
    const s = i / steps, d = deviation(s);
    if (d > best) { best = d; at = s; }
  }
  const out = [{ s: 0, kind: "face" }, { s: 1, kind: "face" }];
  if (at !== null && best > tolerance * Math.abs(frame.dr)) out.push({ s: at, kind: "extreme", deviation_mm: best });
  return out;
}
