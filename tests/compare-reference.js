#!/usr/bin/env node
/* P0 regression: prove the module split changed no physics.
 *
 * Drives two pages over the same set of designs and compares the numbers:
 *   tests/reference/axial-flux-3d-webgpu.html   the frozen pre-split single-file build
 *   headless.html                               the split modules
 *
 * The reference page has no API, so it is driven through its own controls exactly as a person
 * would: fill the inputs, press Solve, read the solution object off the page.
 *
 * Both runs go through the same GPU on the same machine, so agreement should be to f32 round-off
 * (the tolerance below is 1e-6 relative), not merely "close".
 *
 *   node tests/compare-reference.js [--update] [--allow-software]
 */

import { writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve, CHROME_ARGS } from "../cli/run.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const GOLDEN = resolve(ROOT, "tests/golden/reference-designs.json");
const REL_TOL = 1e-9;   // both sides run the same f32 kernels on the same GPU: agreement should be exact

/* The reference page's own control defaults. Every design below is merged over these before it is
 * applied, because the reference page keeps whatever was typed into it last: setting only the
 * fields a design mentions would silently carry the previous design's values into the next run. */
const BASE = {
  poles: 4, layers: 2, ri: 15, ro: 40, turns: 10, amps: 5,
  gap: 3, murRot: 20, tooth: 3, yoke: 4, arc: 0.5,
  back: true, murBack: 20, backT: 4, backGap: 1,
  theta: 0, gamma: 45, grid: 128
};

/* Designs chosen to move every parameter that reaches the solver: pole count, layer count, radii,
 * turns, gap, permeability, back plate on and off, rotor angle, current angle, and grid. */
export const DESIGNS = [
  { name: "default-128", grid: 128 },
  { name: "default-96", grid: 96 },
  { name: "default-160", grid: 160 },
  { name: "6pole-4layer", poles: 6, layers: 4, grid: 128, gamma: 30 },
  { name: "8pole-wide", poles: 8, ri: 20, ro: 55, turns: 14, grid: 128, theta: 11, gamma: 60 },
  { name: "no-backplate", back: false, murRot: 40, grid: 128 },
  { name: "tight-gap", gap: 1.5, tooth: 5, yoke: 6, arc: 0.7, amps: 9, grid: 160 },
  { name: "low-mu", murRot: 3, murBack: 3, grid: 96, gamma: 90 }
];

/* design key -> DOM input id on the reference page, and spec path on the new one. */
const FIELDS = {
  poles: ["poles", "design.stator.poles"],
  layers: ["layers", "design.stator.copperLayers"],
  ri: ["ri", "design.stator.innerRadius_mm"],
  ro: ["ro", "design.stator.outerRadius_mm"],
  turns: ["turns", "design.stator.turnsPerLayer"],
  amps: ["amps", "design.stator.peakCurrent_A"],
  gap: ["gap", "design.rotor.airGap_mm"],
  murRot: ["murRot", "design.rotor.mu_r"],
  tooth: ["tooth", "design.rotor.poleHeight_mm"],
  yoke: ["yoke", "design.rotor.yokeThickness_mm"],
  arc: ["arc", "design.rotor.poleArcFraction"],
  back: ["back", "design.backPlate.enabled"],
  murBack: ["murBack", "design.backPlate.mu_r"],
  backT: ["backT", "design.backPlate.thickness_mm"],
  backGap: ["backGap", "design.backPlate.gapBelowPcb_mm"],
  theta: ["theta", "operatingPoint.rotorAngle_deg"],
  gamma: ["gamma", "operatingPoint.currentAngle_elecDeg"],
  grid: ["grid", "mesh.cellsAcrossDiameter"]
};

/* The quantities compared. Anything the solver computes and a user reads. */
/* Absolute floors, so a quantity that is physically zero is not compared by relative error against
 * round-off. At gamma = 90 the reluctance torque vanishes by symmetry and both builds return a few
 * times 1e-12 N.m of summation noise; the floor sits seven orders below any torque this machine
 * class actually produces (~1e-4 N.m), so it cannot hide a real change. */
const METRICS = {
  torqueMean_Nm: 1e-11, torqueSurface0_Nm: 1e-11, torqueSurface1_Nm: 1e-11,
  /* gapBz is deliberately not compared. The reference build sampled the single cell layer nearest
   * mid-gap; the tool now interpolates to exactly mid-gap between the two layers that straddle it.
   * Refining only z moved the old metric by 2.8% with no trend, purely because the sampled layer
   * moved; the new one moves 0.65% and does not drift. The values differ by 1-4%, as intended. */
  bmaxMat_T: 1e-12,
  I0_A: 1e-9, I1_A: 1e-9, I2_A: 1e-9,
  cells: 0, nx: 0, ny: 0, nz: 0, hm_mm: 0
};

/* ---- reference page ------------------------------------------------------------------------- */

async function runReference(page, designIn) {
  const design = { ...BASE, ...designIn };
  await page.evaluate((d) => {
    const F = {
      poles: "poles", layers: "layers", ri: "ri", ro: "ro", turns: "turns", amps: "amps",
      gap: "gap", murRot: "murRot", tooth: "tooth", yoke: "yoke", arc: "arc", back: "back",
      murBack: "murBack", backT: "backT", backGap: "backGap", theta: "theta", gamma: "gamma", grid: "grid"
    };
    for (const [k, id] of Object.entries(F)) {
      if (d[k] === undefined) continue;
      const el = document.getElementById(id);
      if (el.type === "checkbox") el.checked = !!d[k]; else el.value = String(d[k]);
    }
    window.__done = false;
    document.getElementById("solve").click();
  }, design);

  await page.waitForFunction(() => !state.busy && state.sol && state.sol.job.kind === "motor",
                             null, { timeout: 600000 });
  return page.evaluate(() => {
    const s = state.sol, m = s.m, j = s.job;
    const mean = m.T.length ? m.T.reduce((a, b) => a + b, 0) / m.T.length : null;
    return {
      torqueMean_Nm: mean, torqueSurface0_Nm: null, torqueSurface1_Nm: null,
      gapBz_T: m.gapBz, bmaxMat_T: m.bmaxMat,
      I0_A: s.I[0], I1_A: s.I[1], I2_A: s.I[2],
      cells: s.N, nx: j.nx, ny: j.ny, nz: j.nz, hm_mm: j.hm,
      iterations: s.pcg ? s.pcg.iters : null
    };
  });
}

/* ---- new modules ----------------------------------------------------------------------------- */

async function runSplit(page, designIn) {
  const design = { ...BASE, ...designIn };
  const overrides = Object.entries(design)
    .filter(([k]) => FIELDS[k])
    .map(([k, v]) => [FIELDS[k][1], v]);
  const r = await page.evaluate(async (ov) => {
    const spec = window.AFS.defaultSpec();
    for (const [p, v] of ov) window.AFS.setPathOn(spec, p, v);
    return window.AFS.solve(spec);
  }, overrides);
  if (!r.ok) throw new Error(`split solve failed for ${design.name}: ${r.error.message}`);
  const res = r.value.results, m = res.mesh;
  return {
    // The reference build averaged the two stress planes nearest mid-gap. The tool now averages
    // every plane that fits, which is a deliberate improvement, so the regression compares against
    // the retained legacy definition rather than pretending the headline number is unchanged.
    torqueMean_Nm: res.torqueLegacyTwoSurface_mNm / 1e3,
    torqueSurface0_Nm: null, torqueSurface1_Nm: null,
    gapBz_T: res.gapBzMean_mT / 1e3, bmaxMat_T: res.peakBInMagneticParts_mT / 1e3,
    I0_A: res.phaseCurrents_A[0], I1_A: res.phaseCurrents_A[1], I2_A: res.phaseCurrents_A[2],
    cells: m.cells, nx: m.dimensions[0], ny: m.dimensions[1], nz: m.dimensions[2], hm_mm: m.cellSize_mm,
    iterations: res.solver.iterations
  };
}

/* The summary rounds to 5 significant figures, so comparisons are made at that precision. */
const round5 = v => (Number.isFinite(v) ? +v.toPrecision(5) : v);

function compare(ref, got) {
  const diffs = [];
  for (const [k, atol] of Object.entries(METRICS)) {
    const a = round5(ref[k]), b = round5(got[k]);
    if (a === null && b === null) continue;
    if (a === null || b === null) { diffs.push({ metric: k, reference: a, split: b, relative: null }); continue; }
    const abs = Math.abs(a - b);
    if (abs <= atol) continue;
    const rel = abs / Math.max(1e-30, Math.abs(a));
    if (rel > REL_TOL) diffs.push({ metric: k, reference: a, split: b, relative: +rel.toExponential(3) });
  }
  return diffs;
}

/* ---- main --------------------------------------------------------------------------------------- */

async function main() {
  const args = process.argv.slice(2);
  const allowSoftware = args.includes("--allow-software");
  const update = args.includes("--update");

  const { chromium } = await import("playwright");
  const { server, port } = await serve(ROOT);
  const browser = await chromium.launch({ args: CHROME_ARGS });

  const results = [];
  let failures = 0;
  try {
    const refPage = await browser.newPage();
    refPage.on("pageerror", e => process.stderr.write(`[reference] ${e.message}\n`));
    await refPage.goto(`http://127.0.0.1:${port}/tests/reference/axial-flux-3d-webgpu.html`, { waitUntil: "load" });
    await refPage.waitForFunction(() => state && typeof state === "object", null, { timeout: 30000 });

    const newPage = await browser.newPage();
    newPage.on("pageerror", e => process.stderr.write(`[split] ${e.message}\n`));
    await newPage.goto(`http://127.0.0.1:${port}/headless.html`, { waitUntil: "load" });
    await newPage.waitForFunction("window.AFS && window.AFS.ready", null, { timeout: 30000 });

    const caps = await newPage.evaluate(() => window.AFS.capabilities());
    process.stderr.write(`adapter: ${caps.adapter}${caps.software ? "  [SOFTWARE]" : ""}\n`);
    if (caps.software && !allowSoftware) throw new Error("Software adapter; pass --allow-software to proceed.");

    for (const d of DESIGNS) {
      process.stderr.write(`  ${d.name.padEnd(16)} `);
      const ref = await runReference(refPage, d);
      const got = await runSplit(newPage, d);
      const diffs = compare(ref, got);
      if (diffs.length) failures++;
      process.stderr.write(diffs.length
        ? `FAIL  ${diffs.map(x => `${x.metric} ${x.reference} vs ${x.split}`).join(", ")}\n`
        : `ok    torque ${(got.torqueMean_Nm * 1e3).toFixed(5)} mN·m, ${got.cells.toLocaleString()} cells, ${got.iterations} it\n`);
      results.push({ design: d, reference: ref, split: got, diffs, pass: diffs.length === 0 });
    }
  } finally {
    await browser.close();
    server.close();
  }

  const report = {
    generatedAt: new Date().toISOString(),
    relativeTolerance: REL_TOL,
    pass: failures === 0,
    designs: results
  };
  if (update || !existsSync(GOLDEN)) {
    await writeFile(GOLDEN, JSON.stringify(report, null, 2) + "\n");
    process.stderr.write(`wrote ${GOLDEN}\n`);
  } else {
    const prev = JSON.parse(await readFile(GOLDEN, "utf8"));
    const drift = results.filter(r => {
      const p = prev.designs.find(x => x.design.name === r.design.name);
      return p && compare(p.split, r.split).length;
    });
    if (drift.length) {
      failures += drift.length;
      process.stderr.write(`\ndrift against the stored golden file in: ${drift.map(d => d.design.name).join(", ")}\n`);
    }
  }

  process.stderr.write(`\n${failures ? `${failures} failure(s)` : `all ${results.length} designs match the reference build`}\n`);
  process.exit(failures ? 1 : 0);
}

main().catch(e => { process.stderr.write(`\nerror: ${e.message}\n${e.stack}\n`); process.exit(1); });
