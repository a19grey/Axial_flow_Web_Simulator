/* Binding between the form controls and the design spec.
 *
 * The spec is the source of truth. readSpec() builds one from the controls and normalizes it;
 * writeSpec() pushes one back into the controls. Nothing else in the UI reads an input value, and
 * nothing below src/ui reads the DOM at all.
 */

import { $ } from "./dom.js";
import { defaultSpec, normalizeSpec, getPath, setPath } from "../core/spec.js";

/* control id -> [spec path, kind]. `kind` only says how to read and write the element. */
export const CONTROLS = {
  poles:   ["design.stator.poles", "select"],
  layers:  ["design.stator.copperLayers", "select"],
  ri:      ["design.stator.innerRadius_mm", "number"],
  ro:      ["design.stator.outerRadius_mm", "number"],
  turns:   ["design.stator.turnsPerLayer", "number"],
  amps:    ["design.stator.peakCurrent_A", "number"],
  gap:     ["design.rotor.airGap_mm", "number"],
  murRot:  ["design.rotor.mu_r", "number"],
  tooth:   ["design.rotor.poleHeight_mm", "number"],
  yoke:    ["design.rotor.yokeThickness_mm", "number"],
  arc:     ["design.rotor.poleArcFraction", "number"],
  back:    ["design.backPlate.enabled", "check"],
  murBack: ["design.backPlate.mu_r", "number"],
  backT:   ["design.backPlate.thickness_mm", "number"],
  backGap: ["design.backPlate.gapBelowPcb_mm", "number"],
  theta:   ["operatingPoint.rotorAngle_deg", "number"],
  gamma:   ["operatingPoint.currentAngle_elecDeg", "number"],
  grid:    ["mesh.cellsAcrossDiameter", "select"],
  mActive: ["mesh.activeCellsAcrossDiameter", "number"],
  mGap:    ["mesh.cellsAcrossAirGap", "number"],
  mPole:   ["mesh.cellsAcrossPoleHeight", "number"],
  mYoke:   ["mesh.cellsAcrossYoke", "number"],
  mPcb:    ["mesh.cellsAcrossPcb", "number"],
  mBack:   ["mesh.cellsAcrossBackPlate", "number"],
  mGrowth: ["mesh.growthRatio", "number"],
  mFar:    ["mesh.farFieldCellFactor", "number"]
};

/* Mesh mode is a segmented control rather than an input, so it is held here. */
export const meshMode = { value: "uniform" };

export function setMeshMode(mode) {
  meshMode.value = mode === "graded" ? "graded" : "uniform";
  document.querySelectorAll("[data-mesh]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.mesh === meshMode.value)));
  const u = $("#meshUniform"), g = $("#meshGraded");
  if (u) u.hidden = meshMode.value !== "uniform";
  if (g) g.hidden = meshMode.value !== "graded";
}

/* The spec the controls are a *view* of.
 *
 * Only some spec fields have a control: trace pitch and width, the solver tolerances, the cell
 * budget and several mesh knobs do not. Rebuilding the spec from defaults on every read would
 * silently discard them, so a loaded project would be solved with default windings. The controls
 * are therefore overlaid onto this retained spec rather than onto a fresh default one.
 */
let held = defaultSpec();

/* Replace the retained spec wholesale, for callers that have one from outside the form. */
export function holdSpec(spec) { held = JSON.parse(JSON.stringify(spec)); }
export function heldSpec() { return JSON.parse(JSON.stringify(held)); }

/* Build a normalized spec from the controls. Throws with a readable message on an invalid design,
 * which is what the Solve button surfaces on the status line. */
export function readSpec({ name, notes } = {}) {
  const raw = JSON.parse(JSON.stringify(held));
  for (const [id, [path, kind]] of Object.entries(CONTROLS)) {
    const el = $("#" + id);
    if (!el) continue;
    setPath(raw, path, kind === "check" ? el.checked : +el.value);
  }
  raw.mesh.mode = meshMode.value;
  raw.name = (name ?? $("#projName")?.value ?? "").trim() || "Untitled motor";
  raw.notes = (notes ?? $("#projNotes")?.value ?? "").trim();
  const { spec } = normalizeSpec(raw);
  held = JSON.parse(JSON.stringify(spec));
  return spec;
}

/* Anything that changes the controls announces it, so views derived from the spec — the mesh cost
 * preview in particular — cannot go stale. Typing into an input fires the DOM's own input event;
 * loading a project fires this. */
export const SPEC_CHANGED = "afs-spec-changed";
export const announceSpecChange = () => document.dispatchEvent(new CustomEvent(SPEC_CHANGED));

/* Push a spec into the controls. Returns the paths that could not be applied, so the caller can
 * tell the user which settings kept their previous value. */
export function writeSpec(spec) {
  const skipped = [];
  holdSpec(spec);
  setMeshMode(spec.mesh?.mode);
  for (const [id, [path, kind]] of Object.entries(CONTROLS)) {
    const el = $("#" + id);
    if (!el) continue;
    const v = getPath(spec, path);
    if (v === undefined) { skipped.push(path); continue; }
    if (kind === "check") el.checked = !!v;
    else if (kind === "select") {
      const s = String(v);
      if ([...el.options].some(o => o.value === s)) el.value = s;
      else skipped.push(path);
    } else if (Number.isFinite(+v)) el.value = +v;
    else skipped.push(path);
  }
  if ($("#projName")) $("#projName").value = spec.name || "";
  if ($("#projNotes")) $("#projNotes").value = spec.notes || "";
  announceSpecChange();
  return skipped;
}
