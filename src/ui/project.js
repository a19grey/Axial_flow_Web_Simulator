/* Project files: save, open, the in-browser library, and the model export.
 *
 * A project file is a spec plus the view settings plus a summary of the last solve. The field
 * itself is never stored — the geometry is parametric, so the parameters *are* the geometry, and
 * opening a project re-solves and reports saved against recomputed torque.
 */

import { $, ui, setStatus, guarded } from "./dom.js";
import { readSpec, writeSpec } from "./controls.js";
import { buildModelZip, safeName } from "./export.js";
import { normalizeSpec, specToParams, specHash, SPEC_VERSION, SPEC_FORMAT, getPath } from "../core/spec.js";
import { resultsSummary } from "../core/results.js";
import { V, buildSlices, updateLegend } from "../render/renderer.js";
import { drawSweep } from "./plots.js";

const LIB_KEY = "axialflux.projects.v2";
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/* Called by app.js with the function that re-solves and displays, to avoid a circular import. */
let resolveAndShow = async () => {};
export function setSolveHook(fn) { resolveAndShow = fn; }

/* ---- building and applying a project ------------------------------------------------------- */

export function currentProject() {
  const spec = readSpec();
  const proj = {
    ...spec,
    format: SPEC_FORMAT, version: SPEC_VERSION,
    savedAt: new Date().toISOString(),
    view: { ...V.opt, camera: { azimuth_rad: V.cam.az, elevation_rad: V.cam.el, distance_mm: V.cam.dist, target_mm: [...V.cam.target] } }
  };

  // Results are attached only when they were produced by exactly these inputs.
  const sol = ui.sol;
  const fresh = sol && sol.job.kind === "motor" && sol.spec && specHash(sol.spec) === specHash(spec);
  proj.results = fresh ? { ...resultsSummary(sol), solvedWithTheseInputs: true } : null;

  const sw = ui.sweep;
  const sweepMatches = sw && sw.pts.length && sw.base && specHash({ ...sw.base, operatingPoint: { ...sw.base.operatingPoint, currentAngle_elecDeg: 0 } })
    === specHash({ ...spec, operatingPoint: { ...spec.operatingPoint, currentAngle_elecDeg: 0 } });
  if (sweepMatches) {
    proj.results = { ...(proj.results || {}), currentAngleSweep: sw.pts.map(([g, T]) => ({ currentAngle_elecDeg: g, torque_mNm: T * 1e3 })) };
  }
  return proj;
}

export async function applyProject(obj, { solve = true } = {}) {
  const { spec, warnings } = normalizeSpec(obj);
  const skipped = writeSpec(spec);

  const view = obj.view || {};
  for (const k of ["volume", "lines", "pcb", "back", "cut"]) if (typeof view[k] === "boolean") V.opt[k] = view[k];
  for (const k of ["density", "thr", "lineDensity", "sliceZ"]) if (Number.isFinite(view[k])) V.opt[k] = view[k];
  if (["off", "gap", "axial"].includes(view.slice)) V.opt.slice = view.slice;
  if (["bz", "bmag"].includes(view.sliceField)) V.opt.sliceField = view.sliceField;
  if (["solid", "ghost", "hidden"].includes(view.rotor)) V.opt.rotor = view.rotor;
  syncViewControls();

  const sw = obj.results && obj.results.currentAngleSweep;
  ui.sweep = Array.isArray(sw)
    ? { pts: sw.filter(r => Number.isFinite(r.currentAngle_elecDeg) && Number.isFinite(r.torque_mNm)).map(r => [r.currentAngle_elecDeg, r.torque_mNm / 1e3]), base: spec }
    : null;
  drawSweep();

  const notes = [...warnings];
  if (skipped.length) notes.push(`Some values were missing or invalid and kept their current setting: ${skipped.join(", ")}.`);
  if (notes.length) setStatus(`Loaded "${spec.name}". ${notes.join(" ")}`);

  if (!solve) return;

  const cam = view.camera;
  await guarded(async signal => {
    setStatus(`Recomputing the field for "${spec.name}"…`);
    const sol = await resolveAndShow(signal);
    if (cam && [cam.azimuth_rad, cam.elevation_rad, cam.distance_mm].every(Number.isFinite) && Array.isArray(cam.target_mm)) {
      Object.assign(V.cam, { az: cam.azimuth_rad, el: cam.elevation_rad, dist: cam.distance_mm, target: cam.target_mm.slice(0, 3).map(Number) });
      V.dirty = true;
    }
    if (Number.isFinite(view.sliceZ)) { V.opt.sliceZ = view.sliceZ; $("#sliceZ").value = view.sliceZ; buildSlices(); updateLegend(); }
    const saved = obj.results && obj.results.torque_mNm;
    const now = sol ? resultsSummary(sol).torque_mNm : null;
    setStatus(`Opened "${spec.name}".` + (Number.isFinite(saved) && Number.isFinite(now)
      ? ` Saved torque ${saved.toFixed(4)} mN·m, recomputed ${now.toFixed(4)} mN·m.` : ""));
  });
}

export function syncViewControls() {
  const set = (id, v) => { const el = $(id); if (el) el[el.type === "checkbox" ? "checked" : "value"] = v; };
  set("#oVolume", V.opt.volume); set("#oLines", V.opt.lines); set("#oPcb", V.opt.pcb);
  set("#oBack", V.opt.back); set("#oCut", V.opt.cut);
  set("#oDensity", V.opt.density); set("#oThr", V.opt.thr); set("#oLineDensity", V.opt.lineDensity);
  for (const [attr, val] of [["data-slice", V.opt.slice], ["data-sfield", V.opt.sliceField], ["data-rotor", V.opt.rotor]])
    document.querySelectorAll(`[${attr}]`).forEach(b => b.setAttribute("aria-pressed", String(b.getAttribute(attr) === val)));
  V.dirty = true;
}

/* ---- saving files ----------------------------------------------------------------------------- */

let dlPromise = null;
// A self-hosted copy has no viewer bridge, so it falls back to an ordinary browser download.
const LOCAL_DOWNLOADS = {
  async save({ filename, data }) {
    const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data]));
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
};

export function getDownloads() {
  if (!dlPromise) dlPromise = (window.claude && typeof window.claude.use === "function")
    ? window.claude.use("downloads").catch(() => null)
    : Promise.resolve(LOCAL_DOWNLOADS);
  return dlPromise;
}

export async function saveFile(filename, data) {
  const dl = await getDownloads();
  if (!dl) { setStatus("Saving files isn't available in this view. Open the published page to save.", true); return false; }
  try { await dl.save({ filename, data }); setStatus(`Saved ${filename}.`); return true; }
  catch (e) {
    const c = e && e.code;
    if (c === "declined") setStatus("Save cancelled.");
    else if (c === "rate_limited") setStatus("A save prompt is already open. Finish that one first.", true);
    else setStatus(`Couldn't save the file (${c || e.message || e}).`, true);
    return false;
  }
}

/* ---- browser library (this browser only) -------------------------------------------------------- */

function libRead() { try { const a = JSON.parse(localStorage.getItem(LIB_KEY) || "[]"); return Array.isArray(a) ? a : []; } catch { return []; } }
function libWrite(a) {
  try { localStorage.setItem(LIB_KEY, JSON.stringify(a)); return true; }
  catch { setStatus("This browser wouldn't store the project. Save it as a file instead.", true); return false; }
}

export function renderLibrary() {
  const a = libRead(), el = $("#library");
  if (!el) return;
  if (!a.length) { el.innerHTML = `<p class="muted small" style="margin:6px 0 0">Nothing saved in this browser yet.</p>`; return; }
  el.innerHTML = `<table class="lib">${a.map((p, i) => {
    const r = p.results || {}, d = new Date(p.savedAt);
    return `<tr><td><button class="linkish" data-lib-open="${i}" title="Open and recompute">${esc(p.name)}</button><div class="muted small">${isNaN(d) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " · "}μᵣ ${getPath(p, "design.rotor.mu_r") ?? "–"}, gap ${getPath(p, "design.rotor.airGap_mm") ?? "–"} mm</div></td>
      <td>${Number.isFinite(r.torque_mNm) ? r.torque_mNm.toFixed(3) + " mN·m" : '<span class="muted">not solved</span>'}<div class="muted small">${Number.isFinite(r.gapBzMean_mT) ? r.gapBzMean_mT.toFixed(2) + " mT gap" : ""}</div></td>
      <td><button class="small" data-lib-del="${i}" aria-label="Delete ${esc(p.name)}">✕</button></td></tr>`;
  }).join("")}</table>`;
  el.querySelectorAll("[data-lib-open]").forEach(b => b.onclick = () => {
    const p = libRead()[+b.dataset.libOpen];
    if (p) applyProject(p).catch(e => setStatus(e.message, true));
  });
  el.querySelectorAll("[data-lib-del]").forEach(b => b.onclick = () => {
    const a2 = libRead(), p = a2[+b.dataset.libDel];
    if (!p || !confirm(`Delete "${p.name}" from this browser?`)) return;
    a2.splice(+b.dataset.libDel, 1); libWrite(a2); renderLibrary();
  });
}

/* ---- worked examples ------------------------------------------------------------------------------
 *
 * The case files under src/cases are the same JSON the CLI runs, so a design listed here and a
 * design run headless are one file, not two copies that can drift. A static host has no directory
 * listing, so the list is held here; the blurb is short because each file carries its own notes,
 * which land in the Notes box when it loads.
 */
export const PRESETS = [
  { file: "pcb-reluctance-80mm.json", label: "PCB reluctance, 80 mm", blurb: "the default machine; solves in under a second" },
  { file: "yasa-shapes-demo.json", label: "Shape demo: skewed coils, comma poles", blurb: "profiled geometry neither a width nor a skew can draw" },
  { file: "scale-370mm.json", label: "370 mm scale test, 3 mm gap", blurb: "the graded-mesh case; a few million cells" },
  { file: "dual-rotor-370mm.json", label: "370 mm dual rotor", blurb: "a rotor on both sides, no back plate" }
];

export function hookPresets() {
  const sel = $("#presetPick"), note = $("#presetNote");
  if (!sel) return;
  for (const p of PRESETS) {
    const o = document.createElement("option");
    o.value = p.file; o.textContent = p.label;
    sel.append(o);
  }
  const describe = () => {
    const p = PRESETS.find(q => q.file === sel.value);
    if (note) note.textContent = p ? p.blurb : "Worked examples, loaded from the same case files the headless driver runs.";
  };
  describe();
  sel.onchange = async () => {
    const p = PRESETS.find(q => q.file === sel.value);
    describe();
    if (!p) return;
    setStatus(`Loading "${p.label}"…`);
    try {
      // Relative, because the tool is served from a subdirectory of a larger site.
      const res = await fetch(`./src/cases/${p.file}`, { cache: "no-cache" });
      if (!res.ok) throw new Error(`the case file returned ${res.status}`);
      await applyProject(await res.json());
    } catch (e) {
      setStatus(`Couldn't load "${p.label}": ${e.message}`, true);
    } finally {
      sel.value = "";
      describe();
    }
  };
}

/* ---- wiring -------------------------------------------------------------------------------------- */

export function hookProjectUI() {
  $("#projSaveFile").onclick = async () => {
    let proj; try { proj = currentProject(); } catch (e) { setStatus(e.message, true); return; }
    await saveFile(`${safeName(proj.name)}.json`, JSON.stringify(proj, null, 2));
  };
  $("#projOpen").onclick = () => $("#projFile").click();
  $("#projFile").onchange = async e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    if (f.size > 5e6) { setStatus("That file is too large to be a project file.", true); return; }
    try { await applyProject(JSON.parse(await f.text())); }
    catch (err) { setStatus(err instanceof SyntaxError ? "That file isn't valid JSON." : err.message, true); }
  };
  $("#projSaveLib").onclick = () => {
    let proj; try { proj = currentProject(); } catch (e) { setStatus(e.message, true); return; }
    const a = libRead(), i = a.findIndex(q => q.name === proj.name);
    if (i >= 0) a[i] = proj; else a.unshift(proj);
    if (libWrite(a)) { renderLibrary(); setStatus(`Saved "${proj.name}" in this browser${proj.results ? " with its results" : ". Solve first to store results with it"}.`); }
  };
  $("#projExport").onclick = async () => {
    let proj, p;
    try { proj = currentProject(); p = specToParams(readSpec()); } catch (e) { setStatus(e.message, true); return; }
    const { blob, filename } = buildModelZip(p, proj);
    await saveFile(filename, blob);
  };
  hookPresets();
  renderLibrary();
  getDownloads().then(dl => {
    for (const id of ["#projSaveFile", "#projExport"]) { $(id).disabled = !dl; $(id).hidden = !dl; }
    $("#dlNote").hidden = !!dl;
  });
}
