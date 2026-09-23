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
import { serve, chromeArgs } from "../cli/run.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/* Chrome logs a handful of benign warnings in headless mode that are not ours. */
const IGNORE = [/Failed to load resource.*favicon/i, /fonts\.(googleapis|gstatic)/i, /net::ERR_/i];

async function main() {
  const args = process.argv.slice(2);
  const { chromium } = await import("playwright");
  const { server, port } = await serve(ROOT);
  const browser = await chromium.launch({ args: chromeArgs(args.includes("--force-software")), headless: !args.includes("--headed") });
  const problems = [];
  let checks = 0, skipped = 0;
  let tiny = false;   // set once the adapter is known
  const ok = (label, cond, detail = "") => {
    checks++;
    process.stderr.write(`  ${cond ? "ok  " : "FAIL"}  ${label}${detail ? "  " + detail : ""}\n`);
    if (!cond) problems.push(label);
  };
  /* A check whose truth depends on the mesh being fine enough to resolve the physics.
   *
   * On a software adapter the meshes are shrunk until they run in seconds, which makes the fields
   * genuinely inaccurate — a 3 mm gap spanned by two cells has no valid stress surface, and the
   * sphere test is 30% out. Asserting physics there would either fail honestly or force tolerances
   * so loose they stop meaning anything. These checks are skipped, visibly, and the analytic suite
   * carries physics correctness on CI instead. */
  const okPhysics = (label, cond, detail = "") => {
    if (tiny) { skipped++; process.stderr.write(`  skip  ${label}  (software adapter: mesh too coarse to assert this)\n`); return; }
    ok(label, cond, detail);
  };

  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.on("console", m => {
      if (m.type() !== "error") return;
      const t = m.text();
      if (IGNORE.some(r => r.test(t))) return;
      // SwiftShader does not support everything the 3D view asks of a real GPU, so an unscoped
      // WebGPU error there is the adapter's limitation rather than a defect. It is printed either
      // way; it only stops counting as a failure when there is no hardware adapter to blame.
      if (tiny && /WebGPU error/.test(t)) { process.stderr.write(`  [console, tolerated on software] ${t}\n`); return; }
      problems.push("console error: " + t);
      process.stderr.write(`  [console] ${t}\n`);
    });
    page.on("pageerror", e => { problems.push("page error: " + e.message); process.stderr.write(`  [pageerror] ${e.message}\n`); });

    /* autosolve=0: the page would otherwise start solving its default design the moment it loads,
     * which is the right behaviour for a person and the wrong one for a driver that is about to
     * replace the mesh with something small enough to run on a software adapter. The autosolve
     * itself is checked at the end, on a page of its own. */
    await page.goto(`http://127.0.0.1:${port}/index.html?autosolve=0`, { waitUntil: "load" });
    await page.waitForFunction("window.AFS && window.AFS.ready", null, { timeout: 30000 });
    await page.evaluate(() => { window.shrinkSpec = s => (window.__tinyMesh ? { ...s, mesh: { ...s.mesh, ...window.__tinyMesh } } : s); });

    const caps = await page.evaluate(() => window.AFS.capabilities());
    process.stderr.write(`adapter: ${caps.adapter}${caps.software ? "  [SOFTWARE]" : ""}\n`);
    if (caps.software && !args.includes("--allow-software")) throw new Error("Software adapter; pass --allow-software.");

    ok("AFS is published from the full page too", !!caps.apiVersion, `v${caps.apiVersion}`);

    /* On a software adapter — which is what CI has — the meshes this test would otherwise use take
     * minutes each. The test is about wiring, not accuracy, so shrink every mesh to something that
     * exercises the same code paths in seconds. Reported numbers are then meaningless, and the
     * assertions below are written not to depend on their values. */
    tiny = caps.software;
    if (tiny) {
      process.stderr.write("  (software adapter: using minimal meshes)\n");
      await page.evaluate(() => {
        const set = (id, v) => { const e = document.getElementById(id); if (e) { e.value = String(v); e.dispatchEvent(new Event("input", { bubbles: true })); } };
        // A coarse uniform grid cannot fit a stress surface in a 3 mm gap, so the page would
        // correctly report no torque. Cylindrical resolves the gap at a fraction of the cells, so
        // it is the mode that makes a meaningful smoke test possible without a GPU.
        document.querySelector("[data-mesh='cylindrical']").click();
        set("grid", 64);
        set("mActive", 40); set("mGap", 2); set("mPole", 2); set("mYoke", 1);
        set("mPcb", 1); set("mBack", 1); set("mArc", 6);
        /* Deliberately no `mode`: the shrink makes every mesh small without changing which kind
         * of mesh is being exercised, so a spec loaded in cylindrical mode stays cylindrical and
         * the form's uniform mode still matches what the API is handed. */
        window.__tinyMesh = {
          cellsAcrossDiameter: 48,
          activeCellsAcrossDiameter: 40, cellsAcrossPoleArc: 6,
          cellsAcrossAirGap: 2, cellsAcrossPoleHeight: 2, cellsAcrossYoke: 1,
          cellsAcrossPcb: 1, cellsAcrossBackPlate: 1, cellsAcrossBackGap: 1,
          growthRatio: 1.5, farFieldCellFactor: 16, maxCells: 40000000
        };
      });
    }
    // window.shrinkSpec (installed above) is applied to any spec the test loads from disk, so a
    // preset's own mesh does not sneak back in.

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
    okPhysics("result panel filled with a torque", afterSolve.res.includes("mN·m"));
    ok("solver panel filled", afterSolve.perf.includes("Cells") || afterSolve.perf.includes("Grid"));
    ok("3D canvas sized by the renderer", rendererUp && afterSolve.canvasW > 0, `${afterSolve.canvasW}px`);

    /* ---- page numbers vs the API on the same spec ---------------------------------------------
     * The spec comes from the controls, so this compares the page against the API for exactly what
     * the page is displaying rather than for an assumed default. */
    const cross = await page.evaluate(async () => {
      const spec = (await import("./src/ui/controls.js")).readSpec();
      const r = await window.AFS.solve(spec);
      const shown = document.getElementById("status").textContent.match(/Torque ([-\d.]+) mN/);
      return { api: r.ok ? r.value.results.torque_mNm : null, shown: shown ? +shown[1] : null,
               err: r.ok ? null : r.error.message };
    });
    okPhysics("page torque matches the API for the same spec",
       cross.api !== null && cross.shown !== null && Math.abs(cross.api - cross.shown) < 5e-5,
       `page ${cross.shown} vs api ${cross.api?.toFixed(6)}`);

    /* ---- validation buttons -------------------------------------------------------------------- */
    // They live inside a collapsed <details>, so open every disclosure first.
    await page.evaluate(() => document.querySelectorAll("details").forEach(d => { d.open = true; }));
    for (const [id, label, pass, ran] of [
      ["#vLoop", "loop validation", /Loop test passed/, /Loop test (passed|FAILED)/],
      ["#vSphere", "sphere validation", /Sphere test passed/, /Sphere test (passed|FAILED)/]
    ]) {
      await page.click(id);
      await page.waitForFunction(() => !document.getElementById("solve").disabled, null, { timeout: 300000 });
      const st = await page.textContent("#status");
      // The button running and reporting a verdict is wiring; the verdict itself is physics.
      ok(`${label} button runs and reports`, ran.test(st), st.trim());
      okPhysics(`${label} passes`, pass.test(st));
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
    okPhysics("project saves results with it", Number.isFinite(trip.stored?.results?.torque_mNm), `${trip.stored?.results?.torque_mNm?.toFixed(5)} mN·m`);
    ok("project is spec version 2", trip.stored?.version === 2);

    await page.click("[data-lib-open='0']");
    await page.waitForFunction(() => !document.getElementById("solve").disabled, null, { timeout: 300000 });
    const restored = await page.evaluate(() => ({
      gap: +document.getElementById("gap").value, mur: +document.getElementById("murRot").value,
      status: document.getElementById("status").textContent
    }));
    ok("reopening restores the design", restored.gap === 2.5 && restored.mur === 35, `gap ${restored.gap}, μᵣ ${restored.mur}`);
    okPhysics("reopening reports saved vs recomputed torque", /Saved torque .* recomputed/.test(restored.status), restored.status.trim());

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
      const spec = shrinkSpec(await (await fetch("./src/cases/scale-370mm.json")).json());
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
    // cellsAcrossBackGap and farFieldCellFactor are among the fields the software-adapter shrink
    // overrides, so only fields it leaves alone are asserted.
    ok("unmapped spec fields survive a project load",
       preserved.tracePitch_mm === 2 && preserved.traceWidth_mm === 1.2 && preserved.edgeMargin_mm === 1
       && preserved.maxIterations === 6000 && (tiny || preserved.cellsAcrossBackGap === 3),
       `pitch ${preserved.tracePitch_mm} mm, width ${preserved.traceWidth_mm} mm, maxIter ${preserved.maxIterations}`);
    // farFieldCellFactor is one of the fields the software-adapter shrink overrides, so only the
    // fields the shrink leaves alone are asserted here.
    ok("mapped fields load too", preserved.poles === 8 && preserved.mode === "cylindrical",
       `mode ${preserved.mode}, ${preserved.poles} poles`);

    /* ---- page and headless agree on a preset ----------------------------------------------------- */
    const parity = await page.evaluate(async () => {
      const spec = shrinkSpec(await (await fetch("./src/cases/scale-370mm.json")).json());
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
      const beforePlan = readPlan();
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
      return { beforePlan, gradedPlan, afterGap, gradedVisible, mode: spec.mesh.mode,
               status: document.getElementById("status").textContent,
               result: document.getElementById("res").textContent,
               perf: document.getElementById("perf").textContent };
    });
    ok("graded mode switches the controls", graded.gradedVisible && graded.mode === "graded", `mode ${graded.mode}`);
    ok("mesh preview reports a cost before solving", /[\d,.]+ (M )?cells/.test(graded.gradedPlan), graded.gradedPlan.split("\n")[0].slice(0, 90));
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

    /* ---- dual-sided rotor and the derived metrics panel ---------------------------------------
     * The page is already in cylindrical mode here, which is what a dual-sided machine wants. */
    const dual = await page.evaluate(async () => {
      const chk = document.getElementById("dual");
      chk.checked = true;
      chk.dispatchEvent(new Event("change", { bubbles: true }));
      chk.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise(r => setTimeout(r, 400));
      const backDisabled = document.getElementById("backT").disabled;
      const noteShown = !document.getElementById("dualNote").hidden;
      document.getElementById("solve").click();
      await new Promise(r => { const t = setInterval(() => { if (!document.getElementById("solve").disabled) { clearInterval(t); r(); } }, 50); });
      const res = document.getElementById("res").textContent;
      chk.checked = false;
      chk.dispatchEvent(new Event("change", { bubbles: true }));
      chk.dispatchEvent(new Event("input", { bubbles: true }));
      return { backDisabled, noteShown, res, status: document.getElementById("status").textContent };
    });
    ok("dual-sided disables the back plate controls", dual.backDisabled && dual.noteShown);
    ok("a dual-sided machine solves from the page", /Solved\. Torque/.test(dual.status), dual.status.trim());
    okPhysics("both rotors are reported", /Upper rotor/.test(dual.res) && /Lower rotor/.test(dual.res),
              dual.res.match(/Imbalance between them\s*([\d.]+%)/)?.[1] || "");
    ok("the derived metrics reach the panel",
       /Phase resistance/.test(dual.res) && /Torque density/.test(dual.res) && /Meshed volume vs exact/.test(dual.res));
    ok("air-gap shear stress is reported in psi, over both gaps",
       /psi/.test(dual.res) && /two working gaps/.test(dual.res),
       dual.res.match(/([\d.]+)\s*psi/)?.[0] || "no psi line");

    /* ---- a cross-check runs from its button -----------------------------------------------------
     * Inductance is the cheapest of the three (three solves, no rotor motion), so it is the one the
     * smoke test clicks. */
    const xc = await page.evaluate(async () => {
      document.getElementById("xInduct").click();
      await new Promise(r => { const t = setInterval(() => { if (!document.getElementById("solve").disabled) { clearInterval(t); r(); } }, 50); });
      return { status: document.getElementById("status").textContent,
               hidden: document.getElementById("crossPanel").hidden,
               title: document.getElementById("crossTitle").textContent,
               body: document.getElementById("cross").textContent };
    });
    ok("the inductance cross-check runs from its button", /Reciprocity holds/.test(xc.status), xc.status.trim());
    ok("and fills the cross-check panel", !xc.hidden && /Inductance/.test(xc.title) && /Saliency ratio/.test(xc.body));

    /* ---- the rotor-angle study takes over the sweep plot ---------------------------------------
     * Six positions only: this is about the plot and the panel being wired, not about ripple. */
    const ang = await page.evaluate(async () => {
      const api = await import("./src/core/api.js");
      const plots = await import("./src/ui/plots.js");
      const c = await import("./src/ui/controls.js");
      const r = await api.torqueVsAngle(c.readSpec(), { count: 6 });
      plots.drawAngleSweep(r);
      return { title: document.getElementById("p1title").textContent,
               points: r.points.length, ripple: r.ripple_pct, core: r.coreLoss.available };
    });
    ok("the rotor-angle study plots on the sweep canvas", /Torque vs rotor angle/.test(ang.title), ang.title.trim());
    ok("it returns one point per position", ang.points >= 4, `${ang.points} positions`);
    okPhysics("and a ripple figure", Number.isFinite(ang.ripple), `${ang.ripple?.toFixed(1)}%`);

    /* ---- the page must not be wider than the window ---------------------------------------------
     * Twice now a grid without an explicit track has let a fixed-size canvas set a max-content
     * width in the thousands of pixels and stretched the whole page sideways. It is invisible in a
     * functional test and obvious in a screenshot, so it gets an assertion. */
    const overflow = await page.evaluate(() => {
      const w = window.innerWidth;
      const wide = [...document.querySelectorAll("body *")]
        .filter(e => Math.round(e.getBoundingClientRect().right) > w + 2)
        .map(e => e.tagName + (e.id ? "#" + e.id : "") + (typeof e.className === "string" && e.className ? "." + e.className.split(" ")[0] : ""));
      return { scrollWidth: document.body.scrollWidth, innerWidth: w, wide: [...new Set(wide)].slice(0, 6) };
    });
    ok("nothing overflows the window horizontally", overflow.scrollWidth <= overflow.innerWidth + 2,
       `page ${overflow.scrollWidth}px in a ${overflow.innerWidth}px window${overflow.wide.length ? ": " + overflow.wide.join(", ") : ""}`);

    /* ---- the current-angle sweep, and the confirming solve at its fitted peak -----------------
     * Thirteen solves plus one, so it is only worth running where a solve is fast. What it checks
     * is that the peak solve happens at all, that its angle is the fit's and not a sweep grid
     * point, and that the form is left on the angle the page is displaying. */
    if (!tiny) {
      const sweep = await page.evaluate(async () => {
        document.getElementById("sweep").click();
        await new Promise(r => { const t = setInterval(() => { if (!document.getElementById("sweep").disabled) { clearInterval(t); r(); } }, 100); });
        const { ui } = await import("./src/ui/dom.js");
        return { status: document.getElementById("status").textContent,
                 points: ui.sweep?.pts.length ?? 0, peak: ui.sweep?.peak ?? null,
                 fit: ui.sweep?.fit ?? null, gammaBox: +document.getElementById("gamma").value,
                 shownGamma: ui.sol?.spec.operatingPoint.currentAngle_elecDeg ?? null };
      });
      ok("the sweep solves the whole current-angle range", sweep.points === 13, `${sweep.points} points`);
      ok("and then solves once more at the fitted peak",
         sweep.peak !== null && Math.abs(sweep.peak.gamma_deg - sweep.fit.peak) < 0.01,
         sweep.peak ? `${sweep.peak.gamma_deg}\u00b0, ${sweep.peak.torque_mNm.toFixed(4)} mN\u00b7m` : "no peak solve");
      ok("the page is left showing that solve, and the form agrees",
         sweep.peak !== null && sweep.shownGamma === sweep.peak.gamma_deg && sweep.gammaBox === sweep.peak.gamma_deg,
         `form ${sweep.gammaBox}\u00b0, displayed ${sweep.shownGamma}\u00b0`);
      okPhysics("the peak solve lands on the fit it was predicted from",
         sweep.peak !== null && Math.abs(sweep.peak.torque_mNm - sweep.peak.fitted_mNm) / Math.abs(sweep.peak.fitted_mNm) < 0.1,
         sweep.peak ? `${sweep.peak.torque_mNm.toFixed(4)} vs ${sweep.peak.fitted_mNm.toFixed(4)} mN\u00b7m fitted` : "");
    } else {
      skipped++;
      process.stderr.write("  skip  the current-angle sweep and its peak solve  (software adapter: 14 solves is too slow)\n");
    }

    /* ---- worked examples and shape profiles ------------------------------------------------------
     * The dropdown loads the same case files the CLI runs, so a broken or renamed one is a broken
     * page rather than a broken test fixture. Each is fetched and planned, which builds its mesh
     * without solving it, and then the shape demo is loaded the way the dropdown loads it and
     * solved: profiled coils and a profiled rotor through the full page path. */
    const demo = await page.evaluate(async () => {
      const pj = await import("./src/ui/project.js");
      const settle = () => new Promise(r => { const t = setInterval(() => { if (!document.getElementById("solve").disabled) { clearInterval(t); r(); } }, 50); });
      const plans = [];
      for (const p of pj.PRESETS) {
        const res = await fetch(`./src/cases/${p.file}`);
        const raw = res.ok ? await res.json() : null;
        const r = raw ? await window.AFS.plan(shrinkSpec(raw)) : null;
        plans.push({ file: p.file, status: res.status, name: raw?.name,
                     ok: !!r && !r.error && r.fits !== false, error: r?.error ?? null });
      }
      const spec = shrinkSpec(await (await fetch("./src/cases/yasa-shapes-demo.json")).json());
      await pj.applyProject(spec, { solve: false });
      const note = document.getElementById("shapeNote");
      const noteText = note.hidden ? null : note.textContent;
      document.getElementById("solve").click();
      await settle();
      const status = document.getElementById("status").textContent;

      /* The field-line control. Both readings come from the same solved field, so the only thing
       * that can move the count is the control itself. */
      const lines = async v => {
        const el = document.getElementById("oLineDensity");
        el.value = String(v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise(r => setTimeout(r, 700));
        return +(document.getElementById("lineInfo").textContent.match(/^(\d+) field lines/)?.[1] ?? 0);
      };
      const sparse = await lines(0.5), dense = await lines(4);
      await lines(1);
      return { plans, noteText, status, sparse, dense };
    });
    ok("every worked example fetches and meshes", demo.plans.every(p => p.status === 200 && p.ok),
       demo.plans.map(p => `${p.name || p.file}${p.ok ? "" : " FAILED: " + (p.error || p.status)}`).join("; "));
    ok("a profiled design says so, rather than showing arc controls it ignores",
       /pole profile/.test(demo.noteText || "") && /coil profile/.test(demo.noteText || ""),
       (demo.noteText || "no note").trim());
    ok("the shape demo solves from the page", /Solved\. Torque/.test(demo.status), demo.status.trim());
    okPhysics("the field-line control changes how many lines are drawn", demo.dense > demo.sparse * 2,
       `${demo.sparse} lines at 0.5x, ${demo.dense} at 4x`);

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

    /* ---- the page solves by itself on load ------------------------------------------------------
     * On a fresh page with no query string. Only the start is asserted: the default mesh is the
     * real one, which on a software adapter would take minutes, so the solve is stopped as soon as
     * it is seen to have begun. */
    const fresh = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    let autoStarted = false;
    try {
      await fresh.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "load" });
      await fresh.waitForFunction("window.AFS && window.AFS.ready", null, { timeout: 30000 });
      autoStarted = await fresh.waitForFunction(
        () => document.getElementById("solve").disabled || /Solved\. Torque/.test(document.getElementById("status").textContent),
        null, { timeout: 60000 }).then(() => true).catch(() => false);
      const st = await fresh.evaluate(() => document.getElementById("status").textContent);
      ok("the page starts a solve on load, with nobody pressing anything", autoStarted, st.trim().slice(0, 60));
      // Best effort: the point of the click is to shorten the solve, not to be part of the check.
      await fresh.evaluate(() => document.getElementById("stop").click()).catch(() => {});
    } finally {
      await fresh.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  const tail = skipped ? ` (${skipped} physics checks skipped: software adapter)` : "";
  process.stderr.write(`\n${problems.length ? `${problems.length} problem(s):\n  - ${problems.join("\n  - ")}` : `all ${checks} checks passed${tail}`}\n`);
  process.exit(problems.length ? 1 : 0);
}

main().catch(e => { process.stderr.write(`\nerror: ${e.message}\n${e.stack}\n`); process.exit(1); });
