/* Drawing points from the design box.
 *
 * Two samplers, for two different jobs. Latin hypercube for a fixed budget decided in advance: it
 * guarantees every variable's range is covered evenly, which is what a scan of a 10-to-30
 * dimensional space most needs, and in high dimension it beats a low-discrepancy sequence at the
 * one thing that actually matters here — the one-dimensional marginals, because those are what a
 * sensitivity screen reads. Halton for a stream that can be stopped at any point and is still
 * well-spread, which is what an overnight run wants when the budget is "until morning".
 *
 * Both are seeded and deterministic. That is not a nicety: the resumable-run design depends on it.
 * A run that is interrupted and restarted replays the same sequence, finds every point it already
 * evaluated in the cache, and carries on — no optimizer state has to be checkpointed, because the
 * algorithm plus the seed *is* the state.
 */

/* Small, fast, well-tested integer-state PRNG. Seeded by value, so the same seed gives the same
 * stream on every machine and in every browser. */
export function rng(seed = 1) {
  let a = (seed >>> 0) || 1;
  return function () {
    a += 0x6d2b79f5; a >>>= 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const scaleTo = (u, bounds) => u.map((v, i) => bounds[i][0] + v * (bounds[i][1] - bounds[i][0]));

/* ---- Latin hypercube ---------------------------------------------------------------------------- */

/* n points, each variable's range cut into n strata with exactly one point per stratum, the strata
 * shuffled independently per variable. Centre-of-stratum placement is available because a jittered
 * hypercube's jitter is itself a source of run-to-run difference that has nothing to do with the
 * design. */
export function latinHypercube(n, bounds, { seed = 1, jitter = true } = {}) {
  const R = rng(seed), d = bounds.length, out = [];
  const cols = [];
  for (let j = 0; j < d; j++) {
    const idx = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) { const k = Math.floor(R() * (i + 1)); [idx[i], idx[k]] = [idx[k], idx[i]]; }
    cols.push(idx);
  }
  for (let i = 0; i < n; i++) {
    const u = [];
    for (let j = 0; j < d; j++) u.push((cols[j][i] + (jitter ? R() : 0.5)) / n);
    out.push(scaleTo(u, bounds));
  }
  return out;
}

/* ---- Halton ------------------------------------------------------------------------------------- */

const PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79,
  83, 89, 97, 101, 103, 107, 109, 113, 127, 131, 137, 139, 149, 151, 157, 163, 167, 173, 179, 181,
  191, 193, 197, 199, 211, 223, 227, 229, 233, 239, 241, 251, 257, 263, 269, 271, 277, 281, 283,
  293, 307, 311];

function radicalInverse(i, base, perm) {
  let f = 1 / base, r = 0, n = i;
  while (n > 0) {
    const digit = n % base;
    r += (perm ? perm[digit] : digit) * f;
    n = Math.floor(n / base);
    f /= base;
  }
  return r;
}

/* Halton with a random digit scramble per dimension. Unscrambled Halton correlates badly between
 * high dimensions — the classic failure where dimensions 30 and 31 lie on a visible lattice — and
 * the scramble is what makes it usable past a handful of variables. */
export function haltonStream(bounds, { seed = 1, skip = 64 } = {}) {
  const R = rng(seed), d = bounds.length;
  if (d > PRIMES.length) throw new Error(`Halton sampling is wired for up to ${PRIMES.length} variables, asked for ${d}`);
  const perms = PRIMES.slice(0, d).map(b => {
    const p = Array.from({ length: b }, (_, i) => i);
    for (let i = b - 1; i > 0; i--) { const k = Math.floor(R() * (i + 1)); [p[i], p[k]] = [p[k], p[i]]; }
    // Keep 0 at 0 so the sequence still starts in the interior rather than on a face.
    const z = p.indexOf(0); [p[0], p[z]] = [p[z], p[0]];
    return p;
  });
  let i = skip;
  return () => {
    const u = [];
    for (let j = 0; j < d; j++) u.push(radicalInverse(i, PRIMES[j], perms[j]));
    i++;
    return scaleTo(u, bounds);
  };
}

/* ---- the screen ---------------------------------------------------------------------------------- */

/* One-at-a-time perturbation around a point: the cheapest thing that answers "which variables move
 * the score at all". 2N evaluations, and the output is not an optimum but a ranking — variables
 * whose effect is under the measured noise floor get dropped, with the measurement recorded. This is
 * the step that turns "the space is infinite" into a space of five to eight variables.
 */
export function screenPoints(x0, bounds, { fraction = 0.25 } = {}) {
  const pts = [];
  for (let i = 0; i < x0.length; i++) {
    const [lo, hi] = bounds[i], step = fraction * (hi - lo);
    for (const s of [-1, +1]) {
      const x = x0.slice();
      x[i] = Math.min(hi, Math.max(lo, x0[i] + s * step));
      if (x[i] !== x0[i]) pts.push({ index: i, direction: s, x });
    }
  }
  return pts;
}

/* Rank variables by the score swing their perturbation produced, against a noise floor. */
export function screenRanking(names, results, noiseFloor = 0) {
  const per = names.map((name, i) => ({ name, index: i, scores: [], swing: 0, failures: 0 }));
  for (const r of results) {
    const p = per[r.index];
    if (r.score === null || !Number.isFinite(r.score)) { p.failures++; continue; }
    p.scores.push(r.score);
  }
  for (const p of per) p.swing = p.scores.length >= 2 ? Math.max(...p.scores) - Math.min(...p.scores) : NaN;
  const ranked = per.slice().sort((a, b) => (b.swing || 0) - (a.swing || 0));
  return ranked.map(p => ({
    name: p.name, index: p.index,
    swing: Number.isFinite(p.swing) ? p.swing : null,
    infeasibleAt: p.failures,
    /* Above the noise floor the variable is worth searching; below it, any improvement the search
     * reports on this variable is the mesh talking. */
    matters: Number.isFinite(p.swing) ? p.swing > noiseFloor : null
  }));
}
