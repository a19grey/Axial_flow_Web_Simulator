/* The design spec: one versioned JSON object that is the sole input to a solve.
 *
 * Both the browser UI and the headless API build a spec and hand it to solve(). Nothing downstream
 * reads the DOM. Every numeric field carries its unit in its name.
 *
 * v1 was the project-file format of the single-file tool. v2 keeps every v1 path so old project
 * files load unchanged, and adds an explicit `mesh` section (v1 kept the grid under `solver`).
 */

import { PCB, SOLVER_DEFAULTS, MATERIALS, CORE_LOSS_DEFAULTS, COPPER_THICKNESS_UM } from "./constants.js";
import { footprintCurve, tracedSolid, inspectSolid, DEFAULT_CHORD_TOLERANCE_MM } from "./ir.js";

export const SPEC_FORMAT = "axial-flux-project";
export const SPEC_VERSION = 2;

export const getPath = (o, p) => p.split(".").reduce((a, k) => (a == null ? undefined : a[k]), o);
export const setPath = (o, p, v) => {
  const ks = p.split(".");
  let a = o;
  ks.slice(0, -1).forEach(k => a = a[k] ??= {});
  a[ks[ks.length - 1]] = v;
};

/* ---- defaults ---------------------------------------------------------------------------- */

export function defaultSpec() {
  return {
    format: SPEC_FORMAT,
    version: SPEC_VERSION,
    name: "Untitled motor",
    notes: "",
    design: {
      stator: {
        poles: 4, copperLayers: 2,
        innerRadius_mm: 15, outerRadius_mm: 40,
        /* How much copper goes in, in two parts. `fillFraction` is the driver: turns are laid
         * from the coil outline inward until they have used that fraction of the depth the
         * outline actually has, so the same number means the same thing on any coil shape.
         * `turnsPerLayer` is only a cap on top of that, and null means no cap at all — how many
         * turns are worth winding is a property of the design, not a constant somebody typed. */
        turnsPerLayer: 10, fillFraction: 1, peakCurrent_A: 5,
        thickness_mm: PCB.thickness_mm,
        tracePitch_mm: PCB.tracePitch_mm,
        traceWidth_mm: PCB.traceWidth_mm,
        edgeMargin_mm: PCB.edgeMargin_mm,
        /* Copper foil thickness and laminate density. Neither affects the field: the traces are
         * modelled as filaments. They set the winding resistance and the stator mass. */
        copperThickness_um: COPPER_THICKNESS_UM,
        boardDensity_kg_m3: MATERIALS.boardDensity_kg_m3,
        /* Winding layout. null means the classical 3-phase concentrated arrangement the tool has
         * always used: 1.5 x poles coils, phase k mod 3, all wound the same way round. An explicit
         * coilCount with phasePattern / coilSense arrays describes any other single-layer layout. */
        coilCount: null,
        phasePattern: null,
        coilSense: null,
        /* Coil footprint. By default a coil fills its whole angular pitch and its turns nest as
         * straight-sided trapezoids. coilSpanFraction narrows that wedge, coilSkew_deg swings its
         * centre line linearly from the inner radius to the outer, and coilShape replaces both
         * with a free profile:
         *
         *   [{ atRadius: 0, widthFraction: 0.72, offset_deg: 9 },
         *    { atRadius: 1, widthFraction: 0.86, offset_deg: -6 }]
         *
         * atRadius is 0 at the inner radius and 1 at the outer; widthFraction is the fraction of
         * the coil pitch the turn occupies there. A centre line that swings further than the coil
         * is wide is the YASA-style arrangement a straight radial line crosses two coils in — the
         * coils still clear each other at every radius, which the tool checks. */
        coilSpanFraction: 1,
        coilSkew_deg: 0,
        coilShape: null,
        /* The coil outline as a traced curve — the rotor pole's language pointed at the stator:
         * controlPoints [[u, v], ...], or through [[u, v], ...], or a trailing/leading pair, with
         * u from the stator bore to its rim and v in units of the coil pitch. Set, it replaces the
         * span, the skew and the profile, and the turns inside it are routed by true planar offset
         * rather than nested as trapezoids (src/core/route.js). There is no coil loft: every
         * copper layer is the same outline at a different height. */
        coilCurve: null
      },
      rotor: {
        airGap_mm: 3, mu_r: 20,
        poleHeight_mm: 3, yokeThickness_mm: 4, poleArcFraction: 0.5,
        /* A second rotor mirrored below the board: the YASA / dual-rotor topology. The stator sits
         * between two working gaps and both rotors are on the same shaft, so their torques add. */
        dualSided: false,
        /* Linear skew of the pole arc with radius, in mechanical degrees from the inner radius to
         * the outer. Skew trades peak torque for ripple. */
        poleSkew_deg: 0,
        /* Pole footprint, in the same form as the stator's coilShape: a table of width fraction
         * and centre offset against normalized radius. Set, it replaces poleArcFraction and
         * poleSkew_deg, and lets a 3D-printed rotor carry a pole no arc can draw — a comma, a
         * teardrop, a hook. Null keeps the straight-sided arc. */
        poleShape: null,
        /* The general footprint: a closed control-point curve in normalized wedge coordinates,
         * where u runs 0 at the inner radius to 1 at the outer and v is the angle in units of the
         * pole pitch, so v = +-0.5 is where neighbouring poles would touch. Set, it replaces
         * poleArcFraction, poleSkew_deg and poleShape entirely, and it can draw what none of them
         * can: an outline that doubles back on itself.
         *
         *   { "through": [[0.05, -0.10], [0.4, -0.28], [0.95, 0.02], [0.3, 0.22]] }
         *   { "controlPoints": [[...], ...], "degree": 3 }
         *   { "trailing": [-0.2, -0.3, -0.25], "leading": [0.2, 0.3, 0.25] }
         *
         * The last form is two radially monotone chains, which cannot cross whatever values it is
         * given — the form an optimizer samples. chordTolerance_mm sets how finely the curve is
         * tessellated before it is rasterized; the resulting volume error is reported per solid. */
        poleCurve: null,
        /* How the footprint changes between the gap face and the yoke, one Bezier control list per
         * channel against normalized height: one value is a constant, two a ramp, three the
         * quadratic flare or waist that only a printed rotor can hold.
         *
         *   { "scale": [1, 1.3, 0.85], "widen": [1, 1.1, 1], "twist": [0, 0.05], "pivot": 0.5 }
         *
         * scale sizes the footprint about the pivot radius, widen fans it angularly without growing
         * it radially, twist swings its centre line (poleSkew_deg generalized), shift slides it
         * radially. On a dual-sided machine the schedule runs from each rotor's own gap face. */
        poleLoft: null,
        /* Where the pole is allowed to be, as opposed to where its u coordinate is measured from.
         * A loft `scale` past 1 grows the footprint about its pivot and `widen` fans it angularly,
         * so a traced pole can perfectly legally be drawn reaching past the rotor rim or across
         * into its neighbour. That shape meshes, solves and reports a torque; it is simply not a
         * machine. Null radii mean the rotor annulus itself, so the check is always live;
         * maxRadius_mm set to the stator's outer radius is the usual tightening, because iron that
         * overhangs the copper is iron doing nothing. maxPitchFraction 1 lets neighbouring poles
         * touch and no more. */
        poleBounds: { maxRadius_mm: null, minRadius_mm: null, maxPitchFraction: 1 },
        coreLoss: { ...CORE_LOSS_DEFAULTS }
      },
      backPlate: { enabled: true, mu_r: 20, thickness_mm: 4, gapBelowPcb_mm: 1,
                   density_kg_m3: MATERIALS.ironDensity_kg_m3 }
    },
    operatingPoint: {
      rotorAngle_deg: 0, currentAngle_elecDeg: 45,
      /* Mechanical speed and winding temperature. Neither enters the field solve; speed sets the
       * electrical frequency for core loss, temperature sets the copper resistivity. */
      speed_rpm: 0, windingTemperature_C: 20
    },
    mesh: {
      /* "uniform" reproduces the original single-cell-size grid exactly.
       * "graded" sizes each axis from the geometry: fine through the air gap and the thin parts,
       * stretched into the far field, with every material interface landing on a mesh face. */
      /* "cylindrical" meshes in (r, theta, z), where the bore, the rim and the pole arcs are all
       * coordinate surfaces, so material fractions are exact rather than staircased, and one pole
       * pair can stand in for the whole machine. It is the default: it resolves the air gap at a
       * fraction of the cells, and the rotor-frame core loss is only available on it. */
      mode: "cylindrical",
      cellsAcrossDiameter: 128,        // uniform mode: cells across the whole box
      marginFactor: 0.4,               // outer-box margin as a fraction of outer radius
      marginMin_mm: 12,

      /* graded mode */
      activeCellsAcrossDiameter: 160,  // in-plane cells across the machine itself, not the box
      cellsAcrossAirGap: 6,
      cellsAcrossPoleHeight: 4,
      cellsAcrossYoke: 3,
      cellsAcrossPcb: 4,
      cellsAcrossBackPlate: 3,
      cellsAcrossBackGap: 2,
      /* Angular cells per pole pitch. 64 rather than a rounder number because it is what makes the
       * angular cell comparable to the radial one on the default machine: fewer, and the pole edges
       * are smeared in a way the radial resolution hides. */
      cellsAcrossPoleArc: 64,
      sector: true,                    // cylindrical: model one pole pair rather than the full turn
      growthRatio: 1.2,                // largest ratio between neighbouring cell sizes
      farFieldCellFactor: 8,           // far-field cell size, as a multiple of the in-plane size
      maxCells: 40e6                   // refuse to build a mesh larger than this
    },
    solver: { ...SOLVER_DEFAULTS }
  };
}

/* ---- normalization ----------------------------------------------------------------------- */

const num = (v, fallback) => (Number.isFinite(+v) ? +v : fallback);
const clampMin = (v, lo, fallback) => Math.max(lo, num(v, fallback));

/* Deep-merge a partial spec onto the defaults, coercing every field and clamping to the same
 * bounds readP() enforced in the single-file version. Returns {spec, warnings}. */
export function normalizeSpec(input) {
  const d = defaultSpec();
  const warnings = [];
  const s = JSON.parse(JSON.stringify(d));
  const src = migrate(input || {}, warnings);

  const st = src.design?.stator ?? {}, ds = s.design.stator;
  ds.poles = pickEnum(st.poles, [4, 6, 8], d.design.stator.poles, "design.stator.poles", warnings);
  ds.copperLayers = pickEnum(st.copperLayers, [2, 4], d.design.stator.copperLayers, "design.stator.copperLayers", warnings);
  ds.innerRadius_mm = num(st.innerRadius_mm, ds.innerRadius_mm);
  ds.outerRadius_mm = num(st.outerRadius_mm, ds.outerRadius_mm);
  /* An explicit null is "no cap", which is not the same as an absent field taking the default.
   * `num()` would coerce both to a number and the distinction would be lost on the first
   * round-trip through the archive. */
  ds.turnsPerLayer = st.turnsPerLayer === null ? null
    : st.turnsPerLayer === undefined ? ds.turnsPerLayer
    : Math.max(1, Math.round(num(st.turnsPerLayer, ds.turnsPerLayer)));
  ds.fillFraction = Math.min(1, Math.max(0, num(st.fillFraction, ds.fillFraction)));
  ds.peakCurrent_A = num(st.peakCurrent_A, ds.peakCurrent_A);
  ds.thickness_mm = clampMin(st.thickness_mm, 0.1, ds.thickness_mm);
  ds.tracePitch_mm = clampMin(st.tracePitch_mm, 0.05, ds.tracePitch_mm);
  ds.traceWidth_mm = clampMin(st.traceWidth_mm, 0.01, ds.traceWidth_mm);
  ds.edgeMargin_mm = clampMin(st.edgeMargin_mm, 0, ds.edgeMargin_mm);
  ds.copperThickness_um = clampMin(st.copperThickness_um, 1, ds.copperThickness_um);
  ds.boardDensity_kg_m3 = clampMin(st.boardDensity_kg_m3, 0, ds.boardDensity_kg_m3);
  ds.coilCount = st.coilCount == null ? null : Math.max(1, Math.round(num(st.coilCount, 1)));
  ds.phasePattern = intArray(st.phasePattern, 0, 2);
  ds.coilSense = signArray(st.coilSense);
  ds.coilSpanFraction = Math.min(1, Math.max(0.05, num(st.coilSpanFraction, ds.coilSpanFraction)));
  ds.coilSkew_deg = num(st.coilSkew_deg, ds.coilSkew_deg);
  ds.coilShape = shapeProfile(st.coilShape, "design.stator.coilShape", warnings);
  ds.coilCurve = coilCurveSpec(st.coilCurve, warnings);

  const rt = src.design?.rotor ?? {}, dr = s.design.rotor;
  dr.airGap_mm = clampMin(rt.airGap_mm, 0.3, dr.airGap_mm);
  dr.mu_r = clampMin(rt.mu_r, 1, dr.mu_r);
  dr.poleHeight_mm = clampMin(rt.poleHeight_mm, 0.3, dr.poleHeight_mm);
  dr.yokeThickness_mm = clampMin(rt.yokeThickness_mm, 0.3, dr.yokeThickness_mm);
  dr.poleArcFraction = Math.min(0.95, Math.max(0.1, num(rt.poleArcFraction, dr.poleArcFraction)));
  dr.dualSided = rt.dualSided === undefined ? dr.dualSided : !!rt.dualSided;
  dr.poleSkew_deg = num(rt.poleSkew_deg, dr.poleSkew_deg);
  dr.poleShape = shapeProfile(rt.poleShape, "design.rotor.poleShape", warnings);
  dr.poleCurve = poleCurveSpec(rt.poleCurve, warnings);
  dr.poleLoft = poleLoftSpec(rt.poleLoft, warnings);
  if (dr.poleLoft && !dr.poleCurve) {
    warnings.push("design.rotor.poleLoft: a loft sweeps a traced footprint, and there is no design.rotor.poleCurve to sweep; ignored.");
    dr.poleLoft = null;
  }
  /* A radius bound is optional, and "absent" has to be tested before the value is coerced: `+null`
   * is 0, so the lazy form would turn "no limit" into "a limit of zero" the second time a spec was
   * normalized — which is every time one round-trips through the archive. */
  const pb = rt.poleBounds ?? {};
  const bound = v => (v === null || v === undefined || v === "" || !Number.isFinite(+v)) ? null : +v;
  dr.poleBounds = {
    maxRadius_mm: bound(pb.maxRadius_mm),
    minRadius_mm: bound(pb.minRadius_mm),
    maxPitchFraction: Math.min(2, Math.max(0.01, num(pb.maxPitchFraction, 1)))
  };
  dr.density_kg_m3 = clampMin(rt.density_kg_m3, 0, dr.density_kg_m3);
  const cl = rt.coreLoss ?? {};
  dr.coreLoss.specificLoss_W_per_kg = clampMin(cl.specificLoss_W_per_kg, 0, dr.coreLoss.specificLoss_W_per_kg);
  dr.coreLoss.atFlux_T = clampMin(cl.atFlux_T, 1e-3, dr.coreLoss.atFlux_T);
  dr.coreLoss.atFrequency_Hz = clampMin(cl.atFrequency_Hz, 1e-3, dr.coreLoss.atFrequency_Hz);
  dr.coreLoss.fluxExponent = clampMin(cl.fluxExponent, 0.5, dr.coreLoss.fluxExponent);
  dr.coreLoss.frequencyExponent = clampMin(cl.frequencyExponent, 0.5, dr.coreLoss.frequencyExponent);

  const bp = src.design?.backPlate ?? {}, db = s.design.backPlate;
  db.enabled = bp.enabled === undefined ? db.enabled : !!bp.enabled;
  db.mu_r = clampMin(bp.mu_r, 1, db.mu_r);
  db.thickness_mm = clampMin(bp.thickness_mm, 0.3, db.thickness_mm);
  db.gapBelowPcb_mm = clampMin(bp.gapBelowPcb_mm, 0, db.gapBelowPcb_mm);
  db.density_kg_m3 = clampMin(bp.density_kg_m3, 0, db.density_kg_m3);

  const op = src.operatingPoint ?? {};
  s.operatingPoint.rotorAngle_deg = num(op.rotorAngle_deg, 0);
  s.operatingPoint.currentAngle_elecDeg = num(op.currentAngle_elecDeg, 45);
  s.operatingPoint.speed_rpm = num(op.speed_rpm, 0);
  s.operatingPoint.windingTemperature_C = num(op.windingTemperature_C, 20);

  const me = src.mesh ?? {}, dm = s.mesh;
  dm.mode = ["uniform", "graded", "cylindrical"].includes(me.mode) ? me.mode : dm.mode;
  dm.cellsAcrossDiameter = Math.max(16, Math.round(num(me.cellsAcrossDiameter, dm.cellsAcrossDiameter)));
  dm.marginFactor = clampMin(me.marginFactor, 0, dm.marginFactor);
  dm.marginMin_mm = clampMin(me.marginMin_mm, 0, dm.marginMin_mm);
  dm.activeCellsAcrossDiameter = Math.max(16, Math.round(num(me.activeCellsAcrossDiameter, dm.activeCellsAcrossDiameter)));
  for (const k of ["cellsAcrossAirGap", "cellsAcrossPoleHeight", "cellsAcrossYoke", "cellsAcrossPcb",
                   "cellsAcrossBackPlate", "cellsAcrossBackGap", "cellsAcrossPoleArc"])
    dm[k] = Math.max(1, Math.round(num(me[k], dm[k])));
  dm.sector = me.sector === undefined ? dm.sector : !!me.sector;
  dm.growthRatio = Math.min(3, Math.max(1.02, num(me.growthRatio, dm.growthRatio)));
  dm.farFieldCellFactor = Math.min(64, Math.max(1, num(me.farFieldCellFactor, dm.farFieldCellFactor)));
  dm.maxCells = Math.max(1e4, num(me.maxCells, dm.maxCells));

  const so = src.solver ?? {};
  s.solver.tolerance = clampMin(so.tolerance, 1e-12, s.solver.tolerance);
  s.solver.maxIterations = Math.max(1, Math.round(num(so.maxIterations, s.solver.maxIterations)));
  s.solver.checkInterval = Math.max(1, Math.round(num(so.checkInterval, s.solver.checkInterval)));
  s.solver.stallPatience = Math.max(1, Math.round(num(so.stallPatience, s.solver.stallPatience)));

  if (src.name !== undefined) s.name = String(src.name).slice(0, 200) || s.name;
  if (src.notes !== undefined) s.notes = String(src.notes);
  if (src.view) s.view = src.view;
  if (src.results) s.results = src.results;

  const errs = validateSpec(s);
  if (errs.length) throw new Error(errs.join(" "));
  return { spec: s, warnings };
}

/* An optional shape profile: rows of {atRadius, widthFraction, offset_deg} describing how a wedge
 * widens and swings with radius. Anything unusable becomes null, which every consumer reads as
 * "no profile", so a malformed shape falls back to the plain arc rather than failing a solve.
 *
 * A profile with one row is a constant-width arc and is accepted; a row wider than the pitch is
 * not, because neighbouring wedges would then intersect — two coils shorted together, or a rotor
 * with no gap between poles. That is a design error worth a message rather than a mesh. */
/* A traced footprint, checked by building it. Authoring errors come back as warnings naming the
 * field and what would fix it, and the design falls back to its arc rather than failing to load —
 * the same contract every other malformed field in here gets. */
/* The coil outline, checked the way the pole's is: it has to parse, and it has to stay inside the
 * annulus and its own pitch. What it does *not* get is a loft — a coil is copper on a layer — so
 * the two ways a pole can leave its box after the fact do not arise here and there is nothing to
 * gate that the normalized coordinates have not already settled. */
function coilCurveSpec(v, warnings) {
  if (v == null) return null;
  try {
    const curve = footprintCurve(v, "design.stator.coilCurve");
    const insp = inspectSolid(tracedSolid({ name: "coilCurve", r0: 1, r1: 2, z0: 0, z1: 1 },
                                          { count: 8, curve }));
    if (!insp.withinDeclaredRadii)
      warnings.push("design.stator.coilCurve: the outline reaches outside the 0..1 radial range, so the coil overhangs the board annulus it is measured in. An interpolating curve overshoots its own points slightly, which is the usual cause. Routed as drawn either way.");
    if (insp.overlaps)
      warnings.push("design.stator.coilCurve: the outline is wider than its own coil pitch (|v| past 0.5), so neighbouring coils short against each other.");
    /* Two tolerances, because they buy different things. chordTolerance_mm is how finely the
     * outline itself is drawn; routeTolerance_mm is how finely each routed turn is handed to
     * Biot-Savart, which is the cost that scales with the turn count. routeCell_mm overrides the
     * router's distance-field pitch, which defaults to half a trace pitch. */
    return { ...v, chordTolerance_mm: clampMin(v.chordTolerance_mm, 1e-4, DEFAULT_CHORD_TOLERANCE_MM),
             routeTolerance_mm: v.routeTolerance_mm == null ? null : clampMin(v.routeTolerance_mm, 1e-4, 0.02),
             routeCell_mm: v.routeCell_mm == null ? null : clampMin(v.routeCell_mm, 1e-3, 0.25) };
  } catch (e) {
    warnings.push(`${e.message}; the coil falls back to its wedge.`);
    return null;
  }
}

function poleCurveSpec(v, warnings) {
  if (v == null) return null;
  try {
    const curve = footprintCurve(v, "design.rotor.poleCurve");
    const insp = inspectSolid(tracedSolid({ name: "poleCurve", r0: 1, r1: 2, z0: 0, z1: 1 },
                                          { count: 8, curve }));
    if (!insp.withinDeclaredRadii)
      warnings.push("design.rotor.poleCurve: the footprint reaches outside the 0..1 radial range, so the pole overhangs the rotor annulus it is measured in. An interpolating curve overshoots its own points slightly, which is the usual cause. Meshed as drawn either way.");
    if (insp.overlaps)
      warnings.push(`design.rotor.poleCurve: the footprint is wider than its own pole pitch (|v| past 0.5), so neighbouring poles run into each other. Narrow it or use fewer poles.`);
    return { ...v, chordTolerance_mm: clampMin(v.chordTolerance_mm, 1e-4, DEFAULT_CHORD_TOLERANCE_MM) };
  } catch (e) {
    warnings.push(`${e.message}; the pole falls back to its arc.`);
    return null;
  }
}

function poleLoftSpec(v, warnings) {
  if (v == null) return null;
  const known = ["scale", "widen", "twist", "shift", "pivot"];
  const bad = Object.keys(v).filter(k => !known.includes(k));
  if (bad.length) warnings.push(`design.rotor.poleLoft: no channel named ${bad.join(", ")}; the channels are ${known.join(", ")}.`);
  const out = {};
  for (const k of known) {
    if (v[k] === undefined || v[k] === null) continue;
    const list = (Array.isArray(v[k]) ? v[k] : [v[k]]).map(Number);
    if (!list.length || !list.every(Number.isFinite)) {
      warnings.push(`design.rotor.poleLoft.${k}: not a number or a list of numbers; ignored.`);
      continue;
    }
    out[k] = k === "pivot" ? list[0] : list;
  }
  return Object.keys(out).length ? out : null;
}

function shapeProfile(v, path, warnings) {
  const rows = Array.isArray(v) ? v : Array.isArray(v?.profile) ? v.profile : null;
  if (v == null) return null;
  if (!rows || !rows.length) { warnings.push(`${path}: not a list of profile points; ignored.`); return null; }
  const out = [];
  for (const r of rows) {
    const u = +(r?.atRadius), w = +(r?.widthFraction), o = +(r?.offset_deg ?? 0);
    if (![u, w, o].every(Number.isFinite)) { warnings.push(`${path}: a point is missing atRadius or widthFraction; ignored.`); continue; }
    if (w > 1) warnings.push(`${path}: a point is ${w} of the pitch wide, which would run neighbouring wedges into each other; narrowed to 1.`);
    out.push({ atRadius: Math.min(1, Math.max(0, u)),
               widthFraction: Math.min(1, Math.max(0.01, w)),
               offset_deg: Math.min(180, Math.max(-180, o)) });
  }
  if (!out.length) { warnings.push(`${path}: no usable profile points; ignored.`); return null; }
  out.sort((a, b) => a.atRadius - b.atRadius);
  return out;
}

/* An optional array of small integers, clamped to a range. Anything unusable becomes null, which
 * every consumer reads as "use the default pattern". */
function intArray(v, lo, hi) {
  if (!Array.isArray(v) || !v.length) return null;
  return v.map(x => Math.min(hi, Math.max(lo, Math.round(num(x, lo)))));
}
function signArray(v) {
  if (!Array.isArray(v) || !v.length) return null;
  return v.map(x => (num(x, 1) < 0 ? -1 : 1));
}

function pickEnum(v, allowed, fallback, path, warnings) {
  const n = +v;
  if (allowed.includes(n)) return n;
  if (v !== undefined) warnings.push(`${path}: ${JSON.stringify(v)} is not one of ${allowed.join(", ")}; using ${fallback}.`);
  return fallback;
}

/* Hard errors — a spec that fails these cannot be meshed at all. */
export function validateSpec(s) {
  const e = [];
  const st = s.design.stator;
  if (!(st.outerRadius_mm > st.innerRadius_mm + 4)) e.push("Outer radius must exceed inner radius by at least 4 mm.");
  if (!(st.innerRadius_mm > 0)) e.push("Inner radius must be positive.");
  return e;
}

/* ---- migration --------------------------------------------------------------------------- */

function migrate(obj, warnings) {
  if (!obj || typeof obj !== "object") throw new Error("That file isn't a project file.");
  if (obj.format !== undefined && obj.format !== SPEC_FORMAT)
    throw new Error("That JSON file isn't an axial-flux project file.");
  const v = obj.version === undefined ? SPEC_VERSION : obj.version;
  if (!(v >= 1)) throw new Error("This project file has no recognised version.");
  if (v > SPEC_VERSION) throw new Error(`This project was saved by a newer version of the tool (format ${v}).`);

  if (v >= 2) return obj;

  // v1 -> v2: the grid lived at solver.gridCellsAcrossDiameter; everything else is unchanged.
  const out = JSON.parse(JSON.stringify(obj));
  const legacy = getPath(out, "solver.gridCellsAcrossDiameter");
  out.mesh = { mode: "uniform", ...(out.mesh || {}) };
  if (Number.isFinite(+legacy) && out.mesh.cellsAcrossDiameter === undefined) out.mesh.cellsAcrossDiameter = +legacy;
  if (out.solver) delete out.solver.gridCellsAcrossDiameter;
  out.version = SPEC_VERSION;
  warnings.push("Upgraded a version 1 project file: the grid setting moved from solver to mesh.");
  return out;
}

/* ---- flat parameter view ------------------------------------------------------------------ */

/* The numeric kernels were written against a flat parameter object. Keeping that shape means the
 * geometry and solver code is unchanged from the validated single-file version. */
export function specToParams(spec) {
  const st = spec.design.stator, rt = spec.design.rotor, bp = spec.design.backPlate;
  return {
    poles: st.poles, layers: st.copperLayers,
    ri: st.innerRadius_mm, ro: st.outerRadius_mm,
    turns: st.turnsPerLayer, fillFraction: st.fillFraction, amps: st.peakCurrent_A,
    pcbT: st.thickness_mm, pitch: st.tracePitch_mm, traceW: st.traceWidth_mm, edge: st.edgeMargin_mm,
    arcSegments: PCB.arcSegments,
    copperT: st.copperThickness_um * 1e-3, boardRho: st.boardDensity_kg_m3,
    coilCount: st.coilCount, phasePattern: st.phasePattern, coilSense: st.coilSense,
    coilSpan: st.coilSpanFraction, coilSkew: st.coilSkew_deg, coilShape: st.coilShape,
    coilCurve: st.coilCurve,
    coilSideSegments: PCB.coilSideSegments,
    poleShape: rt.poleShape, poleCurve: rt.poleCurve, poleLoft: rt.poleLoft, poleBounds: rt.poleBounds,
    gap: rt.airGap_mm, murRot: rt.mu_r, tooth: rt.poleHeight_mm, yoke: rt.yokeThickness_mm, arc: rt.poleArcFraction,
    dual: rt.dualSided, skew: rt.poleSkew_deg, rotorRho: rt.density_kg_m3, coreLoss: rt.coreLoss,
    back: bp.enabled, murBack: bp.mu_r, backT: bp.thickness_mm, backGap: bp.gapBelowPcb_mm, backRho: bp.density_kg_m3,
    theta: spec.operatingPoint.rotorAngle_deg, gamma: spec.operatingPoint.currentAngle_elecDeg,
    rpm: spec.operatingPoint.speed_rpm, tempC: spec.operatingPoint.windingTemperature_C,
    grid: spec.mesh.cellsAcrossDiameter,
    marginFactor: spec.mesh.marginFactor, marginMin: spec.mesh.marginMin_mm,
    mesh: spec.mesh
  };
}

/* Key-order-independent JSON, so two equal specs always hash the same. */
export function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}

/* A stable hash of everything that affects the field, for caching solves across a study. */
export function specHash(spec) {
  const keep = {
    design: spec.design, operatingPoint: spec.operatingPoint,
    mesh: spec.mesh, solver: spec.solver
  };
  const str = stableStringify(keep);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
