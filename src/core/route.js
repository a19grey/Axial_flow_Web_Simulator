/* Routing a coil: from the outline somebody draws to the turns a fab can etch.
 *
 * A rotor pole is a shape. A coil is a *path*, and that is a harder object. The outline only says
 * where the copper may go; the winding is the spiral that fills it, and the spiral has to be found
 * rather than drawn. Until now the tool sidestepped this by only ever winding a wedge, where the
 * spiral is available in closed form — turn j is the wedge with `j * pitch` taken off every edge,
 * which the angular half-width absorbs as `half - inset/r`. That works and is exact, and it is why
 * `shapeOutline` still owns the wedge path. It also cannot wind anything a pair of angles cannot
 * draw, which is the whole of the restriction this module exists to lift.
 *
 * The general problem is the inward offset of a closed curve, and the reason it is not a loop over
 * vertices is that an inward offset changes topology. Push a curve in far enough and concave
 * regions collide: the offset self-intersects, then pinches, then splits into two loops, then
 * vanishes. A vertex-by-vertex offset draws all of that as a tangle and reports nothing. So the
 * offsets are taken from a **distance field** instead:
 *
 *     d(x) = the distance from x to the outline, positive inside
 *
 * and turn j is the level set d = edge + j*pitch, extracted by marching squares. Every property
 * this needs falls out of that choice rather than having to be enforced:
 *
 *   - **The turns cannot touch.** Two level sets of a distance function at levels a and b are at
 *     least |a - b| apart, everywhere. Trace-to-trace clearance is therefore `pitch - width` by
 *     construction, not by a check that might miss the one place the outline turns sharply.
 *   - **A pinch reports itself.** When the level set stops being one loop, marching squares returns
 *     two loops — or none — and routing stops there with a reason. A turn that has split in two is
 *     not a turn; it is a short circuit drawn in good faith.
 *   - **There is a well-defined bottom.** max d over the interior is the radius of the largest
 *     circle the outline contains, which is exactly how deep the winding can go. That number is
 *     what makes a *fill fraction* meaningful: "wind 60 % of the way in" is a statement about this
 *     shape rather than a turn count borrowed from a different one.
 *
 * The field is interpolated, not just sampled, and that is what keeps the grid cheap. |grad d| = 1
 * almost everywhere, so d is very nearly linear between nodes and a bilinear crossing lands within
 * about h^2/(8R) of the true offset, R being the local radius of curvature — micron-scale at the
 * resolutions used here. The exception is the medial axis, where d has a crease; that is also
 * exactly where the offset legitimately has a corner, so the error there is a rounded corner rather
 * than a wrong path.
 *
 * Lengths are millimetres throughout.
 */

export const ROUTE_DEFAULTS = {
  /* Grid pitch, and the cap that stops a pathological outline from asking for a gigabyte.
   *
   * A quarter of a trace pitch, which is finer than the level sets need — consecutive turns are a
   * whole pitch apart — and is set by the corners instead. The distance field has a crease along
   * the medial axis, so a sharp convex corner of the outline comes out chamfered by about a cell,
   * and the chamfer is what a routed turn's *perimeter*, and therefore its resistance, is most
   * sensitive to. Measured against the closed-form wedge inset, the worst perimeter error falls
   * from 0.36 % at half a pitch to 0.14 % at a quarter, for about ten milliseconds a design.
   * Below that it stops improving: the remainder is the decimation, not the grid.
   */
  cellsPerPitch: 4,
  maxCells: 250000,
  /* How far a routed turn may sit off the true level set once decimated.
   *
   * Deliberately a different knob from the outline's own chordTolerance_mm, and deliberately looser.
   * That one controls how finely a *shape* is rasterized, which is cheap; this one sets how many
   * segments each turn hands to Biot-Savart, which is the dominant per-design cost and is paid
   * once per turn per coil per layer. 0.02 mm is a sixteenth of a default trace width, so it is far
   * below anything the field can tell apart, and it keeps a turn at a few dozen segments rather
   * than a few hundred.
   */
  tolerance_mm: 0.02,
  maxTurns: 200
};

/* ---- polygon arithmetic ------------------------------------------------------------------------ */

export function polygonArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return 0.5 * a;
}

export function polygonPerimeter(pts) {
  let L = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    L += Math.hypot(q[0] - p[0], q[1] - p[1]);
  }
  return L;
}

/* Douglas-Peucker on a closed loop.
 *
 * Marching squares emits one vertex per grid edge the contour crosses, which is far more than the
 * shape needs and which Biot-Savart pays for linearly. The loop is cut at its two most distant
 * vertices so the decimation has two open chains with fixed ends rather than a ring with no
 * canonical start — a ring decimated from an arbitrary start point is not reproducible, and this
 * geometry has to hash the same way twice.
 */
export function simplifyClosed(pts, tol) {
  const n = pts.length;
  if (n < 4 || !(tol > 0)) return pts.slice();
  let iFar = 0, dFar = -1;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]);
    if (d > dFar) { dFar = d; iFar = i; }
  }
  const a = pts.slice(0, iFar + 1);
  const b = pts.slice(iFar).concat([pts[0]]);
  const out = simplifyOpen(a, tol);
  out.pop();
  const back = simplifyOpen(b, tol);
  back.pop();
  return out.concat(back);
}

function simplifyOpen(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    if (i1 <= i0 + 1) continue;
    const a = pts[i0], b = pts[i1];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
    let worst = -1, iw = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const p = pts[i];
      const d = len > 1e-12
        ? Math.abs(dy * (p[0] - a[0]) - dx * (p[1] - a[1])) / len
        : Math.hypot(p[0] - a[0], p[1] - a[1]);
      if (d > worst) { worst = d; iw = i; }
    }
    if (worst > tol) { keep[iw] = 1; stack.push([i0, iw], [iw, i1]); }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

/* ---- the distance field ------------------------------------------------------------------------ */

/* Signed distance to a closed polygon on a regular grid, positive inside.
 *
 * Brute force over segments, and deliberately so: the outline is decimated to the grid's own
 * resolution first, which leaves a few dozen segments, and the point-in-polygon test rides along in
 * the same loop rather than being a second pass. An acceleration structure would save time the
 * profile says is not being spent.
 */
export function distanceField(outline, { cell_mm, maxCells = ROUTE_DEFAULTS.maxCells } = {}) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of outline) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y);
    x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  const w = x1 - x0, hgt = y1 - y0;
  if (!(w > 0 && hgt > 0)) throw new Error("the outline has no area to route in");

  let h = Math.max(1e-4, +cell_mm);
  // A margin of two cells so the field is negative all the way round the outline and no level set
  // runs off the edge of the grid, which would chain into an open polyline.
  const fit = () => ({ nx: Math.ceil(w / h) + 5, ny: Math.ceil(hgt / h) + 5 });
  let { nx, ny } = fit();
  if (nx * ny > maxCells) { h *= Math.sqrt(nx * ny / maxCells); ({ nx, ny } = fit()); }

  const ox = x0 - 2 * h, oy = y0 - 2 * h;
  /* Decimating the outline before measuring distances to it is a speed knob with a bias attached:
   * a decimated polygon is inscribed in the original, so every distance — and with it the depth
   * the fill fraction is a fraction *of* — comes out short by the chord sagitta. The tolerance is
   * therefore tied to the accuracy wanted rather than to the grid, and only loosened if an outline
   * arrives with far more points than the field can use. A circle at 0.02 h keeps its radius to
   * about a part in ten thousand; at 0.25 h it lost more than a percent, which is what this
   * comment is standing in for.
   */
  let tol = 0.02 * h, seg = simplifyClosed(outline, tol);
  while (seg.length > 400 && tol < 0.25 * h) { tol *= 2; seg = simplifyClosed(outline, tol); }
  const m = seg.length;
  const d = new Float32Array(nx * ny);

  for (let j = 0; j < ny; j++) {
    const py = oy + j * h;
    for (let i = 0; i < nx; i++) {
      const px = ox + i * h;
      let best = Infinity, inside = false;
      for (let k = 0; k < m; k++) {
        const a = seg[k], b = seg[(k + 1) % m];
        const ex = b[0] - a[0], ey = b[1] - a[1];
        const vx = px - a[0], vy = py - a[1];
        const ee = ex * ex + ey * ey;
        let t = ee > 0 ? (vx * ex + vy * ey) / ee : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = vx - t * ex, qy = vy - t * ey;
        const dd = qx * qx + qy * qy;
        if (dd < best) best = dd;
        // Crossing number, counted on the half-open interval so a vertex is counted once.
        if ((a[1] > py) !== (b[1] > py) && px < a[0] + (py - a[1]) * ex / ey) inside = !inside;
      }
      d[j * nx + i] = (inside ? 1 : -1) * Math.sqrt(best);
    }
  }
  return { x0: ox, y0: oy, h, nx, ny, d };
}

/* The deepest point of the field: the radius of the largest circle the outline contains, which is
 * how far in a winding can be laid.
 *
 * The grid maximum underestimates the true one by up to about h, which would bias a fill fraction
 * systematically. A parabola through the best node and its two neighbours in each axis removes most
 * of that bias for the cost of six array reads — worth doing, because this number is a denominator.
 */
export function fieldDepth(F) {
  const { nx, ny, d, h } = F;
  let best = -Infinity, bi = 0, bj = 0;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const v = d[j * nx + i];
    if (v > best) { best = v; bi = i; bj = j; }
  }
  if (!(best > 0)) return { depth_mm: 0, at: null };
  const peak = (m, c, p) => {
    const den = m - 2 * c + p;
    if (!(Math.abs(den) > 1e-12)) return 0;
    const t = 0.5 * (m - p) / den;
    return Math.abs(t) <= 1 ? t : 0;
  };
  const at = (i, j) => d[j * nx + i];
  const tx = bi > 0 && bi < nx - 1 ? peak(at(bi - 1, bj), best, at(bi + 1, bj)) : 0;
  const ty = bj > 0 && bj < ny - 1 ? peak(at(bi, bj - 1), best, at(bi, bj + 1)) : 0;
  const gain = 0.25 * (
    (bi > 0 && bi < nx - 1 ? (at(bi + 1, bj) - at(bi - 1, bj)) * tx : 0) +
    (bj > 0 && bj < ny - 1 ? (at(bi, bj + 1) - at(bi, bj - 1)) * ty : 0));
  return { depth_mm: best + gain, at: [F.x0 + (bi + tx) * h, F.y0 + (bj + ty) * h] };
}

/* ---- level sets ------------------------------------------------------------------------------- */

/* Marching squares at `level`, returned as closed loops wound so that the region d > level is on
 * the left — the same orientation `shapeOutline` produces, so a routed turn and a wedge turn carry
 * their current the same way round.
 *
 * Crossings are identified by the grid edge they lie on rather than by their coordinates. Two cells
 * sharing an edge compute the same crossing from the same two corner values, so the coordinates
 * would in fact match to the last bit; keying on the edge says that in the code instead of relying
 * on a reader to notice it, and it makes the chaining a lookup rather than a search.
 */
export function levelLoops(F, level) {
  const { nx, ny, d } = F;
  const next = new Map();          // start edge -> end edge
  const key = (axis, i, j) => axis * nx * ny + j * nx + i;   // 0 horizontal, 1 vertical
  const add = (s, e) => { const a = next.get(s); if (a === undefined) next.set(s, e); else next.set(s, a); };

  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const v0 = d[j * nx + i], v1 = d[j * nx + i + 1], v2 = d[(j + 1) * nx + i + 1], v3 = d[(j + 1) * nx + i];
    let c = 0;
    if (v0 > level) c |= 1;
    if (v1 > level) c |= 2;
    if (v2 > level) c |= 4;
    if (v3 > level) c |= 8;
    if (c === 0 || c === 15) continue;
    const B = key(0, i, j), T = key(0, i, j + 1), L = key(1, i, j), R = key(1, i + 1, j);
    switch (c) {
      case 1:  add(B, L); break;
      case 2:  add(R, B); break;
      case 3:  add(R, L); break;
      case 4:  add(T, R); break;
      case 6:  add(T, B); break;
      case 7:  add(T, L); break;
      case 8:  add(L, T); break;
      case 9:  add(B, T); break;
      case 11: add(R, T); break;
      case 12: add(L, R); break;
      case 13: add(B, R); break;
      case 14: add(L, B); break;
      /* The two ambiguous cells. The centre value decides whether the diagonal corners are one
       * region pinched at the middle or two islands, which is the same question the router is
       * asking at a larger scale and deserves the same answer rather than a fixed convention. */
      case 5:
        if (0.25 * (v0 + v1 + v2 + v3) > level) { add(B, R); add(T, L); }
        else { add(B, L); add(T, R); }
        break;
      case 10:
        if (0.25 * (v0 + v1 + v2 + v3) > level) { add(L, B); add(R, T); }
        else { add(R, B); add(L, T); }
        break;
    }
  }
  if (!next.size) return [];

  const point = k => {
    const axis = Math.floor(k / (nx * ny)), rest = k - axis * nx * ny;
    const j = Math.floor(rest / nx), i = rest - j * nx;
    const a = d[j * nx + i];
    const b = axis === 0 ? d[j * nx + i + 1] : d[(j + 1) * nx + i];
    const t = Math.abs(b - a) > 1e-30 ? (level - a) / (b - a) : 0.5;
    return axis === 0
      ? [F.x0 + (i + t) * F.h, F.y0 + j * F.h]
      : [F.x0 + i * F.h, F.y0 + (j + t) * F.h];
  };

  const loops = [], seen = new Set();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const pts = [];
    let e = start;
    while (e !== undefined && !seen.has(e)) {
      seen.add(e);
      pts.push(point(e));
      e = next.get(e);
    }
    // A chain that does not return to its start left the grid, which the two-cell margin is there
    // to prevent; dropping it is safer than closing it with a chord across the outline.
    if (e === start && pts.length >= 3) loops.push(pts);
  }
  return loops;
}

/* ---- the winding ------------------------------------------------------------------------------ */

/* Lay concentric turns inside one outline, from the outside in.
 *
 * Turn j is the level set at `edgeMargin + j * tracePitch`, and routing stops at the first of four
 * honest ends: the fill fraction is reached, the outline has no more room, the level set splits, or
 * the turn cap is hit. Which one it was is returned, because "eleven turns" means something quite
 * different depending on which of those stopped it.
 *
 * `fillFraction` is a fraction of the depth the outline actually has, so the same number means the
 * same thing on a shape the optimizer has just invented as on the one it started from — which is
 * the property that makes it a design variable rather than a turn count in disguise. Winding all
 * the way in is rarely right: the innermost turns are short on flux linkage and long on resistance,
 * and where that trade turns over is a question about the design, not a constant.
 */
export function routeTurns(outline, {
  edgeMargin_mm = 0, tracePitch_mm, fillFraction = 1,
  maxTurns = ROUTE_DEFAULTS.maxTurns, cell_mm = null,
  tolerance_mm = ROUTE_DEFAULTS.tolerance_mm, maxCells = ROUTE_DEFAULTS.maxCells
} = {}) {
  const pitch = +tracePitch_mm;
  if (!(pitch > 0)) throw new Error("routeTurns needs a positive trace pitch");
  const h = cell_mm != null ? +cell_mm : pitch / ROUTE_DEFAULTS.cellsPerPitch;

  const F = distanceField(outline, { cell_mm: h, maxCells });
  const { depth_mm } = fieldDepth(F);
  const fill = Math.min(1, Math.max(0, +fillFraction));
  const target = fill * depth_mm;

  const turns = [], insets = [];
  let stopped = "fill";
  const cap = Math.max(0, Math.round(maxTurns));
  for (let j = 0; ; j++) {
    if (j >= cap) { stopped = "cap"; break; }
    const inset = edgeMargin_mm + j * pitch;
    if (inset > target + 1e-9) { stopped = turns.length ? "fill" : "depth"; break; }
    const loops = levelLoops(F, inset).filter(L => Math.abs(polygonArea(L)) > 1e-6);
    if (loops.length === 0) { stopped = "depth"; break; }
    if (loops.length > 1) { stopped = "split"; break; }
    let pts = simplifyClosed(loops[0], tolerance_mm);
    if (pts.length < 3) { stopped = "depth"; break; }
    if (polygonArea(pts) < 0) pts.reverse();
    turns.push(pts);
    insets.push(inset);
  }

  return {
    turns, insets_mm: insets, depth_mm, fillFraction: fill,
    filled_mm: insets.length ? insets[insets.length - 1] : 0,
    stopped,
    grid: { cell_mm: F.h, nx: F.nx, ny: F.ny }
  };
}

/* How deep an *analytic* inset can go before the outline it is taken from closes up.
 *
 * The wedge path does not need a distance field — its offsets are closed form — but it does need
 * the same denominator, or a fill fraction would mean one thing on a traced coil and another on a
 * wedge. `exists(d)` is monotone in d (both the radial span and the angular half-width shrink with
 * the inset), so a bisection is exact to its tolerance rather than a search that might miss.
 */
export function insetDepth(exists, { hi = 1e4, tol = 1e-6 } = {}) {
  if (!exists(0)) return 0;
  let lo = 0, up = 1;
  while (up < hi && exists(up)) up *= 2;
  if (up >= hi) return hi;
  while (up - lo > tol) { const mid = 0.5 * (lo + up); if (exists(mid)) lo = mid; else up = mid; }
  return lo;
}
