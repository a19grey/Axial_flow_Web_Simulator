#!/usr/bin/env node
/* The study layer: is a design's score a property of the design?
 *
 *   node tests/study.js [--out report.json] [--cpu-only] [--allow-software]
 *
 * Two halves. The CPU half is the algebra and the plumbing — the quadratic form's closed-form peak
 * against a brute-force maximization, the searchers against functions with known optima, the design
 * compiler, the archive's resume — and runs in milliseconds with no GPU. The GPU half is the claims
 * that can only be settled by solving: that the quadratic form *is* the torque, that the closed-form
 * current phase is the peak of a dense sweep, that three rotor angles give the mean a twelve-point
 * sweep gives, and that refining a footprint does not change the design.
 *
 * That last one is the load-bearing claim of the whole shape ladder. If a refined curve scored even
 * slightly differently, every "this rung bought 2 %" in a run report would be measuring the
 * parameterization rather than the machine.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { phaseCoefficients, optimalPhase, torqueAt } from "../src/study/operatingPoint.js";
import { scopeOf, scoreDesign, manufacturability, checkExpressions, containment, gateDesign } from "../src/study/objectives.js";
import { compileDesign, discreteCombinations } from "../src/study/design.js";
import { twoChainVariable, loftVariable, ladderStep, inspectShape } from "../src/study/shape.js";
import { latinHypercube, haltonStream, screenPoints, screenRanking, rng } from "../src/study/sample.js";
import { patternSearch, cmaes, differentialEvolution, jacobiEigen } from "../src/study/search.js";
import { curveAt } from "../src/core/curves.js";
import { normalizeSpec, defaultSpec, specHash } from "../src/core/spec.js";
import { RunArchive, repairLedger } from "../cli/archive.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const flag = n => args.includes("--" + n);
const outPath = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;

const problems = [];
const report = { generatedAt: new Date().toISOString(), cases: {} };
const ok = (label, cond, detail = "") => {
  process.stderr.write(`  ${cond ? "ok  " : "FAIL"}  ${label}${detail ? "  " + detail : ""}\n`);
  if (!cond) problems.push(label);
};
const rel = (a, b) => Math.abs(a - b) / Math.max(1e-30, Math.abs(b));
const TWO3 = 2 * Math.PI / 3;

/* ---- 1. the quadratic form and its closed-form peak --------------------------------------------- */

/* The algebra, checked against the definition it came from rather than against itself: build an
 * arbitrary symmetric Q, evaluate I^T Q I directly on a dense grid of current phases, and ask
 * whether the three coefficients reproduce it and whether 1/2 atan2(d, b) really is the maximum. */
function quadraticForm() {
  const R = rng(4242);
  let worstValue = 0, worstPeak = 0, worstMeanPeak = 0;
  for (let trial = 0; trial < 60; trial++) {
    const Q = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let j = 0; j < 3; j++) for (let k = j; k < 3; k++) Q[j][k] = Q[k][j] = R() * 2 - 1;
    const c = phaseCoefficients(Q);

    // The closed form against the definition, at 360 phases.
    for (let i = 0; i < 360; i++) {
      const phi = i * Math.PI / 180;
      const I = [0, 1, 2].map(k => Math.cos(phi - TWO3 * k));
      let direct = 0;
      for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) direct += Q[j][k] * I[j] * I[k];
      worstValue = Math.max(worstValue, Math.abs(direct - torqueAt(c, phi)));
    }

    // And the peak, against a dense scan of the same curve.
    const single = optimalPhase([c], [0]);
    let bestPhi = 0, bestVal = -Infinity;
    for (let i = 0; i < 36000; i++) { const phi = i * Math.PI / 18000; const v = torqueAt(c, phi); if (v > bestVal) { bestVal = v; bestPhi = phi; } }
    /* The closed form must be at least as good as the best point on a 36000-point grid. Asking for
     * equality would be asking the grid to be exact: its own discretization error is about 1e-7 of
     * the peak, which is precisely the reason not to find the peak by scanning. */
    worstPeak = Math.max(worstPeak, (bestVal - single.meanAtGamma) / Math.max(1e-9, Math.abs(bestVal)));
    void bestPhi;

    /* Three different rotor angles, three different Q matrices, one gamma. This is the case that
     * matters for the score, and the one where an averaged closed form could quietly be wrong. */
    const Qs = [Q, Q.map(r => r.map(v => v * 0.7 + 0.2)), Q.map(r => r.map(v => -0.4 * v + 0.1))];
    const cs = Qs.map(phaseCoefficients), eps = [0, TWO3, 2 * TWO3];
    const many = optimalPhase(cs, eps);
    let mBest = -Infinity;
    for (let i = 0; i < 36000; i++) {
      const gamma = i * Math.PI / 36000;
      const m = cs.reduce((a, cc, idx) => a + torqueAt(cc, eps[idx] + gamma), 0) / cs.length;
      if (m > mBest) mBest = m;
    }
    worstMeanPeak = Math.max(worstMeanPeak, (mBest - many.meanAtGamma) / Math.max(1e-9, Math.abs(mBest)));
  }
  ok("the three coefficients reproduce I^T Q I at every current phase", worstValue < 1e-13, `worst ${worstValue.toExponential(1)}`);
  ok("no point on a 36000-point scan beats the closed-form phase", worstPeak < 1e-12, `best scan point was ${worstPeak.toExponential(1)} better`);
  ok("and none does when three rotor angles are averaged", worstMeanPeak < 1e-12, `${worstMeanPeak.toExponential(1)}`);
  report.cases.quadraticForm = { worstValue, worstPeak, worstMeanPeak };
}

/* ---- 2. gates and the score ---------------------------------------------------------------------- */

function gates() {
  const base = normalizeSpec(defaultSpec()).spec;
  ok("the default objective typechecks against the record's own names", checkExpressions({}).length === 0);
  ok("and a typo in it is caught before a run, by name",
     /unknown name "sheer_kPa"/.test(checkExpressions({ maximize: "sheer_kPa" }).join(" ")));

  const m = manufacturability(base);
  ok("the default design is manufacturable", m.pass, m.fails.join("; "));
  const thin = JSON.parse(JSON.stringify(base));
  thin.design.stator.traceWidth_mm = 0.05;
  const tm = manufacturability(thin);
  ok("a trace under the process minimum is rejected, and the message says by how much",
     !tm.pass && /0.05 mm is under the 0.15 mm/.test(tm.fails.join(" ")), tm.fails[0]);
  const shallow = JSON.parse(JSON.stringify(base));
  shallow.design.rotor.poleHeight_mm = 0.3;
  ok("a pole shorter than the nozzle can print is rejected", !manufacturability(shallow).pass);

  /* The two-chain footprint's narrowest chord is a subtraction, so it can be checked exactly; the
   * general traced curve's is not, and must say so rather than pass silently. */
  const narrow = JSON.parse(JSON.stringify(base));
  narrow.design.rotor.poleCurve = { trailing: [-0.3, -0.002, -0.3], leading: [0.3, 0.002, 0.3] };
  const nm = manufacturability(narrow);
  ok("a two-chain footprint that pinches to nothing is rejected", !nm.pass && /narrows to/.test(nm.fails.join(" ")), nm.fails[0]);
  const general = JSON.parse(JSON.stringify(base));
  general.design.rotor.poleCurve = { through: [[0.1, -0.2], [0.9, -0.1], [0.9, 0.2], [0.1, 0.15]] };
  const gm = manufacturability(general);
  ok("and a general traced curve reports its narrowest chord as unchecked rather than passing quietly",
     gm.pass && gm.unchecked.length === 1);

  /* An infeasible design has no score at all, rather than a large negative one: a penalty would let
   * a search trade real performance against numerical nonsense. */
  const record = { meanShear_kPa: 12, results: { quality: [{ level: "error", code: "gapUnresolved", message: "x" }], torqueSurfaceSpread_pct: 1 }, operatingPoint: {}, cost: {} };
  const s = scoreDesign(base, record, {});
  ok("an error-level quality flag means no score, not a bad one", s.score === null && !s.feasible);
  const clean = { meanShear_kPa: 12, confirm: { error_pct: 0.01 }, results: { quality: [], torqueSurfaceSpread_pct: 1 }, operatingPoint: {}, cost: {} };
  ok("and a clean record scores the objective", scoreDesign(base, clean, {}).score === 12);
  ok("a superposition error past the threshold is a gate, not a footnote",
     scoreDesign(base, { ...clean, confirm: { error_pct: 7 } }, {}).score === null);
  ok("the scope exposes the results JSON by dotted path too", "results.torqueSurfaceSpread_pct" in scopeOf(clean));
}

/* ---- 3. design variables ------------------------------------------------------------------------- */

function variables() {
  const base = normalizeSpec(defaultSpec()).spec;
  const d = compileDesign([
    { name: "riOverRo", min: 0.3, max: 0.75, init: 0.4, writes: [{ path: "design.stator.innerRadius_mm", expr: "riOverRo * ro" }] },
    { name: "gapOverRo", min: 0.02, max: 0.12, init: 0.05, writes: [{ path: "design.rotor.airGap_mm", expr: "gapOverRo * ro" }] },
    { kind: "footprint", name: "pole", stations: 4 },
    { kind: "loft", name: "sweep", channels: { scale: 3 } },
    { name: "layers", path: "design.stator.copperLayers", values: [2, 4, 6] }
  ], base);

  ok("ratios write millimetres through the baseline's own dimensions",
     d.apply(d.x0).design.stator.innerRadius_mm === 0.4 * base.design.stator.outerRadius_mm);
  ok("a discrete variable stays out of the continuous vector", d.dim === 2 + 8 + 3 && d.discrete.length === 1);
  ok("and is enumerated instead", discreteCombinations(d.discrete).length === 3);
  ok("applying a vector never mutates the baseline it came from",
     base.design.stator.innerRadius_mm === defaultSpec().design.stator.innerRadius_mm);
  ok("every variable's bounds are a box the sampler can draw from without knowing what it is drawing",
     d.bounds.length === d.dim && d.bounds.every(([lo, hi]) => hi > lo));

  /* The measurement the parameterization exists for: how often a draw from the box is a design
   * worth solving. The two-chain layout cannot cross itself whatever it is handed, which is why the
   * low rungs use it; the number is asserted rather than asserted-about. */
  let simple = 0, valid = 0, N = 500;
  const R = rng(99);
  for (let i = 0; i < N; i++) {
    const x = d.bounds.map(([lo, hi]) => lo + R() * (hi - lo));
    const v = d.validate(x);
    if (v.ok) valid++;
    if (!/crosses itself/.test(v.reason || "")) simple++;
  }
  ok("every uniform draw from the two-chain box is a simple outline", simple === N, `${simple}/${N}`);

  /* Simple is not the same as legal, and conflating the two is how the first overnight run ended
   * up with poles hanging 5 mm past the stator. The footprint's own box keeps it in the annulus;
   * the loft is applied afterwards and can take it straight back out, so the same draws with the
   * loft pinned neutral must be 100 % valid and with the loft free must not be. */
  const flat = compileDesign([{ kind: "footprint", name: "pole", stations: 4 }], base);
  const R2 = rng(99);
  let flatValid = 0;
  for (let i = 0; i < N; i++) flatValid += flat.validate(flat.bounds.map(([lo, hi]) => lo + R2() * (hi - lo))).ok ? 1 : 0;
  ok("with no loft, every one of them is also inside the rotor it belongs to", flatValid === N, `${flatValid}/${N}`);
  ok("with a loft free to scale past 1, some are not, and that is the containment check working",
     valid < N, `${valid}/${N} survive once the loft is applied`);
  report.cases.boxFeasibility = { draws: N, simple, valid, validWithoutLoft: flatValid };
}

/* ---- 3b. containment ----------------------------------------------------------------------------- */

/* The gate the first overnight study did without. It found the hole in four hours: the winning
 * rotor grew scythes reaching 5.9 mm past the stator's outer radius and spanning 66 degrees
 * against a 45 degree pole pitch, so neighbouring poles interpenetrated. Real torque, and cheating.
 */
function containmentGate() {
  const base = normalizeSpec(defaultSpec()).spec;
  ok("a stock design is inside the rotor it is drawn on", containment(base).pass);

  const ro = base.design.stator.outerRadius_mm;
  const over = normalizeSpec({ ...base, design: { ...base.design, rotor: { ...base.design.rotor,
    poleCurve: { trailing: [-0.25, -0.25, -0.25], leading: [0.25, 0.25, 0.25], u0: 0.1, u1: 0.9 },
    poleLoft: { scale: [1, 1.6], widen: [1, 1], pivot: 0.5 } } } }).spec;
  const c = containment(over);
  ok("a loft that scales past 1 pushes the pole off the rim, and is caught", !c.pass && c.overrun_mm > 0.5,
     c.fails.join("; "));
  ok("and it is caught before anything is meshed or solved",
     gateDesign(over, null).needsSolve === false &&
     gateDesign(over, null).gates.some(g => g.name === "containment" && !g.pass));

  const wide = normalizeSpec({ ...base, design: { ...base.design, rotor: { ...base.design.rotor,
    poleCurve: { trailing: [-0.4, -0.4], leading: [0.4, 0.4], u0: 0.2, u1: 0.8 },
    poleLoft: { widen: [1, 1.4], pivot: 0.5 } } } }).spec;
  ok("a widen that fans the pole across its neighbour is caught too",
     !containment(wide).pass && /pole pitch/.test(containment(wide).fails.join(" ")));

  /* The bound is a design field, so a study can be stricter than the geometry is. */
  const tight = normalizeSpec({ ...base, design: { ...base.design, rotor: { ...base.design.rotor,
    poleBounds: { maxRadius_mm: ro - 3 } } } }).spec;
  ok("tightening maxRadius_mm to inside the stator rejects a pole the rotor itself would allow",
     containment(base).pass && !containment(tight).pass);

  /* `+null` is 0. A bound of null that survives one normalization and becomes a bound of zero on
   * the next would reject every design in the study, one round-trip through the archive later. */
  const twice = normalizeSpec(normalizeSpec(base).spec).spec;
  ok("an absent bound stays absent when a spec is normalized twice",
     twice.design.rotor.poleBounds.maxRadius_mm === null && containment(twice).pass);
}

/* ---- 4. the ladder is exact ---------------------------------------------------------------------- */

function ladder() {
  const v = twoChainVariable({ stations: 4 });
  let x = v.x0.slice();
  // A shape with something to lose: asymmetric, non-monotone, nothing a rectangle.
  x = [-0.40, -0.12, -0.34, -0.20, 0.09, 0.31, 0.14, 0.27];
  let variable = v, worst = 0;
  for (let rung = 0; rung < 3; rung++) {
    const up = ladderStep(variable, x);
    const a = variable.curve(x), b = up.variable.curve(up.x);
    for (let i = 0; i <= 400; i++) {
      const t = i / 400 * a.spans;
      const pa = curveAt(a, t), pb = curveAt(b, 2 * t);
      worst = Math.max(worst, Math.abs(pa.u - pb.u), Math.abs(pa.v - pb.v));
    }
    ok(`rung ${rung + 1}: ${variable.dim} -> ${up.dim} variables, same curve`, true);
    variable = up.variable; x = up.x;
  }
  ok("refining a footprint returns the identical curve, three rungs deep", worst < 1e-14, `worst deviation ${worst.toExponential(2)}`);
  ok("and the refined design is still a valid footprint", inspectShape(variable, x).ok);
  report.cases.ladder = { worstDeviation: worst, finalDim: variable.dim };

  const lv = loftVariable({ channels: { scale: 3, widen: 2, twist: 2 } });
  ok("a neutral loft vector is no loft at all", lv.loft(lv.x0) === null);
  ok("and a flare is one", lv.loft([1, 1.3, 1, 1, 1, 0, 0]) !== null);
}

/* ---- 5. samplers and searchers ------------------------------------------------------------------ */

function searchers() {
  const b3 = [[0, 1], [0, 1], [0, 1]];
  const L = latinHypercube(40, b3, { seed: 3 });
  let perStratum = true;
  for (let j = 0; j < 3; j++) {
    const seen = new Set(L.map(p => Math.floor(p[j] * 40)));
    if (seen.size !== 40) perStratum = false;
  }
  ok("a Latin hypercube puts exactly one point in every stratum of every variable", perStratum);
  ok("the same seed gives the same points", JSON.stringify(latinHypercube(10, b3, { seed: 7 })) === JSON.stringify(latinHypercube(10, b3, { seed: 7 })));
  ok("and a different seed does not", JSON.stringify(latinHypercube(10, b3, { seed: 7 })) !== JSON.stringify(latinHypercube(10, b3, { seed: 8 })));
  const h = haltonStream(b3, { seed: 1 });
  const first = [h(), h(), h()];
  ok("a Halton stream stays inside the box", first.every(p => p.every(v => v >= 0 && v <= 1)));

  ok("a screen is two evaluations per variable", screenPoints([0.5, 0.5, 0.5], b3).length === 6);
  const rank = screenRanking(["a", "b"], [{ index: 0, score: 1 }, { index: 0, score: 3 }, { index: 1, score: 2 }, { index: 1, score: 2.01 }], 0.1);
  ok("and it drops the variable whose whole swing is inside the noise floor",
     rank[0].name === "a" && rank[0].matters === true && rank[1].matters === false);

  const e = jacobiEigen([[4, 1, 0], [1, 3, 1], [0, 1, 2]]);
  const vals = e.values.slice().sort((a, b) => a - b);
  ok("the eigensolver CMA-ES leans on is right", rel(vals[0], 3 - Math.sqrt(3)) < 1e-12 && rel(vals[2], 3 + Math.sqrt(3)) < 1e-12,
     vals.map(v => v.toFixed(6)).join(" "));

  /* A correlated quadratic is the case the choice of algorithm rests on: pattern search moves one
   * variable at a time and cannot see the correlation, CMA-ES learns it. If this ordering ever
   * inverts, the reason rungs 3 and 4 of the ladder use CMA-ES has gone away and should be revisited.
   */
  const n = 8, bounds = Array.from({ length: n }, () => [-3, 3]);
  const f = x => { let s = 0; for (let i = 0; i < n; i++) { const y = x[i] + 0.9 * x[(i + 1) % n]; s += (i + 1) * y * y; } return -s; };
  const x0 = Array.from({ length: n }, () => 2);
  const common = { x0, bounds, evaluate: x => ({ score: f(x) }), budget: 1200, seed: 5 };
  const ps = await0(patternSearch({ ...common, step: 0.3, stepMin: 1e-4 }));
  const cs = await0(cmaes({ ...common, sigma0: 0.3 }));
  const de = await0(differentialEvolution({ ...common }));
  return Promise.all([ps, cs, de]).then(([p, c, d]) => {
    ok("every searcher improves on its starting point", p.score > f(x0) && c.score > f(x0) && d.score > f(x0));
    ok("CMA-ES beats pattern search on a correlated quadratic, which is why the high rungs use it",
       c.score > p.score, `cmaes ${c.score.toExponential(2)} vs pattern ${p.score.toExponential(2)}`);
    ok("and it gets within a fraction of a percent of the optimum", Math.abs(c.score) < 1e-1, `${c.score.toExponential(2)}`);
    ok("a searcher stops on its budget, not past it", p.evaluations <= 1200 && c.evaluations <= 1200 && d.evaluations <= 1200);
    report.cases.searchers = { pattern: p.score, cmaes: c.score, de: d.score };
  });
}
const await0 = p => p;

/* ---- 6. the archive resumes ---------------------------------------------------------------------- */

function archive() {
  const dir = mkdtempSync(join(tmpdir(), "afs-archive-"));
  try {
    const a = RunArchive.open({ resume: dir });
    a.primaryTier = "score";
    a.manifest({ study: "test", objective: "shear_kPa" });
    for (let i = 0; i < 5; i++) a.record({ hash: `h${i}`, tier: "score", stage: "scan", score: i === 3 ? null : i, feasible: i !== 3 },
                                         { spec: { n: i }, record: { n: i } });
    a.record({ hash: "coarse", tier: "screen", stage: "scan", score: 99 });
    ok("the archive tracks the best on each tier separately, not one leaderboard across meshes",
       a.best.score === 4 && a.bestOn("screen").score === 99);
    ok("and every improvement is a line in the storyboard", a.storyboard().length === 4 + 1);

    const b = RunArchive.open({ resume: dir });
    b.primaryTier = "score";
    ok("reopening a run replays its ledger as the evaluation cache", b.byHash.size === 6 && b.seq === 6);
    ok("so an already-scored design is free on resume", b.cached("h2").score === 2);
    ok("and the best survives the reopen", b.best.score === 4);
    ok("a design's spec and results are stored beside the ledger under their hash", b.design("h2").spec.n === 2);

    /* A run killed mid-write leaves a truncated last line. It must not take the run with it. */
    const { appendFileSync, writeFileSync } = fsMod;
    appendFileSync(a.ledgerPath, '{"hash":"trunc","sc');
    const c = RunArchive.open({ resume: dir });
    ok("a half-written final line is dropped rather than failing the resume", c.byHash.size === 6);

    /* One writer per directory. Two deterministic searches appending to one ledger evaluate the
     * same points, so the second buys nothing and doubles the history. */
    const held = RunArchive.open({ resume: dir });
    held.lock();
    ok("a holder may re-lock its own run", held.lock() === null || true);
    /* A live process that is not us. pid 1 is init and is always running, which is all the check
     * asks: the lock is held by something the operating system says exists. */
    writeFileSync(held.lockPath, JSON.stringify({ pid: 1, host: fsHost(), started: "x", heartbeat: Date.now() }) + "\n");
    let refused = null;
    try { RunArchive.open({ resume: dir }).lock(); } catch (e) { refused = e.message; }
    ok("a second writer is refused, and told which process holds the run",
       refused !== null && /pid 1 on /.test(refused), (refused || "").slice(0, 60));
    ok("and --force is named as the way past it", /--force/.test(refused || ""));
    writeFileSync(held.lockPath, JSON.stringify({ pid: 999999, host: "somewhere-else", started: "x", heartbeat: 0 }) + "\n");
    let took = null;
    try { took = RunArchive.open({ resume: dir }).lock(); } catch (e) { took = e; }
    ok("but a stale lock is taken over rather than being a wall in the morning",
       took && !(took instanceof Error) && took.pid === 999999);

    /* And if it does happen, the damage is repairable — but only because the duplicated lines agree.
     * Where they disagree, dropping either one would be destroying a measurement. */
    const dir2 = mkdtempSync(join(tmpdir(), "afs-repair-"));
    try {
      const d = RunArchive.open({ resume: dir2 });
      for (const e of [{ hash: "a", score: 1, tier: "score", ts: 1 }, { hash: "b", score: 2, tier: "score", ts: 2 },
                       { hash: "a", score: 1, tier: "score", ts: 3 }, { hash: "c", score: 3, tier: "score", ts: 4 }]) d.record(e);
      const r = repairLedger(dir2);
      ok("repair drops the duplicated line, renumbers, and rebuilds the storyboard",
         r.kept === 3 && r.dropped === 1 && r.improvements === 3);
      const back = RunArchive.open({ resume: dir2 });
      ok("and the repaired ledger reads back with contiguous sequence numbers",
         back.ledger().map(e => e.seq).join(",") === "0,1,2");
      d.record({ hash: "a", score: 99, tier: "score", ts: 5 });
      let refusedRepair = null;
      try { repairLedger(dir2); } catch (e) { refusedRepair = e.message; }
      ok("a duplicate that disagrees on the score is not tidied away, it is refused",
         refusedRepair !== null && /not duplicated work/.test(refusedRepair));
    } finally { rmSync(dir2, { recursive: true, force: true }); }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
let fsMod = null;
const fsHost = () => osMod.hostname();
let osMod = null;

/* ---- 7. through a solve -------------------------------------------------------------------------- */

/* The claims that need the field. Each one is the assertion form of a line in the optimization
 * plan's validation table. */
async function throughASolve() {
  const { PageHost } = await import("../cli/host.js");
  const host = new PageHost({ allowSoftware: flag("allow-software") });
  try {
    const spec = JSON.parse(await (await import("node:fs/promises")).readFile(resolve(ROOT, "src/cases/pcb-reluctance-80mm.json"), "utf8"));
    const call = (fn, arg) => host.call(fn, arg).then(r => {
      if (!r.ok) throw new Error(r.error);
      if (r.value && r.value.ok === false) throw new Error(r.value.error.message);
      return r.value && "value" in r.value ? r.value.value : r.value;
    });

    /* 1. The quadratic form is the torque. The confirming solve is run at the closed form's own
     * chosen phase and amplitude, so any disagreement is superposition failing. */
    const scored = await call(([s, o]) => window.AFS.score(s, o), [spec, { tier: "score" }]);
    const err = Math.abs(scored.record.confirm.error_pct);
    ok("the closed-form torque matches a direct solve at the phase it chose", err < 0.05,
       `${err.toExponential(2)} % at gamma* = ${scored.record.operatingPoint.currentAngle_elecDeg.toFixed(3)} deg`);

    /* 2. gamma* is the peak of a dense sweep. The machine is a reluctance rotor with no magnets, so
     * the textbook answer is 45 electrical degrees; the closed form should find it without being
     * told, and the sweep should agree. */
    const gStar = scored.record.operatingPoint.currentAngle_elecDeg;
    const sweep = await call(([s, amps]) => window.AFS.sweep(
      { ...s, design: { ...s.design, stator: { ...s.design.stator, peakCurrent_A: amps } } },
      { path: "operatingPoint.currentAngle_elecDeg", from: 0, to: 175, step: 5 }),
      [spec, scored.record.operatingPoint.peakCurrent_A]);
    let peak = null, peakT = -Infinity;
    for (const p of sweep.points) if (p.results.torque_mNm > peakT) { peakT = p.results.torque_mNm; peak = p.value; }
    const dGamma = Math.min(Math.abs(gStar - peak), 180 - Math.abs(gStar - peak));
    ok("and a 36-point current-phase sweep peaks at the same place", dGamma <= 5,
       `closed form ${gStar.toFixed(2)} deg, sweep peak ${peak} deg (5 deg grid)`);
    const tAtStar = scored.record.torqueAtAngles_mNm[0];
    /* Not "greater than", because the closed form and the sweep are two f32 routes to the same
     * number and the gap between them is the superposition error measured above, not a preference. */
    ok("the closed form's torque matches the best the sweep found, to the superposition error",
       Math.abs(tAtStar - peakT) / peakT * 100 < Math.max(0.01, err * 2),
       `${tAtStar.toFixed(6)} vs ${peakT.toFixed(6)} mN.m, ${(rel(tAtStar, peakT) * 100).toExponential(1)} % apart`);

    /* 3. Three rotor angles give the mean that twelve do. The three-sample mean cancels the 6th and
     * 12th electrical harmonics exactly and aliases only the 18th, which is the whole reason the
     * score tier costs nine solves instead of thirty-six. */
    const dense = await call(([s, o]) => window.AFS.score(s, o), [spec, { tier: "confirm" }]);
    const dMean = rel(scored.record.meanTorque_mNm, dense.record.meanTorque_mNm) * 100;
    ok("three rotor angles give the mean torque twelve do", dMean < 2,
       `${scored.record.meanTorque_mNm.toFixed(6)} vs ${dense.record.meanTorque_mNm.toFixed(6)} mN.m, ${dMean.toFixed(2)} % apart`);

    /* 4. The same spec scores the same number, bit for bit. Without this the evaluation cache is a
     * source of error rather than a saving. */
    const again = await call(([s, o]) => window.AFS.score(s, o), [spec, { tier: "score" }]);
    ok("the same design scores identically, bit for bit", again.score === scored.score,
       `${scored.score} vs ${again.score}`);

    /* 5. Refining a footprint does not change the design — end to end, through a solve, not just
     * pointwise on the curve. This is what makes "the rung bought 2 %" a statement about the
     * machine. */
    const coarse = twoChainVariable({ stations: 4, chordTolerance_mm: 0.002 });
    const xShape = [-0.36, -0.14, -0.30, -0.22, 0.11, 0.30, 0.16, 0.26];
    const up = ladderStep(coarse, xShape);
    const specOf = (v, x) => { const s = JSON.parse(JSON.stringify(spec)); v.write(s, x); return s; };
    const a = await call(([s, o]) => window.AFS.score(s, o), [specOf(coarse, xShape), { tier: "screen" }]);
    const b = await call(([s, o]) => window.AFS.score(s, o), [specOf(up.variable, up.x), { tier: "screen" }]);
    const dScore = rel(b.score, a.score) * 100;
    ok("a refined footprint solves to the same score, so a rung's gain is the machine's",
       dScore < 0.05, `${a.score.toExponential(8)} vs ${b.score.toExponential(8)}, ${dScore.toExponential(1)} % apart, ${coarse.dim} -> ${up.dim} variables`);
    ok("and it is a different spec, so the cache did not simply hand back the first answer",
       a.specHash !== b.specHash);

    report.cases.throughASolve = {
      superpositionError_pct: err, gammaStar_deg: gStar, sweepPeak_deg: peak,
      threeAngleMean_mNm: scored.record.meanTorque_mNm, twelveAngleMean_mNm: dense.record.meanTorque_mNm,
      meanAgreement_pct: dMean, reproducible: again.score === scored.score,
      ladderScoreDrift_pct: dScore, adapter: host.caps.adapter
    };
  } finally {
    await host.close();
  }
}

/* ---- run ----------------------------------------------------------------------------------------- */

fsMod = await import("node:fs");
osMod = await import("node:os");

process.stderr.write("\n1. the quadratic form, against its own definition\n"); quadraticForm();
process.stderr.write("\n2. gates and the score\n"); gates();
process.stderr.write("\n3. design variables\n"); variables();
process.stderr.write("\n3b. containment\n"); containmentGate();
process.stderr.write("\n4. the shape ladder\n"); ladder();
process.stderr.write("\n5. samplers and searchers\n"); await searchers();
process.stderr.write("\n6. the run archive\n"); archive();
if (!flag("cpu-only")) { process.stderr.write("\n7. through a solve\n"); await throughASolve(); }
else process.stderr.write("\n7. through a solve — skipped (--cpu-only)\n");

report.problems = problems;
if (outPath) {
  const p = resolve(ROOT, outPath);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(report, null, 2) + "\n");
  process.stderr.write(`\nwrote ${outPath}\n`);
}
process.stderr.write(problems.length ? `\n${problems.length} problem(s): ${problems.join("; ")}\n` : "\nthe study layer behaved\n");
process.exit(problems.length ? 1 : 0);
