/* The design spec: one versioned JSON object that is the sole input to a solve.
 *
 * Both the browser UI and the headless API build a spec and hand it to solve(). Nothing downstream
 * reads the DOM. Every numeric field carries its unit in its name.
 *
 * v1 was the project-file format of the single-file tool. v2 keeps every v1 path so old project
 * files load unchanged, and adds an explicit `mesh` section (v1 kept the grid under `solver`).
 */

import { PCB, SOLVER_DEFAULTS } from "./constants.js";

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
        turnsPerLayer: 10, peakCurrent_A: 5,
        thickness_mm: PCB.thickness_mm,
        tracePitch_mm: PCB.tracePitch_mm,
        traceWidth_mm: PCB.traceWidth_mm,
        edgeMargin_mm: PCB.edgeMargin_mm
      },
      rotor: {
        airGap_mm: 3, mu_r: 20,
        poleHeight_mm: 3, yokeThickness_mm: 4, poleArcFraction: 0.5
      },
      backPlate: { enabled: true, mu_r: 20, thickness_mm: 4, gapBelowPcb_mm: 1 }
    },
    operatingPoint: { rotorAngle_deg: 0, currentAngle_elecDeg: 45 },
    mesh: {
      mode: "uniform",
      cellsAcrossDiameter: 128,
      marginFactor: 0.4,      // outer-box margin as a fraction of outer radius
      marginMin_mm: 12
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
  ds.turnsPerLayer = Math.max(1, Math.round(num(st.turnsPerLayer, ds.turnsPerLayer)));
  ds.peakCurrent_A = num(st.peakCurrent_A, ds.peakCurrent_A);
  ds.thickness_mm = clampMin(st.thickness_mm, 0.1, ds.thickness_mm);
  ds.tracePitch_mm = clampMin(st.tracePitch_mm, 0.05, ds.tracePitch_mm);
  ds.traceWidth_mm = clampMin(st.traceWidth_mm, 0.01, ds.traceWidth_mm);
  ds.edgeMargin_mm = clampMin(st.edgeMargin_mm, 0, ds.edgeMargin_mm);

  const rt = src.design?.rotor ?? {}, dr = s.design.rotor;
  dr.airGap_mm = clampMin(rt.airGap_mm, 0.3, dr.airGap_mm);
  dr.mu_r = clampMin(rt.mu_r, 1, dr.mu_r);
  dr.poleHeight_mm = clampMin(rt.poleHeight_mm, 0.3, dr.poleHeight_mm);
  dr.yokeThickness_mm = clampMin(rt.yokeThickness_mm, 0.3, dr.yokeThickness_mm);
  dr.poleArcFraction = Math.min(0.95, Math.max(0.1, num(rt.poleArcFraction, dr.poleArcFraction)));

  const bp = src.design?.backPlate ?? {}, db = s.design.backPlate;
  db.enabled = bp.enabled === undefined ? db.enabled : !!bp.enabled;
  db.mu_r = clampMin(bp.mu_r, 1, db.mu_r);
  db.thickness_mm = clampMin(bp.thickness_mm, 0.3, db.thickness_mm);
  db.gapBelowPcb_mm = clampMin(bp.gapBelowPcb_mm, 0, db.gapBelowPcb_mm);

  const op = src.operatingPoint ?? {};
  s.operatingPoint.rotorAngle_deg = num(op.rotorAngle_deg, 0);
  s.operatingPoint.currentAngle_elecDeg = num(op.currentAngle_elecDeg, 45);

  const me = src.mesh ?? {};
  s.mesh.mode = me.mode === "graded" ? "graded" : "uniform";
  s.mesh.cellsAcrossDiameter = Math.max(16, Math.round(num(me.cellsAcrossDiameter, s.mesh.cellsAcrossDiameter)));
  s.mesh.marginFactor = clampMin(me.marginFactor, 0, s.mesh.marginFactor);
  s.mesh.marginMin_mm = clampMin(me.marginMin_mm, 0, s.mesh.marginMin_mm);

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
    turns: st.turnsPerLayer, amps: st.peakCurrent_A,
    pcbT: st.thickness_mm, pitch: st.tracePitch_mm, traceW: st.traceWidth_mm, edge: st.edgeMargin_mm,
    arcSegments: PCB.arcSegments,
    gap: rt.airGap_mm, murRot: rt.mu_r, tooth: rt.poleHeight_mm, yoke: rt.yokeThickness_mm, arc: rt.poleArcFraction,
    back: bp.enabled, murBack: bp.mu_r, backT: bp.thickness_mm, backGap: bp.gapBelowPcb_mm,
    theta: spec.operatingPoint.rotorAngle_deg, gamma: spec.operatingPoint.currentAngle_elecDeg,
    grid: spec.mesh.cellsAcrossDiameter,
    marginFactor: spec.mesh.marginFactor, marginMin: spec.mesh.marginMin_mm
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
