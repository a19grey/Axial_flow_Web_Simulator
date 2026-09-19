/* One-dimensional graded node placement.
 *
 * The problem this solves: a 370 mm machine with a 3 mm air gap needs ~0.4 mm cells through the gap
 * and can afford 8 mm cells 200 mm away in the far field. A uniform grid has to use the smallest
 * size everywhere, which is ~116 million cells for that machine — of which the overwhelming
 * majority sit in the bore, the box corners and empty air.
 *
 * The method:
 *
 *   1. A *size function* s(x): the target cell size at each point, the minimum over every
 *      constraint covering x, falling back to a far-field maximum.
 *
 *   2. *Lipschitz smoothing*: a mesh cannot jump from 0.4 mm to 8 mm in one step without wrecking
 *      the discretization, so s is limited to grow by at most a factor r per unit length. One
 *      forward and one backward sweep enforce |ds/dx| <= r - 1 everywhere, which is the standard
 *      gradient-limiting step in mesh generation.
 *
 *   3. *Node placement in size space*: let t(x) = integral of dx'/s(x'). Cells of the target size
 *      are exactly unit steps in t. Placing n nodes at equal intervals of t therefore follows the
 *      size function's shape, while landing exactly on both endpoints.
 *
 *   4. *Interface snapping*: material boundaries are supplied as hard points and step 3 runs
 *      separately on each interval between them, so every boundary is a mesh face rather than
 *      something smeared across a cell. This matters as much as the grading: a partially filled
 *      cell has its permeability blended, and an air gap thinner than a cell simply averages away.
 */

const SAMPLES = 4096;

/**
 * @param {number} a            domain start (mm)
 * @param {number} b            domain end (mm)
 * @param {Array}  constraints  [{ from, to, h }] target cell size h over [from, to]
 * @param {Array}  hard         coordinates that must land exactly on a node (material interfaces)
 * @param {number} hMax         far-field cell size, the target where no constraint applies
 * @param {number} growth       maximum ratio between neighbouring cell sizes, e.g. 1.2
 * @returns {Float64Array}      node coordinates, strictly increasing, starting at a and ending at b
 */
export function gradedAxis(a, b, constraints, hard, hMax, growth = 1.2) {
  if (!(b > a)) throw new Error("A graded axis needs b > a.");
  const g = Math.max(1.02, growth);

  /* ---- 1. sample the size function ---- */
  const dxs = (b - a) / (SAMPLES - 1);
  const s = new Float64Array(SAMPLES);
  for (let i = 0; i < SAMPLES; i++) {
    const x = a + i * dxs;
    let v = hMax;
    for (const c of constraints) {
      if (!(c.h > 0)) continue;
      // Constraints apply a little beyond their own span so the fine region does not start
      // coarsening the instant it crosses the boundary.
      if (x >= c.from - c.h && x <= c.to + c.h) v = Math.min(v, c.h);
    }
    s[i] = Math.max(v, 1e-6);
  }

  /* ---- 2. gradient limiting ----
   * The limit is on the ratio between neighbouring *cells*, not an absolute slope: over a sample
   * step of dxs there are dxs/s cells, so the size may grow by at most g^(dxs/s). One sweep each
   * way makes the constraint hold in both directions. */
  for (let i = 1; i < SAMPLES; i++) s[i] = Math.min(s[i], s[i - 1] * Math.pow(g, dxs / s[i - 1]));
  for (let i = SAMPLES - 2; i >= 0; i--) s[i] = Math.min(s[i], s[i + 1] * Math.pow(g, dxs / s[i + 1]));

  /* ---- 3. cumulative size-space coordinate t(x) ---- */
  const t = new Float64Array(SAMPLES);
  for (let i = 1; i < SAMPLES; i++) t[i] = t[i - 1] + dxs * 0.5 * (1 / s[i - 1] + 1 / s[i]);

  const tAt = x => {
    const u = (x - a) / dxs;
    if (u <= 0) return t[0];
    if (u >= SAMPLES - 1) return t[SAMPLES - 1];
    const i = Math.floor(u), f = u - i;
    return t[i] * (1 - f) + t[i + 1] * f;
  };
  // Invert t by binary search on the monotone table, then interpolate.
  const xAt = tv => {
    if (tv <= t[0]) return a;
    if (tv >= t[SAMPLES - 1]) return b;
    let lo = 0, hi = SAMPLES - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t[mid] <= tv) lo = mid; else hi = mid; }
    const span = t[hi] - t[lo];
    const f = span > 0 ? (tv - t[lo]) / span : 0;
    return a + (lo + f) * dxs;
  };

  /* ---- 4. place nodes, interval by interval between the hard points ---- */
  const pts = [...new Set([a, b, ...hard.filter(h => h > a + 1e-9 && h < b - 1e-9)])].sort((p, q) => p - q);
  const nodes = [pts[0]];
  for (let k = 0; k < pts.length - 1; k++) {
    const p = pts[k], q = pts[k + 1];
    const n = Math.max(1, Math.round(tAt(q) - tAt(p)));
    const t0 = tAt(p), t1 = tAt(q);
    for (let i = 1; i < n; i++) nodes.push(xAt(t0 + (t1 - t0) * i / n));
    nodes.push(q);
  }

  const out = Float64Array.from(nodes);
  // Node placement goes through two interpolations, so nudge any pair that came out non-increasing
  // rather than handing the mesh builder something it will reject.
  for (let i = 1; i < out.length; i++) if (!(out[i] > out[i - 1])) out[i] = out[i - 1] + 1e-9;
  return out;
}

/* A symmetric axis: grade the half-axis and mirror it, so the mesh has the same symmetry the
 * machine does and a rotor angle of zero is not biased by the grid. */
export function symmetricAxis(halfWidth, constraints, hard, hMax, growth) {
  const half = gradedAxis(0, halfWidth, constraints.map(c => ({ ...c, from: Math.max(0, c.from), to: Math.abs(c.to) })),
                          hard.filter(h => h > 0), hMax, growth);
  const out = new Float64Array(2 * half.length - 1);
  const n = half.length;
  for (let i = 0; i < n; i++) { out[n - 1 + i] = half[i]; out[n - 1 - i] = -half[i]; }
  return out;
}

/* A uniform axis, expressed through the same interface. */
export function uniformAxis(a, b, n) {
  const e = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) e[i] = a + (b - a) * i / n;
  return e;
}
