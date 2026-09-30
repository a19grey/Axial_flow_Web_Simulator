#!/usr/bin/env node
/* Run a study for hours without anybody watching.
 *
 *   node cli/study.js run studies/printed-rotor-shape.json --hours 8
 *   node cli/study.js run studies/printed-rotor-shape.json --resume ../axialflow-runs/20260927-2210-...
 *   node cli/study.js list
 *   node cli/study.js report <run-dir>
 *
 * The design is that the *script* holds the state, not a person and not a conversation. A study spec
 * is a file; the run is a directory of append-only JSON Lines outside the repository; the searchers
 * are deterministic given their seed, so the ledger doubles as the evaluation cache and `--resume`
 * needs no checkpoint of anything. Kill it at 3 a.m., restart it at 9, and it picks up having lost
 * only the design it was solving.
 *
 * What it produces is meant to be *looked at*, not just parsed: `best.jsonl` is one line per
 * improvement in order, which is a storyboard, and `runs.html` in this repo flips through it. See
 * `docs/runs.md` for the archive format and `cli/frames.js` for turning a run into a frame sequence.
 *
 * Stages, each optional and each declared in the study spec:
 *
 *   baseline   score the starting design, so everything after it is a comparison
 *   noise      the same design repeatedly (must be bit-identical) and at two or three mesh
 *              refinements, which *measures* the noise floor instead of guessing it. Nothing later
 *              is allowed to chase an improvement smaller than this.
 *   screen     one variable at a time, 2N evaluations: which variables move the score at all
 *   scan       Latin hypercube over the survivors: the shape of the landscape, not the optimum
 *   rankcheck  re-score the scan's designs on the fine mesh and correlate the rankings, which is the
 *              only thing that makes screening on a coarse mesh legitimate
 *   refine     pattern search or CMA-ES from the best scan points
 *   ladder     refine the shape exactly, restart in the larger space at the same design, and record
 *              what the extra freedom bought against the noise floor
 *   confirm    the last few designs on the fine mesh, with the convergence evidence
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { normalizeSpec, specHash, defaultSpec } from "../src/core/spec.js";
import { compileDesign, discreteCombinations } from "../src/study/design.js";
import { gateDesign, checkExpressions, OBJECTIVE_DEFAULTS } from "../src/study/objectives.js";
import { latinHypercube, screenPoints, screenRanking } from "../src/study/sample.js";
import { SEARCHERS } from "../src/study/search.js";
import { ladderStep } from "../src/study/shape.js";
import { PageHost } from "./host.js";
import { RunArchive, listRuns, runId, repairLedger, DEFAULT_RUNS_ROOT } from "./archive.js";

/* ---- study spec ------------------------------------------------------------------------------- */

const DEFAULT_STUDY = {
  study: "untitled",
  baseline: null,
  /* Spec fields the study pins before the search starts, deep-merged onto the baseline. */
  overrides: null,
  seed: 1,
  objective: { ...OBJECTIVE_DEFAULTS },
  /* Mesh overrides per evaluation tier. The screening mesh is the whole reason a scan of a hundred
   * designs is affordable, and `rankcheck` is the stage that earns the right to use it. */
  tiers: { screen: {}, score: {}, confirm: {} },
  variables: [],
  stages: [],
  budget: { evaluations: Infinity, hours: Infinity }
};

/* Deep merge, objects only: arrays and scalars replace wholesale, because a partial array is
 * never what an override means. */
function deepMerge(base, over) {
  if (!over || typeof over !== "object" || Array.isArray(over)) return over === undefined ? base : over;
  const out = Array.isArray(base) ? [...base] : { ...(base || {}) };
  for (const [k, v] of Object.entries(over))
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? deepMerge(out[k], v) : v;
  return out;
}

function loadStudy(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const s = { ...DEFAULT_STUDY, ...raw, objective: { ...OBJECTIVE_DEFAULTS, ...(raw.objective || {}) },
              tiers: { ...DEFAULT_STUDY.tiers, ...(raw.tiers || {}) },
              budget: { ...DEFAULT_STUDY.budget, ...(raw.budget || {}) } };
  const problems = checkExpressions(s.objective);
  if (problems.length) throw new Error("the study's objective does not typecheck:\n  " + problems.join("\n  "));
  let base;
  if (!s.baseline) base = defaultSpec();
  else {
    const p = resolve(dirname(path), s.baseline);
    const q = existsSync(p) ? p : resolve(s.baseline);
    if (!existsSync(q)) throw new Error(`No such baseline spec: ${s.baseline}`);
    base = JSON.parse(readFileSync(q, "utf8"));
  }
  /* Constants the study imposes on the baseline before any variable moves: the containment bound
   * is the motivating case, since "the rotor may not reach past the stator" is a property of the
   * study's question rather than of the baseline machine, and expressing it as a design variable
   * with one legal value would be a lie about what is being searched. */
  s.baselineSpec = normalizeSpec(s.overrides ? deepMerge(base, s.overrides) : base).spec;
  return s;
}

/* A tier's mesh, and the extra rotor angles it averages over. Merged onto the design's own mesh
 * rather than replacing it, so a study only states what it wants to change. */
function atTier(spec, study, tier) {
  const t = study.tiers[tier] || {};
  const out = JSON.parse(JSON.stringify(spec));
  if (t.mesh) out.mesh = { ...out.mesh, ...t.mesh };
  if (t.solver) out.solver = { ...out.solver, ...t.solver };
  return out;
}

/* A mesh refinement factor, for the noise floor and the convergence evidence. Everything that is a
 * cell count scales together; everything that is a ratio or a budget does not. */
function refineMesh(spec, factor) {
  const out = JSON.parse(JSON.stringify(spec));
  const m = out.mesh;
  for (const k of ["activeCellsAcrossDiameter", "cellsAcrossAirGap", "cellsAcrossPoleArc",
                   "cellsAcrossPoleHeight", "cellsAcrossYoke", "cellsAcrossPcb",
                   "cellsAcrossBackPlate", "cellsAcrossDiameter"]) {
    if (Number.isFinite(m[k])) m[k] = Math.max(1, Math.round(m[k] * factor));
  }
  return out;
}

/* ---- the evaluator ----------------------------------------------------------------------------- */

/* One design, evaluated once, recorded once, and never evaluated twice.
 *
 * The cache is the ledger, keyed by spec hash, which makes it honest by construction: two designs
 * share a score only if they are the same design down to the last field the solver reads. It also
 * means a resumed run and a fresh one produce the same archive, and that two overlapping studies of
 * the same machine share work if pointed at the same run directory.
 */
function makeEvaluator({ host, archive, study, stats, log }) {
  return async function evaluate(spec, { stage, tier = "score", tag = {}, vars = null, x = null, lossBudget_W = null } = {}) {
    const tiered = atTier(spec, study, tier);
    const { spec: norm } = normalizeSpec(tiered);
    const hash = specHash(norm);
    /* An explicitly declared loss budget changes the score without changing the spec, so it has to
     * be part of the cache key or two studies sharing a directory would read each other's answers.
     * A budget derived from the baseline needs no suffix: it is a function of the baseline, which
     * the manifest already records, so one directory can only ever hold one of them. */
    const key = study.objective.lossBudget_W === undefined ? hash : `${hash}@${study.objective.lossBudget_W}`;

    const hit = archive.cached(key);
    if (hit) { stats.cacheHits++; return { ...hit, cached: true }; }

    /* Spec-only gates, run here rather than in the page: a trace narrower than the fab allows is
     * not worth a browser round trip, let alone three solves. */
    const pre = gateDesign(norm, null, study.objective);
    if (!pre.feasible) {
      stats.rejected++;
      /* The spec goes down even though nothing was solved. A design rejected on its geometry is one
       * of the more interesting things in the archive — it is a shape the search reached for and
       * could not have — and without its spec the viewer has a gate message and no picture of what
       * tripped it. It costs a kilobyte on the few per cent of designs that fail a gate. */
      return archive.record({ hash, key: key === hash ? undefined : key, stage, tier, tag, vars, x,
                              score: null, feasible: false,
                              rejectedBefore: "solve", gates: pre.gates, metrics: null, cost: { solves: 0, elapsed_ms: 0 } },
                            { spec: norm });
    }

    const t0 = Date.now();
    const r = await host.call(([s, o]) => window.AFS.score(s, o), [norm, { tier, lossBudget_W }]);
    const wall = Date.now() - t0;
    stats.evaluations++; stats.wall_ms += wall;

    if (!r.ok || r.value?.ok === false) {
      const message = r.ok ? r.value.error.message : r.error;
      stats.failed++;
      log(`  design ${hash} failed: ${message}`);
      return archive.record({ hash, key: key === hash ? undefined : key, stage, tier, tag, vars, x,
                              score: null, feasible: false,
                              error: message, gates: null, metrics: null, cost: { solves: 0, elapsed_ms: wall } },
                            { spec: norm });
    }

    const d = r.value.value, rec = d.record;
    const entry = {
      hash, ...(key === hash ? {} : { key }), stage, tier, tag, vars, x,
      score: Number.isFinite(d.score) ? d.score : null,
      feasible: !!d.feasible,
      objective: d.objective,
      gates: (d.gates || []).map(g => ({ name: g.name, pass: g.pass, detail: g.detail ?? null })),
      /* A compact row, so ten thousand of these still load in a browser in one fetch. Everything
       * else is in designs/<hash>.json. */
      metrics: rec ? {
        shear_kPa: rec.meanShear_kPa, torque_mNm: rec.meanTorque_mNm,
        torqueMin_mNm: rec.minTorque_mNm, torqueMax_mNm: rec.maxTorque_mNm,
        ripple_pct: rec.ripple_pct,
        gamma_deg: rec.operatingPoint.currentAngle_elecDeg,
        amps_A: rec.operatingPoint.peakCurrent_A,
        copperLoss_W: rec.operatingPoint.copperLoss_W,
        phaseLeverage_pct: rec.operatingPoint.phaseLeverage_pct,
        confirmError_pct: rec.confirm ? rec.confirm.error_pct : null,
        peakB_mT: rec.results ? rec.results.peakBInMagneticParts_mT : null,
        surfaceSpread_pct: rec.results ? rec.results.torqueSurfaceSpread_pct : null,
        mass_kg: rec.results?.derived?.mass_kg?.total ?? null,
        cells: rec.results ? rec.results.mesh.cells : null,
        gapCells: rec.results ? rec.results.mesh.cellsAcrossAirGap : null,
        iterations: rec.results ? rec.results.solver.iterations : null
      } : null,
      cost: { solves: rec ? rec.cost.solves : 0, elapsed_ms: wall }
    };
    return archive.record(entry, { spec: norm, record: rec });
  };
}

/* ---- stages ------------------------------------------------------------------------------------ */

const spearman = (a, b) => {
  const rank = v => { const idx = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]); const r = new Array(v.length); idx.forEach(([, i], k) => { r[i] = k; }); return r; };
  const ra = rank(a), rb = rank(b), n = a.length;
  const mean = r => r.reduce((s, x) => s + x, 0) / n;
  const ma = mean(ra), mb = mean(rb);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : null;
};

async function runStudy(study, { archive, host, hours, budget, log }) {
  const stats = { evaluations: 0, cacheHits: 0, rejected: 0, failed: 0, wall_ms: 0 };
  const evaluate = makeEvaluator({ host, archive, study, stats, log });
  const started = Date.now();
  const deadline = Number.isFinite(hours) ? started + hours * 3600e3 : Infinity;
  const stop = () => Date.now() >= deadline || stats.evaluations >= budget;

  /* Which tier's score the run's "best" refers to: the one the search itself ran on. Mixing a
   * screening score with a confirm score into one leaderboard would rank meshes, not designs. */
  archive.primaryTier = (study.stages.find(s => s.kind === "ladder") || study.stages.find(s => s.kind === "refine")
    || study.stages.find(s => s.kind === "scan") || {}).tier || "score";

  let design = compileDesign(study.variables, study.baselineSpec);
  const combos = discreteCombinations(design.discrete);
  const report = { stages: [], noiseFloor: null, lossBudget_W: null };
  log(`${design.dim} continuous variables, ${combos.length} discrete combination${combos.length === 1 ? "" : "s"}`);
  log(`variables: ${design.names.join(", ")}`);

  /* One design vector, scored. Everything below goes through this, so the loss budget, the discrete
   * choices, the shape validity check and the archive are applied once rather than per stage. */
  let choices = combos[0], lossBudget_W = null;
  const scoreVector = async (x, stage, tier, tag) => {
    const v = design.validate(x);
    if (!v.ok) {
      const spec = design.apply(x, choices);
      const { spec: norm } = normalizeSpec(spec);
      return archive.record({ hash: specHash(norm), stage, tier, tag, vars: design.describe(x), x,
                              score: null, feasible: false, rejectedBefore: "mesh",
                              gates: [{ name: "shape", pass: false, detail: v.reason }],
                              metrics: null, cost: { solves: 0, elapsed_ms: 0 } });
    }
    return evaluate(design.apply(x, choices), { stage, tier, tag, vars: design.describe(x), x, lossBudget_W });
  };

  for (const st of study.stages) {
    if (stop()) { log(`out of ${Date.now() >= deadline ? "time" : "budget"}; skipping the rest`); break; }
    const t0 = Date.now();
    const elapsedH = () => ((Date.now() - started) / 3600e3).toFixed(2);
    log(`\n--- ${st.kind} --- (${elapsedH()} h in, ${stats.evaluations} evaluations)`);
    const tier = st.tier || "score";
    let out = {};

    if (st.kind === "baseline") {
      const e = await scoreVector(design.x0, "baseline", tier, { event: "baseline" });
      /* The loss budget every later design is scored against: the baseline's own copper loss, so a
       * variant is a statement about equal heat rather than about equal amps. */
      lossBudget_W = study.objective.lossBudget_W ?? e.metrics?.copperLoss_W ?? null;
      report.lossBudget_W = lossBudget_W;
      out = { score: e.score, hash: e.hash, feasible: e.feasible, lossBudget_W,
              gates: e.gates?.filter(g => !g.pass).map(g => g.detail) || [] };
      log(`  baseline ${fmt(e.score)} ${study.objective.maximize}, loss budget ${lossBudget_W === null ? "?" : lossBudget_W.toFixed(3)} W`);

    } else if (st.kind === "noise") {
      /* Two different questions. Repeating the same spec must give a bit-identical score, which is
       * what makes the cache honest; the cache would hide it, so this goes around the cache. Then
       * the same design at two or three mesh refinements says how much the score moves for reasons
       * that are not the design — and no later stage may chase an improvement smaller than that. */
      const spec = design.apply(design.x0, choices);
      const reps = [];
      for (let i = 0; i < (st.repeats ?? 2) && !stop(); i++) {
        const r = await host.call(([s, o]) => window.AFS.score(s, o), [atTier(spec, study, tier), { tier, lossBudget_W }]);
        stats.evaluations++;
        reps.push(r.ok && r.value.ok !== false ? r.value.value.score : null);
      }
      const refs = [];
      for (const f of st.refinements ?? [1, 1.4, 2]) {
        if (stop()) break;
        const e = await evaluate(refineMesh(spec, f), { stage: "noise", tier, tag: { factor: f }, vars: design.describe(design.x0) });
        refs.push({ factor: f, score: e.score, cells: e.metrics?.cells ?? null, elapsed_ms: e.cost.elapsed_ms });
      }
      const good = refs.map(r => r.score).filter(Number.isFinite);
      const base = good.length ? good[good.length - 1] : null;
      const spread = good.length > 1 && base ? (Math.max(...good) - Math.min(...good)) / Math.abs(base) * 100 : null;
      const reproducible = reps.length > 1 && reps.every(v => v === reps[0]);
      report.noiseFloor = { repeats: reps, reproducible, refinements: refs, meshSpread_pct: spread,
                            /* The floor, as a fraction of the score, that everything later respects. */
                            floor_pct: spread };
      out = report.noiseFloor;
      log(`  repeats ${reproducible ? "bit-identical" : "DIFFER: " + reps.join(" vs ")}`);
      log(`  mesh refinement moves the score by ${spread === null ? "?" : spread.toFixed(2) + "%"}` +
          ` (${refs.map(r => `x${r.factor}: ${fmt(r.score)}`).join(", ")})`);

    } else if (st.kind === "screen") {
      const base = archive.best?.score ?? null;
      const pts = screenPoints(design.x0, design.bounds, { fraction: st.fraction ?? 0.25 });
      const results = [];
      for (const p of pts) {
        if (stop()) break;
        const e = await scoreVector(p.x, "screen", tier, { variable: design.names[p.index], direction: p.direction });
        results.push({ index: p.index, score: e.score });
      }
      const floorAbs = report.noiseFloor?.floor_pct && base ? Math.abs(base) * report.noiseFloor.floor_pct / 100 : 0;
      out = { noiseFloorAbsolute: floorAbs, ranking: screenRanking(design.names, results, floorAbs) };
      for (const r of out.ranking.slice(0, 12))
        log(`  ${r.matters === false ? " " : "*"} ${r.name.padEnd(28)} swing ${fmt(r.swing)}${r.infeasibleAt ? `  (${r.infeasibleAt} infeasible)` : ""}`);
      /* Variables whose whole swing is inside the noise floor are dropped, with the measurement
       * kept. This is the step that turns "the space is infinite" into five to eight variables. */
      if (st.drop !== false) {
        const keep = new Set(out.ranking.filter(r => r.matters !== false).map(r => r.name));
        const kept = study.variables.filter(v => !isScalar(v) || keep.has(v.name || v.path));
        out.dropped = study.variables.filter(v => isScalar(v) && !keep.has(v.name || v.path)).map(v => v.name || v.path);
        if (out.dropped.length && kept.length) {
          design = compileDesign(kept, study.baselineSpec);
          log(`  dropped ${out.dropped.join(", ")}; ${design.dim} variables left`);
        }
      }

    } else if (st.kind === "scan") {
      const n = st.points ?? 60;
      const pts = latinHypercube(n, design.bounds, { seed: study.seed + 17 });
      const scored = [];
      for (let i = 0; i < pts.length; i++) {
        if (stop()) break;
        const e = await scoreVector(pts[i], "scan", tier, { index: i, total: pts.length });
        scored.push({ x: pts[i], hash: e.hash, score: e.score });
        if ((i + 1) % 10 === 0) log(`  ${i + 1}/${pts.length}  best on ${tier} ${fmt(archive.bestOn(tier)?.score)}`);
      }
      const feasible = scored.filter(s => s.score !== null);
      out = { points: scored.length, feasible: feasible.length,
              best: feasible.length ? Math.max(...feasible.map(s => s.score)) : null };
      report.scan = scored;
      log(`  ${feasible.length}/${scored.length} feasible, best ${fmt(out.best)}`);

    } else if (st.kind === "rankcheck") {
      /* Screening on a coarse mesh is only legitimate if the coarse mesh *ranks* designs the way the
       * fine one does. If this correlation is low, the multi-fidelity shortcut is invalid and we
       * find out here rather than after a thousand wasted evaluations. */
      const pool = (report.scan || []).filter(s => s.score !== null).slice(0, st.count ?? 20);
      const pairs = [];
      for (const p of pool) {
        if (stop()) break;
        const e = await scoreVector(p.x, "rankcheck", st.against || "score", { from: p.hash });
        if (e.score !== null) pairs.push([p.score, e.score]);
      }
      out = { pairs: pairs.length, spearman: pairs.length > 2 ? spearman(pairs.map(p => p[0]), pairs.map(p => p[1])) : null };
      log(`  screening mesh vs ${st.against || "score"} mesh over ${pairs.length} designs: Spearman ${out.spearman === null ? "?" : out.spearman.toFixed(3)}`);

    } else if (st.kind === "refine") {
      const algo = SEARCHERS[st.algorithm] || SEARCHERS.cmaes;
      const starts = pickStarts(report.scan, design, st.restarts ?? 1);
      const floor = report.noiseFloor?.floor_pct ?? null;
      const results = [];
      for (let k = 0; k < starts.length; k++) {
        if (stop()) break;
        log(`  ${st.algorithm || "cmaes"} restart ${k + 1}/${starts.length}`);
        const r = await algo({
          x0: starts[k], bounds: design.bounds,
          evaluate: async (x, tag) => ({ score: (await scoreVector(x, "refine", tier, { ...tag, restart: k })).score }),
          budget: Math.min(st.budget ?? 200, budget - stats.evaluations),
          deadline, seed: study.seed + 100 * k,
          sigma0: st.sigma0 ?? 0.25,
          step: st.step ?? 0.25,
          /* The step floor is the measured noise floor, not a taste. Below it the poll is comparing
           * two evaluations of the same design through a different mesh. */
          stepMin: st.stepMin ?? (floor ? Math.max(0.005, floor / 100) : 0.02),
          onGeneration: g => log(`    gen ${g.generation}  best ${fmt(g.best)}${g.sigma ? `  sigma ${g.sigma.toFixed(4)}` : ""}  ${g.evaluations} evals`)
        });
        results.push({ restart: k, score: r.score, evaluations: r.evaluations, stopped: r.stopped, x: r.x });
        log(`    -> ${fmt(r.score)} after ${r.evaluations} evaluations (${r.stopped})`);
      }
      out = { algorithm: st.algorithm || "cmaes", restarts: results.map(({ x, ...r }) => r) };
      report.refine = results;

    } else if (st.kind === "ladder") {
      /* The rung. `refine()` doubles a footprint's control points and returns the *same* curve to the
       * last bit, so the next rung starts not near the previous optimum but exactly at it, and only
       * has to buy what its extra freedom is worth. A rung whose improvement is inside the noise
       * floor is where the parameterization stops being worth refining — which is the measurement
       * this stage exists to make. */
      const from = (report.refine || []).filter(r => r.x).sort((a, b) => b.score - a.score)[0];
      if (!from) { log("  nothing to climb from; the refine stage produced no design"); out = { skipped: true }; }
      else {
        let x = from.x, dsn = design, before = from.score;
        const rungs = [];
        for (const rung of st.rungs ?? [{ algorithm: "cmaes", budget: 150 }]) {
          if (stop()) break;
          const stepped = stepLadder(dsn, x, study, rung);
          if (!stepped) { log("  no shape variable to refine"); break; }
          dsn = stepped.design; x = stepped.x;
          /* The claim, checked rather than trusted: the refined design must score exactly what the
           * coarse one did, because it is the same shape. `scoreVector` reads the `design` binding,
           * so the rung's space becomes the current one here and stays it for the search below. */
          const previous = design;
          design = dsn;
          const same = await scoreVector(x, "ladder", tier, { event: "reentry", dim: dsn.dim });
          const drift = before && same.score !== null ? (same.score - before) / Math.abs(before) * 100 : null;
          log(`  rung at ${dsn.dim} variables re-enters at ${fmt(same.score)} (was ${fmt(before)}, drift ${drift === null ? "?" : drift.toExponential(1) + "%"})`);
          const algo = SEARCHERS[rung.algorithm] || SEARCHERS.cmaes;
          const r = await algo({
            x0: x, bounds: dsn.bounds,
            evaluate: async (xx, tag) => ({ score: (await scoreVector(xx, "ladder", tier, { ...tag, dim: dsn.dim })).score }),
            budget: Math.min(rung.budget ?? 150, budget - stats.evaluations), deadline,
            seed: study.seed + 1000 * (rungs.length + 1), sigma0: rung.sigma0 ?? 0.12,
            onGeneration: g => log(`    gen ${g.generation}  best ${fmt(g.best)}  ${g.evaluations} evals`)
          });
          void previous;
          const gained = before && r.score !== null ? (r.score - before) / Math.abs(before) * 100 : null;
          const floor = report.noiseFloor?.floor_pct ?? null;
          rungs.push({ dim: dsn.dim, reentryScore: same.score, reentryDrift_pct: drift, score: r.score,
                       gain_pct: gained, evaluations: r.evaluations,
                       aboveNoiseFloor: floor === null || gained === null ? null : gained > floor });
          log(`    rung bought ${gained === null ? "?" : gained.toFixed(2) + "%"}` +
              `${floor === null ? "" : gained > floor ? "  (above the noise floor)" : "  (inside the noise floor — this is where refining stops paying)"}`);
          if (r.x) x = r.x;
          before = r.score ?? before;
        }
        out = { rungs };
        report.ladder = { rungs, design: dsn, x };
      }

    } else if (st.kind === "confirm") {
      /* The last few designs, on the fine mesh, plus the independent evidence. A design that does
       * not survive refinement was never a design. */
      const pool = archive.ledger().filter(e => e.score !== null).sort((a, b) => b.score - a.score);
      const seen = new Set(), picks = [];
      for (const e of pool) { if (seen.has(e.hash) || !e.x) continue; seen.add(e.hash); picks.push(e); if (picks.length >= (st.count ?? 3)) break; }
      const confirmed = [];
      for (const e of picks) {
        if (stop()) break;
        const d = archive.design(e.hash);
        if (!d) continue;
        const fine = await evaluate(d.spec, { stage: "confirm", tier: "confirm", tag: { from: e.hash }, vars: e.vars, x: e.x });
        confirmed.push({ from: e.hash, screenScore: e.score, confirmScore: fine.score, hash: fine.hash,
                         change_pct: e.score ? (fine.score - e.score) / Math.abs(e.score) * 100 : null,
                         ripple_pct: fine.metrics?.ripple_pct ?? null });
        log(`  ${e.hash} ${fmt(e.score)} -> ${fmt(fine.score)} on the confirm tier` +
            `${fine.metrics?.ripple_pct === null || fine.metrics?.ripple_pct === undefined ? "" : `  ripple ${fine.metrics.ripple_pct.toFixed(1)}%`}`);
      }
      out = { confirmed };
      report.confirm = confirmed;
    } else {
      log(`  unknown stage "${st.kind}"; skipped`);
      out = { skipped: true, reason: "unknown stage" };
    }

    report.stages.push({ kind: st.kind, elapsed_ms: Date.now() - t0, ...out, ...(st.kind === "refine" || st.kind === "ladder" ? {} : {}) });
    archive.manifest({ status: "running", stages: report.stages.map(s => ({ kind: s.kind, elapsed_ms: s.elapsed_ms })),
                       evaluations: stats.evaluations, cacheHits: stats.cacheHits, rejected: stats.rejected,
                       failed: stats.failed, primaryTier: archive.primaryTier,
                       bestScore: archive.best?.score ?? null, bestHash: archive.best?.hash ?? null,
                       bestByTier: Object.fromEntries([...archive.bestByTier].map(([t, e]) => [t, { hash: e.hash, score: e.score }])),
                       noiseFloor: report.noiseFloor, lossBudget_W: report.lossBudget_W });
    writeFileSync(join(archive.dir, "report.json"), JSON.stringify(stripHeavy(report), null, 2) + "\n");
  }

  return { report: stripHeavy(report), stats };
}

const isScalar = v => !v.kind && !v.values;
const fmt = v => (v === null || v === undefined || !Number.isFinite(v) ? "-" : v.toPrecision(6));

/* Drop the design vectors out of the report, which are already in the ledger and make the report
 * unreadable. */
function stripHeavy(report) {
  const out = JSON.parse(JSON.stringify({ ...report, scan: undefined, refine: undefined, ladder: undefined }));
  if (report.scan) out.scanSummary = { points: report.scan.length, best: Math.max(...report.scan.map(s => s.score ?? -Infinity)) };
  if (report.refine) out.refineSummary = report.refine.map(({ x, ...r }) => r);
  if (report.ladder) out.ladderSummary = report.ladder.rungs;
  return out;
}

/* The best few scan points, as independent starting basins rather than one long run from one point. */
function pickStarts(scan, design, n) {
  const good = (scan || []).filter(s => s.score !== null).sort((a, b) => b.score - a.score);
  if (!good.length) return [design.x0];
  const starts = [];
  for (const g of good) {
    if (starts.length >= n) break;
    // Keep restarts genuinely separate: a start within a tenth of the box of an existing one is the
    // same basin and a second run from it buys nothing.
    const far = starts.every(s => Math.hypot(...s.map((v, i) => (v - g.x[i]) / (design.bounds[i][1] - design.bounds[i][0]))) > 0.1 * Math.sqrt(design.dim));
    if (far) starts.push(g.x);
  }
  return starts.length ? starts : [good[0].x];
}

/* Rebuild the design with the shape variable refined one rung, and the vector that reproduces the
 * incoming design exactly in the larger space. */
function stepLadder(design, x, study, rung) {
  const g = design.groups.find(v => v.curve);
  if (!g) return null;
  const stepped = ladderStep(g, x.slice(g.offset, g.offset + g.dim), { releaseU: rung.releaseU ?? null });
  const decls = study.variables.map(v => {
    if (v.kind === "footprint" || v.kind === "footprint.twoChain" || v.kind === "footprint.control") {
      const s = stepped.variable;
      return { kind: "footprint.control", name: v.name, target: s.target, controlPoints: s.meta.template.control,
               degree: s.meta.degree, fixU: s.meta.fixU, chordTolerance_mm: s.meta.chordTolerance_mm,
               uRange: v.uRange, vRange: v.vRange };
    }
    return v;
  });
  const next = compileDesign(decls, study.baselineSpec);
  /* Carry every other variable's value across unchanged, and drop the refined shape's own values in
   * at its new offset. */
  const xs = next.x0.slice();
  for (const ng of next.groups) {
    const og = design.groups.find(o => (o.name || o.kind) === (ng.name || ng.kind));
    if (!og) continue;
    if (ng.curve && og.curve) for (let i = 0; i < ng.dim; i++) xs[ng.offset + i] = stepped.x[i];
    else if (ng.dim === og.dim) for (let i = 0; i < ng.dim; i++) xs[ng.offset + i] = x[og.offset + i];
  }
  return { design: next, x: xs };
}

/* ---- commands ---------------------------------------------------------------------------------- */

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] === undefined || argv[i + 1].startsWith("--")) out[a.slice(2)] = true;
      else out[a.slice(2)] = argv[++i];
    } else out._.push(a);
  }
  return out;
}

const USAGE = `axial-flux study driver — long headless optimization runs

  node cli/study.js run <study.json> [options]
  node cli/study.js list [--runs-root <dir>]
  node cli/study.js report <run-dir>

  --hours <h>          stop cleanly after this many hours (default: the study's own budget)
  --budget <n>         stop after this many evaluations
  --out <dir>          the run directory to create (default: <runs-root>/<timestamp>-<study>)
  --resume <dir>       carry on in an existing run directory; already-scored designs are free
  --runs-root <dir>    where runs live. Default ../axialflow-runs, i.e. beside the checkout and
                       deliberately outside it — results are not repository contents
  --allow-software     proceed on a software WebGPU adapter (about a thousand times too slow)
  --dry-run            compile the study, print the variables and the plan, solve nothing
  --force              write a run directory that another process holds a lock on

  node cli/study.js repair <run-dir>

  Collapse a ledger written by more than one process: drop the duplicated designs, renumber, and
  rebuild the storyboard, keeping the original as ledger.jsonl.bak. Refuses if two lines claim the
  same design with different scores, since then the duplication is not the accident it looks like.
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  if (cmd === "list") {
    const runs = listRuns(args["runs-root"] || DEFAULT_RUNS_ROOT);
    if (!runs.length) process.stdout.write(`no runs under ${args["runs-root"] || DEFAULT_RUNS_ROOT}\n`);
    for (const r of runs) process.stdout.write(
      `${r.runId}  ${String(r.status || "?").padEnd(9)} ${String(r.evaluations ?? "-").padStart(6)} evals  best ${fmt(r.best)}  ${r.objective || ""}\n`);
    return;
  }
  if (cmd === "repair") {
    const dir = args._[1];
    if (!dir) throw new Error("repair needs a run directory");
    const r = repairLedger(dir);
    process.stdout.write(`kept ${r.kept}, dropped ${r.dropped} duplicate line(s), ${r.improvements} improvements\n` +
                         `the original is at ${r.backup}\n`);
    return;
  }
  if (cmd === "report") {
    const dir = args._[1];
    if (!dir) throw new Error("report needs a run directory");
    const a = new RunArchive(dir);
    const led = a.ledger(), story = a.storyboard();
    process.stdout.write(JSON.stringify({
      manifest: JSON.parse(readFileSync(join(a.dir, "run.json"), "utf8")),
      evaluations: led.length,
      feasible: led.filter(e => e.score !== null).length,
      improvements: story.length,
      best: story[story.length - 1] || null
    }, null, 2) + "\n");
    return;
  }
  if (cmd !== "run" || !args._[1]) { process.stderr.write(USAGE); process.exit(cmd ? 2 : 0); }

  const study = loadStudy(resolve(args._[1]));
  const hours = Number.isFinite(+args.hours) ? +args.hours : (Number.isFinite(study.budget.hours) ? study.budget.hours : Infinity);
  const budget = Number.isFinite(+args.budget) ? +args.budget : (Number.isFinite(study.budget.evaluations) ? study.budget.evaluations : Infinity);

  if (args["dry-run"]) {
    const design = compileDesign(study.variables, study.baselineSpec);
    process.stdout.write(JSON.stringify({
      study: study.study, objective: study.objective.maximize,
      dimension: design.dim, variables: design.names,
      bounds: design.bounds, x0: design.x0,
      discrete: discreteCombinations(design.discrete),
      stages: study.stages.map(s => s.kind),
      /* The gates on the design the study will actually start from, which is the baseline with the
       * variables' own initial values stamped onto it — not the baseline spec as written. Those
       * differ whenever a variable's `init` is not the baseline's value, and reporting the wrong
       * one either invents a failure or hides a real one. */
      gatesOnBaseline: gateDesign(design.apply(design.x0), null, study.objective).gates
    }, null, 2) + "\n");
    return;
  }

  const root = args["runs-root"] || DEFAULT_RUNS_ROOT;
  mkdirSync(root, { recursive: true });
  const archive = args.out && !args.resume
    ? RunArchive.open({ resume: resolve(args.out) })          // an explicit directory, created or continued
    : RunArchive.open({ root, id: runId(study.study), resume: args.resume || null });
  const dir = archive.dir;

  const stale = archive.lock({ force: !!args.force });
  const log = s => { process.stderr.write(s + "\n"); archive.log(s); };
  if (stale) log(`taking over a lock left behind by pid ${stale.pid} on ${stale.host}`);
  if (archive.seq > 0) log(`resuming ${dir}: ${archive.seq} evaluations already scored, ${archive.byHash.size} distinct designs`);
  log(`run directory: ${dir}`);
  log(`study "${study.study}"  objective ${study.objective.maximize}  seed ${study.seed}`);
  if (Number.isFinite(hours)) log(`stopping after ${hours} h`);

  const host = new PageHost({ allowSoftware: !!args["allow-software"], onLog: log });
  const caps = await host.start();
  archive.manifest({
    study: study.study, studyFile: resolve(args._[1]), studySpec: study,
    baselineName: study.baselineSpec.name,
    objective: study.objective.maximize, seed: study.seed,
    started: new Date().toISOString(), status: "running",
    adapter: caps.adapter, softwareAdapter: !!caps.software,
    budget: { hours, evaluations: budget }
  });

  let status = "complete", failure = null;
  const onSignal = () => { status = "interrupted"; log("\ninterrupted; the archive is already on disk"); };
  process.on("SIGINT", () => { onSignal(); process.exit(130); });

  try {
    const { report, stats } = await runStudy(study, { archive, host, hours, budget, log });
    log(`\n${stats.evaluations} evaluations, ${stats.cacheHits} cache hits, ${stats.rejected} rejected before solving, ${stats.failed} failed`);
    log(`best ${fmt(archive.best?.score)} ${study.objective.maximize} on the ${archive.primaryTier} tier  (${archive.best?.hash})`);
    for (const [t, e] of archive.bestByTier) if (t !== archive.primaryTier) log(`  best on ${t}: ${fmt(e.score)} (${e.hash})`);
    archive.manifest({ status, finished: new Date().toISOString(), report, ...stats,
                       primaryTier: archive.primaryTier,
                       bestScore: archive.best?.score ?? null, bestHash: archive.best?.hash ?? null,
                       bestByTier: Object.fromEntries([...archive.bestByTier].map(([t, e]) => [t, { hash: e.hash, score: e.score }])) });
  } catch (e) {
    status = "failed"; failure = e.message;
    archive.manifest({ status, error: failure, finished: new Date().toISOString() });
    log(`\nstudy failed: ${failure}`);
  } finally {
    await host.close();
    archive.unlock();
  }
  process.stdout.write(JSON.stringify({ runDir: dir, status, error: failure,
                                        best: archive.best ? { hash: archive.best.hash, score: archive.best.score, vars: archive.best.vars } : null }, null, 2) + "\n");
  if (status === "failed") process.exit(1);
}

main().catch(e => { process.stderr.write(`\nerror: ${e.message}\n${e.stack || ""}\n`); process.exit(1); });
