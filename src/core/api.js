/* AFS — the public interface.
 *
 * Every entry point takes a plain JSON spec and returns plain JSON. The browser UI calls these and
 * so does the headless CLI, so a headless result is identical to a UI result by construction
 * rather than by agreement.
 *
 * Nothing in this file or anything it imports touches the DOM.
 */

import { normalizeSpec, defaultSpec, specToParams, specHash, SPEC_VERSION, getPath, setPath } from "./spec.js";
import { buildMotor, buildMesh, motorGeom, meshResolution } from "./geometry.js";
import { solveJob, phaseCurrents } from "./solve.js";
import { motorMetrics } from "./torque.js";
import { resultsSummary } from "./results.js";
import { runLoopCase, runSphereCase } from "./validate.js";
import { convergenceStudy } from "./convergence.js";
import { capabilities as gpuCapabilities, initGPU, isSoftwareAdapter } from "../gpu/device.js";
import { bufferBytes } from "../gpu/buffers.js";
import { meshStats } from "./mesh.js";

export const API_VERSION = "0.2.0";

/* ---- planning ------------------------------------------------------------------------------ */

/* What this spec would cost, without solving it. Cheap: no rasterization, no GPU work. */
export async function plan(specIn) {
  const { spec, warnings } = normalizeSpec(specIn);
  const p = specToParams(spec);
  const notes = [...warnings];

  let mesh;
  try { mesh = buildMesh(p); }
  catch (e) { return { specHash: specHash(spec), error: e.message, notes: [...notes, e.message], fits: false }; }

  const res = meshResolution(mesh, p);
  const mem = bufferBytes(mesh.N);

  let caps = null;
  try { caps = await gpuCapabilities(); } catch { /* reported as a note below */ }
  if (!caps) notes.push("No WebGPU adapter is available, so device limits could not be checked.");
  else if (mem.largestBinding > caps.limits.maxStorageBufferBindingSize)
    notes.push(`This mesh needs ${(mem.largestBinding / 1048576).toFixed(0)} MB in one binding; this device allows ${(caps.limits.maxStorageBufferBindingSize / 1048576).toFixed(0)} MB.`);

  if (res.airGap < 3) notes.push(
    `Only ${res.airGap.toFixed(1)} cells span the ${p.gap} mm air gap; at least 3 are needed for a meaningful torque. ` +
    (spec.mesh.mode === "uniform"
      ? `A uniform grid has to use that cell size everywhere. Set mesh.mode to "graded" to spend cells where the field varies.`
      : `Raise mesh.cellsAcrossAirGap (now ${spec.mesh.cellsAcrossAirGap}).`));
  // Fitting the largest single binding is necessary but not sufficient: the whole set has to fit in
  // device memory, and a few GB will either fail to allocate or thrash.
  if (mem.total > 2 * 1024 ** 3) notes.push(
    `This mesh wants ${(mem.total / 1024 ** 3).toFixed(1)} GB of device memory across all buffers. Most GPUs will refuse or thrash; aim for well under 2 GB.`);
  if (mesh.aspect > 40) notes.push(
    `The worst cell aspect ratio is ${mesh.aspect.toFixed(0)}:1. Strongly stretched cells slow the conjugate-gradient solve; lowering mesh.farFieldCellFactor or mesh.growthRatio will trade cells for iterations.`);

  // What a uniform grid would have cost for the same gap resolution, which is the case for grading.
  const hGap = p.gap / Math.max(1, spec.mesh.mode === "graded" ? spec.mesh.cellsAcrossAirGap : res.airGap);
  const uniformEquivalent = Math.round((mesh.x1 - mesh.x0) / hGap) * Math.round((mesh.y1 - mesh.y0) / hGap) * Math.round((mesh.z1 - mesh.z0) / hGap);

  return {
    specHash: specHash(spec),
    mesh: { ...meshStats(mesh), margin_mm: Math.max(p.marginMin, p.marginFactor * p.ro) },
    resolution_cells: res,
    memory: {
      totalDeviceBytes: mem.total,
      totalDeviceMB: +(mem.total / 1048576).toFixed(1),
      largestBindingMB: +(mem.largestBinding / 1048576).toFixed(1)
    },
    uniformEquivalentCells: uniformEquivalent,
    savingVsUniform: +(uniformEquivalent / mesh.N).toFixed(1),
    fits: caps ? mem.largestBinding <= caps.limits.maxStorageBufferBindingSize : null,
    adapter: caps ? caps.adapter : null,
    notes
  };
}

export async function capabilities() {
  const caps = await gpuCapabilities();
  return { ...caps, apiVersion: API_VERSION, specVersion: SPEC_VERSION };
}

/* ---- solving -------------------------------------------------------------------------------- */

/* Solve and return the full in-memory solution, fields included. Internal callers (the renderer,
 * sweeps) use this; the JSON API wraps it. */
export async function solveMotor(specIn, opts = {}) {
  const { spec, warnings } = normalizeSpec(specIn);
  const p = specToParams(spec);
  opts.onProgress && opts.onProgress({ phase: "rasterize" });
  // Yield once so a browser caller can paint the status before the rasterizer blocks the thread.
  await Promise.resolve();
  const job = buildMotor(p);
  const I = phaseCurrents(p);
  const sol = await solveJob(job, { ...opts, currents: I, solver: spec.solver });
  sol.I = I;
  sol.m = motorMetrics(sol);
  sol.resolution = meshResolution(job.mesh, p);
  sol.spec = spec;
  sol.warnings = warnings;
  return sol;
}

/* The JSON entry point. */
export async function solve(specIn, opts = {}) {
  const sol = await solveMotor(specIn, opts);
  return {
    spec: sol.spec,
    specHash: specHash(sol.spec),
    results: resultsSummary(sol),
    adapter: sol.adapter,
    warnings: sol.warnings
  };
}

/* ---- sweeps ---------------------------------------------------------------------------------- */

/* Vary one spec field over a list of values, or over a linear range.
 *   sweep(spec, { path: "operatingPoint.currentAngle_elecDeg", from: 0, to: 180, step: 15 })
 * The Biot-Savart trace field is cached whenever the winding and grid are unchanged, so a current
 * angle or rotor angle sweep pays for it once. */
export async function sweep(specIn, sweepSpec, opts = {}) {
  const { spec } = normalizeSpec(specIn);
  const path = sweepSpec.path;
  if (!path) throw new Error("A sweep needs a `path`, for example operatingPoint.currentAngle_elecDeg.");
  const values = sweepSpec.values ?? rangeValues(sweepSpec);
  if (!values.length) throw new Error("That sweep produced no values.");

  const points = [];
  const t0 = performance.now();
  for (let i = 0; i < values.length; i++) {
    if (opts.signal?.aborted) break;
    const variant = JSON.parse(JSON.stringify(spec));
    setPath(variant, path, values[i]);
    opts.onProgress && opts.onProgress({ phase: "sweep", index: i, total: values.length, path, value: values[i] });
    const sol = await solveMotor(variant, opts);
    const res = resultsSummary(sol);
    points.push({ value: values[i], results: res });
    opts.onPoint && opts.onPoint({ index: i, total: values.length, value: values[i], results: res, solution: sol });
  }
  return {
    path, values, points,
    baseSpec: spec, specHash: specHash(spec),
    elapsed_ms: +(performance.now() - t0).toFixed(0),
    complete: points.length === values.length
  };
}

function rangeValues({ from, to, step, count }) {
  if (Number.isFinite(count) && count > 1) {
    const out = [];
    for (let i = 0; i < count; i++) out.push(from + (to - from) * i / (count - 1));
    return out;
  }
  if (![from, to, step].every(Number.isFinite) || step === 0) return [];
  const out = [];
  const n = Math.floor((to - from) / step + 1e-9);
  for (let i = 0; i <= n; i++) out.push(+(from + i * step).toPrecision(12));
  return out;
}

/* ---- convergence ------------------------------------------------------------------------------ */

/* Solve the same design at a sequence of mesh refinements and fit the observed order of
 * convergence. This is the only real evidence that a result is mesh-converged; two stress surfaces
 * agreeing is necessary but not sufficient, because both can be wrong together. */
export async function convergence(specIn, opts = {}) {
  return convergenceStudy(specIn, {
    ...opts,
    solveFn: async variant => resultsSummary(await solveMotor(variant, opts))
  });
}

/* ---- validation ------------------------------------------------------------------------------ */

export const VALIDATION_CASES = {
  loop: {
    title: "Circular loop, on-axis B_z",
    reference: "mu0 I R^2 / 2 (R^2 + z^2)^{3/2}",
    run: (spec, opts) => runLoopCase(spec, opts).then(r => r.report)
  },
  sphere: {
    title: "Magnetic sphere in a uniform field",
    reference: "B_in = 3 mu_r/(mu_r + 2) mu0 H0",
    run: (spec, opts) => runSphereCase(spec, opts).then(r => r.report)
  }
};

export async function validate(which = "all", specIn = defaultSpec(), opts = {}) {
  const { spec } = normalizeSpec(specIn);
  const names = which === "all" || !which ? Object.keys(VALIDATION_CASES)
    : (Array.isArray(which) ? which : [which]);
  const G = await initGPU();
  const reports = [];
  for (const n of names) {
    const c = VALIDATION_CASES[n];
    if (!c) throw new Error(`Unknown validation case "${n}". Known: ${Object.keys(VALIDATION_CASES).join(", ")}.`);
    const t0 = performance.now();
    const report = await c.run(spec, opts);
    reports.push({ name: n, title: c.title, reference: c.reference, elapsed_ms: +(performance.now() - t0).toFixed(0), ...report });
  }
  return {
    apiVersion: API_VERSION,
    adapter: G.name,
    softwareAdapter: isSoftwareAdapter(G),
    spec,
    cases: reports,
    pass: reports.every(r => r.pass)
  };
}

export { defaultSpec, normalizeSpec, specHash, getPath, setPath };
