#!/usr/bin/env node
/* The geometry language: expressions today, profiles and traced coils as they land.
 *
 * Everything here is CPU-only and runs in milliseconds — no GPU, no browser, no mesh. That is
 * deliberate: the geometry layer is where an authoring mistake turns into a plausible-looking
 * wrong machine, so its checks should be cheap enough to run on every edit rather than reserved
 * for a nightly.
 *
 *   node tests/geometry.js [--out report.json]
 */

import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { evalExpr, resolveScope, dependencies, parseExpr, field, ExprError } from "../src/core/expr.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const problems = [];
const report = { generatedAt: new Date().toISOString(), cases: {} };
const ok = (label, cond, detail = "") => {
  process.stderr.write(`  ${cond ? "ok  " : "FAIL"}  ${label}${detail ? "  " + detail : ""}\n`);
  if (!cond) problems.push(label);
};
const near = (a, b, tol = 1e-12) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

/* What the error said, or null if it did not throw. Expression errors are a feature of this
 * module rather than an edge case — an agent authoring geometry reads them and tries again — so
 * they are asserted on as closely as the values are. */
function threw(fn) {
  try { fn(); return null; } catch (e) { return e; }
}

/* ---- arithmetic ------------------------------------------------------------------------------ */

function arithmetic() {
  process.stderr.write("\n1. expression arithmetic\n");
  const scope = { ri: 15, ro: 40, poles: 8, turns: 10 };
  const cases = [
    ["17", 17], ["  -4.5 ", -4.5], ["1e-3", 1e-3], [".5", 0.5], ["2.5e2", 250],
    ["ri + 1", 16], ["ro - ri", 25], ["2 * ri + ro / 2", 50], ["(ri + ro) / 2", 27.5],
    // Precedence and associativity: multiplication over addition, power right to left, unary last.
    ["1 + 2 * 3", 7], ["2 ^ 3 ^ 2", 512], ["-2 ^ 2", -4], ["2 ^ -3", 0.125],
    ["7 % 3", 1], ["-ri", -15], ["- -ri", 15], ["2 * -ri", -30],
    ["min(ro - 1, 2 * ri)", 30], ["max(1, 2, 3, ri)", 15], ["hypot(3, 4)", 5],
    ["clamp(ri, 20, 30)", 20], ["atan2(1, 1)", Math.PI / 4], ["round(2.5)", 3],
    ["deg(pi)", 180], ["rad(180)", Math.PI], ["tau / poles", Math.PI / 4],
    // Constants are shadowable: a design that wants a parameter named `e` gets one.
    ["e", Math.E]
  ];
  let bad = 0;
  for (const [src, want] of cases) {
    const got = evalExpr(src, scope);
    if (!near(got, want)) { bad++; process.stderr.write(`        ${src} -> ${got}, wanted ${want}\n`); }
  }
  ok(`${cases.length} expressions evaluate correctly`, bad === 0, `${cases.length - bad}/${cases.length}`);
  ok("a parameter shadows a constant of the same name", evalExpr("e * 2", { e: 10 }) === 20);
  ok("a plain number passes through unevaluated", evalExpr(42) === 42);
  ok("dependencies are the names read, and only those",
     [...dependencies("max(a, b) + c * 2 - min(a, 3)")].sort().join(",") === "a,b,c");
  ok("a number has no dependencies", dependencies(7).size === 0);
  report.cases.arithmetic = { count: cases.length, failed: bad };
}

/* ---- the grammar refuses what it should ------------------------------------------------------- */

function refusals() {
  process.stderr.write("\n2. the grammar is closed\n");
  /* Each of these is a way an expression language accidentally becomes a code-execution surface,
   * or a way a typo becomes a silent wrong number. Both must be errors, not results. */
  const bad = [
    ["a = 1", "assignment"],
    ["ri; ro", "statement separator"],
    ["this.constructor", "member access"],
    ["Math.sqrt(4)", "host object"],
    ["(() => 1)()", "function literal"],
    ["`x`", "template string"],
    ["ri ro", "two terms with no operator"],
    ["2 +", "a trailing operator"],
    ["(1 + 2", "an unclosed bracket"],
    ["1 / 0", "a result that is not finite"],
    ["sqrt(-1)", "a result that is not a number"],
    ["nosuchname", "an unknown name"],
    ["nosuchfunc(1)", "an unknown function"],
    ["atan2(1)", "the wrong argument count"],
    ["min()", "a variadic with no arguments"]
  ];
  let missed = 0;
  for (const [src, why] of bad) {
    const e = threw(() => evalExpr(src, { ri: 15, ro: 40 }));
    if (!e) { missed++; process.stderr.write(`        ${JSON.stringify(src)} (${why}) was accepted\n`); }
    else if (!(e instanceof ExprError)) { missed++; process.stderr.write(`        ${JSON.stringify(src)} threw ${e.constructor.name}, not ExprError\n`); }
  }
  ok(`${bad.length} malformed or unsafe expressions are refused`, missed === 0, `${bad.length - missed}/${bad.length}`);

  // Nothing in the language can reach the host: evaluating cannot set a global.
  globalThis.__exprEscape = undefined;
  threw(() => evalExpr("__exprEscape", {}));
  ok("evaluation cannot read a global", globalThis.__exprEscape === undefined &&
     threw(() => evalExpr("globalThis", {})) instanceof ExprError);
  report.cases.refusals = { count: bad.length, missed };
}

/* ---- error messages are usable ---------------------------------------------------------------- */

function messages() {
  process.stderr.write("\n3. errors name the mistake and the fix\n");
  const unknown = threw(() => evalExpr("innerRadius + 1", { innerRadius_mm: 3, ri: 1 }));
  ok("an unknown name suggests the nearest one in scope",
     /Did you mean "innerRadius_mm"/.test(unknown.message), unknown.message.slice(0, 80));
  ok("an unknown name lists what was in scope", /Available:.*\bri\b/.test(unknown.message));

  const fn = threw(() => evalExpr("sqr(4)"));
  ok("an unknown function suggests a real one", /Unknown function "sqr"/.test(fn.message) && /sqrt/.test(fn.message));

  const syntax = threw(() => evalExpr("2 * (3 + 4"));
  ok("a syntax error gives the position and the source",
     /position \d+/.test(syntax.message) && syntax.message.includes('"2 * (3 + 4"'));

  const cycle = threw(() => resolveScope({ a: "b + 1", b: "c", c: "a" }));
  ok("a cycle is spelled out as a path", /a -> b -> c -> a/.test(cycle.message), cycle.message);
  ok("a cycle is attributed once, not once per frame",
     (cycle.message.match(/Parameter/g) || []).length === 1, cycle.message);

  const inField = threw(() => field("ri + nope", { ri: 1 }, "geometry.solids[0].profile.r0"));
  ok("a field error names its JSON path",
     inField.message.startsWith("geometry.solids[0].profile.r0:"), inField.message.slice(0, 60));
  ok("a missing required field says so", /is required/.test(threw(() => field(undefined, {}, "x")).message));
  ok("a missing field with a fallback takes it", field(undefined, {}, "x", 3) === 3);
  report.cases.messages = "checked";
}

/* ---- scopes ----------------------------------------------------------------------------------- */

function scopes() {
  process.stderr.write("\n4. scopes resolve in any order\n");
  /* Declaration order must not matter: a spec should read in whatever order makes the design
   * clear, not in whatever order the resolver finds convenient. */
  const defs = { ro: "ri + span", span: "2 * halfSpan", halfSpan: 12.5, ri: 15 };
  const forward = resolveScope(defs);
  const reversed = resolveScope(Object.fromEntries(Object.entries(defs).reverse()));
  ok("resolution is independent of declaration order",
     forward.ro === 40 && reversed.ro === 40 && forward.span === 25, `ro = ${forward.ro}`);

  const withBase = resolveScope({ half: "polePitch / 2", arc: "half * frac", frac: 0.62 },
                                { polePitch: Math.PI / 4 });
  ok("a definition can read a landmark from the base scope",
     near(withBase.half, Math.PI / 8) && near(withBase.arc, Math.PI / 8 * 0.62));
  ok("the base scope survives resolution", near(withBase.polePitch, Math.PI / 4));

  const shadow = resolveScope({ polePitch: 1 }, { polePitch: 2 });
  ok("a definition shadows a base landmark of the same name", shadow.polePitch === 1);

  ok("an empty scope resolves to the base", Object.keys(resolveScope()).length === 0);

  // A definition that fails must not leave a half-built scope behind for the next caller.
  const before = resolveScope({ a: 1 });
  ok("a failed scope throws rather than returning partial values",
     threw(() => resolveScope({ a: 1, b: "nope" })) instanceof ExprError && before.a === 1);
  report.cases.scopes = "checked";
}

/* ---- parsing is stable ------------------------------------------------------------------------ */

function reuse() {
  process.stderr.write("\n5. a parsed expression is reusable and cheap\n");
  const tree = parseExpr("ri * 2 + offset");
  ok("the same source parses to a tree once", tree && tree.op === "+");
  /* A sweep evaluates the same expression thousands of times against different scopes; the cost
   * has to be evaluation, not re-parsing. This is a floor on speed, not a benchmark: it fails
   * only if something has gone badly wrong, such as parsing inside the evaluator. */
  const t0 = performance.now();
  let acc = 0;
  for (let i = 0; i < 20000; i++) acc += evalExpr("ri * 2 + offset", { ri: i, offset: 1 });
  const ms = performance.now() - t0;
  ok("20k evaluations complete in well under a second", ms < 1000, `${ms.toFixed(0)} ms`);
  ok("and give the right answer", acc === 20000 * 1 + 2 * (19999 * 20000 / 2));
  report.cases.evaluationsPerSecond = Math.round(20000 / (ms / 1000));
}

/* ---- main ------------------------------------------------------------------------------------- */

const args = process.argv.slice(2);
const outFile = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;

arithmetic();
refusals();
messages();
scopes();
reuse();

if (outFile) {
  await mkdir(dirname(resolve(ROOT, outFile)), { recursive: true });
  await writeFile(resolve(ROOT, outFile), JSON.stringify({ ...report, problems }, null, 2) + "\n");
  process.stderr.write(`\nwrote ${outFile}\n`);
}
process.stderr.write(problems.length ? `\n${problems.length} problem(s):\n  ${problems.join("\n  ")}\n`
                                     : "\nthe geometry language behaved\n");
process.exit(problems.length ? 1 : 0);
