/* Page wiring. Every button here calls the same AFS entry points the headless driver calls, so a
 * result on the page and a result from the CLI come from one code path.
 *
 * This module also publishes window.AFS, so an agent can drive the full page exactly as it drives
 * headless.html.
 */

import { $, ui, setStatus, setBusy, requestStop, guarded } from "./dom.js";
import { readSpec } from "./controls.js";
import { perfPanel, resultPanel, qualityPanel } from "./panels.js";
import { drawSweep, drawP2 } from "./plots.js";
import { hookProjectUI, setSolveHook } from "./project.js";
import { initRenderer, updateScene, updateLegend, hookViewControls } from "../render/renderer.js";
import { solveMotor } from "../core/api.js";
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

$("#solve").onclick = () => guarded(async signal => {
  const sol = await solveCurrent(signal);
  const res = resultsSummary(sol);
  setStatus(`Solved. Torque ${fmtTorque(res)} mN·m at γ = ${sol.spec.operatingPoint.currentAngle_elecDeg}°.`);
});

$("#sweep").onclick = () => guarded(async signal => {
  const base = readSpec();
  ui.sweep = { pts: [], base };
  drawSweep();
  const t0 = performance.now();
  for (let g = 0; g <= 180; g += 15) {
    if (signal.aborted) break;
    const variant = JSON.parse(JSON.stringify(base));
    variant.operatingPoint.currentAngle_elecDeg = g;
    const sol = await solveMotor(variant, { onProgress, signal });
    const T = sol.m.T.length ? sol.m.T.reduce((a, b) => a + b, 0) / sol.m.T.length : NaN;
    ui.sweep.pts.push([g, T]);
    drawSweep();
    show(sol, ui.sweep.pts.length > 1);
    setStatus(`Sweep: γ = ${g}°, torque ${(T * 1e3).toFixed(4)} mN·m`);
  }
  setStatus(`Sweep finished: ${ui.sweep.pts.length} solves in ${((performance.now() - t0) / 1000).toFixed(1)} s. The trace field was computed once and reused.`);
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

$("#stop").onclick = requestStop;

/* ---- startup -------------------------------------------------------------------------------------- */

window.addEventListener("resize", () => { drawSweep(); drawP2(); });
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  drawSweep(); drawP2();
  if (ui.sol) updateScene(ui.sol, true);
});

onDeviceLost(info => setStatus(`The GPU device was lost (${info.message}). Try a smaller grid, then solve again.`, true));

drawSweep();
drawP2();
hookViewControls();
updateLegend();
hookProjectUI();
setBusy(false);

if (!navigator.gpu) {
  setStatus("WebGPU isn't available in this browser. Use a recent Chrome or Edge, or Safari 26+.", true);
} else {
  initGPU().then(G => { ui.adapterName = G.name; }).catch(() => {});
  initRenderer().catch(e => { console.error(e); setStatus("The 3D view could not start: " + e.message, true); });
}
