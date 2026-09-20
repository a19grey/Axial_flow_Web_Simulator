/* Page wiring. Every button here calls the same AFS entry points the headless driver calls, so a
 * result on the page and a result from the CLI come from one code path.
 *
 * This module also publishes window.AFS, so an agent can drive the full page exactly as it drives
 * headless.html.
 */

import { $, ui, setStatus, setBusy, requestStop, guarded } from "./dom.js";
import { readSpec, heldSpec, setMeshMode, syncDualSided, announceSpecChange, CONTROLS, SPEC_CHANGED } from "./controls.js";
import { perfPanel, resultPanel, qualityPanel, crossPanel } from "./panels.js";
import { drawSweep, drawAngleSweep, drawP2, sin2Fit } from "./plots.js";
import { hookProjectUI, setSolveHook } from "./project.js";
import { initRenderer, updateScene, updateLegend, hookViewControls } from "../render/renderer.js";
import { solveMotor, plan, virtualWork, inductance, torqueVsAngle } from "../core/api.js";
import { runLoopCase, runSphereCase } from "../core/validate.js";
import { resultsSummary } from "../core/results.js";
import { initGPU, onDeviceLost } from "../gpu/device.js";
import "../afs.js";

/* ---- display ----------------------------------------------------------------------------------- */

function show(sol, keepView) {
  ui.sol = sol;
  resultPanel(sol);
  perfPanel(sol);
  qualityPanel(sol.job.kind === "motor" ? resultsSummary(sol).quality : null);
  drawP2();
  try { updateScene(sol, keepView); }
  catch (e) { console.error(e); setStatus("3D view update failed: " + e.message, true); }
}

/* Progress from the solver onto the status line. */
const onProgress = ev => {
  if (ev.phase === "rasterize") setStatus("Rasterizing rotor and back plate…");
  else if (ev.phase === "biotSavart") setStatus(`Biot-Savart: ${ev.done} of ${ev.total} trace segments summed…`);
  else if (ev.phase === "pcg") setStatus(`Potential solve: iteration ${ev.iteration}, residual ${ev.residual.toExponential(2)}`);
};

const fmtTorque = res => (res && Number.isFinite(res.torque_mNm) ? res.torque_mNm.toFixed(4) : "—");

/* ---- actions ------------------------------------------------------------------------------------ */

async function solveCurrent(signal, keepView = false) {
  const spec = readSpec();
  const sol = await solveMotor(spec, { onProgress, signal });
  show(sol, keepView);
  return sol;
}
setSolveHook(signal => solveCurrent(signal, false));

const solveAction = () => guarded(async signal => {
  const sol = await solveCurrent(signal);
  const res = resultsSummary(sol);
  setStatus(`Solved. Torque ${fmtTorque(res)} mN·m at γ = ${sol.spec.operatingPoint.currentAngle_elecDeg}°.`);
});
$("#solve").onclick = solveAction;

/* Sweep the current angle, then solve once more at the peak the fit predicts.
 *
 * The sweep is on a 15° grid, so the best sampled point can be up to 7.5° from the true optimum,
 * and the sin 2γ fit locates it far better than the grid does. One extra solve turns the fitted
 * peak from a drawn curve into a computed operating point, and leaves the page showing the machine
 * at its best current angle rather than at 180°, which is where the sweep happens to end. */
const sweepMean = sol => (sol.m.T.length ? sol.m.T.reduce((a, b) => a + b, 0) / sol.m.T.length : NaN);

$("#sweep").onclick = () => guarded(async signal => {
  const base = readSpec();
  ui.sweep = { pts: [], base };
  ui.angle = null;
  drawSweep();
  const t0 = performance.now();
  const at = async g => {
    const variant = JSON.parse(JSON.stringify(base));
    variant.operatingPoint.currentAngle_elecDeg = g;
    return solveMotor(variant, { onProgress, signal });
  };
  for (let g = 0; g <= 180; g += 15) {
    if (signal.aborted) break;
    const sol = await at(g);
    const T = sweepMean(sol);
    ui.sweep.pts.push([g, T]);
    drawSweep();
    show(sol, ui.sweep.pts.length > 1);
    setStatus(`Sweep: γ = ${g}°, torque ${(T * 1e3).toFixed(4)} mN·m`);
  }
  const elapsed = () => ((performance.now() - t0) / 1000).toFixed(1);
  if (signal.aborted) { setStatus(`Sweep stopped after ${ui.sweep.pts.length} solves.`); return; }

  const fit = sin2Fit(ui.sweep.pts);
  if (!Number.isFinite(fit.peak)) {
    setStatus(`Sweep finished: ${ui.sweep.pts.length} solves in ${elapsed()} s. The fit was degenerate, so no peak was confirmed.`);
    return;
  }
  const gPeak = +fit.peak.toFixed(2);
  setStatus(`Sweep done in ${elapsed()} s. Confirming the fitted peak at γ = ${gPeak}°…`);
  const sol = await at(gPeak);
  const T = sweepMean(sol);
  ui.sweep.peak = { gamma_deg: gPeak, torque_mNm: T * 1e3, fitted_mNm: fit.amp * 1e3 };
  drawSweep();
  show(sol, true);
  // Leave the form on the angle that is being displayed, so pressing Solve reproduces this result.
  const box = $("#gamma");
  if (box) { box.value = String(gPeak); announceSpecChange(); }
  const missPct = fit.amp ? Math.abs(T - fit.amp) / Math.abs(fit.amp) * 100 : 0;
  setStatus(`Sweep finished: ${ui.sweep.pts.length + 1} solves in ${elapsed()} s. Peak torque ${(T * 1e3).toFixed(4)} mN·m at γ = ${gPeak}°, ${missPct.toFixed(1)}% from the sin 2γ fit. The view is showing that solve.`);
});

$("#vLoop").onclick = () => guarded(async signal => {
  const { sol, report } = await runLoopCase(readSpec(), { onProgress, signal });
  show(sol);
  setStatus(`Loop test ${report.pass ? "passed" : "FAILED"}: worst on-axis error ${Math.abs(report.worstError_pct).toFixed(3)}% against a ${report.tolerance_pct}% tolerance.`);
});

$("#vSphere").onclick = () => guarded(async signal => {
  const { sol, report } = await runSphereCase(readSpec(), { onProgress, signal });
  show(sol);
  setStatus(`Sphere test ${report.pass ? "passed" : "FAILED"}: mean interior B_z is ${report.meanInsideError_pct.toFixed(2)}% from analytic, tolerance ${report.tolerance_pct.toFixed(1)}%.`);
});

/* The cross-checks. Each runs several solves, so each reports its own cost on the status line. */
const CROSS = {
  xVirtual: { kind: "virtualWork", run: (spec, o) => virtualWork(spec, o),
    status: r => `Virtual work gives ${r.torqueVirtualWork_mNm.toFixed(4)} mN·m against ${r.torqueMaxwellStress_mNm.toFixed(4)} from Maxwell stress — ${r.disagreement_pct.toFixed(2)}% apart, over ${r.solves} solves.` },
  xInduct: { kind: "inductance", run: (spec, o) => inductance(spec, o),
    status: r => `Ld ${(r.dq_H.total.Ld * 1e6).toFixed(2)} µH, Lq ${(r.dq_H.total.Lq * 1e6).toFixed(2)} µH. Reciprocity holds to ${r.reciprocity.asymmetry_pct.toFixed(3)}%.` },
  xAngle: { kind: "angle", run: (spec, o) => torqueVsAngle(spec, o), plot: drawAngleSweep,
    status: r => `Mean torque ${r.torqueMean_mNm.toFixed(4)} mN·m over ${r.count} positions, ripple ${r.ripple_pct === null ? "—" : r.ripple_pct.toFixed(1) + "%"}.` }
};
for (const [id, c] of Object.entries(CROSS)) {
  const el = $("#" + id);
  if (el) el.onclick = () => guarded(async signal => {
    setStatus("Running the cross-check — this takes several solves.");
    const r = await c.run(readSpec(), { onProgress: crossProgress, signal });
    crossPanel(c.kind, r);
    c.plot && c.plot(r);
    setStatus(c.status(r));
  });
}

const crossProgress = ev => {
  if (ev.phase === "virtualWork") setStatus(`Co-energy: solving with the rotor at ${ev.angle_deg.toFixed(3)}°…`);
  else if (ev.phase === "inductance") setStatus(`Inductance: unit current in phase ${"ABC"[ev.index]}, ${ev.index + 1} of ${ev.total}…`);
  else if (ev.phase === "angle") setStatus(`Rotor position ${ev.index + 1} of ${ev.total}, θ = ${ev.angle_deg.toFixed(2)}°…`);
  else onProgress(ev);
};

$("#stop").onclick = requestStop;

/* ---- live mesh preview -------------------------------------------------------------------------
 * plan() is cheap (it builds the mesh but rasterizes nothing and touches no GPU buffers), so the
 * cost of a mesh can be shown while it is being tuned rather than discovered by pressing Solve. */

let planTimer = null;
function schedulePlan() {
  clearTimeout(planTimer);
  planTimer = setTimeout(refreshPlan, 150);
}

async function refreshPlan() {
  const el = $("#meshPlan");
  if (!el) return;
  let info;
  try { info = await plan(readSpec()); }
  catch (e) { el.innerHTML = `<span class="fail">${e.message}</span>`; return; }
  if (info.error) { el.innerHTML = `<span class="fail">${info.error}</span>`; return; }

  const m = info.mesh, r = info.resolution_cells;
  const size = m.uniform ? `${m.smallestCell_mm.toFixed(2)} mm cells`
    : `${m.smallestCell_mm.toFixed(2)}–${m.largestCell_mm.toFixed(1)} mm`;
  const gapClass = r.airGap < 3 ? "fail" : r.airGap < 5 ? "warn" : "pass";
  const saving = info.savingVsUniform > 1.5
    ? ` · <span class="pass">${info.savingVsUniform}× fewer than uniform</span>` : "";
  const cells = m.cells >= 1e6 ? `${(m.cells / 1e6).toFixed(2)} M cells` : `${m.cells.toLocaleString()} cells`;
  const sector = m.sectors > 1 ? ` · <span class="pass">1/${m.sectors} sector</span>` : "";
  el.innerHTML =
    `<strong>${cells}</strong> ${m.dimensions.join("×")} · ${size} · ${info.memory.totalDeviceMB} MB${saving}${sector}` +
    `<br><span class="${gapClass}">${r.airGap.toFixed(1)} cells across the air gap</span>` +
    (r.poleArc ? ` · ${r.poleArc.toFixed(1)} across the pole arc` : "") +
    (m.uniform ? "" : ` · aspect ${m.worstAspectRatio.toFixed(0)}:1`) +
    (info.notes.length ? `<br><span class="fail">${info.notes[0]}</span>` : "");
}

document.querySelectorAll("[data-mesh]").forEach(b => b.onclick = () => { setMeshMode(b.dataset.mesh); schedulePlan(); });
$("#dual")?.addEventListener("change", syncDualSided);
for (const id of Object.keys(CONTROLS)) { const el = $("#" + id); if (el) el.addEventListener("input", schedulePlan); }
document.addEventListener(SPEC_CHANGED, schedulePlan);

/* ---- startup -------------------------------------------------------------------------------------- */

window.addEventListener("resize", () => { drawSweep(); drawP2(); });
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  drawSweep(); drawP2();
  if (ui.sol) updateScene(ui.sol, true);
});

onDeviceLost(info => setStatus(`The GPU device was lost (${info.message}). Try a smaller grid, then solve again.`, true));

drawSweep();
drawP2();
setMeshMode(heldSpec().mesh.mode);
syncDualSided();
hookViewControls();
updateLegend();
hookProjectUI();
setBusy(false);

/* The page solves its default design as soon as it can, so the first thing seen is a field and a
 * torque rather than an empty view and a button. It is one ordinary solve through the same handler
 * the button uses, it can be stopped like any other, and ?autosolve=0 suppresses it — which is what
 * a test driver wants when it is about to set up a mesh of its own. */
const AUTO_SOLVE = new URLSearchParams(location.search).get("autosolve") !== "0";

if (!navigator.gpu) {
  setStatus("WebGPU isn't available in this browser. Use a recent Chrome or Edge, or Safari 26+.", true);
} else {
  initGPU().then(G => { ui.adapterName = G.name; }).catch(() => {});
  refreshPlan();
  initRenderer()
    .catch(e => { console.error(e); setStatus("The 3D view could not start: " + e.message, true); })
    .then(() => {
      if (!AUTO_SOLVE || ui.busy) return;
      setStatus("Solving the default design\u2026 press Stop to interrupt, or change anything and solve again.");
      return solveAction();
    });
}
