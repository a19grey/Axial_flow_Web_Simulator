#!/usr/bin/env node
/* Mesh convergence and scale suite.
 *
 * Two questions this answers that no single solve can:
 *
 *   1. Does the answer stop moving as the mesh is refined? Two Maxwell-stress surfaces agreeing
 *      says the field is smooth between them; it does not say the mesh is fine enough, because
 *      both surfaces can be wrong together.
 *   2. Does the graded mesh agree with a uniform one on a problem small enough to run both? If it
 *      does not, grading has introduced an error rather than removed one.
 *
 * Also runs the 370 mm / 3 mm-gap case, the geometry a uniform grid cannot reach at all, and
 * records what it actually cost.
 *
 *   node tests/convergence.js [--quick] [--out report.json]
 */

import { writeFile, readFile, mkdir } from "node:fs/promises";

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { serve, CHROME_ARGS } from "../cli/run.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/* The last refinement must move the answer by less than this for the case to pass. */
const SETTLED_PCT = {
  /* The small machine's reluctance torque is a difference between the d- and q-axis reluctances,
   * so it is a small number carrying the discretization error of two larger ones, and it settles
   * into a band rather than onto a value. The large machine, whose features span many more cells,
   * settles cleanly. */
  "80 mm PCB reluctance": 2.5,
  "370 mm scale test": 1.0
};
/* Graded and uniform meshes at comparable resolution must agree within this. */
const CROSS_MESH_PCT = 3.0;

async function main() {
  const args = process.argv.slice(2);
  const quick = args.includes("--quick");
  const outFile = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;

  const { chromium } = await import("playwright");
  const { server, port } = await serve(ROOT);
  const browser = await chromium.launch({ args: CHROME_ARGS });
  const problems = [];
  const report = { generatedAt: new Date().toISOString(), cases: {} };

  const ok = (label, cond, detail = "") => {
    process.stderr.write(`  ${cond ? "ok  " : "FAIL"}  ${label}${detail ? "  " + detail : ""}\n`);
    if (!cond) problems.push(label);
  };

  try {
    const page = await browser.newPage();
    page.on("pageerror", e => { problems.push("page error: " + e.message); process.stderr.write(`  [pageerror] ${e.message}\n`); });
    await page.goto(`http://127.0.0.1:${port}/headless.html`, { waitUntil: "load" });
    await page.waitForFunction("window.AFS && window.AFS.ready", null, { timeout: 30000 });

    const caps = await page.evaluate(() => window.AFS.capabilities());
    process.stderr.write(`adapter: ${caps.adapter}${caps.software ? "  [SOFTWARE]" : ""}\n`);
    report.adapter = caps.adapter;
    report.softwareAdapter = caps.software;
    if (caps.software && !args.includes("--allow-software")) throw new Error("Software adapter; pass --allow-software.");

    const solve = spec => page.evaluate(async s => {
      const r = await window.AFS.solve(s);
      return r.ok ? r.value.results : { error: r.error.message };
    }, spec);
    const study = (spec, factors) => page.evaluate(async ([s, f]) => {
      const r = await window.AFS.convergence(s, { factors: f });
      return r.ok ? r.value : { error: r.error.message };
    }, [spec, factors]);

    const load = async name => JSON.parse(await readFile(resolve(ROOT, "src/cases", name), "utf8"));
    const small = await load("pcb-reluctance-80mm.json");
    const large = await load("scale-370mm.json");

    /* ---- 1. is grading buying accuracy per cell? ----------------------------------------------
     * The claim grading makes is not "it agrees with a uniform grid" — a uniform grid coarse
     * enough to compare against is not converged either. The claim is that for a given number of
     * cells, grading lands closer to the converged answer. So: establish a reference by refining
     * hard, then compare the two meshes against it at a matched cell budget. */
    process.stderr.write("\n1. accuracy per cell, graded vs uniform (80 mm machine)\n");
    const ref = await solve({ ...small, mesh: { ...small.mesh, mode: "graded", activeCellsAcrossDiameter: 400, cellsAcrossAirGap: 14,
                                                cellsAcrossPoleHeight: 10, cellsAcrossYoke: 8, cellsAcrossPcb: 8, cellsAcrossBackPlate: 8 } });
    const uni = await solve({ ...small, mesh: { ...small.mesh, mode: "uniform", cellsAcrossDiameter: 200 } });
    const gra = await solve({ ...small, mesh: { ...small.mesh, mode: "graded", activeCellsAcrossDiameter: 200, cellsAcrossAirGap: 7 } });
    const errOf = r => Math.abs(r.torque_mNm - ref.torque_mNm) / Math.abs(ref.torque_mNm) * 100;
    const eU = errOf(uni), eG = errOf(gra);
    process.stderr.write(`     reference ${ref.mesh.cells.toLocaleString().padStart(10)} cells, ${ref.mesh.cellsAcrossAirGap.toFixed(0).padStart(2)} in gap -> ${ref.torque_mNm.toFixed(5)} mN.m\n`);
    process.stderr.write(`     uniform   ${uni.mesh.cells.toLocaleString().padStart(10)} cells, ${uni.mesh.cellsAcrossAirGap.toFixed(1).padStart(4)} in gap -> ${uni.torque_mNm.toFixed(5)} mN.m  (${eU.toFixed(2)}% off)\n`);
    process.stderr.write(`     graded    ${gra.mesh.cells.toLocaleString().padStart(10)} cells, ${gra.mesh.cellsAcrossAirGap.toFixed(1).padStart(4)} in gap -> ${gra.torque_mNm.toFixed(5)} mN.m  (${eG.toFixed(2)}% off)\n`);
    ok("graded is more accurate than uniform at a comparable cell budget", eG < eU,
       `${eG.toFixed(2)}% vs ${eU.toFixed(2)}% error, using ${(uni.mesh.cells / gra.mesh.cells).toFixed(1)}x ${gra.mesh.cells < uni.mesh.cells ? "fewer" : "more"} cells`);
    ok("graded is within a few percent of the converged answer", eG < CROSS_MESH_PCT, `${eG.toFixed(2)}%`);
    report.cases.accuracyPerCell = { reference: ref, uniform: uni, graded: gra, uniformError_pct: eU, gradedError_pct: eG };

    /* ---- 1b. the cylindrical mesh ----------------------------------------------------------------
     * Two properties that have to hold exactly rather than approximately, plus one that has to
     * hold to discretization error. */
    process.stderr.write("\n1b. cylindrical coordinates\n");

    // A one-pole-pair sector with periodic boundaries must reproduce the full turn to the last
    // digit: same mesh spacing, same field, half or a quarter of the cells. Anything else means
    // the periodic wrap or the sector scaling is wrong.
    const cylFull = await solve({ ...small, mesh: { ...small.mesh, mode: "cylindrical", sector: false } });
    const cylSec = await solve({ ...small, mesh: { ...small.mesh, mode: "cylindrical", sector: true } });
    const secErr = Math.abs(cylSec.torque_mNm - cylFull.torque_mNm) / Math.abs(cylFull.torque_mNm);
    process.stderr.write(`     full turn  ${cylFull.mesh.cells.toLocaleString().padStart(9)} cells -> ${cylFull.torque_mNm.toFixed(8)} mN.m\n`);
    process.stderr.write(`     one sector ${cylSec.mesh.cells.toLocaleString().padStart(9)} cells -> ${cylSec.torque_mNm.toFixed(8)} mN.m\n`);
    ok("a periodic sector reproduces the full turn exactly", secErr < 1e-6,
       `${secErr.toExponential(1)} relative, ${(cylFull.mesh.cells / cylSec.mesh.cells).toFixed(0)}x fewer cells`);
    ok("the sector really is a fraction of the machine", cylSec.mesh.sectors > 1, `1/${cylSec.mesh.sectors}`);

    // Cylindrical and Cartesian discretize the same physics in different coordinates, with
    // different staircasing and different stress surfaces. Agreeing is a genuinely independent
    // check that neither is wrong, in a way that refining either one alone cannot be.
    const cylRef = await solve({ ...small, mesh: { ...small.mesh, mode: "cylindrical",
      activeCellsAcrossDiameter: 260, cellsAcrossPoleArc: 96, cellsAcrossAirGap: 10,
      cellsAcrossPoleHeight: 7, cellsAcrossYoke: 5, cellsAcrossPcb: 6, cellsAcrossBackPlate: 5 } });
    const crossErr = Math.abs(cylRef.torque_mNm - ref.torque_mNm) / Math.abs(ref.torque_mNm) * 100;
    process.stderr.write(`     cartesian  ${ref.mesh.cells.toLocaleString().padStart(9)} cells -> ${ref.torque_mNm.toFixed(5)} mN.m\n`);
    process.stderr.write(`     cylindrical${cylRef.mesh.cells.toLocaleString().padStart(9)} cells -> ${cylRef.torque_mNm.toFixed(5)} mN.m\n`);
    ok("cylindrical and Cartesian agree on a converged answer", crossErr < CROSS_MESH_PCT,
       `${crossErr.toFixed(2)}% apart, using ${(ref.mesh.cells / cylRef.mesh.cells).toFixed(0)}x fewer cells`);
    report.cases.cylindrical = { full: cylFull, sector: cylSec, refined: cylRef, crossError_pct: crossErr };

    /* ---- 2. refinement studies ----------------------------------------------------------------- */
    for (const [name, spec, factors] of [
      ["80 mm PCB reluctance", small, quick ? [0.7, 1, 1.4] : [0.6, 0.8, 1, 1.4, 2]],
      ["370 mm scale test", large, quick ? [0.6, 0.8, 1] : [0.6, 0.8, 1, 1.3, 1.7]]
    ]) {
      process.stderr.write(`\n2. mesh refinement: ${name}\n`);
      const r = await study(spec, factors);
      if (r.error) { ok(`${name} convergence study runs`, false, r.error); continue; }
      for (const l of r.levels) {
        if (l.error) { process.stderr.write(`     x${l.factor}  ERROR ${l.error}\n`); continue; }
        process.stderr.write(`     x${String(l.factor).padEnd(4)} ${l.cells.toLocaleString().padStart(11)} cells  ` +
          `gap ${l.cellsAcrossAirGap.toFixed(1).padStart(4)}  T ${l.torque_mNm.toFixed(5).padStart(11)} mN.m  ` +
          `spread ${l.torqueSurfaceSpread_pct.toFixed(2).padStart(5)}%  ${String(l.wall_ms).padStart(6)} ms\n`);
      }
      const t = r.trends.torque_mNm;
      if (!t) { ok(`${name} produces a convergence trend`, false); continue; }
      process.stderr.write(`     extrapolated ${t.extrapolated.toFixed(5)} mN.m; finest is ${t.finestError_pct.toFixed(2)}% from it; ` +
        `last refinement moved it ${t.lastStep_pct.toFixed(2)}%` +
        (t.observedOrder ? `; observed order p = ${t.observedOrder}` : "; order fit unreliable") + "\n");
      const limit = SETTLED_PCT[name];
      ok(`${name} torque is settled on the finest mesh`, t.lastStep_pct < limit,
         `last step ${t.lastStep_pct.toFixed(2)}% < ${limit}%`);
      report.cases[name] = r;
    }

    /* ---- 3. the scale claim --------------------------------------------------------------------- */
    process.stderr.write("\n3. the 370 mm / 3 mm-gap case a uniform grid cannot reach\n");
    const planGraded = await page.evaluate(s => window.AFS.plan(s), large);
    const planUniform = await page.evaluate(s => window.AFS.plan({ ...s, mesh: { ...s.mesh, mode: "uniform", cellsAcrossDiameter: 520 } }), large);
    const solved = await solve(large);
    process.stderr.write(`     uniform, 3 cells in the gap: ${planUniform.mesh.cells.toLocaleString()} cells, ${planUniform.memory.totalDeviceMB} MB\n`);
    process.stderr.write(`     graded,  ${planGraded.resolution_cells.airGap.toFixed(0)} cells in the gap: ${planGraded.mesh.cells.toLocaleString()} cells, ${planGraded.memory.totalDeviceMB} MB\n`);
    process.stderr.write(`     solved:  ${(solved.torque_mNm / 1000).toFixed(4)} N.m, surfaces ${solved.torqueSurfaceSpread_pct.toFixed(2)}% apart, ` +
      `${solved.solver.iterations} CG iterations, ${(solved.timing_ms.biotSavart + solved.timing_ms.potentialSolve).toFixed(0)} ms GPU\n`);
    ok("370 mm case resolves the gap", solved.mesh.cellsAcrossAirGap >= 5.5, `${solved.mesh.cellsAcrossAirGap.toFixed(1)} cells`);
    ok("370 mm case converges", solved.solver.converged, `residual ${solved.solver.residual.toExponential(1)}`);
    ok("370 mm stress surfaces agree", solved.torqueSurfaceSpread_pct < 2, `${solved.torqueSurfaceSpread_pct.toFixed(2)}%`);
    ok("370 mm case fits comfortably in memory", planGraded.memory.totalDeviceMB < 1024, `${planGraded.memory.totalDeviceMB} MB`);
    report.cases.scale370 = { planGraded, planUniform, solved };

    /* ---- 4. large meshes must not silently return zero ------------------------------------------ */
    process.stderr.write("\n4. a mesh past the workgroup-per-dimension cap\n");
    const big = await solve({ ...small, mesh: { ...small.mesh, mode: "uniform", cellsAcrossDiameter: 320 } });
    process.stderr.write(`     ${big.error ? "error: " + big.error : `${big.mesh.cells.toLocaleString()} cells -> ${big.torque_mNm.toFixed(5)} mN.m`}\n`);
    ok("a 14 M-cell solve returns a real answer, not zeros",
       !big.error && Math.abs(big.torque_mNm) > 1e-3,
       big.error || `${big.torque_mNm.toFixed(5)} mN.m from ${big.mesh.cells.toLocaleString()} cells`);
    report.cases.largeDispatch = big;

  } finally {
    await browser.close();
    server.close();
  }

  report.pass = problems.length === 0;
  if (outFile) {
    await mkdir(dirname(outFile), { recursive: true });
    await writeFile(outFile, JSON.stringify(report, null, 2) + "\n");
    process.stderr.write(`\nwrote ${outFile}\n`);
  }
  process.stderr.write(`\n${problems.length ? `${problems.length} problem(s):\n  - ${problems.join("\n  - ")}` : "all convergence checks passed"}\n`);
  process.exit(problems.length ? 1 : 0);
}

main().catch(e => { process.stderr.write(`\nerror: ${e.message}\n${e.stack}\n`); process.exit(1); });
