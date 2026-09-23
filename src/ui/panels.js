/* Result and solver panels.
 *
 * These render what core/results.js and core/validate.js compute; they do not compute anything
 * themselves, so a number shown on the page is the same number the headless CLI prints.
 */

import { $, ui } from "./dom.js";
import { fmtB } from "./format.js";
import { analyzeLoop, analyzeSphere } from "../core/validate.js";
import { resultsSummary } from "../core/results.js";

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
    const res = resultsSummary(sol), d = res.derived;
    /* A dual-sided machine gets a line per rotor. They are mirror images, so their difference is a
     * mesh asymmetry and worth showing rather than averaging away. */
    const rotorRows = res.rotors.length < 2 ? "" : `<table>
        ${res.rotors.map(r => `<tr class="sub"><td>${r.name === "upper" ? "Upper" : "Lower"} rotor, gap at z = ${r.midGapZ_mm.toFixed(2)} mm</td><td>${r.torque_mNm.toFixed(4)} mN·m</td></tr>`).join("")}
        <tr class="sub"><td>Imbalance between them</td><td class="${res.rotorImbalance_pct < 2 ? "pass" : "fail"}">${res.rotorImbalance_pct.toFixed(2)}%</td></tr>
      </table>`;
    // Worst mismatch between the volume each region should occupy and the volume the mesh gave it.
    const worst = d.rasterization ? d.rasterization.reduce((a, b) => (Math.abs(b.error_pct) > Math.abs(a.error_pct) ? b : a)) : null;
    const rast = !worst ? "" : `<tr class="sub"><td>Meshed volume vs exact, worst region</td><td class="${Math.abs(worst.error_pct) < 1 ? "pass" : "warn"}">${worst.error_pct >= 0 ? "+" : ""}${worst.error_pct.toFixed(3)}%</td></tr>`;
    $("#res").innerHTML = `
      <div class="muted" style="font-size:13px">Torque on rotor</div>
      <div class="big">${(Tm * 1e3).toFixed(3)} mN·m</div>
      ${d.perUnit.airgapShear_psi === null ? "" : `<div class="muted" style="font-size:13px;margin-top:6px">Air-gap shear stress, over ${d.perUnit.workingGaps === 2 ? "two working gaps" : "the working gap"}</div>
      <div class="big">${d.perUnit.airgapShear_psi.toFixed(3)} psi</div>
      <div class="muted" style="font-size:12px;margin-bottom:4px">${d.perUnit.airgapShear_kPa.toFixed(2)} kPa — torque divided by the r-weighted gap area, so it does not reward a larger rotor for being larger. Good machines run 3–6 psi air-cooled and reach about 14 psi, one atmosphere, at the top end.</div>`}
      <div style="font-size:13px;margin-bottom:8px">${agree === null ? "Only one stress surface fits in the gap, so there is no spread to report." : `Mean of ${T.length} stress surfaces across the gap, spread <span class="${agree < 5 ? "pass" : "fail"}">${agree.toFixed(2)}%</span>`}</div>
      <table>
        ${T.length > 1 ? `<tr class="sub"><td>Range over the ${T.length} surfaces</td><td>${(Math.min(...T) * 1e3).toFixed(4)} – ${(Math.max(...T) * 1e3).toFixed(4)} mN·m</td></tr>` : ""}
        <tr class="sub"><td>Surfaces at z</td><td>${m.planeZ_mm[0].toFixed(2)} – ${m.planeZ_mm[m.planeZ_mm.length - 1].toFixed(2)} mm</td></tr>
        <tr><td>Phase currents A · B · C</td><td>${I.map(v => v.toFixed(2)).join(" · ")} A</td></tr>
        <tr><td>Mean |B<sub>z</sub>| mid-gap over coils</td><td>${fmtB(m.gapBz)}</td></tr>
        <tr><td>Peak |B| in magnetic parts</td><td>${fmtB(m.bmaxMat)}</td></tr>
        <tr class="sub"><td>Coil turns total</td><td>${(sol.job.polys.length / d.winding.coils).toFixed(0)} per coil · ${d.winding.coils} coils · ${sol.job.p.layers} layers</td></tr>
      </table>
      ${rotorRows}
      <h3 style="margin:14px 0 4px;font-size:13px">Derived</h3>
      <table>
        <tr><td>Phase resistance at ${d.winding.temperature_C.toFixed(0)} °C</td><td>${d.winding.phaseResistance_ohm[0].toFixed(3)} Ω</td></tr>
        <tr class="sub"><td>Conductor per phase</td><td>${d.winding.conductorLength_m[0].toFixed(2)} m × ${d.winding.conductorArea_mm2.toFixed(4)} mm²</td></tr>
        <tr><td>Copper loss at this current</td><td>${d.losses_W.copper.toFixed(2)} W</td></tr>
        <tr><td>Mass, rotor · stator</td><td>${(d.mass_kg.rotor * 1e3).toFixed(0)} · ${(d.mass_kg.stator * 1e3).toFixed(0)} g</td></tr>
        <tr><td>Torque density</td><td>${d.perUnit.torqueDensity_Nm_per_kg === null ? "—" : (d.perUnit.torqueDensity_Nm_per_kg * 1e3).toFixed(3) + " mN·m/kg"}</td></tr>
        <tr class="sub"><td>Torque per amp · per √W</td><td>${d.perUnit.torquePerAmp_mNm_per_A === null ? "—" : d.perUnit.torquePerAmp_mNm_per_A.toFixed(4) + " mN·m/A"} · ${d.perUnit.torquePerRootWatt_Nm_per_sqrtW === null ? "—" : (d.perUnit.torquePerRootWatt_Nm_per_sqrtW * 1e3).toFixed(3) + " mN·m/√W"}</td></tr>
        ${rast}
      </table>
      <p class="muted" style="font-size:12px;margin:8px 0 0">Resistance and copper mass count the modelled traces only — no run-outs, vias or star point — so both are lower bounds for a real board.</p>`;
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

/* ---- cross-checks ------------------------------------------------------------------------------ */

const pct = v => (v === null || v === undefined ? "—" : `${v.toFixed(2)}%`);
const cls = (v, good) => (v === null || v === undefined ? "" : v <= good ? "pass" : "fail");

/* The virtual-work, inductance and angle studies, each rendered into the same panel. What these
 * are for is comparison, so every one of them leads with the number that disagrees. */
export function crossPanel(kind, r) {
  const panel = $("#crossPanel"), el = $("#cross");
  if (!panel || !el) return;
  panel.hidden = false;
  if (kind === "virtualWork") {
    $("#crossTitle").textContent = "Torque by two independent methods";
    el.innerHTML = `
      <div class="muted" style="font-size:13px">Virtual work — dW′/dθ at constant current</div>
      <div class="big">${r.torqueVirtualWork_mNm.toFixed(4)} mN·m</div>
      <div style="font-size:13px;margin-bottom:8px">Maxwell stress on the same field gives
        ${r.torqueMaxwellStress_mNm.toFixed(4)} mN·m — they differ by
        <span class="${cls(r.disagreement_pct, 3)}">${pct(r.disagreement_pct)}</span></div>
      <table>
        ${r.stencilEstimates.map(e => `<tr class="sub"><td>Order-${e.order} stencil</td><td>${e.torque_mNm.toFixed(4)} mN·m</td></tr>`).join("")}
        <tr class="sub"><td>Spread across stencil orders</td><td class="${cls(r.stencilSpread_pct, 2)}">${pct(r.stencilSpread_pct)}</td></tr>
        <tr class="sub"><td>Spread across stress surfaces</td><td class="${cls(r.maxwellSurfaceSpread_pct, 5)}">${pct(r.maxwellSurfaceSpread_pct)}</td></tr>
        <tr class="sub"><td>Step · solves</td><td>${r.step_deg.toFixed(3)}° · ${r.solves}</td></tr>
      </table>
      <p class="muted" style="font-size:12px;margin:8px 0 0">A surface integral in the air gap against a volume integral over the whole domain. They share the field and nothing else, so agreement here is a much stronger statement than agreement between two stress surfaces.</p>`;
  } else if (kind === "inductance") {
    const t = r.dq_H.total, uH = v => (v * 1e6).toFixed(3);
    $("#crossTitle").textContent = "Inductance";
    el.innerHTML = `
      <div class="muted" style="font-size:13px">L<sub>d</sub> and L<sub>q</sub> at θ<sub>e</sub> = ${r.electricalAngle_deg.toFixed(1)}°</div>
      <div class="big">${uH(t.Ld)} / ${uH(t.Lq)} µH</div>
      <div style="font-size:13px;margin-bottom:8px">Saliency ratio ${r.saliencyRatio.toFixed(4)}</div>
      <table>
        <tr><td>From the material response</td><td>${uH(r.dq_H.material.Ld)} / ${uH(r.dq_H.material.Lq)} µH</td></tr>
        <tr class="sub"><td>Air-core part, filament estimate</td><td>${uH(t.Ld - r.dq_H.material.Ld)} µH, equal in d and q</td></tr>
        <tr><td>Reciprocity, L<sub>jk</sub> vs L<sub>kj</sub></td><td class="${cls(r.reciprocity.asymmetry_pct, 1)}">${pct(r.reciprocity.asymmetry_pct)}</td></tr>
        <tr><td>Torque from (3/2)(P/2)(L<sub>d</sub>−L<sub>q</sub>)i<sub>d</sub>i<sub>q</sub></td><td>${r.torqueFromSaliency_mNm.toFixed(4)} mN·m</td></tr>
        <tr class="sub"><td>Currents i<sub>d</sub> · i<sub>q</sub></td><td>${r.currents_A.d.toFixed(3)} · ${r.currents_A.q.toFixed(3)} A</td></tr>
      </table>
      <p class="muted" style="font-size:12px;margin:8px 0 0">Reciprocity is a theorem, so the asymmetry is pure discretization error — it falls with angular refinement and is an error bar that costs nothing. The saliency torque assumes a harmonic-free machine, which a concentrated winding is not, so expect it to sit below the Maxwell-stress torque.</p>`;
  } else {
    const cl = r.coreLoss;
    $("#crossTitle").textContent = "One electrical period of rotation";
    el.innerHTML = `
      <div class="muted" style="font-size:13px">Mean torque over ${r.count} rotor positions across ${r.period_deg}°</div>
      <div class="big">${r.torqueMean_mNm.toFixed(4)} mN·m</div>
      <div style="font-size:13px;margin-bottom:8px">Ripple ${pct(r.ripple_pct)} peak-to-peak
        (${r.torqueMin_mNm.toFixed(4)} – ${r.torqueMax_mNm.toFixed(4)} mN·m)</div>
      <table>
        ${(r.harmonics || []).filter(h => h.ofMean_pct > 1).slice(0, 4).map(h =>
          `<tr class="sub"><td>Harmonic ${h.order} of the electrical period</td><td>${h.ofMean_pct.toFixed(1)}% of mean</td></tr>`).join("")}
        ${cl.available
          ? `<tr><td>Core loss at ${cl.frequency_Hz.toFixed(0)} Hz</td><td>${cl.coreLoss_W < 0.01 ? cl.coreLoss_W.toExponential(2) : cl.coreLoss_W.toFixed(3)} W</td></tr>
             <tr class="sub"><td>Rotor iron · peak |B| amplitude</td><td>${(cl.ironMass_kg * 1e3).toFixed(0)} g · ${fmtB(cl.peakFluxAmplitude_T)}</td></tr>`
          : `<tr class="sub"><td>Core loss</td><td class="muted">${cl.reason}</td></tr>`}
      </table>
      <p class="muted" style="font-size:12px;margin:8px 0 0">${cl.available ? cl.model + " " + cl.caveats[0] : "Ripple and harmonics are solver output; core loss needs the rotor frame, which only the cylindrical mesh recovers exactly."}</p>`;
  }
}
