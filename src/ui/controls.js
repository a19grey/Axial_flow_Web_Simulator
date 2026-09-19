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
  grid:    ["mesh.cellsAcrossDiameter", "select"]
};

/* Build a normalized spec from the controls. Throws with a readable message on an invalid design,
 * which is what the Solve button surfaces on the status line. */
export function readSpec({ name, notes } = {}) {
  const raw = defaultSpec();
  for (const [id, [path, kind]] of Object.entries(CONTROLS)) {
    const el = $("#" + id);
    if (!el) continue;
    setPath(raw, path, kind === "check" ? el.checked : +el.value);
  }
  raw.name = (name ?? $("#projName")?.value ?? "").trim() || "Untitled motor";
  raw.notes = (notes ?? $("#projNotes")?.value ?? "").trim();
  const { spec } = normalizeSpec(raw);
  return spec;
}

/* Push a spec into the controls. Returns the paths that could not be applied, so the caller can
 * tell the user which settings kept their previous value. */
export function writeSpec(spec) {
  const skipped = [];
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
  return skipped;
}
