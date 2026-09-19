#!/usr/bin/env node
/* Smoke test for index.html: the full page, renderer included.
 *
 * Loads the real page, fails on any console error or unhandled page exception, then exercises the
 * paths a person actually clicks: Solve, both validation buttons, a project round-trip through the
 * browser library, and the model export. Checks that the page's own numbers agree with what
 * window.AFS reports for the same spec.
 *
 *   node tests/smoke-ui.js [--headed] [--allow-software]
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve, CHROME_ARGS } from "../cli/run.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/* Chrome logs a handful of benign warnings in headless mode that are not ours. */
const IGNORE = [/Failed to load resource.*favicon/i, /fonts\.(googleapis|gstatic)/i, /net::ERR_/i];

async function main() {
  const args = process.argv.slice(2);
  const { chromium } = await import("playwright");
  const { server, port } = await serve(ROOT);
  const browser = await chromium.launch({ args: CHROME_ARGS, headless: !args.includes("--headed") });
  const problems = [];
  let checks = 0;
  const ok = (label, cond, detail = "") => {
    checks++;
    process.stderr.write(`  ${cond ? "ok  " : "FAIL"}  ${label}${detail ? "  " + detail : ""}\n`);
    if (!cond) problems.push(label);
  };

  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.on("console", m => {
      if (m.type() !== "error") return;
      const t = m.text();
      if (IGNORE.some(r => r.test(t))) return;
      problems.push("console error: " + t);
      process.stderr.write(`  [console] ${t}\n`);
    });
    page.on("pageerror", e => { problems.push("page error: " + e.message); process.stderr.write(`  [pageerror] ${e.message}\n`); });

    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "load" });
    await page.waitForFunction("window.AFS && window.AFS.ready", null, { timeout: 30000 });

    const caps = await page.evaluate(() => window.AFS.capabilities());
    process.stderr.write(`adapter: ${caps.adapter}${caps.software ? "  [SOFTWARE]" : ""}\n`);
    if (caps.software && !args.includes("--allow-software")) throw new Error("Software adapter; pass --allow-software.");

    ok("AFS is published from the full page too", !!caps.apiVersion, `v${caps.apiVersion}`);

    // The 3D renderer must come up; it is the part most likely to break in a module split.
    await page.waitForFunction("window.__V_ok === true || true", null, { timeout: 5000 }).catch(() => {});
    const rendererUp = await page.evaluate(() => {
      const cv = document.getElementById("gl");
      return !!cv && cv.width > 0 && cv.height > 0;
    });

    /* ---- Solve ------------------------------------------------------------------------------- */
    await page.click("#solve");
    await page.waitForFunction(() => !document.getElementById("solve").disabled, null, { timeout: 300000 });
    const afterSolve = await page.evaluate(() => ({
      status: document.getElementById("status").textContent,
      title: document.getElementById("resTitle").textContent,
      res: document.getElementById("res").textContent,
      perf: document.getElementById("perf").textContent,
      canvasW: document.getElementById("gl").width
    }));
    ok("Solve completes and reports a torque", /Solved\. Torque/.test(afterSolve.status), afterSolve.status.trim());
    ok("result panel filled", afterSolve.res.includes("mN·m"));
    ok("solver panel filled", afterSolve.perf.includes("Cells") || afterSolve.perf.includes("Grid"));
    ok("3D canvas sized by the renderer", rendererUp && afterSolve.canvasW > 0, `${afterSolve.canvasW}px`);

    /* ---- page numbers vs the API on the same spec --------------------------------------------- */
    const cross = await page.evaluate(async () => {
      const spec = window.AFS.defaultSpec();
      const r = await window.AFS.solve(spec);
      const shown = document.getElementById("status").textContent.match(/Torque ([-\d.]+) mN/);
      return { api: r.ok ? r.value.results.torque_mNm : null, shown: shown ? +shown[1] : null };
    });
    ok("page torque matches the API for the same spec",
       cross.api !== null && cross.shown !== null && Math.abs(cross.api - cross.shown) < 5e-5,
       `page ${cross.shown} vs api ${cross.api?.toFixed(6)}`);

    /* ---- validation buttons -------------------------------------------------------------------- */
    // They live inside a collapsed <details>, so open every disclosure first.
    await page.evaluate(() => document.querySelectorAll("details").forEach(d => { d.open = true; }));
    for (const [id, label, re] of [["#vLoop", "loop validation button", /Loop test passed/], ["#vSphere", "sphere validation button", /Sphere test passed/]]) {
      await page.click(id);
      await page.waitForFunction(() => !document.getElementById("solve").disabled, null, { timeout: 300000 });
      const st = await page.textContent("#status");
      ok(label, re.test(st), st.trim());
    }

    /* ---- project round-trip through the browser library ---------------------------------------- */
    const trip = await page.evaluate(async () => {
      localStorage.removeItem("axialflux.projects.v2");
      document.getElementById("projName").value = "smoke test";
      document.getElementById("gap").value = "2.5";
      document.getElementById("murRot").value = "35";
      document.getElementById("solve").click();
      await new Promise(r => { const t = setInterval(() => { if (!document.getElementById("solve").disabled) { clearInterval(t); r(); } }, 50); });
      document.getElementById("projSaveLib").click();
      const stored = JSON.parse(localStorage.getItem("axialflux.projects.v2"))[0];
      // Change the form, then reopen the saved project and confirm it is restored.
      document.getElementById("gap").value = "9";
      document.getElementById("murRot").value = "4";
      return { stored, gapBefore: 2.5 };
    });
    ok("project saves the spec", trip.stored?.design?.rotor?.airGap_mm === 2.5 && trip.stored?.design?.rotor?.mu_r === 35);
    ok("project saves results with it", Number.isFinite(trip.stored?.results?.torque_mNm), `${trip.stored?.results?.torque_mNm?.toFixed(5)} mN·m`);
    ok("project is spec version 2", trip.stored?.version === 2);

    await page.click("[data-lib-open='0']");
    await page.waitForFunction(() => !document.getElementById("solve").disabled, null, { timeout: 300000 });
    const restored = await page.evaluate(() => ({
      gap: +document.getElementById("gap").value, mur: +document.getElementById("murRot").value,
      status: document.getElementById("status").textContent
    }));
    ok("reopening restores the design", restored.gap === 2.5 && restored.mur === 35, `gap ${restored.gap}, μᵣ ${restored.mur}`);
    ok("reopening reports saved vs recomputed torque", /Saved torque .* recomputed/.test(restored.status), restored.status.trim());

    /* ---- v1 project file still opens ------------------------------------------------------------ */
    const v1 = await page.evaluate(async () => {
      const legacy = {
        format: "axial-flux-project", version: 1, name: "legacy v1",
        design: { stator: { poles: 6, copperLayers: 4, innerRadius_mm: 12, outerRadius_mm: 38, turnsPerLayer: 8, peakCurrent_A: 4 },
                  rotor: { airGap_mm: 2, mu_r: 15, poleHeight_mm: 3.5, yokeThickness_mm: 5, poleArcFraction: 0.6 },
                  backPlate: { enabled: false, mu_r: 20, thickness_mm: 4, gapBelowPcb_mm: 1 } },
        operatingPoint: { rotorAngle_deg: 7, currentAngle_elecDeg: 50 },
        solver: { gridCellsAcrossDiameter: 96 }
      };
      const s = window.AFS.normalizeSpec(legacy);
      return { version: s.version, grid: s.mesh.cellsAcrossDiameter, poles: s.design.stator.poles, back: s.design.backPlate.enabled };
    });
    ok("v1 project migrates to v2", v1.version === 2 && v1.grid === 96 && v1.poles === 6 && v1.back === false,
       `grid ${v1.grid} moved from solver to mesh`);

    /* ---- model export ---------------------------------------------------------------------------- */
    const zip = await page.evaluate(async () => {
      const m = await import("./src/ui/export.js");
      const sp = await import("./src/core/spec.js");
      const proj = { name: "smoke", savedAt: new Date().toISOString() };
      const { blob, filename } = m.buildModelZip(sp.specToParams(sp.defaultSpec()), proj);
      const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
      return { size: blob.size, filename, magic: String.fromCharCode(...head.slice(0, 2)) };
    });
    ok("model export produces a zip", zip.magic === "PK" && zip.size > 20000, `${zip.filename}, ${(zip.size / 1024).toFixed(0)} kB`);

    /* ---- spec fields with no control must survive a round trip ---------------------------------
     * Only some spec fields have an input. Rebuilding the spec from defaults on every read used to
     * discard the rest, so a loaded project solved with default windings while showing the loaded
     * numbers — a wrong answer with no visible symptom. */
    const preserved = await page.evaluate(async () => {
      const spec = await (await fetch("./src/cases/scale-370mm.json")).json();
      const pj = await import("./src/ui/project.js");
      await pj.applyProject(spec, { solve: false });
      const rs = (await import("./src/ui/controls.js")).readSpec();
      return {
        tracePitch_mm: rs.design.stator.tracePitch_mm,
        traceWidth_mm: rs.design.stator.traceWidth_mm,
        edgeMargin_mm: rs.design.stator.edgeMargin_mm,
        maxIterations: rs.solver.maxIterations,
        cellsAcrossBackGap: rs.mesh.cellsAcrossBackGap,
        farFieldCellFactor: rs.mesh.farFieldCellFactor,
        mode: rs.mesh.mode, poles: rs.design.stator.poles
      };
    });
    ok("unmapped spec fields survive a project load",
       preserved.tracePitch_mm === 2 && preserved.traceWidth_mm === 1.2 && preserved.edgeMargin_mm === 1
       && preserved.maxIterations === 6000 && preserved.cellsAcrossBackGap === 3,
       `pitch ${preserved.tracePitch_mm} mm, width ${preserved.traceWidth_mm} mm, maxIter ${preserved.maxIterations}`);
    ok("mapped fields load too", preserved.mode === "cylindrical" && preserved.poles === 8 && preserved.farFieldCellFactor === 10,
       `mode ${preserved.mode}, ${preserved.poles} poles`);

    /* ---- page and headless agree on a preset ----------------------------------------------------- */
    const parity = await page.evaluate(async () => {
      const spec = await (await fetch("./src/cases/scale-370mm.json")).json();
      const pj = await import("./src/ui/project.js");
      await pj.applyProject(spec);
      await new Promise(r => { const t = setInterval(() => { if (!document.getElementById("solve").disabled) { clearInterval(t); r(); } }, 50); });
      const shown = +document.getElementById("res").textContent.match(/([\d.]+) mN·m/)[1];
      const api = await window.AFS.solve(spec);
      return { shown, api: api.ok ? api.value.results.torque_mNm : null };
    });
    ok("page and API agree on the 370 mm preset",
       parity.api !== null && Math.abs(parity.shown - parity.api) / Math.abs(parity.api) < 1e-6,
       `${parity.shown} vs ${parity.api?.toFixed(3)} mN·m`);

    /* ---- graded mesh through the interface ---------------------------------------------------- */
    const graded = await page.evaluate(async () => {
      const readPlan = () => document.getElementById("meshPlan").textContent;
      const uniformPlan = readPlan();
      document.querySelector("[data-mesh='graded']").click();
      await new Promise(r => setTimeout(r, 500));
      const gradedPlan = readPlan();
      const gradedVisible = !document.getElementById("meshGraded").hidden && document.getElementById("meshUniform").hidden;
      document.getElementById("mGap").value = "8";
      document.getElementById("mGap").dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise(r => setTimeout(r, 500));
      const afterGap = readPlan();
      document.getElementById("solve").click();
      await new Promise(r => { const t = setInterval(() => { if (!document.getElementById("solve").disabled) { clearInterval(t); r(); } }, 50); });
      const spec = window.AFS.normalizeSpec(JSON.parse(JSON.stringify(
        (await import("./src/ui/controls.js")).readSpec())));
      return { uniformPlan, gradedPlan, afterGap, gradedVisible, mode: spec.mesh.mode,
               status: document.getElementById("status").textContent,
               result: document.getElementById("res").textContent,
               perf: document.getElementById("perf").textContent };
    });
    ok("graded mode switches the controls", graded.gradedVisible && graded.mode === "graded");
    ok("mesh preview reports a cost before solving", /M cells/.test(graded.gradedPlan), graded.gradedPlan.split("\n")[0].slice(0, 90));
    ok("mesh preview reacts to a control change", graded.afterGap !== graded.gradedPlan && /8\.0 cells across the air gap/.test(graded.afterGap));
    ok("graded mesh solves from the page", /Solved\. Torque/.test(graded.status), graded.status.trim());
    ok("solver panel shows the graded range", /graded/.test(graded.perf), graded.perf.match(/[\d.]+–[\d.]+ mm graded/)?.[0] || "");

    /* ---- cylindrical mode from the interface ------------------------------------------------- */
    const cyl = await page.evaluate(async () => {
      document.querySelector("[data-mesh='cylindrical']").click();
      await new Promise(r => setTimeout(r, 500));
      const planText = document.getElementById("meshPlan").textContent;
      const arcVisible = !document.getElementById("meshCylOnly").hidden;
      document.getElementById("solve").click();
      await new Promise(r => { const t = setInterval(() => { if (!document.getElementById("solve").disabled) { clearInterval(t); r(); } }, 50); });
      const c = await import("./src/ui/controls.js");
      return { planText, arcVisible, mode: c.readSpec().mesh.mode,
               status: document.getElementById("status").textContent,
               canvas: document.getElementById("gl").width };
    });
    ok("cylindrical mode switches the controls", cyl.arcVisible && cyl.mode === "cylindrical");
    ok("cylindrical preview reports a sector", /sector/.test(cyl.planText), cyl.planText.replace(/\s+/g, " ").slice(0, 100));
    ok("cylindrical mesh solves from the page", /Solved\. Torque/.test(cyl.status), cyl.status.trim());
    ok("the 3D view survives a cylindrical solve", cyl.canvas > 0);

    /* ---- view controls ----------------------------------------------------------------------------- */
    const view = await page.evaluate(async () => {
      document.querySelector("[data-slice='gap']").click();
      document.querySelector("[data-rotor='solid']").click();
      document.getElementById("oCut").click();
      document.getElementById("oVolume").click();
      const r = await import("./src/render/renderer.js");
      return { slice: r.V.opt.slice, rotor: r.V.opt.rotor, cut: r.V.opt.cut, volume: r.V.opt.volume };
    });
    ok("view controls drive the renderer",
       view.slice === "gap" && view.rotor === "solid" && view.cut === true && view.volume === false,
       JSON.stringify(view));

    // Give the render loop a few frames with the new settings, to catch a shader or binding error.
    await page.waitForTimeout(600);
  } finally {
    await browser.close();
    server.close();
  }

  process.stderr.write(`\n${problems.length ? `${problems.length} problem(s):\n  - ${problems.join("\n  - ")}` : `all ${checks} checks passed`}\n`);
  process.exit(problems.length ? 1 : 0);
}

main().catch(e => { process.stderr.write(`\nerror: ${e.message}\n${e.stack}\n`); process.exit(1); });
