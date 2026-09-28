/* Three derivative-free searches behind one interface, so which one wins is measured on this
 * problem rather than asserted from the literature.
 *
 * Every one of them is a maximizer over a box, takes a seeded RNG, and is deterministic given its
 * seed. Determinism is load-bearing: a run that is interrupted and restarted replays the same
 * sequence of points, finds them in the on-disk cache, and carries on without any optimizer state
 * having been checkpointed. The algorithm plus the seed *is* the checkpoint.
 *
 *   pattern  compass / generalized pattern search. Cheap, robust, needs no tuning, and provably
 *            converges on a smooth function. It also dies above roughly ten dimensions: its cost per
 *            improvement is linear in the dimension and it has no way to learn that the shape's
 *            variables are correlated, which they overwhelmingly are. The low rungs of the ladder.
 *
 *   cmaes    the algorithm for a thirty-to-sixty dimensional shape vector. Derivative-free,
 *            invariant to rotations of the space — so a correlated shape basis costs it nothing —
 *            and it adapts its own step length, which matters here because the measured noise floor
 *            sets a hard lower bound on a step that means anything.
 *
 *   de       differential evolution. Kept because it is the one of the three that copes best with a
 *            genuinely multimodal landscape, and the scan stage exists precisely because we do not
 *            yet know whether this landscape is one.
 *
 * `evaluate(x)` returns `{ score }`, where `score` is null for an infeasible design. Infeasible is
 * not "very bad": a large negative number would distort a step size and pull a population towards a
 * wall. It is excluded from selection and recorded, and nothing else.
 */

import { rng, latinHypercube } from "./sample.js";

const clampTo = (x, bounds) => x.map((v, i) => Math.min(bounds[i][1], Math.max(bounds[i][0], v)));
const better = (a, b) => a !== null && (b === null || a > b);

/* A budget that can run out mid-poll, and a wall clock that can too. Both are checked by every
 * searcher between evaluations rather than between iterations, because an iteration of CMA-ES at 60
 * dimensions is a dozen designs and an overnight run should stop when it is out of time, not when it
 * next happens to finish a generation. */
function budgetGuard({ budget = Infinity, deadline = Infinity, signal = null }) {
  let used = 0;
  return {
    get used() { return used; },
    spend() { used++; },
    get exhausted() {
      return used >= budget || Date.now() >= deadline || !!signal?.aborted;
    },
    reason() {
      if (signal?.aborted) return "aborted";
      if (Date.now() >= deadline) return "deadline";
      if (used >= budget) return "budget";
      return null;
    }
  };
}

/* ---- pattern search ------------------------------------------------------------------------------ */

/* Compass search with opportunistic polling: poll the 2N axis directions at the current step, move
 * to the first improvement found rather than the best (which is cheaper per improvement and, on a
 * noisy objective, no worse), expand the step after a success and halve it after a failed poll.
 *
 * `stepMin` should be set from the measured noise floor. Below it the poll is comparing two
 * evaluations of the same design through a different mesh, and the search will happily chase that
 * forever. */
export async function patternSearch({ x0, bounds, evaluate, step = 0.25, stepMin = 0.01, expand = 2, contract = 0.5, ...rest }) {
  const g = budgetGuard(rest);
  const n = x0.length;
  const span = bounds.map(([lo, hi]) => hi - lo);
  let x = clampTo(x0.slice(), bounds), h = step;
  let fx = null;
  const history = [];

  const probe = async (point, tag) => {
    g.spend();
    const r = await evaluate(point, tag);
    history.push({ x: point, score: r.score, tag });
    return r.score;
  };

  fx = await probe(x, { stage: "pattern", event: "start" });

  let polls = 0;
  while (!g.exhausted && h > stepMin) {
    let moved = false;
    /* Poll order rotates with the iteration count, so a search does not always improve along
     * variable 0 first and leave the later ones to a smaller step. */
    for (let k = 0; k < 2 * n && !g.exhausted; k++) {
      const i = (Math.floor(k / 2) + polls) % n, s = k % 2 ? -1 : +1;
      const trial = clampTo(x.map((v, j) => (j === i ? v + s * h * span[j] : v)), bounds);
      if (trial[i] === x[i]) continue;
      const f = await probe(trial, { stage: "pattern", event: "poll", variable: i, step: h });
      if (better(f, fx)) { x = trial; fx = f; moved = true; break; }
    }
    polls++;
    h = moved ? Math.min(1, h * expand) : h * contract;
  }
  return { x, score: fx, evaluations: g.used, history, stopped: g.reason() || "converged", finalStep: h };
}

/* ---- CMA-ES --------------------------------------------------------------------------------------- */

/* Standard (mu/mu_w, lambda)-CMA-ES with rank-mu and rank-one covariance updates and cumulative step
 * length adaptation, following Hansen's reference formulation. The search runs in a unit box — every
 * variable scaled to [0, 1] by its own bounds — so one sigma is meaningful across a vector that
 * mixes a radius ratio with a control-point angle.
 *
 * Out-of-box samples are resampled rather than clamped. Clamping piles density onto the faces of the
 * box and teaches the covariance that the wall is a direction worth exploring; resampling costs a
 * few draws and keeps the distribution honest. An infeasible *design* (a self-crossing outline) is
 * different: it is a real point of the space with no score, so it is ranked last and kept in the
 * population count, which lets sigma shrink in response to a region that is mostly invalid.
 */
export async function cmaes({ x0, bounds, evaluate, sigma0 = 0.25, popSize = null, seed = 1, ...rest }) {
  const g = budgetGuard(rest);
  const n = x0.length;
  const R = rng(seed);
  const toUnit = x => x.map((v, i) => (v - bounds[i][0]) / (bounds[i][1] - bounds[i][0]));
  const fromUnit = u => u.map((v, i) => bounds[i][0] + v * (bounds[i][1] - bounds[i][0]));

  const lambda = popSize || 4 + Math.floor(3 * Math.log(n));
  const mu = Math.floor(lambda / 2);
  const wRaw = Array.from({ length: mu }, (_, i) => Math.log((lambda + 1) / 2) - Math.log(i + 1));
  const wSum = wRaw.reduce((a, b) => a + b, 0);
  const w = wRaw.map(v => v / wSum);
  const muEff = 1 / w.reduce((a, v) => a + v * v, 0);

  const cc = (4 + muEff / n) / (n + 4 + 2 * muEff / n);
  const cs = (muEff + 2) / (n + muEff + 5);
  const c1 = 2 / ((n + 1.3) ** 2 + muEff);
  const cmu = Math.min(1 - c1, 2 * (muEff - 2 + 1 / muEff) / ((n + 2) ** 2 + muEff));
  const damps = 1 + 2 * Math.max(0, Math.sqrt((muEff - 1) / (n + 1)) - 1) + cs;
  const chiN = Math.sqrt(n) * (1 - 1 / (4 * n) + 1 / (21 * n * n));

  let m = toUnit(clampTo(x0, bounds));
  let sigma = sigma0;
  let pc = new Array(n).fill(0), ps = new Array(n).fill(0);
  let C = identity(n), B = identity(n), D = new Array(n).fill(1);
  let eigenAge = 0;

  let best = { x: null, score: null };
  const history = [];
  let gen = 0;

  const gauss = () => {
    // Box-Muller; one of the pair is kept, which is fine and keeps the stream easy to reason about.
    let u = 0, v = 0;
    while (u === 0) u = R();
    v = R();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  while (!g.exhausted) {
    gen++;
    const pop = [];
    for (let k = 0; k < lambda && !g.exhausted; k++) {
      let z = null, y = null, u = null;
      for (let tries = 0; tries < 40; tries++) {
        z = Array.from({ length: n }, () => gauss());
        y = matVec(B, z.map((zi, i) => zi * D[i]));
        u = m.map((v, i) => v + sigma * y[i]);
        if (u.every(v => v >= 0 && v <= 1)) break;
        u = null;
      }
      // Forty draws all outside the box means the distribution has walked onto a face; take the
      // clamped point rather than spinning, and let the step-size adaptation deal with it.
      if (!u) u = m.map((v, i) => Math.min(1, Math.max(0, v + sigma * y[i])));
      const x = fromUnit(u);
      g.spend();
      const r = await evaluate(x, { stage: "cmaes", generation: gen, member: k });
      pop.push({ u, z, y, x, score: r.score });
      history.push({ x, score: r.score, tag: { stage: "cmaes", generation: gen, member: k } });
      if (better(r.score, best.score)) best = { x, score: r.score };
    }
    if (pop.length < mu) break;

    /* Infeasible designs sort last. They stay in the population, so a generation that lands mostly
     * in an invalid region produces a short parent set and a shrinking sigma, which is the right
     * response: the distribution is too wide for where it is. */
    pop.sort((a, b) => (b.score === null ? -Infinity : b.score) - (a.score === null ? -Infinity : a.score));
    const parents = pop.slice(0, mu).filter(p => p.score !== null);
    if (!parents.length) { sigma *= 0.7; continue; }
    const pw = parents.map((_, i) => w[i]);
    const pwSum = pw.reduce((a, b) => a + b, 0);

    const mOld = m.slice();
    m = new Array(n).fill(0);
    for (let i = 0; i < parents.length; i++) for (let j = 0; j < n; j++) m[j] += (pw[i] / pwSum) * parents[i].u[j];

    const yw = m.map((v, j) => (v - mOld[j]) / sigma);
    const CinvYw = matVec(B, matVec(transpose(B), yw).map((v, i) => v / D[i]));
    ps = ps.map((v, i) => (1 - cs) * v + Math.sqrt(cs * (2 - cs) * muEff) * CinvYw[i]);
    const psNorm = Math.hypot(...ps);
    const hsig = psNorm / Math.sqrt(1 - (1 - cs) ** (2 * gen)) / chiN < 1.4 + 2 / (n + 1) ? 1 : 0;
    pc = pc.map((v, i) => (1 - cc) * v + hsig * Math.sqrt(cc * (2 - cc) * muEff) * yw[i]);

    const c1a = c1 * (1 - (1 - hsig * hsig) * cc * (2 - cc));
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      let rank = 0;
      for (let k = 0; k < parents.length; k++) {
        const yk = parents[k].u.map((v, d) => (v - mOld[d]) / sigma);
        rank += (pw[k] / pwSum) * yk[i] * yk[j];
      }
      C[i][j] = (1 - c1a - cmu) * C[i][j] + c1 * pc[i] * pc[j] + cmu * rank;
    }
    sigma *= Math.exp((cs / damps) * (psNorm / chiN - 1));
    sigma = Math.min(1.5, Math.max(1e-6, sigma));

    /* The eigendecomposition is the expensive part of CMA-ES and is amortized: the covariance is
     * refreshed every O(n / (c1 + cmu) / 10) generations, as in the reference implementation. Next
     * to a field solve it is free either way, but the cadence keeps the update numerically calm. */
    if (++eigenAge > n / (10 * (c1 + cmu))) {
      eigenAge = 0;
      symmetrize(C);
      const e = jacobiEigen(C);
      B = e.vectors; D = e.values.map(v => Math.sqrt(Math.max(1e-20, v)));
    }
    if (rest.onGeneration) rest.onGeneration({ generation: gen, sigma, best: best.score, evaluations: g.used });
    // Flat-fitness and collapsed-sigma stops, both of which mean the same thing: nothing left to learn.
    if (sigma < 1e-5) break;
  }
  return { x: best.x, score: best.score, evaluations: g.used, history, stopped: g.reason() || "converged", sigma, generations: gen };
}

/* ---- differential evolution -------------------------------------------------------------------- */

/* DE/rand/1/bin with a Latin-hypercube initial population, which is the cheapest way to make a
 * population of 40 in 20 dimensions cover the box at all. */
export async function differentialEvolution({ x0, bounds, evaluate, popSize = null, F = 0.7, CR = 0.9, seed = 1, ...rest }) {
  const g = budgetGuard(rest);
  const n = bounds.length, R = rng(seed);
  const np = popSize || Math.max(8, Math.min(60, 5 * n));
  const pop = latinHypercube(np, bounds, { seed });
  if (x0) pop[0] = clampTo(x0.slice(), bounds);
  const history = [], fit = new Array(np).fill(null);

  for (let i = 0; i < np && !g.exhausted; i++) {
    g.spend();
    const r = await evaluate(pop[i], { stage: "de", event: "init", member: i });
    fit[i] = r.score;
    history.push({ x: pop[i], score: r.score, tag: { stage: "de", event: "init", member: i } });
  }

  let gen = 0;
  while (!g.exhausted) {
    gen++;
    for (let i = 0; i < np && !g.exhausted; i++) {
      let a, b, c;
      do { a = Math.floor(R() * np); } while (a === i);
      do { b = Math.floor(R() * np); } while (b === i || b === a);
      do { c = Math.floor(R() * np); } while (c === i || c === a || c === b);
      const jr = Math.floor(R() * n);
      const trial = pop[i].map((v, j) => (j === jr || R() < CR ? pop[a][j] + F * (pop[b][j] - pop[c][j]) : v));
      const x = clampTo(trial, bounds);
      g.spend();
      const r = await evaluate(x, { stage: "de", generation: gen, member: i });
      history.push({ x, score: r.score, tag: { stage: "de", generation: gen, member: i } });
      if (better(r.score, fit[i])) { pop[i] = x; fit[i] = r.score; }
    }
    if (rest.onGeneration) rest.onGeneration({ generation: gen, best: Math.max(...fit.filter(v => v !== null)), evaluations: g.used });
  }
  let bi = -1;
  for (let i = 0; i < np; i++) if (better(fit[i], bi < 0 ? null : fit[bi])) bi = i;
  return { x: bi < 0 ? null : pop[bi], score: bi < 0 ? null : fit[bi], evaluations: g.used, history, stopped: g.reason() || "converged", generations: gen };
}

export const SEARCHERS = { pattern: patternSearch, cmaes, de: differentialEvolution };

/* ---- small dense linear algebra ----------------------------------------------------------------- */

const identity = n => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
const matVec = (M, v) => M.map(row => row.reduce((a, m, j) => a + m * v[j], 0));
const transpose = M => M[0].map((_, j) => M.map(r => r[j]));
function symmetrize(C) { for (let i = 0; i < C.length; i++) for (let j = 0; j < i; j++) C[i][j] = C[j][i] = 0.5 * (C[i][j] + C[j][i]); }

/* Cyclic Jacobi rotations. At n <= 64 this is microseconds and it is unconditionally stable for a
 * symmetric matrix, which is the only kind it is ever handed. */
export function jacobiEigen(Ain, sweeps = 100) {
  const n = Ain.length;
  const A = Ain.map(r => r.slice());
  let V = identity(n);
  for (let s = 0; s < sweeps; s++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] * A[i][j];
    if (off < 1e-30) break;
    for (let p = 0; p < n - 1; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(A[p][q]) < 1e-300) continue;
      const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), sn = t * c;
      for (let k = 0; k < n; k++) {
        const akp = A[k][p], akq = A[k][q];
        A[k][p] = c * akp - sn * akq; A[k][q] = sn * akp + c * akq;
      }
      for (let k = 0; k < n; k++) {
        const apk = A[p][k], aqk = A[q][k];
        A[p][k] = c * apk - sn * aqk; A[q][k] = sn * apk + c * aqk;
      }
      for (let k = 0; k < n; k++) {
        const vkp = V[k][p], vkq = V[k][q];
        V[k][p] = c * vkp - sn * vkq; V[k][q] = sn * vkp + c * vkq;
      }
    }
  }
  return { values: A.map((r, i) => r[i]), vectors: V };
}
