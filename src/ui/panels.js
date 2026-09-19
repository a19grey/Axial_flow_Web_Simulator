/* Result and solver panels.
 *
 * These render what core/results.js and core/validate.js compute; they do not compute anything
 * themselves, so a number shown on the page is the same number the headless CLI prints.
 */

import { $, ui } from "./dom.js";
import { fmtB } from "./format.js";
import { analyzeLoop, analyzeSphere } from "../core/validate.js";

const sgn = v => (v >= 0 ? "+" : "") + v.toFixed(1) + "%";
export function perfPanel(sol) {
  const t = sol.t, pc = sol.pcg;
  const mesh = sol.job.mesh;
  const size = mesh.uniform ? `${mesh.hMin.toFixed(2)} mm`
                            : `${mesh.hMin.toFixed(2)}–${mesh.hMax.toFixed(2)} mm graded`;
  let rows = `<tr><td>Mesh</td><td>${mesh.nx}×${mesh.ny}×${mesh.nz} · ${size}</td></tr>
    <tr class="sub"><td>Cells${mesh.uniform ? "" : " · worst aspect"}</td><td>${sol.N.toLocaleString()}${mesh.uniform ? "" : " · " + mesh.aspect.toFixed(1) + ":1"}</td></tr>`;
  if (sol.nseg) rows += `<tr><td>Biot-Savart, ${sol.nseg.toLocaleString()} segments</td><td>${t.bsCached ? "cached" : t.bs.toFixed(0) + " ms"}</td></tr>` +
    (t.bsCached ? "" : `<tr class="sub"><td>Throughput</td><td>${(sol.N * sol.nseg / t.bs / 1e6).toFixed(0)} G segment-cell/s</td></tr>`);
  if (pc) rows += `<tr><td>Potential solve</td><td>${pc.iters} it · ${pc.ms.toFixed(0)} ms</td></tr>
    <tr class="sub"><td>Per iteration · residual</td><td>${(pc.ms / pc.iters).toFixed(2)} ms · ${pc.rel.toExponential(1)}</td></tr>`;
  rows += `<tr class="sub"><td>Setup · readback and post</td><td>${t.setup.toFixed(0)} · ${t.post.toFixed(0)} ms</td></tr>`;
  $("#perf").innerHTML = `<div class="muted" style="font-size:12px;margin-bottom:6px">${ui.adapterName}</div><table>${rows}</table>`;
}
export function resultPanel(sol) {
  const k = sol.job.kind;
  if (k === "motor") {
    const m = sol.m, I = sol.I, T = m.T;
    $("#resTitle").textContent = "Torque and gap field";
    if (!T.length) { $("#res").innerHTML = `<span class="fail">The air gap is thinner than one grid cell, so no torque surface fits in it. Use a finer mesh or a larger gap.</span>`; return; }
    const Tm = m.torque, agree = m.torqueSpread_pct;
    $("#res").innerHTML = `
      <div class="muted" style="font-size:13px">Torque on rotor</div>
      <div class="big">${(Tm * 1e3).toFixed(3)} mN·m</div>
      <div style="font-size:13px;margin-bottom:8px">${agree === null ? "Only one stress surface fits in the gap, so there is no spread to report." : `Mean of ${T.length} stress surfaces across the gap, spread <span class="${agree < 5 ? "pass" : "fail"}">${agree.toFixed(2)}%</span>`}</div>
      <table>
        ${T.length > 1 ? `<tr class="sub"><td>Range over the ${T.length} surfaces</td><td>${(Math.min(...T) * 1e3).toFixed(4)} – ${(Math.max(...T) * 1e3).toFixed(4)} mN·m</td></tr>` : ""}
        <tr class="sub"><td>Surfaces at z</td><td>${m.planeZ_mm[0].toFixed(2)} – ${m.planeZ_mm[m.planeZ_mm.length - 1].toFixed(2)} mm</td></tr>
        <tr><td>Phase currents A · B · C</td><td>${I.map(v => v.toFixed(2)).join(" · ")} A</td></tr>
        <tr><td>Mean |B<sub>z</sub>| mid-gap over coils</td><td>${fmtB(m.gapBz)}</td></tr>
        <tr><td>Peak |B| in magnetic parts</td><td>${fmtB(m.bmaxMat)}</td></tr>
        <tr class="sub"><td>Coil turns total</td><td>${sol.job.polys.length / (1.5 * sol.job.p.poles)} per layer · ${sol.job.p.layers} layers</td></tr>
      </table>`;
  } else if (k === "sphere") {
    // Numbers come from core/validate.js, the same function the headless runner uses, so the page
    // and the CLI can never disagree about whether this case passed.
    const r = analyzeSphere(sol);
    $("#resTitle").textContent = "Sphere validation";
    $("#res").innerHTML = `<div class="muted" style="font-size:13px">Mean B<sub>z</sub> inside sphere, μᵣ = ${r.mu_r}</div>
      <div class="big">${(r.meanInside_T * 1e3).toFixed(4)} mT</div>
      <div style="font-size:13px;margin-bottom:8px">Analytic ${(r.analytic_T * 1e3).toFixed(4)} mT — <span class="${r.pass ? "pass" : "fail"}">${sgn(r.meanInsideError_pct)}</span> against a ${r.tolerance_pct.toFixed(1)}% tolerance</div>
      <table><tr><td>B<sub>z</sub> at centre</td><td>${(r.centre_T * 1e3).toFixed(4)} mT (${sgn(r.centreError_pct)})</td></tr>
      <tr><td>Applied field μ₀H₀</td><td>${(r.appliedB0_T * 1e3).toFixed(4)} mT</td></tr>
      <tr class="sub"><td>Sphere radius · cells across</td><td>${r.radius_mm} mm · ${r.cellsAcrossSphere.toFixed(0)}</td></tr></table>
      <p class="muted" style="font-size:12px;margin:8px 0 0">The interior field is sensitive to the demagnetizing factor, amplified roughly μᵣ/3 times, so a staircased sphere reads a few percent high at moderate μᵣ. The error shrinks with grid refinement, and about 2–3% of it comes from the finite box.</p>`;
  } else {
    const r = analyzeLoop(sol);
    $("#resTitle").textContent = "Loop validation";
    $("#res").innerHTML = `<div class="muted" style="font-size:13px">Worst error on axis for |z| ≤ 30 mm</div>
      <div class="big ${r.pass ? "pass" : "fail"}">${Math.abs(r.worstError_pct).toFixed(2)}%</div>
      <div style="font-size:13px">Loop radius ${r.loopRadius_mm} mm at 1 A, worst point z = ${r.worstAt_z_mm.toFixed(1)} mm, tolerance ${r.tolerance_pct}%. The small residual is the polygon approximation plus interpolating four cells onto the axis.</div>`;
  }
}

/* Convergence and formulation warnings from core/results.js, shown under the result. */
export function qualityPanel(flags) {
  const el = $("#quality");
  if (!el) return;
  if (!flags || !flags.length) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  el.innerHTML = flags.map(f =>
    `<p class="${f.level === "error" ? "fail" : "warn"}" style="margin:6px 0;font-size:13px">${f.message}</p>`).join("");
}
