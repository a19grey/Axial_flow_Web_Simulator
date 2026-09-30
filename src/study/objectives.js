/* What a design's score is, and what disqualifies it from having one.
 *
 * The objective is an expression over the evaluation record — `src/core/expr.js` already parses and
 * evaluates exactly this — so none of it is hard-coded. What matters is choosing the default well,
 * because the default is what a search will actually chase.
 *
 * The default is **mean air-gap shear stress at a fixed copper-loss budget**:
 *
 *   - shear rather than torque, because torque gets a free win from a larger rotor and the question
 *     is whether the machine is good, not whether it is big;
 *   - at a fixed loss budget rather than a fixed current, because torque is quadratic in current and
 *     any objective that does not fix the thermal input is really an objective about how much
 *     current someone was willing to type in. The budget is imposed analytically, so it is free;
 *   - the budget defaults to the baseline design's own copper loss, so the starting design is scored
 *     exactly as it stands today and every variant is a statement about equal heat;
 *   - the mean over the ripple period, not the peak, for the reason in operatingPoint.js.
 *
 * Gates, not penalties. A design that fails a gate is *not scored*, rather than scored badly: an
 * unresolved air gap is not a low torque, it is not a measurement, and a weighted penalty would let
 * the search trade real performance against numerical nonsense. Everything that is not the primary
 * objective is a constraint, and sweeping a constraint's threshold is what draws the Pareto picture
 * — a weighted-sum scalarization would hide exactly the trade-off one wants to see.
 */

import { evalExpr, dependencies, ExprError } from "../core/expr.js";
import { specToParams } from "../core/spec.js";
import { inspectRegions, windingPlan, coilFootprintOf, windingLayout } from "../core/geometry.js";
import { curveFrame, inspectCurve } from "../core/curves.js";

/* Fab and printer limits. Defaults are a common 4-layer process class and a 0.4 mm nozzle, and
 * every one of them is a study-spec field, because the point of the gate is that it describes the
 * shop that is going to build the thing. */
export const PROCESS_DEFAULTS = {
  minTraceWidth_mm: 0.15,
  minTraceSpacing_mm: 0.15,
  layerOptions: [2, 4, 6, 8],
  minPrintedFeature_mm: 0.8,      // two 0.4 mm extrusions side by side
  minPrintedWall_mm: 1.2,
  minAirGap_mm: 0.5              // runout and tolerance stack on a printed rotor
};

export const OBJECTIVE_DEFAULTS = {
  maximize: "shear_kPa",
  maxSurfaceSpread_pct: 8,
  maxSuperpositionError_pct: 1,
  /* Reported beside the score and available as constraints, but not gates by default: ripple is a
   * real trade rather than a disqualification, and the saturation ceiling is the linear model's
   * honest boundary either way — clamping it silently would hide that. */
  constraints: []
};

/* ---- the scope an expression sees ------------------------------------------------------------- */

/* Flat names, chosen to be the ones somebody would type. The full results JSON is reachable by its
 * own dotted path as well, so an expression is never limited to this list. */
export function scopeOf(record) {
  const r = record.results || {};
  const d = r.derived || {};
  const pu = d.perUnit || {};
  const op = record.operatingPoint || {};
  const flat = {
    shear_kPa: record.meanShear_kPa,
    torque_mNm: record.meanTorque_mNm,
    torqueMin_mNm: record.minTorque_mNm,
    torqueMax_mNm: record.maxTorque_mNm,
    ripple_pct: record.ripple_pct,
    gamma_deg: op.currentAngle_elecDeg,
    amps_A: op.peakCurrent_A,
    copperLoss_W: op.copperLoss_W,
    phaseLeverage_pct: op.phaseLeverage_pct,
    confirmError_pct: record.confirm ? record.confirm.error_pct : null,
    mass_kg: (d.mass_kg || {}).total,
    rotorMass_kg: (d.mass_kg || {}).rotor,
    copperMass_kg: (d.mass_kg || {}).copper,
    torqueDensity_Nm_per_kg: pu.torqueDensity_Nm_per_kg,
    torquePerRootWatt: pu.torquePerRootWatt_Nm_per_sqrtW,
    peakB_mT: r.peakBInMagneticParts_mT,
    gapBz_mT: r.gapBzMean_mT,
    surfaceSpread_pct: r.torqueSurfaceSpread_pct,
    cells: (r.mesh || {}).cells,
    gapCells: (r.mesh || {}).cellsAcrossAirGap,
    iterations: (r.solver || {}).iterations,
    residual: (r.solver || {}).residual,
    solves: (record.cost || {}).solves,
    elapsed_ms: (record.cost || {}).elapsed_ms
  };
  /* Shear and torque density are reported at the operating point the confirm solve ran at, which is
   * one rotor angle. The mean over the period is the score, so the per-mass and per-watt figures are
   * rebuilt from it rather than taken from the single-angle solve. */
  if (Number.isFinite(flat.torque_mNm) && Number.isFinite(flat.mass_kg) && flat.mass_kg > 0)
    flat.torqueDensity_Nm_per_kg = flat.torque_mNm * 1e-3 / flat.mass_kg;
  if (Number.isFinite(flat.torque_mNm) && Number.isFinite(flat.copperLoss_W) && flat.copperLoss_W > 0)
    flat.torquePerRootWatt = flat.torque_mNm * 1e-3 / Math.sqrt(flat.copperLoss_W);

  const scope = {};
  for (const [k, v] of Object.entries(flat)) scope[k] = Number.isFinite(v) ? v : NaN;
  addPaths(scope, "results", r);
  return scope;
}

/* Dotted paths, so anything in the results JSON can be an objective without being listed above.
 * Only finite numbers are exposed; a null in the JSON stays absent, and an expression that reaches
 * for it gets the "unknown name" error with the near-miss suggestion rather than a silent NaN. */
function addPaths(scope, prefix, obj, depth = 0) {
  if (depth > 4 || !obj || typeof obj !== "object") return;
  for (const [k, v] of Object.entries(obj)) {
    const name = `${prefix}.${k}`;
    if (typeof v === "number") { if (Number.isFinite(v)) scope[name] = v; }
    else if (v && typeof v === "object" && !Array.isArray(v)) addPaths(scope, name, v, depth + 1);
  }
}

/* ---- gates ------------------------------------------------------------------------------------ */

/* Manufacturability, checked against the spec rather than the solve, so it can reject a design
 * before it is meshed.
 *
 * Every check here is exact. The one that is not yet possible is the minimum printed feature of a
 * general traced footprint — the narrowest chord of an arbitrary closed curve is a genuinely
 * harder measurement than the narrowest chord of the two-chain form, which is a subtraction — so
 * the two-chain form is checked and the general form is reported as unchecked instead of being
 * waved through silently. */
export function manufacturability(spec, processIn = {}) {
  const P = { ...PROCESS_DEFAULTS, ...processIn };
  const s = spec.design.stator, r = spec.design.rotor;
  const fails = [], unchecked = [];

  if (s.traceWidth_mm < P.minTraceWidth_mm)
    fails.push(`trace width ${s.traceWidth_mm} mm is under the ${P.minTraceWidth_mm} mm process minimum`);
  const spacing = s.tracePitch_mm - s.traceWidth_mm;
  if (spacing < P.minTraceSpacing_mm)
    fails.push(`trace spacing ${spacing.toFixed(3)} mm (pitch ${s.tracePitch_mm} less width ${s.traceWidth_mm}) is under the ${P.minTraceSpacing_mm} mm process minimum`);
  if (P.layerOptions && !P.layerOptions.includes(s.copperLayers))
    fails.push(`${s.copperLayers} copper layers is not one of the available stack-ups (${P.layerOptions.join(", ")})`);
  if (r.poleHeight_mm < P.minPrintedFeature_mm)
    fails.push(`pole height ${r.poleHeight_mm} mm is under the ${P.minPrintedFeature_mm} mm minimum printed feature`);
  if (r.yokeThickness_mm < P.minPrintedWall_mm)
    fails.push(`yoke ${r.yokeThickness_mm} mm is thinner than the ${P.minPrintedWall_mm} mm minimum printed wall`);
  if (r.airGap_mm < P.minAirGap_mm)
    fails.push(`air gap ${r.airGap_mm} mm is under the ${P.minAirGap_mm} mm the runout and tolerance stack allow`);

  /* The narrowest the pole gets, in millimetres of arc. For the two-chain footprint the width at a
   * radial station is (leading - trailing) times the pole pitch times the radius there, which is a
   * subtraction; for a plain arc it is the arc fraction. */
  const pitch = 2 * Math.PI / Math.max(1, spec.design.stator.poles);
  const ri = s.innerRadius_mm, ro = s.outerRadius_mm;
  let narrowest = null;
  const c = r.poleCurve;
  if (c && Array.isArray(c.trailing) && Array.isArray(c.leading)) {
    const n = Math.min(c.trailing.length, c.leading.length);
    const u0 = Number.isFinite(+c.u0) ? +c.u0 : 0.05, u1 = Number.isFinite(+c.u1) ? +c.u1 : 0.95;
    narrowest = Infinity;
    for (let i = 0; i < n; i++) {
      const u = u0 + (u1 - u0) * i / (n - 1);
      const rad = ri + u * (ro - ri);
      narrowest = Math.min(narrowest, (Math.max(0, +c.leading[i]) - Math.min(0, +c.trailing[i])) * pitch * rad);
    }
  } else if (c) {
    unchecked.push("the pole footprint is a general traced curve, whose narrowest chord is not measured here");
  } else if (!r.poleShape) {
    narrowest = r.poleArcFraction * pitch * ri;
  } else {
    let half = Infinity;
    for (const st of r.poleShape) half = Math.min(half, (+st.widthFraction || 0));
    narrowest = half * pitch * ri;
  }
  if (narrowest !== null && narrowest < P.minPrintedFeature_mm)
    fails.push(`the pole narrows to ${narrowest.toFixed(2)} mm of arc, under the ${P.minPrintedFeature_mm} mm minimum printed feature`);

  return { pass: fails.length === 0, fails, unchecked, narrowestPoleFeature_mm: narrowest };
}

/* Every gate, evaluated. `spec`-only gates run first so a design can be rejected before it costs a
 * solve; `record` may be null in that case. */
/* ---- containment ------------------------------------------------------------------------------ */

/* Does the geometry stay where it is allowed to be?
 *
 * This is the gate that the first overnight run did without, and the search found the hole in
 * about four hours: the winning rotor grew scythes reaching 5.9 mm past the stator's outer radius
 * and spanning 66 degrees against a 45 degree pole pitch, so neighbouring poles interpenetrated.
 * Both are real torque — flux does not care that the iron is in the wrong place — and both are
 * cheating, because the honest way to use radius past the stator is to build a bigger stator, and
 * two poles merged into one are not the eight-pole machine the spec claims.
 *
 * It costs no solve: `inspectRegions` builds the solids and integrates their outlines in closed
 * form, so this runs *before* the design is meshed and rejects it for free. It reads the bounds
 * off the spec rather than inventing them, so the same call answers for a hand-authored design in
 * the UI and for a design a search just proposed.
 */
export function containment(spec) {
  const fails = [];
  let worst = 0;
  try {
    for (const s of inspectRegions(specToParams(spec))) {
      const c = s.containment;
      if (!c || c.ok) continue;
      fails.push(s.containmentReason);
      worst = Math.max(worst, c.overRim_mm, c.underBore_mm);
    }
  } catch (e) {
    /* A geometry that will not even build is not contained, and saying so here keeps the caller
     * from discovering it two stages later inside a mesher. */
    return { pass: false, fails: [`the geometry could not be built: ${e.message}`], overrun_mm: null };
  }
  return { pass: fails.length === 0, fails, overrun_mm: worst };
}

/* ---- the winding ------------------------------------------------------------------------------- */

/* Is there a coil in there at all?
 *
 * Once the turn count is an *output* — the fill fraction and the outline decide it between them —
 * a design can be perfectly well-formed and still describe no winding: an outline too thin to hold
 * one turn, or a fill fraction that rounds to none. Those are not slow motors, they are not motors,
 * and the search needs them rejected rather than scored at zero, which it would otherwise read as
 * a flat region worth exploring.
 *
 * The third failure is the one only a router can see. Pushed far enough in, a non-convex outline
 * pinches and its offset splits into two loops. Two loops is not a turn; it is two turns shorted
 * together at the pinch, carrying a current the solver would faithfully model and no board would
 * ever carry. Routing stops at the split and this gate reports it.
 *
 * Like the other spec-only gates it costs no solve. The router builds one distance field on a grid
 * of a few thousand nodes — single-digit milliseconds against the seconds a rejected solve would
 * have cost.
 */
export function winding(spec) {
  const fails = [];
  const p = specToParams(spec);
  let W;
  try { W = windingPlan(p); }
  catch (e) { return { pass: false, fails: [`the winding could not be routed: ${e.message}`], turns: null }; }

  if (W.turns < 1) fails.push(
    `the coil outline holds no turns: it is ${W.depth_mm.toFixed(2)} mm deep at its widest and the ` +
    `first turn sits ${spec.design.stator.edgeMargin_mm} mm in, at a fill fraction of ${W.fillFraction}`);
  if (W.stopped === "split") fails.push(
    `the winding pinches ${W.filled_mm.toFixed(2)} mm in: past there the coil outline offsets into two ` +
    `separate loops, which is a short between turns rather than a turn`);

  /* The outline itself, on the stator's own annulus. A coil has no loft, so unlike a rotor pole it
   * cannot leave its box after the fact — but an interpolating spline overshoots its own control
   * points, and a coil hanging off the board edge or lying across its neighbour is the same kind of
   * free lunch the rotor gate exists to refuse. */
  const st = spec.design.stator;
  const traced = coilFootprintOf(p);
  let reach = null;
  if (traced) {
    const { count } = windingLayout(p);
    const frame = curveFrame({ r0: st.innerRadius_mm, r1: st.outerRadius_mm, centre: 0, count });
    const insp = inspectCurve(traced.curve, frame, { tolerance_mm: 0.05 });
    reach = { uMin: insp.uMin, uMax: insp.uMax, maxAbsV: insp.maxAbsV };
    if (!insp.simple) fails.push("the coil outline crosses itself, so it is not a shape a turn can follow");
    if (!insp.insideAnnulus) fails.push(
      `the coil outline reaches ${insp.uMin.toFixed(3)}..${insp.uMax.toFixed(3)} of the stator annulus, ` +
      `so the copper hangs off the board`);
    if (!insp.clearsNeighbour) fails.push(
      `the coil outline spans ${(200 * insp.maxAbsV).toFixed(0)} % of its own coil pitch, so neighbouring coils short`);
  }

  return { pass: fails.length === 0, fails, turns: W.turns, depth_mm: W.depth_mm,
           filled_mm: W.filled_mm, stopped: W.stopped, footprint: W.mode, reach };
}

export function gateDesign(spec, record, objSpec = {}) {
  const o = { ...OBJECTIVE_DEFAULTS, ...objSpec };
  const gates = [];

  const man = manufacturability(spec, o.process);
  gates.push({ name: "manufacturability", pass: man.pass, detail: man.fails.join("; ") || null, unchecked: man.unchecked.length ? man.unchecked : undefined });

  /* Both of these are spec-only, so a design that fails them never reaches a mesh. */
  const con = containment(spec);
  gates.push({ name: "containment", pass: con.pass, value: con.overrun_mm, detail: con.fails.join("; ") || null });

  const wnd = winding(spec);
  gates.push({ name: "winding", pass: wnd.pass, value: wnd.turns, detail: wnd.fails.join("; ") || null });

  const needsSolve = man.pass && con.pass && wnd.pass;
  if (!record) return { gates, feasible: gates.every(g => g.pass), needsSolve };

  const r = record.results || {};
  const errs = (r.quality || []).filter(f => f.level === "error");
  gates.push({
    name: "numericalQuality", pass: errs.length === 0,
    detail: errs.length ? errs.map(f => f.message).join(" ") : null
  });

  const spread = r.torqueSurfaceSpread_pct;
  gates.push({
    name: "surfaceAgreement",
    pass: !Number.isFinite(spread) || spread <= o.maxSurfaceSpread_pct,
    value: spread ?? null,
    detail: Number.isFinite(spread) && spread > o.maxSurfaceSpread_pct
      ? `the ${r.mesh?.torqueSurfaceCount} stress surfaces in the gap disagree by ${spread.toFixed(1)}%, over the ${o.maxSurfaceSpread_pct}% this study is willing to rank on`
      : null
  });

  /* The design's own evidence that the operating point it was scored at is real. */
  const ce = record.confirm ? record.confirm.error_pct : null;
  gates.push({
    name: "superposition",
    pass: !Number.isFinite(ce) || Math.abs(ce) <= o.maxSuperpositionError_pct,
    value: ce,
    detail: Number.isFinite(ce) && Math.abs(ce) > o.maxSuperpositionError_pct
      ? `the closed-form torque missed the confirming solve by ${ce.toFixed(2)}%, so the quadratic form is not describing this solve and the chosen current phase is not trustworthy`
      : null
  });

  const scope = scopeOf(record);
  for (const c of o.constraints || []) {
    let pass = false, value = null, detail = null;
    try { value = evalExpr(c.expr ?? c, scope); pass = value > 0 || value === true; }
    catch (e) { detail = e.message; }
    if (!pass && !detail) detail = `${c.name || c.expr} evaluated to ${value}`;
    gates.push({ name: c.name || String(c.expr), pass, value, detail });
  }

  return { gates, feasible: gates.every(g => g.pass), needsSolve };
}

/* ---- the score -------------------------------------------------------------------------------- */

/* The score, and the reason it is or is not one.
 *
 * `score` is always the number a *maximizer* wants larger. An infeasible design gets `null` rather
 * than a large negative number, and the caller decides what a search does with that — which in
 * practice is to keep it out of the population and record why, not to let it distort a step size. */
export function scoreDesign(spec, record, objSpec = {}) {
  const o = { ...OBJECTIVE_DEFAULTS, ...objSpec };
  const { gates, feasible } = gateDesign(spec, record, objSpec);
  const scope = record ? scopeOf(record) : {};
  let score = null, error = null;
  if (feasible) {
    try {
      const v = evalExpr(o.maximize, scope);
      score = Number.isFinite(v) ? (o.minimize ? -v : v) : null;
      if (score === null) error = `the objective "${o.maximize}" evaluated to ${v}`;
    } catch (e) {
      error = e instanceof ExprError ? e.message : String(e.message || e);
    }
  }
  return { score, feasible, gates, error, objective: o.maximize, scope };
}

/* Names an objective or constraint expression needs, so a study spec can be checked for typos
 * before it runs for eight hours. */
export function checkExpressions(objSpec = {}) {
  const o = { ...OBJECTIVE_DEFAULTS, ...objSpec };
  const known = new Set(Object.keys(scopeOf({ results: {}, operatingPoint: {}, cost: {} })));
  const problems = [];
  for (const src of [o.maximize, ...(o.constraints || []).map(c => c.expr ?? c)]) {
    let needs;
    try { needs = dependencies(src); } catch (e) { problems.push(`${src}: ${e.message}`); continue; }
    for (const n of needs) if (!known.has(n) && !n.startsWith("results.")) problems.push(`${src}: unknown name "${n}"`);
  }
  return problems;
}
