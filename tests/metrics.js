#!/usr/bin/env node
/* Derived metrics and the cross-checks between them.
 *
 * Everything here is a comparison between two routes to the same number, or against a closed form.
 * A solver that is merely self-consistent can be confidently wrong; these are the checks that can
 * actually catch that.
 *
 *   closed form        loop self-inductance against mu0 R (ln(8R/gmd) - 2)
 *                      cylindrical cell volumes against the exact annulus volume
 *                      rasterized region volumes against their exact volumes
 *   symmetry           the two rotors of a dual-sided machine, which are mirror images
 *                      reciprocity of the inductance matrix, L_jk = L_kj
 *                      the free-space inductance having no saliency
 *   two methods        Maxwell stress against virtual work
 *                      material co-energy from the field against it from the inductance matrix
 *   behaviour          pole skew trading torque ripple for mean torque
 *
 *   node tests/metrics.js [--allow-software] [--quick] [--cpu-only] [--out report.json]
 *
 * The closed-form half needs no GPU at all and runs in milliseconds, so --cpu-only is what CI
 * uses: it still catches a wrong volume element, a broken rasterizer or a mis-derived winding
 * period, which are the failures most likely to go unnoticed elsewhere.
 */

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { serve, CHROME_ARGS } from "../cli/run.js";

import { buildLoop, buildMotor, motorRegions, regionVolume, angularPeriod } from "../src/core/geometry.js";
import { freeSpaceInductance } from "../src/core/metrics.js";
import { makeMesh, volumeM, CYLINDRICAL } from "../src/core/mesh.js";
import { MU0 } from "../src/core/constants.js";
import { normalizeSpec, specToParams } from "../src/core/spec.js";
import { sin2Fit } from "../src/ui/plots.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/* Tolerances, each with the reason it is what it is. */
const TOL = {
  // Neumann against the analytic loop, at 512 segments. The residual is the polygon perimeter.
  loopInductance_pct: 0.5,
  // Exact arithmetic identities, so this is f64 rounding over a few hundred thousand cells.
  volumeIdentity_pct: 1e-9,
  // Cylindrical rasterization is exact by construction; Cartesian staircases in plane.
  rasterCylindrical_pct: 1e-6,
  rasterCartesian_pct: 0.5,
  // Mirror images on a mesh that is not mirror-symmetric in z, because the grading is not.
  dualRotorImbalance_pct: 1.0,
  // Discretization, falling second order with angular refinement.
  reciprocity_pct: 0.15,
  /* A circulant matrix has equal d and q eigenvalues, and the free-space matrix of a symmetric
   * three-phase winding is circulant. What breaks it is not arithmetic but the adaptive
   * subdivision in the Neumann quadrature: the number of sub-segments is an integer function of
   * the segment separation, so two geometrically identical pairs can land on either side of a
   * threshold. The effect is a part in 10^5 and harmless, but it is not zero. */
  freeSpaceSaliency_pct: 0.01,
  // Two routes to the same integral, sharing only the mesh.
  energyConsistency_pct: 1.0,
  /* Maxwell stress against virtual work. On the large machine, whose features span many cells,
   * they agree to a tenth of a percent. The small machine's reluctance torque is a small
   * difference between two larger reluctances, so it carries the discretization error of both and
   * settles into a band rather than onto a value: refining its mesh by factors of 0.7, 1, 1.4 and
   * 2 gave disagreements of 0.93, 1.67, 0.58 and 1.28 percent, with no trend. The tolerance is set
   * above that band, not below it. */
  virtualWorkLarge_pct: 1.0,
  virtualWorkSmall_pct: 3.0
};

const problems = [];
const report = { generatedAt: new Date().toISOString(), cases: {} };
const ok = (label, cond, detail = "") => {
  process.stderr.write(`  ${cond ? "ok  " : "FAIL"}  ${label}${detail ? "  " + detail : ""}\n`);
  if (!cond) problems.push(label);
};
const rel = (a, b) => Math.abs(a - b) / Math.abs(b) * 100;

/* ---- closed-form checks that need no GPU ------------------------------------------------------ */

function cpuChecks() {
  process.stderr.write("\n1. closed forms, on the CPU\n");

  /* A circular loop's self-inductance is known exactly for a filament of given geometric mean
   * distance: L = mu0 R (ln(8R/gmd) - 2). Neumann's double integral has to reproduce it, and this
   * is the only check on the free-space half of the inductance matrix — the half the field solve
   * never sees. */
  const R = 15, p = { grid: 32, murRot: 1, traceW: 0.34, copperT: 0.035 };
  const gmd = 0.2235 * (p.traceW + p.copperT) * 1e-3;
  const analytic = MU0 * (R * 1e-3) * (Math.log(8 * (R * 1e-3) / gmd) - 2);
  const rows = [];
  for (const segments of [128, 256, 512]) {
    const L = freeSpaceInductance(buildLoop(p, { radius_mm: R, segments })).L[0][0];
    rows.push({ segments, L_H: L, error_pct: (L - analytic) / analytic * 100 });
    process.stderr.write(`     ${String(segments).padStart(4)} segments -> ${(L * 1e9).toFixed(3)} nH  (${((L / analytic - 1) * 100).toFixed(3)}%)\n`);
  }
  process.stderr.write(`     analytic      ${(analytic * 1e9).toFixed(3)} nH\n`);
  const fine = rows[rows.length - 1];
  ok("loop self-inductance matches the closed form", Math.abs(fine.error_pct) < TOL.loopInductance_pct,
     `${fine.error_pct.toFixed(3)}% at ${fine.segments} segments`);
  ok("and converges as the loop is refined", Math.abs(fine.error_pct) < Math.abs(rows[0].error_pct),
     `${rows[0].error_pct.toFixed(3)}% -> ${fine.error_pct.toFixed(3)}%`);
  report.cases.loopInductance = { analytic_H: analytic, gmd_m: gmd, rows };

  /* Cell volumes on a cylindrical mesh must sum to the exact volume of the annulus they tile. The
   * factorized volume element is easy to get subtly wrong — a missing dz reads as an area — and a
   * wrong one would quietly corrupt every mass and loss figure downstream. */
  const re = Float64Array.from([0, 1, 2.5, 4]), ze = Float64Array.from([0, 1, 3, 3.5]);
  const th = Float64Array.from([0, 1, 2.2, 2 * Math.PI]);
  const m = makeMesh(re, th, ze, { kind: CYLINDRICAL, periodicY: true });
  let V = 0;
  for (let k = 0; k < m.nz; k++) for (let j = 0; j < m.ny; j++) for (let i = 0; i < m.nx; i++) V += volumeM(m, i, j, k);
  const exactV = Math.PI * 16 * 3.5 * 1e-9;
  ok("cylindrical cell volumes tile the annulus exactly", rel(V, exactV) < TOL.volumeIdentity_pct,
     `${(V * 1e9).toFixed(9)} vs ${(exactV * 1e9).toFixed(9)} mm^3`);

  /* The angular period has to be derived from the winding pattern, not assumed. The default layout
   * repeats every pole pair; a layout that alternates the winding sense of same-phase coils has no
   * plain period at all and must say so rather than silently model a quarter of a machine wrong. */
  const per = angularPeriod({ poles: 4, coilCount: null });
  ok("the default 4-pole layout repeats every pole pair", per.sectors === 2, `sectors ${per.sectors}`);
  const per8 = angularPeriod({ poles: 8, coilCount: null });
  ok("and the 8-pole layout every quarter turn", per8.sectors === 4, `sectors ${per8.sectors}`);
  const alt = angularPeriod({ poles: 4, coilCount: 6, coilSense: [1, 1, 1, -1, -1, -1] });
  ok("an alternating-sense winding reports no periodicity", alt.sectors === 1, `sectors ${alt.sectors}`);

  /* The volume the rasterizer lays down against the exact volume of the same region. In cylindrical
   * coordinates every region is a coordinate box, so this is exact; on a Cartesian mesh it is the
   * in-plane staircase, and its size is worth knowing. */
  process.stderr.write("\n2. rasterized volume against exact volume\n");
  const rasterRows = [];
  for (const mode of ["cylindrical", "graded", "uniform"]) {
    const { spec } = normalizeSpec({ mesh: { mode, activeCellsAcrossDiameter: 128, cellsAcrossDiameter: 128, cellsAcrossPoleArc: 24 } });
    const job = buildMotor(specToParams(spec));
    const regions = motorRegions(job.p);
    const errs = regions.map((r, i) => (job.volumes[i] * job.mesh.sectors - regionVolume(r)) / regionVolume(r) * 100);
    const worst = Math.max(...errs.map(Math.abs));
    rasterRows.push({ mode, worst_pct: worst, byRegion: regions.map((r, i) => ({ region: r.name, error_pct: errs[i] })) });
    process.stderr.write(`     ${mode.padEnd(12)} worst ${worst.toExponential(2)}%\n`);
    ok(`${mode} rasterization matches the exact volumes`,
       worst < (mode === "cylindrical" ? TOL.rasterCylindrical_pct : TOL.rasterCartesian_pct),
       `${worst.toExponential(2)}%`);
  }
  report.cases.rasterization = rasterRows;

  /* The same audit for a profiled machine: a comma-shaped pole whose width and centre line both
   * move with radius. This is the case where the closed-form area earns its keep — an arc of
   * constant width is hard to rasterize wrongly, a free-form footprint is not. Cylindrical stays
   * near-exact because the wedge is still bounded by two angles at every radius and the radial
   * variation inside a cell is integrated rather than sampled; the Cartesian modes carry their
   * usual in-plane staircase. */
  const COMMA = [
    { atRadius: 0, widthFraction: 0.26, offset_deg: 18 },
    { atRadius: 0.35, widthFraction: 0.5, offset_deg: 11 },
    { atRadius: 0.7, widthFraction: 0.72, offset_deg: 3 },
    { atRadius: 1, widthFraction: 0.8, offset_deg: -4 }
  ];
  const profiledRows = [];
  for (const mode of ["cylindrical", "graded", "uniform"]) {
    const { spec } = normalizeSpec({ design: { rotor: { poleShape: COMMA } },
                                     mesh: { mode, activeCellsAcrossDiameter: 128, cellsAcrossDiameter: 128, cellsAcrossPoleArc: 24 } });
    const job = buildMotor(specToParams(spec));
    const regions = motorRegions(job.p);
    const errs = regions.map((r, i) => (job.volumes[i] * job.mesh.sectors - regionVolume(r)) / regionVolume(r) * 100);
    const worst = Math.max(...errs.map(Math.abs));
    profiledRows.push({ mode, worst_pct: worst });
    process.stderr.write(`     ${mode.padEnd(12)} worst ${worst.toExponential(2)}%  (comma-profiled poles)\n`);
    ok(`${mode} rasterization matches the exact volumes of a profiled pole`,
       worst < (mode === "cylindrical" ? TOL.rasterCylindrical_pct : TOL.rasterCartesian_pct),
       `${worst.toExponential(2)}%`);
  }
  report.cases.rasterizationProfiled = profiledRows;

  /* The current-angle sweep solves on a 15° grid and then solves once more at the peak of a
   * sin 2γ fit, so the fit has to find a peak the grid does not contain. Sampled from an exact
   * sin 2(γ − φ) on that same grid, it must recover φ + 45° to round-off — a peak that lands
   * between two sampled angles is the case that matters. */
  process.stderr.write("\n3. the sin 2\u03b3 fit behind the sweep\n");
  const fitRows = [];
  for (const phase of [0, 7, 31, 88, 143]) {
    const pts = [];
    for (let g = 0; g <= 180; g += 15) pts.push([g, 3e-4 * Math.sin(2 * (g - phase) * Math.PI / 180)]);
    const f = sin2Fit(pts);
    const want = (phase + 45) % 180;
    const err = Math.abs(((f.peak - want + 270) % 180) - 90);
    fitRows.push({ phase_deg: phase, peak_deg: f.peak, expected_deg: want, error_deg: err, amp: f.amp });
    ok(`sin 2γ fit finds the peak of a ${phase}°-shifted sweep`,
       err < 1e-6 && rel(f.amp, 3e-4) < 1e-6, `${f.peak.toFixed(4)}° against ${want}°`);
  }
  report.cases.sin2Fit = fitRows;
}

/* ---- checks that need the solver ---------------------------------------------------------------- */

async function gpuChecks(page, quick) {
  const call = (method, spec, opts) => page.evaluate(async ([m, s, o]) => {
    const r = await window.AFS[m](s, o);
    return r.ok ? r.value : { error: r.error.message };
  }, [method, spec, opts ?? {}]);
  const need = r => { if (r.error) throw new Error(r.error); return r; };

  const load = async name => JSON.parse(await readFile(resolve(ROOT, "src/cases", name), "utf8"));
  const small = await load("pcb-reluctance-80mm.json");
  const large = await load("scale-370mm.json");
  /* The 80 mm preset is already cylindrical and solves in well under a second, so the cross-checks
   * run on exactly the design the regression suite uses. The angular mesh matters more here than
   * anywhere else: at 24 cells per pole pitch instead of 64 the two torque methods drift 6% apart,
   * which is the angular discretization rather than either method being wrong. */
  const smallCyl = small;
  // Coarser, for the studies that need a solve per rotor position.
  const sweepMesh = { ...small, mesh: { ...small.mesh, activeCellsAcrossDiameter: 120, cellsAcrossPoleArc: 32 } };

  /* ---- Maxwell stress against virtual work ----------------------------------------------------
   * The strongest check available without an external reference. One is a surface integral in the
   * air gap; the other is the derivative of a volume integral over the whole domain. They share
   * the field and nothing else. */
  process.stderr.write("\n3. torque by two methods\n");
  const vwRows = [];
  const vwCases = quick ? [["80 mm", smallCyl, TOL.virtualWorkSmall_pct]]
                        : [["80 mm", smallCyl, TOL.virtualWorkSmall_pct], ["370 mm", large, TOL.virtualWorkLarge_pct]];
  for (const [name, spec, tol] of vwCases) {
    const r = need(await call("virtualWork", spec));
    vwRows.push({ case: name, ...r });
    process.stderr.write(`     ${name.padEnd(7)} virtual work ${r.torqueVirtualWork_mNm.toFixed(5)}  maxwell ${r.torqueMaxwellStress_mNm.toFixed(5)} mN.m\n`);
    process.stderr.write(`             stencil orders ${r.stencilEstimates.map(e => e.torque_mNm.toFixed(5)).join(" ")}  (spread ${r.stencilSpread_pct.toFixed(2)}%)\n`);
    ok(`${name}: virtual work agrees with Maxwell stress`, r.disagreement_pct < tol,
       `${r.disagreement_pct.toFixed(2)}% against a ${tol}% tolerance`);
  }
  report.cases.virtualWork = vwRows;

  /* ---- the inductance matrix ------------------------------------------------------------------
   * Three properties that are theorems rather than modelling choices, so any departure is error. */
  process.stderr.write("\n4. inductance\n");
  const ind = need(await call("inductance", smallCyl));
  const fsD = ind.dq_H.total.Ld - ind.dq_H.material.Ld;
  const fsQ = ind.dq_H.total.Lq - ind.dq_H.material.Lq;
  process.stderr.write(`     Ld ${(ind.dq_H.total.Ld * 1e6).toFixed(3)}  Lq ${(ind.dq_H.total.Lq * 1e6).toFixed(3)} uH  (material ${(ind.dq_H.material.Ld * 1e6).toFixed(3)} / ${(ind.dq_H.material.Lq * 1e6).toFixed(3)})\n`);
  ok("the inductance matrix is reciprocal", ind.reciprocity.asymmetry_pct < TOL.reciprocity_pct,
     `worst asymmetry ${ind.reciprocity.asymmetry_pct.toFixed(4)}%`);
  ok("the air-core inductance has no saliency", rel(fsD, fsQ) < TOL.freeSpaceSaliency_pct,
     `Ld0 - Lq0 = ${((fsD - fsQ) * 1e12).toFixed(3)} pH out of ${(fsD * 1e6).toFixed(2)} uH`);
  ok("the machine is salient at all", Math.abs(ind.saliencyRatio - 1) > 1e-3,
     `Ld/Lq = ${ind.saliencyRatio.toFixed(4)}`);
  report.cases.inductance = ind;

  /* Reciprocity error is discretization, so it must fall when the angular mesh is refined. If it
   * did not, it would be a bug rather than an error bar, and reporting it as one would mislead. */
  if (!quick) {
    const coarse = need(await call("inductance", { ...smallCyl, mesh: { ...smallCyl.mesh, cellsAcrossPoleArc: 32 } }));
    process.stderr.write(`     reciprocity at 32 / 64 cells per pole pitch: ${coarse.reciprocity.asymmetry_pct.toFixed(4)}% -> ${ind.reciprocity.asymmetry_pct.toFixed(4)}%\n`);
    ok("reciprocity error falls with angular refinement",
       ind.reciprocity.asymmetry_pct < 0.6 * coarse.reciprocity.asymmetry_pct,
       `${(coarse.reciprocity.asymmetry_pct / ind.reciprocity.asymmetry_pct).toFixed(1)}x smaller`);
  }

  /* ---- stored energy, two ways ------------------------------------------------------------------ */
  process.stderr.write("\n5. stored energy\n");
  const en = need(await call("energyCheck", smallCyl));
  process.stderr.write(`     from the field ${en.materialCoEnergy_J.fromField.toExponential(5)} J, from the inductance matrix ${en.materialCoEnergy_J.fromInductance.toExponential(5)} J\n`);
  ok("co-energy from the field matches co-energy from the inductance matrix",
     en.disagreement_pct < TOL.energyConsistency_pct, `${en.disagreement_pct.toFixed(3)}%`);
  report.cases.energy = en;

  /* ---- dual-sided machine ------------------------------------------------------------------------
   * Two rotors that are exact mirror images of each other, each with its own stress surface on its
   * own side of the stator. Their agreement tests the sign convention of the stress integral on a
   * surface whose normals run the other way — something a single-rotor machine can never exercise. */
  process.stderr.write("\n6. dual-sided rotor\n");
  const dualSpec = { ...sweepMesh, design: { ...sweepMesh.design, rotor: { ...sweepMesh.design.rotor, dualSided: true } } };
  const dual = need(await call("solve", dualSpec)).results;
  const [up, lo] = dual.rotors;
  process.stderr.write(`     upper ${up.torque_mNm.toFixed(5)}  lower ${lo.torque_mNm.toFixed(5)} mN.m  total ${dual.torque_mNm.toFixed(5)}\n`);
  ok("both rotors are found and both make torque", dual.rotors.length === 2 && up.torque_mNm * lo.torque_mNm > 0);
  ok("the two mirrored rotors agree", dual.rotorImbalance_pct < TOL.dualRotorImbalance_pct,
     `${dual.rotorImbalance_pct.toFixed(3)}% apart`);
  ok("the total is their sum", rel(dual.torque_mNm, up.torque_mNm + lo.torque_mNm) < 1e-9);
  ok("the lower air gap is meshed like the upper", Math.abs(dual.mesh.resolution.lowerAirGap - dual.mesh.resolution.airGap) < 0.01,
     `${dual.mesh.resolution.airGap.toFixed(1)} and ${dual.mesh.resolution.lowerAirGap.toFixed(1)} cells`);
  report.cases.dualRotor = dual;

  /* Air-gap shear stress is torque made size-free, so the point of it is that it does not hand
   * out credit for extra gap area. The dual-sided machine makes more torque than the single-sided
   * one — two working gaps instead of one — but it gets there by trading the steel back plate for
   * a second rotor, so its traction per unit of gap area must not go up. That is exactly the
   * comparison raw torque cannot make. */
  const single = need(await call("solve", sweepMesh)).results;
  const sh = single.derived.perUnit, dh = dual.derived.perUnit;
  const sp = normalizeSpec(sweepMesh).spec.design.stator;
  const ri = sp.innerRadius_mm * 1e-3, ro = sp.outerRadius_mm * 1e-3;
  const lever = g => g * (2 * Math.PI / 3) * (ro ** 3 - ri ** 3);
  process.stderr.write(`     single ${sh.airgapShear_psi.toExponential(4)} psi over ${sh.workingGaps} gap  dual ${dh.airgapShear_psi.toExponential(4)} over ${dh.workingGaps}\n`);
  ok("shear stress recovers the torque it came from",
     rel(sh.airgapShear_kPa * 1e3 * lever(sh.workingGaps), single.torque_mNm / 1e3) < 1e-9);
  ok("a psi is 6894.76 Pa", rel(sh.airgapShear_kPa * 1e3, sh.airgapShear_psi * 6894.757293168361) < 1e-12);
  ok("the second gap is counted", dh.workingGaps === 2 && rel(dh.airgapShear_kPa * 1e3 * lever(2), dual.torque_mNm / 1e3) < 1e-9);
  ok("and buying torque with gap area does not buy shear stress",
     dual.torque_mNm > single.torque_mNm && dh.airgapShear_psi < sh.airgapShear_psi,
     `torque ${single.torque_mNm.toFixed(5)} -> ${dual.torque_mNm.toFixed(5)} mN.m, shear ${sh.airgapShear_psi.toExponential(3)} -> ${dh.airgapShear_psi.toExponential(3)} psi`);

  /* ---- skew --------------------------------------------------------------------------------------
   * Not a check against a reference, but against the reason skew exists: it should cut torque
   * ripple and cost some mean torque. A skew implementation that did nothing would pass every
   * symmetry and conservation check above. */
  process.stderr.write("\n7. pole skew against torque ripple\n");
  const skewRows = [];
  for (const skew of quick ? [0, 30] : [0, 15, 30]) {
    const spec = { ...sweepMesh, design: { ...sweepMesh.design, rotor: { ...sweepMesh.design.rotor, poleSkew_deg: skew } } };
    const r = need(await call("torqueVsAngle", spec, { count: 12 }));
    skewRows.push({ skew_deg: skew, mean_mNm: r.torqueMean_mNm, ripple_pct: r.ripple_pct });
    process.stderr.write(`     skew ${String(skew).padStart(3)} deg  mean ${r.torqueMean_mNm.toFixed(5)} mN.m  ripple ${r.ripple_pct.toFixed(1)}%\n`);
  }
  const first = skewRows[0], last = skewRows[skewRows.length - 1];
  ok("skew reduces torque ripple", last.ripple_pct < 0.8 * first.ripple_pct,
     `${first.ripple_pct.toFixed(1)}% -> ${last.ripple_pct.toFixed(1)}%`);
  ok("and costs mean torque, as it must", last.mean_mNm < first.mean_mNm,
     `${first.mean_mNm.toFixed(5)} -> ${last.mean_mNm.toFixed(5)} mN.m`);
  report.cases.skew = skewRows;

  /* Core loss is only claimed where the rotor frame can be recovered exactly. The Cartesian mesh
   * must say so rather than return a number it cannot justify. */
  const cart = need(await call("torqueVsAngle", { ...small, mesh: { ...small.mesh, mode: "graded" } }, { count: 6 }));
  ok("core loss declines to guess on a Cartesian mesh", cart.coreLoss.available === false,
     cart.coreLoss.reason.slice(0, 60) + "...");
}

/* ---- driver -------------------------------------------------------------------------------------- */

async function main() {
  const args = process.argv.slice(2);
  const quick = args.includes("--quick");
  const outFile = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;

  cpuChecks();
  if (args.includes("--cpu-only")) {
    process.stderr.write(problems.length ? `\n${problems.length} problem(s):\n  ${problems.join("\n  ")}\n`
                                         : "\nevery closed-form check agreed\n");
    process.exit(problems.length ? 1 : 0);
  }

  const { chromium } = await import("playwright");
  const { server, port } = await serve(ROOT);
  const browser = await chromium.launch({ args: CHROME_ARGS });
  try {
    const page = await browser.newPage();
    page.on("pageerror", e => { problems.push("page error: " + e.message); process.stderr.write(`  [pageerror] ${e.message}\n`); });
    await page.goto(`http://127.0.0.1:${port}/headless.html`, { waitUntil: "load" });
    await page.waitForFunction("window.AFS && window.AFS.ready", null, { timeout: 30000 });
    const caps = await page.evaluate(() => window.AFS.capabilities());
    process.stderr.write(`\nadapter: ${caps.adapter}${caps.software ? "  [SOFTWARE]" : ""}\n`);
    report.adapter = caps.adapter;
    report.softwareAdapter = caps.software;
    if (caps.software && !args.includes("--allow-software")) throw new Error("Software adapter; pass --allow-software.");
    await gpuChecks(page, quick);
  } finally {
    await browser.close();
    server.close();
  }

  if (outFile) {
    await mkdir(dirname(resolve(ROOT, outFile)), { recursive: true });
    await writeFile(resolve(ROOT, outFile), JSON.stringify({ ...report, problems }, null, 2) + "\n");
    process.stderr.write(`\nwrote ${outFile}\n`);
  }
  process.stderr.write(problems.length ? `\n${problems.length} problem(s):\n  ${problems.join("\n  ")}\n`
                                       : "\nevery cross-check agreed\n");
  process.exit(problems.length ? 1 : 0);
}

main().catch(e => { process.stderr.write(`\nerror: ${e.message}\n${e.stack}\n`); process.exit(1); });
