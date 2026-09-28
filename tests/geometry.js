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
import { resolveShape, shapeAt, shapeOutline, shapeAreaFraction, shapeClearance, shapeSwing, DEG } from "../src/core/shapes.js";
import { coilPolys, windingLayout } from "../src/core/geometry.js";
import { closedCurve, curveAt, refine, curveArea, curveAreaFraction, curveFrame, splineThrough,
         loftSchedule, loftAt, loftVolume, tessellate, selfIntersects, curveFromProfile, inspectCurve,
         curveToVector, curveFromVector, curveBounds, bezierAt, CurveError,
         twoSidedCurve, twoSidedFromVector, twoSidedBounds } from "../src/core/curves.js";
import { normalizeSpec } from "../src/core/spec.js";
import { makeMesh, CYLINDRICAL } from "../src/core/mesh.js";
import { polygonRT, polygonMeasure, coverageTable, clampTable, footprintCopies, clipToBand,
         pointInPolygonRT } from "../src/core/raster.js";
import { wedgeSolid, tracedSolid, solidVolume, solidAngularHalf, solidRadialExtent, solidFrame,
         solidHeightFraction, solidProvenance, inspectSolid, footprintCurve, footprintLoft } from "../src/core/ir.js";

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

/* ---- shape profiles --------------------------------------------------------------------------- */

/* The coil builder as it stood before profiles existed. A profiled shape has to be a superset of
 * it, not a replacement for it: every design saved before this feature landed must still produce
 * exactly the same current paths, down to the bit, or the field it solves has quietly moved. */
function legacyCoilPolys(p) {
  const { count: Nc, phase, sense } = windingLayout(p);
  const half = Math.PI / Nc, pitch = p.pitch, edge = p.edge, nArc = p.arcSegments ?? 10;
  const polys = [];
  for (let k = 0; k < Nc; k++) {
    const th = k * 2 * Math.PI / Nc, ph = phase[k];
    for (let j = 0; j < p.turns; j++) {
      const d = edge + j * pitch, ri = p.ri + d, ro = p.ro - d;
      const ai = half - d / ri, ao = half - d / ro;
      if (ro - ri < 1 || ai < 0.02) break;
      const pts = [[ri * Math.cos(th - ai), ri * Math.sin(th - ai)]];
      for (let s = 0; s <= nArc; s++) { const a = th - ao + 2 * ao * s / nArc; pts.push([ro * Math.cos(a), ro * Math.sin(a)]); }
      for (let s = 0; s <= nArc; s++) { const a = th + ai - 2 * ai * s / nArc; pts.push([ri * Math.cos(a), ri * Math.sin(a)]); }
      polys.push({ pts: sense[k] < 0 ? pts.slice().reverse() : pts, ph, coil: k, sense: sense[k] });
    }
  }
  return polys;
}

const COMMA = [
  { atRadius: 0, widthFraction: 0.26, offset_deg: 18 },
  { atRadius: 0.35, widthFraction: 0.5, offset_deg: 11 },
  { atRadius: 0.7, widthFraction: 0.72, offset_deg: 3 },
  { atRadius: 1, widthFraction: 0.8, offset_deg: -4 }
];

function shapes() {
  process.stderr.write("\n6. shape profiles\n");

  // Reading the table: interpolated between rows, held flat outside it.
  const sh = resolveShape({ count: 8, profile: COMMA });
  const pitch = 2 * Math.PI / 8;
  ok("a profile reads its rows back", near(shapeAt(sh, 0).half, 0.5 * 0.26 * pitch) && near(shapeAt(sh, 1).off, -4 * DEG));
  ok("and interpolates linearly between them",
     near(shapeAt(sh, 0.175).half, 0.5 * 0.5 * (0.26 + 0.5) * pitch, 1e-9));
  ok("and holds the end values outside the table",
     shapeAt(sh, -2).half === shapeAt(sh, 0).half && shapeAt(sh, 7).off === shapeAt(sh, 1).off);

  /* The swept area is what the rasterizer is audited against, so it is worth checking against a
   * method that shares nothing with it: brute-force quadrature over 200k radial strips. */
  const r0 = 19, r1 = 51;
  const closed = shapeAreaFraction(sh, r0, r1);
  let num = 0;
  const n = 200000;
  for (let i = 0; i < n; i++) {
    const r = r0 + (r1 - r0) * (i + 0.5) / n;
    num += 2 * shapeAt(sh, (r - r0) / (r1 - r0)).half * r * (r1 - r0) / n;
  }
  const bruteFrac = 8 * num / (Math.PI * (r1 * r1 - r0 * r0));
  ok("the closed-form swept area matches brute-force quadrature",
     Math.abs(closed - bruteFrac) / bruteFrac < 1e-8, `${closed.toFixed(9)} vs ${bruteFrac.toFixed(9)}`);

  // A plain arc is the profile a fraction and a skew describe, so its area is the old formula.
  const plain = resolveShape({ count: 8, fraction: 0.5 });
  ok("a constant-width wedge covers exactly its width fraction", shapeAreaFraction(plain, r0, r1) === 0.5);
  const skewed = resolveShape({ count: 8, fraction: 0.5, skew: 12 * DEG });
  ok("and a skew moves it without resizing it", shapeAreaFraction(skewed, r0, r1) === 0.5);

  /* Clearance is the distinction the YASA-style winding turns on. Neighbouring coils must not
   * touch at any radius, and that is a question about width alone; a centre line that swings
   * further than the coil is wide is the intended overlap along a radius, not a fault. */
  const coil = resolveShape({ count: 12, profile: [
    { atRadius: 0, widthFraction: 0.62, offset_deg: 11 },
    { atRadius: 0.5, widthFraction: 0.78, offset_deg: 3 },
    { atRadius: 1, widthFraction: 0.88, offset_deg: -7 }] });
  const clr = shapeClearance(coil);
  ok("the demo coil clears its neighbour at every radius", !clr.overlaps && clr.gap > 0.01,
     `${(clr.gap / DEG).toFixed(2)}° gap`);
  /* The claim the demo actually makes: sweeping the whole coil over its radial range covers more
   * than one coil pitch, so somewhere there is an angle at which a straight radial line leaves one
   * coil and enters its neighbour. That needs the centre line to swing, but how far is not a fixed
   * multiple of the width — it is this comparison, against the pitch. */
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i <= 200; i++) {
    const { half, off } = shapeAt(coil, i / 200);
    lo = Math.min(lo, off - half); hi = Math.max(hi, off + half);
  }
  ok("so a straight radial line crosses two coils", hi > lo + coil.pitch,
     `${((hi - lo - coil.pitch) / DEG).toFixed(1)}° of radial overlap`);
  const wide = resolveShape({ count: 12, profile: [{ atRadius: 0, widthFraction: 1.4 }] });
  ok("a wedge wider than its pitch is reported as overlapping", shapeClearance(wide).overlaps);

  /* Outlines. A straight-sided turn keeps single chords for sides; a profiled one samples them. */
  const o1 = shapeOutline(plain, { r0: 20, r1: 50, arcSegs: 10 });
  ok("a straight-sided outline has no intermediate side points", o1.length === 1 + 11 + 11);
  const o2 = shapeOutline(sh, { r0: 20, r1: 50, arcSegs: 10, sideSegs: 6 });
  ok("a profiled outline samples both sides", o2.length === 6 + 11 + 5 + 11);
  ok("an outline the inset has closed up reports itself rather than crossing over",
     shapeOutline(plain, { r0: 20, r1: 50, inset: 40 }) === null);

  /* The equivalence that protects every design saved before profiles existed. */
  const designs = [
    { poles: 4, ri: 15, ro: 40, turns: 10, pitch: 0.4, edge: 0.6, arcSegments: 10 },
    { poles: 8, ri: 20, ro: 55, turns: 14, pitch: 0.5, edge: 1, arcSegments: 10 },
    { poles: 6, ri: 15, ro: 40, turns: 40, pitch: 0.4, edge: 0.6, arcSegments: 10 },
    { poles: 8, ri: 110, ro: 185, turns: 16, pitch: 2, edge: 1, arcSegments: 10,
      coilCount: 12, phasePattern: [0, 1, 2], coilSense: [1, -1] }
  ];
  const same = designs.every(p => JSON.stringify(coilPolys(p)) === JSON.stringify(legacyCoilPolys(p)));
  ok("unprofiled coils are bit-for-bit what the old builder produced", same, `${designs.length} designs`);

  /* A profile a turn cannot fit inside ends the coil early, which is the honest answer: fewer
   * turns, not crossed traces. */
  const tight = coilPolys({ ...designs[0], coilShape: [{ atRadius: 0, widthFraction: 0.3 }, { atRadius: 1, widthFraction: 0.5 }] });
  const loose = coilPolys(designs[0]);
  ok("a narrower coil profile fits fewer turns", tight.length < loose.length, `${tight.length} vs ${loose.length} turns`);

  // The spec is the authoring surface, so its cleanup of a hand-written profile is part of this.
  const { spec, warnings } = normalizeSpec({ design: { rotor: { poleShape: [
    { atRadius: 1.4, widthFraction: 1.8, offset_deg: 5 },
    { atRadius: 0.2, widthFraction: 0.4 },
    { atRadius: "x", widthFraction: 3 }] } } });
  const rows = spec.design.rotor.poleShape;
  ok("the spec sorts a profile by radius and clamps it into range",
     rows.length === 2 && rows[0].atRadius === 0.2 && rows[1].atRadius === 1 && rows[1].widthFraction === 1);
  ok("and says so rather than silently redrawing the design", warnings.length === 2, warnings.length + " warnings");
  ok("a profile that is not a list is ignored with a warning",
     normalizeSpec({ design: { rotor: { poleShape: 7 } } }).spec.design.rotor.poleShape === null);

  report.cases.shapes = { commaAreaFraction: closed, coilClearance_deg: clr.gap / DEG,
                          coilSwing_deg: shapeSwing(coil) / DEG };
}

/* ---- control-point curves -------------------------------------------------------------------- */

/* The general footprint: a closed curve through control points, swept with its own schedule. Three
 * claims in `curves.js` are load-bearing and all three are checked numerically here rather than
 * argued for in a comment: refinement does not change the curve, the area and volume integrals are
 * exact and not merely converged, and the two shape languages agree where they overlap. */
function curves() {
  process.stderr.write("\n7. control-point curves and lofts\n");

  const ctrl = [[0.05, -0.18], [0.30, -0.30], [0.80, -0.22], [0.98, 0.0],
                [0.80, 0.28], [0.30, 0.22], [0.05, 0.15]];
  const frame = curveFrame({ r0: 15, r1: 40, count: 8 });

  // Refinement is exact, which is what makes a coarse optimum a *member* of the finer design space
  // rather than a guess at one. The refined curve at 2t must be the original at t, to rounding.
  for (const degree of [1, 2, 3]) {
    const a = closedCurve(ctrl, { degree }), b = refine(a);
    let worst = 0;
    for (let i = 0; i < 400; i++) {
      const t = i / 400 * a.spans, p = curveAt(a, t), q = curveAt(b, 2 * t);
      worst = Math.max(worst, Math.hypot(p.u - q.u, p.v - q.v));
    }
    ok(`refining a degree-${degree} curve leaves it unchanged`, worst < 1e-14, worst.toExponential(2));
    ok(`and doubles its control points`, b.spans === 2 * a.spans, `${a.spans} -> ${b.spans}`);
  }

  // Where the two shape languages overlap they must agree exactly, not nearly: a trapezoid traced as
  // a degree-1 curve has the same swept area as the same trapezoid written as a width fraction.
  const plain = resolveShape({ count: 8, fraction: 0.5 });
  const asCurve = curveFromProfile(shapeAt, plain, { perSide: 2, degree: 1 });
  ok("a traced trapezoid sweeps the area the wedge formula gives",
     near(curveAreaFraction(asCurve, frame), shapeAreaFraction(plain, 15, 40), 1e-14));

  const profiled = resolveShape({ count: 8, fraction: 0.5, skew: 10 * DEG,
                                  profile: [{ atRadius: 0, widthFraction: 0.3 },
                                            { atRadius: 0.5, widthFraction: 0.7 },
                                            { atRadius: 1, widthFraction: 0.45 }] });
  const traced = curveFromProfile(shapeAt, profiled, { perSide: 41, degree: 1 });
  ok("and so does a traced kinked profile",
     near(curveAreaFraction(traced, frame), shapeAreaFraction(profiled, 15, 40), 1e-7));

  // The polar Green's-theorem integral is exact because the integrand is a polynomial. Checked
  // against the area of a very fine polyline, which converges to it from below.
  const c = closedCurve(ctrl);
  const exact = curveArea(c, frame).area;
  const poly = tessellate(c, frame, { tolerance_mm: 1e-4, maxPoints: 40000 }).points;
  let shoelace = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    shoelace += a[0] * b[1] - b[0] * a[1];
  }
  ok("the closed-form area matches a finely tessellated one",
     near(exact, Math.abs(0.5 * shoelace), 3e-5),
     `${exact.toFixed(6)} mm^2, polyline short by ${((exact - Math.abs(0.5 * shoelace)) / exact * 1e6).toFixed(1)} ppm`);

  // The lofted volume likewise: a prism is area x height exactly, and a flared-then-pinched sweep
  // matches a brute-force integration over height.
  const prism = loftSchedule({});
  ok("a constant loft is a prism", near(loftVolume(c, frame, prism, 0, 3), exact * 3, 1e-14));
  const loft = loftSchedule({ scale: [1, 1.35, 0.8], widen: [1, 1.1, 1], twist: [0, 0.06] });
  const V = loftVolume(c, frame, loft, 0, 3);
  let brute = 0, N = 4000;
  for (let i = 0; i < N; i++) brute += curveArea(c, frame, loftAt(loft, (i + 0.5) / N)).area;
  brute = brute / N * 3;
  ok("a three-point flare integrates exactly in height", near(V, brute, 1e-7), `${V.toFixed(4)} mm^3`);
  ok("a one-value channel is a constant and two is a ramp",
     bezierAt([0.7], 0.3) === 0.7 && near(bezierAt([0, 1], 0.25), 0.25) && near(bezierAt([0, 0, 1], 0.5), 0.25));

  // Authoring: an agent handed a list of coordinates means "go through these".
  const through = splineThrough(ctrl);
  let miss = 0;
  for (let i = 0; i < ctrl.length; i++) {
    const q = curveAt(through, i);
    miss = Math.max(miss, Math.hypot(q.u - ctrl[i][0], q.v - ctrl[i][1]));
  }
  ok("splineThrough passes through its points", miss < 1e-12, miss.toExponential(2));

  // Validity. A control polygon drawn at random sometimes crosses itself, and a crossed footprint is
  // not a shape — it has to be caught before it is meshed, not explained afterwards.
  const bowtie = closedCurve([[0.1, -0.2], [0.9, 0.2], [0.1, 0.2], [0.9, -0.2]], { degree: 1 });
  ok("a self-crossing outline is caught",
     selfIntersects(tessellate(bowtie, frame, {}).points) && !selfIntersects(poly));

  const insp = inspectCurve(c, frame, { loft, z0: 0, z1: 3 });
  ok("a legal footprint reports itself legal",
     insp.simple && insp.insideAnnulus && insp.clearsNeighbour && insp.overhang_deg > 0);
  const wide = inspectCurve(closedCurve([[0.2, -0.7], [0.9, 0], [0.2, 0.7]], { degree: 1 }), frame, {});
  ok("a footprint wider than its pitch is flagged rather than meshed", !wide.clearsNeighbour,
     `|v| max ${wide.maxAbsV.toFixed(2)}`);
  const outside = inspectCurve(closedCurve([[-0.3, -0.2], [1.4, 0], [-0.3, 0.2]], { degree: 1 }), frame, {});
  ok("and so is one that leaves its annulus", !outside.insideAnnulus);

  // The optimizer's view: a curve is a vector in a box that is the same for every entry, and the
  // round trip has to be lossless or a design cannot be reproduced from its own saved spec.
  const vec = curveToVector(c);
  const back = curveFromVector(vec, c);
  ok("a curve round-trips through its design vector",
     vec.length === 2 * c.spans && back.control.every((p, i) => p[0] === c.control[i][0] && p[1] === c.control[i][1]));
  const fixed = curveToVector(c, { fixU: true });
  ok("pinning the radial coordinates halves the dimension", fixed.length === c.spans);
  ok("and the bounds are the normalized box", curveBounds(c).length === 2 * c.spans
     && curveBounds(c)[1][0] === -0.5 && curveBounds(c)[1][1] === 0.5);

  ok("too few control points is an error that says so",
     threw(() => closedCurve([[0, 0], [1, 0]]))?.message.includes("at least 4"));
  ok("a malformed control point is an error, not a NaN shape",
     threw(() => closedCurve([[0, 0], [1, "x"], [0.5, 0.2], [0.2, 0]])) instanceof CurveError);

  // The box is feasible; the *ordering* is not. Points taken in the order they were drawn cross
  // themselves nearly always, which is why the low rung of the ladder uses the two-chain layout: two
  // radially monotone chains with non-overlapping angular ranges cannot cross, so every draw in the
  // box is a shape. Both rates are measured here rather than asserted, because the whole argument for
  // searching a thirty-dimensional shape space rests on the second one.
  const R = (a, b) => a + Math.random() * (b - a);
  const rate = gen => {
    let good = 0;
    for (let i = 0; i < 300; i++) {
      const c = gen();
      if (!selfIntersects(tessellate(c, frame, { tolerance_mm: 0.1 }).points)) good++;
    }
    return good / 300;
  };
  const naive = rate(() => closedCurve(Array.from({ length: 8 }, () => [R(0.05, 0.95), R(-0.45, 0.45)])));
  const layout = rate(() => twoSidedFromVector(twoSidedBounds(4, { maxV: 0.45 }).map(([lo, hi]) => R(lo, hi))));
  ok("points taken in the order they were drawn mostly cross themselves",
     naive < 0.25, `${(100 * naive).toFixed(0)} % simple`);
  ok("the two-chain layout cannot draw a broken shape", layout === 1, `${(100 * layout).toFixed(0)} % simple`);

  const tsq = twoSidedCurve([-0.2, -0.3, -0.25], [0.2, 0.3, 0.25]);
  ok("a two-sided footprint is symmetric when its sides are",
     near(curveArea(tsq, frame).area, curveArea(twoSidedCurve([-0.2, -0.3, -0.25], [0.2, 0.3, 0.25]), frame).area, 1e-15)
     && tsq.spans === 6);
  ok("and its vector round-trips", twoSidedFromVector([-0.2, -0.3, -0.25, 0.2, 0.3, 0.25]).control.length === 6);
  ok("an odd-length vector is an error that says so",
     threw(() => twoSidedFromVector([0.1, 0.2, 0.3]))?.message.includes("even"));

  report.cases.curves = { area_mm2: exact, volume_mm3: V, overhang_deg: insp.overhang_deg,
                          naiveSimpleRate: naive, layoutSimpleRate: layout,
                          tessellationPoints: insp.points, areaFraction: insp.areaFraction };
}

/* ---- solids and traced rasterization --------------------------------------------------------- */

/* The IR and the polygon rasterizer behind it. The claim under test is the one the whole design
 * rests on: a traced footprint is *not* a supersampled approximation on a cylindrical mesh. In
 * normalized coordinates the footprint maps affinely into the (r, theta) plane, where cells are
 * axis-aligned rectangles, so a clip and a Green's-theorem contour integral give the cell fraction
 * with no sampling at all — and the only error left is the tessellation, which the solid reports
 * for itself. */
function solids() {
  process.stderr.write("\n8. solids and traced rasterization\n");

  const frame = curveFrame({ r0: 15, r1: 40, count: 8 });
  const rect = closedCurve([[0, -0.25], [1, -0.25], [1, 0.25], [0, 0.25]], { degree: 1 });

  // A rectangle in (u, v) is an annular sector, whose area anyone can write down.
  const poly = polygonRT(rect, frame, {}).points;
  const sector = 0.5 * (40 * 40 - 15 * 15) * (0.5 * 2 * Math.PI / 8);
  ok("a traced rectangle measures as the annular sector it is",
     near(Math.abs(polygonMeasure(poly)), sector, 1e-14), `${sector.toFixed(4)} mm^2`);

  // The cell fractions must sum back to that measure exactly — this is the exactness claim, and it
  // is a sum over ~4000 clipped cells, so a systematic bias of any kind would show.
  const nr = 40, nt = 96, re = new Float64Array(nr + 1), the = new Float64Array(nt + 1);
  for (let i = 0; i <= nr; i++) re[i] = 50 * i / nr;
  for (let j = 0; j <= nt; j++) the[j] = 2 * Math.PI * j / nt;
  const mesh = makeMesh(re, the, new Float64Array([0, 1]), { kind: CYLINDRICAL, periodicY: true });
  const sumOver = (curve, loft = null, s = 0) => {
    const base = polygonRT(curve, frame, { loft, s, tolerance_mm: 0.002 });
    const copies = footprintCopies(base.points, { count: 8, phase: 0, pitch: Math.PI / 4 }, mesh.y0, mesh.y1);
    const { table } = coverageTable(copies, mesh);
    clampTable(table);
    let sum = 0;
    for (let i = 0; i < nr; i++) for (let j = 0; j < nt; j++) sum += table[i * nt + j] * mesh.rArea[i] * (the[j + 1] - the[j]);
    return { sum, exact: 8 * Math.abs(polygonMeasure(base.points)), points: base.points.length, copies: copies.length };
  };
  const a = sumOver(rect);
  ok("clipped cell fractions sum to the polygon exactly", near(a.sum, a.exact, 1e-12),
     `${(a.sum / a.exact - 1).toExponential(1)} over ${nr * nt} cells`);
  const comma = splineThrough([[0.05, -0.10], [0.35, -0.28], [0.75, -0.20], [0.97, 0.02], [0.7, 0.26], [0.3, 0.20], [0.05, 0.12]]);
  const b = sumOver(comma);
  ok("and so do the fractions of a footprint that doubles back", near(b.sum, b.exact, 1e-12),
     `${b.points} polygon points, ${b.copies} copies`);
  const loft = loftSchedule({ scale: [1, 1.3, 0.85], twist: [0, 0.05] });
  const c = sumOver(comma, loft, 0.6);
  ok("and of a lofted one at height", near(c.sum, c.exact, 1e-12));

  // Copies, and the wrap that a footprint straddling theta = 0 depends on.
  const full = footprintCopies(poly, { count: 8, phase: 0, pitch: Math.PI / 4 }, 0, 2 * Math.PI);
  ok("a wedge straddling theta = 0 is emitted at both ends of a full turn", full.length === 9,
     `${full.length} copies of 8`);
  const sect = footprintCopies(poly, { count: 8, phase: 0, pitch: Math.PI / 4 }, 0, Math.PI / 2);
  ok("and a sector window takes only the copies it contains", sect.length === 3, `${sect.length} copies`);
  ok("clipping to a band outside the polygon leaves nothing",
     clipToBand(poly, 0, 45, 50).length === 0);

  // Solids: the volume every audit is measured against, and the reach a loft changes.
  const fields = { name: "pole", mu_r: 20, group: "rotorTop", r0: 15, r1: 40, z0: 3, z1: 6 };
  const prism = tracedSolid(fields, { count: 8, curve: comma });
  const lofted = tracedSolid(fields, { count: 8, curve: comma, loft });
  ok("a traced prism's volume is its area times its height",
     near(solidVolume(prism), 8 * curveArea(comma, frame).area * 3, 1e-12));
  ok("a flaring loft is bigger than the prism it started from", solidVolume(lofted) > solidVolume(prism),
     `${solidVolume(lofted).toFixed(1)} vs ${solidVolume(prism).toFixed(1)} mm^3`);
  const [lo, hi] = solidRadialExtent(lofted);
  ok("and reaches further than the footprint alone", hi > solidRadialExtent(prism)[1] && lo < solidRadialExtent(prism)[0],
     `${lo.toFixed(2)}..${hi.toFixed(2)} mm`);
  ok("the reach is recorded on the solid, because both rasterizers and the volume must agree on it",
     lofted.rLo === lo && lofted.rHi === hi);

  // The wedge path is untouched: a solid with an arc still answers with the old closed form.
  const shape = resolveShape({ count: 8, fraction: 0.5 });
  const wedge = wedgeSolid({ ...fields, arc: { count: 8, phase: 0, shape, pitchAngle: shape.pitch } });
  ok("a wedge solid's volume is the old closed form",
     near(solidVolume(wedge), Math.PI * (40 * 40 - 15 * 15) * shapeAreaFraction(shape, 15, 40) * 3, 1e-12));

  // Flip: the loft runs from each rotor's own gap face, so a mirrored pole is not upside down.
  const down = tracedSolid({ ...fields, z0: -6, z1: -3 }, { count: 8, curve: comma, loft, flip: true });
  ok("a flipped loft starts at the face nearest the gap",
     solidHeightFraction(down, -3) === 0 && solidHeightFraction(down, -6) === 1);
  ok("and an unflipped one starts at z0", solidHeightFraction(lofted, 3) === 0 && solidHeightFraction(lofted, 6) === 1);

  // Provenance: the number the solid claims for itself is the number the audit must find.
  const prov = solidProvenance(prism);
  ok("a traced solid says which path it takes and what it costs",
     prov.path === "traced" && prov.volumeError_pct > 0 && prov.volumeError_pct < 0.05,
     `${prov.polygonPoints} points, ${prov.volumeError_pct.toExponential(1)} %`);
  ok("and an exact one says so", solidProvenance(wedge).path === "exact");
  const tight = solidProvenance(tracedSolid(fields, { count: 8, curve: comma, tolerance_mm: 1e-4 }));
  ok("a tighter chord tolerance is a smaller error, not a different shape",
     tight.volumeError_pct < prov.volumeError_pct / 4,
     `${prov.volumeError_pct.toExponential(1)} -> ${tight.volumeError_pct.toExponential(1)} %`);

  // Sampling and clipping must agree about what is inside: they are the two rasterizer paths.
  const insideAt = (r, th) => pointInPolygonRT(polygonRT(comma, frame, {}).points, r, th);
  ok("the sampled path and the clipped path agree about a point well inside", insideAt(30, 0.0));
  ok("and about one outside", !insideAt(30, 0.35));

  // Authoring, including the errors, because the customer is a model reading the reply.
  ok("a footprint can be authored as control points",
     footprintCurve({ controlPoints: [[0, 0], [1, -0.2], [1, 0.2], [0, 0.1]], degree: 1 }).spans === 4);
  ok("or as points to pass through", footprintCurve({ through: [[0.1, -0.2], [0.9, 0], [0.5, 0.25], [0.2, 0.1]] }).spans === 4);
  ok("or as two chains that cannot cross",
     footprintCurve({ trailing: [-0.2, -0.3], leading: [0.2, 0.3] }).spans === 4);
  ok("and a footprint with no points says what the forms are",
     threw(() => footprintCurve({}, "design.rotor.poleCurve"))?.message.includes("trailing/leading"));
  ok("a loft with no channels set is no loft at all", footprintLoft({ scale: [1] }) === null);
  ok("and one with a flare is", footprintLoft({ scale: [1, 1.2] }) !== null);

  const insp = inspectSolid(lofted);
  report.cases.solids = { prismVolume_mm3: solidVolume(prism), loftVolume_mm3: solidVolume(lofted),
                          reach_mm: [lo, hi], angularHalf_deg: solidAngularHalf(lofted) * 180 / Math.PI,
                          clearance_deg: insp.clearance_deg, provenance: prov,
                          frameRadius: [solidFrame(prism).r0, solidFrame(prism).r1] };
}

/* ---- main ------------------------------------------------------------------------------------- */

const args = process.argv.slice(2);
const outFile = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;

arithmetic();
refusals();
messages();
scopes();
reuse();
shapes();
curves();
solids();

if (outFile) {
  await mkdir(dirname(resolve(ROOT, outFile)), { recursive: true });
  await writeFile(resolve(ROOT, outFile), JSON.stringify({ ...report, problems }, null, 2) + "\n");
  process.stderr.write(`\nwrote ${outFile}\n`);
}
process.stderr.write(problems.length ? `\n${problems.length} problem(s):\n  ${problems.join("\n  ")}\n`
                                     : "\nthe geometry language behaved\n");
process.exit(problems.length ? 1 : 0);
