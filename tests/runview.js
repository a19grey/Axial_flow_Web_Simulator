#!/usr/bin/env node
/* The run viewer, against a synthetic archive.
 *
 *   node tests/runview.js [--out tests/out/runview.json]
 *
 * No GPU and no study: the fixture is a hand-written archive with three designs in it — one that
 * scores, one rejected on its geometry, and one whose design vector sits on its bounds — so this
 * suite runs anywhere, including CI, and takes a few seconds.
 *
 * What it is for. The viewer's job is to explain itself: every term it prints carries a definition,
 * and the definitions for the design vector are *generated* from the study's own declaration in the
 * manifest rather than written down anywhere. Both halves of that can rot silently. A row renamed
 * without its glossary entry loses its tooltip and nobody notices by looking; a change to how a
 * study declares a variable turns generated help into nonsense while the page still renders. Neither
 * shows up in a screenshot, so it is checked here.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { serveEphemeral } from "../cli/serve.js";
import { normalizeSpec, specHash } from "../src/core/spec.js";
import { footprintCurve, footprintLoft } from "../src/core/ir.js";
import { curveFrame } from "../src/core/curves.js";
import { loftHeights } from "../src/runview/loft.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const outPath = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;

let failures = 0;
const report = { cases: {} };
function ok(what, pass, detail = "") {
  if (!pass) failures++;
  process.stderr.write(`  ${pass ? "ok  " : "FAIL"}  ${what}${detail ? "  " + detail : ""}\n`);
}

/* ---- the fixture -------------------------------------------------------------------------------- */

/* A study declaring one scalar, one shape and one loft — the three kinds of variable the generated
 * help has to handle — plus a scalar whose write is a plain path rather than an expression. */
const STUDY_SPEC = {
  study: "glossary-fixture",
  objective: { maximize: "shear_kPa" },
  variables: [
    { name: "gapOverRo", min: 0.02, max: 0.08, init: 0.04,
      writes: [{ path: "design.rotor.airGap_mm", expr: "gapOverRo * ro" }] },
    { name: "fill", min: 0.2, max: 1.0, init: 0.85, path: "design.stator.fillFraction" },
    { kind: "footprint", name: "pole", target: "design.rotor.poleCurve", stations: 2, maxV: 0.4 },
    { kind: "loft", name: "sweep", target: "design.rotor.poleLoft", channels: { scale: 3 },
      scaleRange: [0.6, 1.2] },
    { kind: "footprint", name: "coil", target: "design.stator.coilCurve", stations: 2, maxV: 0.45 }
  ]
};

const VARS = {
  scored:   { gapOverRo: 0.05, fill: 0.84, "pole.trail0": -0.2, "pole.trail1": -0.25,
              "pole.lead0": 0.2, "pole.lead1": 0.25, "sweep.scale0": 1, "sweep.scale1": 1.1,
              "sweep.scale2": 0.95, "coil.trail0": -0.3, "coil.trail1": -0.35,
              "coil.lead0": 0.3, "coil.lead1": 0.35 },
  /* Two kinds of bound: a scalar on its floor, which means the box is in the way, and an edge chain
   * on the zero it shares with the other chain, which means the shape has collapsed. The help has
   * to say different things about them. */
  pinned:   { gapOverRo: 0.02, fill: 1.0, "pole.trail0": -0.4, "pole.trail1": 0,
              "pole.lead0": 0.4, "pole.lead1": 0.01, "sweep.scale0": 1.2, "sweep.scale1": 0.6,
              "sweep.scale2": 1, "coil.trail0": -0.45, "coil.trail1": -0.2,
              "coil.lead0": 0.45, "coil.lead1": 0.2 },
  /* Refined past a ladder rung: free control points, whose per-point box this page declines to
   * guess at. It must still describe them. */
  refined:  { gapOverRo: 0.05, fill: 0.84, "pole.v0": -0.2, "pole.v1": -0.25, "pole.v2": 0.2,
              "pole.v3": 0.25, "sweep.scale0": 1, "sweep.scale1": 1.1, "sweep.scale2": 0.95,
              "coil.v0": -0.3, "coil.v1": -0.35, "coil.v2": 0.3, "coil.v3": 0.35 }
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "afs-runview-"));
  const dir = join(root, "20260101-000000-glossary-fixture");
  mkdirSync(join(dir, "designs"), { recursive: true });

  const base = JSON.parse(readFileSync(join(ROOT, "src/cases/printed-rotor-demo.json"), "utf8"));
  const { spec } = normalizeSpec(base);
  const hash = specHash(spec);

  const metrics = { shear_kPa: 0.0312, torque_mNm: 4.4, ripple_pct: 48.2, gamma_deg: 45.06,
                    amps_A: 8.38, copperLoss_W: 497.5, peakB_mT: 712, surfaceSpread_pct: 1.5,
                    confirmError_pct: 1.3e-4, mass_kg: 0.21, cells: 1.2e6, gapCells: 8,
                    iterations: 311 };
  const rows = [
    { seq: 0, hash, stage: "baseline", tier: "score", score: 0.0312, objective: "shear_kPa",
      feasible: true, vars: VARS.scored, metrics, cost: { solves: 9, elapsed_ms: 2400 },
      gates: [{ name: "manufacturability", pass: true }], spec },
    { seq: 1, hash: hash.slice(0, -2) + "aa", stage: "refine", tier: "score", score: 0.0351,
      objective: "shear_kPa", feasible: true, vars: VARS.pinned, metrics,
      cost: { solves: 9, elapsed_ms: 2300 }, gates: [{ name: "manufacturability", pass: true }],
      spec },
    { seq: 2, hash: hash.slice(0, -2) + "bb", stage: "ladder", tier: "score", score: 0.0355,
      objective: "shear_kPa", feasible: true, vars: VARS.refined, metrics,
      cost: { solves: 9, elapsed_ms: 2300 }, gates: [{ name: "manufacturability", pass: true }],
      spec },
    /* Rejected on its geometry, and carrying its spec, which is what the viewer needs to draw the
     * shape that got it thrown out. */
    { seq: 3, hash: hash.slice(0, -2) + "cc", stage: "scan", tier: "score", score: null,
      objective: "shear_kPa", feasible: false, rejectedBefore: "solve", vars: VARS.scored,
      metrics: null, cost: { solves: 0, elapsed_ms: 0 },
      gates: [{ name: "containment", pass: false, detail: "the pole reaches 1.4 mm past the stator rim" }],
      spec }
  ];

  const ledger = rows.map(({ spec: _s, ...r }) => r);
  writeFileSync(join(dir, "ledger.jsonl"), ledger.map(r => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(join(dir, "best.jsonl"), JSON.stringify(ledger[0]) + "\n");
  for (const r of rows)
    writeFileSync(join(dir, "designs", `${r.hash}.json`),
                  JSON.stringify({ hash: r.hash, seq: r.seq, spec: r.spec, record: null }) + "\n");
  writeFileSync(join(dir, "run.json"), JSON.stringify({
    archiveVersion: 1, runId: "20260101-000000-glossary-fixture", study: "glossary-fixture",
    studySpec: STUDY_SPEC, objective: "shear_kPa", seed: 1, started: "2026-01-01T00:00:00.000Z",
    status: "complete", adapter: "apple metal-3", softwareAdapter: false,
    primaryTier: "score", bestScore: 0.0355, evaluations: 4, cacheHits: 0,
    noiseFloor: { floor_pct: 1.64 }, lossBudget_W: 497.52, commit: "0".repeat(40)
  }, null, 2) + "\n");
  return { root, runId: "20260101-000000-glossary-fixture" };
}

/* ---- which heights a lofted pole is drawn at ---------------------------------------------------- */

/* Pure, so it runs before the browser does.
 *
 * A loft channel is a Bezier against height and a Bezier interpolates only its end control values.
 * So the two face outlines — gap face and yoke — do not bound the shape: `scale: [1, 1.3, 1]` bulges
 * 15 % at mid-height with *identical* faces, and drawing only the faces shows it as unlofted under a
 * caption saying it is lofted. The viewer therefore looks for an interior section that reaches
 * outside the pair. The thing to get right is both directions at once: catch every non-monotone
 * loft, and stay quiet on every monotone one, where the interior sections lie between the two
 * outlines a reader can already see. */
function loftSections() {
  const demo = JSON.parse(readFileSync(join(ROOT, "src/cases/printed-rotor-demo.json"), "utf8"));
  const curve = footprintCurve(demo.design.rotor.poleCurve);
  const frame = curveFrame({ r0: 21, r1: 53, centre: 0, count: 8 });
  const find = spec => loftHeights(curve, frame, footprintLoft(spec)).find(h => h.kind === "extreme") || null;

  ok("no loft at all is one outline, not three",
     loftHeights(curve, frame, null).length === 1);

  /* Monotone: every interior section is between the faces, so there is nothing a third line adds. */
  for (const [what, spec] of [["a taper", { scale: [1, 0.8] }], ["a widening", { widen: [1, 1.2] }],
                              ["a twist", { twist: [0, 0.045] }]])
    ok(`${what} that only ramps is drawn as two outlines`, find(spec) === null);

  /* Non-monotone: the interior reaches outside the pair, and in the bulge and waist cases the two
   * faces are the same outline, so without this the picture would show no loft whatsoever. */
  const bulge = find({ scale: [1, 1.3, 1] }), waist = find({ scale: [1, 0.7, 1] });
  ok("a pole that bulges at mid-height and comes back is not drawn as unlofted",
     bulge !== null && Math.abs(bulge.s - 0.5) < 0.05, bulge ? `found at ${bulge.s.toFixed(2)}` : "missed");
  ok("and neither is one that waists", waist !== null && Math.abs(waist.s - 0.5) < 0.05);
  ok("a twist that swings out and back is caught too, which no measure of size would notice",
     find({ twist: [0, 0.12, 0] }) !== null);
  ok("the demo rotor's own widest section is interior, and is drawn",
     find(demo.design.rotor.poleLoft) !== null);

  /* The threshold is relative to the annulus, so it means the same thing at any diameter. */
  ok("a loft too slight to see is left alone", find({ scale: [1, 1.002, 1] }) === null);
  const big = loftHeights(curve, curveFrame({ r0: 210, r1: 530, centre: 0, count: 8 }),
                          footprintLoft({ scale: [1, 1.002, 1] })).find(h => h.kind === "extreme") || null;
  ok("and that judgement is scale-free: ten times the machine, same answer", big === null);

  report.cases.loftSections = { bulge: bulge && bulge.s, demo: !!find(demo.design.rotor.poleLoft) };
}

process.stderr.write("\n0. which heights a lofted pole is drawn at\n"); loftSections();

/* ---- the checks --------------------------------------------------------------------------------- */

const { root, runId } = fixture();
const { server, port } = await serveEphemeral({ runsRoot: root });
const origin = `http://127.0.0.1:${port}`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errs = [];
page.on("pageerror", e => errs.push("pageerror: " + e.message));
page.on("console", m => { if (m.type() === "error") errs.push("console: " + m.text()); });

try {
  await page.goto(`${origin}/runs.html?run=${runId}`, { waitUntil: "load" });
  await page.waitForFunction(() => window.RUNVIEW && window.RUNVIEW.ready, { timeout: 60000 });

  const audit = () => page.evaluate(() => {
    const terms = [...document.querySelectorAll("#runmeta dt, #vars dl dt, #vars table.vars th")];
    const tip = e => e.getAttribute("title") || "";
    return {
      count: terms.length,
      untitled: terms.filter(e => !tip(e)).map(e => e.textContent),
      tooShort: terms.filter(e => tip(e) && tip(e).length < 40).map(e => e.textContent),
      byName: Object.fromEntries(terms.map(e => [e.textContent, tip(e)]))
    };
  });

  process.stderr.write("\n1. every term the viewer prints carries a definition\n");
  await page.evaluate(() => window.RUNVIEW.setMode("all"));
  let worst = null;
  const undefined_ = new Set(), stubs = new Set();
  for (let i = 0; i < 4; i++) {
    await page.evaluate(k => window.RUNVIEW.goto(k), i);
    const a = await audit();
    for (const t of a.untitled) undefined_.add(t);
    for (const t of a.tooShort) stubs.add(t);
    if (!worst || a.count < worst.count) worst = a;
  }
  ok("every term on every design in the fixture has a definition",
     undefined_.size === 0, [...undefined_].join(", "));
  /* A one-line gloss is not a definition. The threshold is crude on purpose: it cannot judge whether
   * a definition is *good*, only that somebody wrote more than a restatement of the label. */
  ok("and none of them is a one-line restatement of its own label",
     stubs.size === 0, [...stubs].join(", ") || `fewest terms on one design: ${worst.count}`);
  report.cases.coverage = { fewestTerms: worst.count, undefined: [...undefined_], stubs: [...stubs] };

  process.stderr.write("\n2. the design vector documents itself from the study's own declaration\n");
  await page.evaluate(() => window.RUNVIEW.goto(0));
  let v = (await audit()).byName;
  ok("a scalar names the spec field and the expression it writes",
     /design\.rotor\.airGap_mm|the air gap/.test(v.gapOverRo) && /gapOverRo \* ro/.test(v.gapOverRo),
     v.gapOverRo.slice(0, 70) + "…");
  ok("and its bounds come from the study, not from this page",
     /Range 0\.02 to 0\.08/.test(v.gapOverRo));
  ok("a direct path write is not described as an expression",
     /fill fraction/.test(v.fill) && !/to fill\b/.test(v.fill));
  ok("an edge-chain station explains the v coordinate and its pitch units",
     /units of the feature's own pitch/.test(v["pole.trail0"]) && /±0\.5/.test(v["pole.trail0"]));
  ok("a loft channel says what its control count makes it",
     /3 control values/.test(v["sweep.scale1"]) && /quadratic/.test(v["sweep.scale1"]));
  ok("and reads its range from the study's own override",
     /Range 0\.6 to 1\.2/.test(v["sweep.scale1"]));
  ok("a shape member names the group it belongs to and the field that group writes",
     /design\.stator\.coilCurve/.test(v["coil.trail0"]));

  process.stderr.write("\n3. a value on a bound says so, and says which kind of bound\n");
  await page.evaluate(() => window.RUNVIEW.goto(1));
  v = (await audit()).byName;
  ok("a scalar on its floor is called out as the box being in the way",
     /on its lower bound/.test(v.gapOverRo) && /box is too small/.test(v.gapOverRo));
  ok("a scalar on its ceiling likewise", /on its upper bound/.test(v.fill));
  ok("but an edge chain on the centre line is not: that bound is the shape, not the box",
     /centre line/.test(v["pole.trail1"]) && !/box is too small/.test(v["pole.trail1"]),
     v["pole.trail1"].split("Range").pop().trim().slice(0, 80) + "…");
  ok("while the same chain's outer bound is the box",
     /box is too small/.test(v["pole.lead0"]));
  report.cases.bounds = { pinnedScalar: /lower bound/.test(v.gapOverRo),
                          centreLine: /centre line/.test(v["pole.trail1"]) };

  process.stderr.write("\n4. a vector refined past a ladder rung\n");
  await page.evaluate(() => window.RUNVIEW.goto(2));
  v = (await audit()).byName;
  ok("free control points are described", /control point 1/.test(v["coil.v1"]));
  ok("and no range is invented for them, since their box is per-point",
     !/Range/.test(v["coil.v1"]), v["coil.v1"].slice(-60));

  process.stderr.write("\n5. a design rejected on its geometry\n");
  await page.evaluate(() => window.RUNVIEW.goto(3));
  const rej = await page.evaluate(() => ({
    gate: document.querySelector(".gates .bad")?.textContent || "",
    terms: [...document.querySelectorAll("#vars dl dt")].length,
    untitled: [...document.querySelectorAll("#vars dl dt, #vars table.vars th")]
      .filter(e => !e.getAttribute("title")).length,
    wound: [...document.querySelectorAll("#vars dl dt")].some(e => e.textContent === "turns per coil")
  }));
  ok("the gate it failed is shown", /reaches 1\.4 mm past/.test(rej.gate));
  ok("its winding is still routed and drawn, because the spec went down with the rejection",
     rej.wound);
  ok("and nothing on its panel lost its definition", rej.untitled === 0);

  process.stderr.write("\n6. the page explains itself without a tooltip too\n");
  const about = await page.evaluate(() => {
    const el = document.querySelector("#about");
    return { present: !!el, collapsedByDefault: el && !el.open,
             headings: [...document.querySelectorAll("#about h3")].map(h => h.textContent),
             chars: (document.querySelector("#about .body")?.textContent || "").length,
             defines: ["riOverRo", "gapOverRo", "poleHeightOverGap", "yokeOverRo", "fill"]
               .filter(n => (document.querySelector("#about .body")?.textContent || "").includes(n)) };
  });
  ok("there is a written section describing the tool", about.present && about.chars > 2000,
     `${about.chars} characters`);
  ok("collapsed by default, but real DOM either way — an agent reading the page finds it",
     about.collapsedByDefault);
  ok("it names every scalar the studies use", about.defines.length === 5, about.defines.join(", "));
  ok("and covers what a score is, how a run is organized, and what to distrust",
     about.headings.length >= 5, about.headings.join(" / "));
  report.cases.about = { headings: about.headings, chars: about.chars };

  process.stderr.write("\n7. and it did all that without a page error\n");
  ok("no page errors, no failed fetches", errs.length === 0, errs.join(" | "));
} finally {
  await browser.close();
  server.close();
  rmSync(root, { recursive: true, force: true });
}

report.failures = failures;
if (outPath) {
  mkdirSync(resolve(ROOT, "tests/out"), { recursive: true });
  writeFileSync(resolve(ROOT, outPath), JSON.stringify(report, null, 2) + "\n");
  process.stderr.write(`\nwrote ${outPath}\n`);
}
process.stderr.write(failures ? `\n${failures} check(s) failed\n` : "\nthe run viewer explains itself\n");
process.exit(failures ? 1 : 0);
