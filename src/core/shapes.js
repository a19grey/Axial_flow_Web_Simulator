/* Angular shape profiles: what a repeated feature looks like as a function of radius.
 *
 * Every repeated feature in an axial-flux machine — a rotor pole, a coil, a tooth — is a wedge
 * that repeats `count` times around the axis. The tool used to describe such a wedge with two
 * numbers, a width fraction and a linear skew, which can only draw a straight-sided trapezoid.
 * That is not enough for either of the shapes this machine class actually uses: a YASA-style coil
 * whose inner edge is swung round from its outer edge, or a 3D-printed rotor pole with a
 * comma-shaped footprint.
 *
 * A profile is the general version and the old two numbers are a special case of it. It is a
 * small table, read at normalized radius u = (r - r0) / (r1 - r0):
 *
 *     [{ atRadius: 0, widthFraction: 0.30, offset_deg: 16 },      inner end: narrow, swung +16 deg
 *      { atRadius: 1, widthFraction: 0.78, offset_deg: -3 }]      outer end: broad, swung back
 *
 * `widthFraction` is the fraction of the feature's *pitch* (2*pi/count) that the wedge occupies,
 * so 1.0 means neighbouring wedges touch. `offset_deg` swings the wedge's centre line away from
 * its nominal angle. Values between table rows are interpolated linearly, and the ends are held
 * flat outside the table, so a two-row table is a straight-sided trapezoid and a one-row table is
 * a plain arc.
 *
 * Two properties matter downstream and are why this lives in its own module:
 *
 *   - half(u) and centre(u) are cheap and pure, so the rasterizers can call them per cell (exactly,
 *     in cylindrical coordinates) without allocating anything;
 *   - the area a profile sweeps is available in closed form, so the volume a region *should*
 *     occupy can be compared against the volume the rasterizer actually laid down. With
 *     straight-sided arcs that check was nearly trivial; with free-form profiles it is the main
 *     defence against a shape that draws convincingly and rasterizes wrongly.
 *
 * Angles are radians throughout this module. The _deg suffix appears only in the spec.
 */

export const DEG = Math.PI / 180;

/* Turn a spec-level shape into the internal form: a sorted table of {u, half, off} in radians,
 * plus the flag that says whether it varies with radius at all. `constant` is not an optimization
 * detail — a profile that does not vary is rasterized by a one-dimensional angular table, which
 * is both faster and bit-for-bit what the tool produced before profiles existed.
 *
 *   count      how many copies of the wedge go round the machine
 *   fraction   width fraction, used when there is no profile
 *   skew       linear swing of the centre line, inner to outer, in radians; added to any profile
 *   profile    the table, as spec rows
 */
export function resolveShape({ count, fraction = 1, skew = 0, profile = null }) {
  const pitch = 2 * Math.PI / Math.max(1, count);
  const rows = normalizeProfile(profile);
  let pts;
  if (!rows) {
    const half = 0.5 * fraction * pitch;
    pts = skew ? [{ u: 0, half, off: -0.5 * skew }, { u: 1, half, off: 0.5 * skew }]
               : [{ u: 0, half, off: 0 }];
  } else {
    pts = rows.map(r => ({ u: r.atRadius, half: 0.5 * r.widthFraction * pitch,
                           off: r.offset_deg * DEG + skew * (r.atRadius - 0.5) }));
  }
  const constant = pts.every(q => q.half === pts[0].half && q.off === pts[0].off);
  return { count, pitch, pts, constant };
}

/* Spec rows, cleaned up: finite numbers only, clamped into range, sorted by radius, with rows at
 * the same radius collapsed. Returns null for anything that is not a usable table, which every
 * caller reads as "no profile, use the width fraction". */
function normalizeProfile(profile) {
  const list = Array.isArray(profile) ? profile : Array.isArray(profile?.profile) ? profile.profile : null;
  if (!list) return null;
  const rows = [];
  for (const r of list) {
    const u = +(r?.atRadius), w = +(r?.widthFraction), o = +(r?.offset_deg ?? 0);
    if (!Number.isFinite(u) || !Number.isFinite(w) || !Number.isFinite(o)) continue;
    rows.push({ atRadius: Math.min(1, Math.max(0, u)), widthFraction: Math.max(0, w), offset_deg: o });
  }
  if (!rows.length) return null;
  rows.sort((a, b) => a.atRadius - b.atRadius);
  const out = [rows[0]];
  for (const r of rows.slice(1)) if (r.atRadius - out[out.length - 1].atRadius > 1e-9) out.push(r);
  return out;
}

/* Half-width and centre offset at normalized radius u, both radians. Flat outside the table. */
export function shapeAt(shape, u) {
  const p = shape.pts, n = p.length;
  if (n === 1 || u <= p[0].u) return { half: p[0].half, off: p[0].off };
  if (u >= p[n - 1].u) return { half: p[n - 1].half, off: p[n - 1].off };
  let i = 1;
  while (i < n - 1 && u > p[i].u) i++;
  const a = p[i - 1], b = p[i], t = (u - a.u) / (b.u - a.u);
  return { half: a.half + t * (b.half - a.half), off: a.off + t * (b.off - a.off) };
}

export const shapeMaxHalf = shape => shape.pts.reduce((m, q) => Math.max(m, q.half), 0);
export const shapeMinHalf = shape => shape.pts.reduce((m, q) => Math.min(m, q.half), Infinity);

/* The fraction of the annulus r0..r1 that all `count` copies of the wedge cover.
 *
 * The swept area is count * integral of 2*half(r) * r dr. half is piecewise linear in u and r is
 * linear in u, so the integrand is piecewise quadratic and Simpson's rule is exact on each piece,
 * not an approximation. Offsets move a wedge without resizing it, so they do not appear.
 *
 * Returns the same number the old `min(1, fraction)` did for a plain arc, so the volume of an
 * unprofiled region is unchanged to the last bit.
 */
export function shapeAreaFraction(shape, r0, r1) {
  const p = shape.pts, dr = r1 - r0;
  const annulus = 0.5 * (r1 * r1 - r0 * r0);
  if (!(annulus > 0)) return 0;
  // A wedge of constant width covers the same fraction of every ring, which is worth taking
  // directly: it is the old formula, to the last bit, for every design that predates profiles.
  if (shape.constant) return Math.min(1, shape.count * shape.pts[0].half / Math.PI);
  const f = u => { const { half } = shapeAt(shape, u); return Math.min(half, 0.5 * shape.pitch) * (r0 + u * dr) * dr; };
  // Integrate over [0, 1], breaking at every table row so no piece spans a kink in half(u).
  const knots = [0, ...p.map(q => q.u).filter(u => u > 0 && u < 1), 1];
  let I = 0;
  for (let i = 0; i < knots.length - 1; i++) {
    const a = knots[i], b = knots[i + 1];
    if (b - a < 1e-15) continue;
    I += (b - a) / 6 * (f(a) + 4 * f(0.5 * (a + b)) + f(b));
  }
  return Math.min(1, shape.count * I / (Math.PI * annulus));
}

/* The outline of one wedge as a closed polygon in the plane, millimetres.
 *
 * Used for the coil turns the Biot-Savart shader integrates and for the rotor surface the 3D view
 * and the STL export draw, so a shape can never look like one thing and solve as another.
 *
 *   centre    nominal angle of this copy, radians
 *   inset     radial clearance taken off every edge, mm — how a coil's turns nest inside each other
 *   sideSegs  samples along each radial side. 1 draws the side as a straight chord, which is what
 *             a straight-sided trapezoidal turn is; more samples follow a curving profile.
 *   arcSegs   samples along the inner and outer arcs.
 *
 * Returns null when the inset has eaten the wedge, which is how a turn count that does not fit the
 * available copper reports itself.
 */
export function shapeOutline(shape, { r0, r1, centre = 0, inset = 0, sideSegs = 1, arcSegs = 10, minHalf = 0.02, minSpan = 1 }) {
  const dr = r1 - r0;
  if (!(dr >= minSpan)) return null;
  const at = u => {
    const r = r0 + u * dr, { half, off } = shapeAt(shape, u);
    return { r, c: centre + off, h: half - inset / r };
  };
  const inner = at(0), outer = at(1);
  if (inner.h < minHalf || outer.h < minHalf) return null;
  const P = (r, a) => [r * Math.cos(a), r * Math.sin(a)];
  const pts = [];
  // One lap: out along the trailing side, round the outer arc, back down the leading side, and
  // round the inner arc. Shared corners are emitted once, by the arcs.
  for (let s = 0; s < sideSegs; s++) { const q = at(s / sideSegs); pts.push(P(q.r, q.c - q.h)); }
  for (let s = 0; s <= arcSegs; s++) pts.push(P(outer.r, outer.c - outer.h + 2 * outer.h * s / arcSegs));
  for (let s = sideSegs - 1; s >= 1; s--) { const q = at(s / sideSegs); pts.push(P(q.r, q.c + q.h)); }
  for (let s = 0; s <= arcSegs; s++) pts.push(P(inner.r, inner.c + inner.h - 2 * inner.h * s / arcSegs));
  return pts;
}

/* Do neighbouring copies of a wedge run into each other?
 *
 * Two adjacent copies are the same profile a pitch apart, so at every radius the clearance between
 * them is pitch - 2*half(u): the offsets cancel and only the width can close the gap. A profile
 * wider than the pitch is a short circuit between coils or a rotor with no gap between poles, and
 * the caller reports it rather than quietly meshing it.
 *
 * Note what this deliberately does *not* flag: a wedge whose centre line swings by more than its
 * own width still has clearance at every radius, and is exactly the YASA-style overlap a straight
 * radial line crosses two of. Overlap seen along a radius is a feature; overlap at a radius is a
 * fault.
 */
export function shapeClearance(shape) {
  const worst = shapeMaxHalf(shape);
  return { gap: shape.pitch - 2 * worst, overlaps: 2 * worst > shape.pitch + 1e-12 };
}

/* How far the centre line swings from end to end, radians. Reported so a design that relies on the
 * radial overlap can show that it has it. */
export function shapeSwing(shape) {
  let lo = Infinity, hi = -Infinity;
  for (const q of shape.pts) { lo = Math.min(lo, q.off); hi = Math.max(hi, q.off); }
  return hi - lo;
}
