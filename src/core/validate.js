/* Validation cases with closed-form references.
 *
 * Each analyzer returns plain numbers, so the browser panel and the headless test runner report
 * exactly the same figures. Pass thresholds live here too, not in the UI, so a test cannot quietly
 * pass in one place and fail in the other.
 */

import { MU0 } from "./constants.js";
import { buildLoop, buildSphere } from "./geometry.js";
import { solveJob } from "./solve.js";
import { interpCentre } from "./torque.js";
import { specToParams } from "./spec.js";

export const pctErr = (a, b) => (a - b) / b * 100;

/* ---- case 1: circular filament, on-axis B_z ------------------------------------------------
 * Reference: B_z(z) = mu0 I R^2 / 2 (R^2 + z^2)^{3/2}.
 * Tests the source field alone; the potential solve is skipped because mu = 1 everywhere. */
export function analyzeLoop(sol, { window_mm = 30 } = {}) {
  const { job } = sol;
  const R = job.R * 1e-3;
  let worstPct = 0, worstZ = 0;
  const samples = [];
  for (let iz = 1; iz < job.nz - 1; iz++) {
    const z = job.z0 + (iz + .5) * job.hm;
    if (Math.abs(z) > window_mm) continue;
    const analytic = MU0 * R * R / (2 * (R * R + (z * 1e-3) ** 2) ** 1.5);
    const computed = interpCentre(sol.Bz, job, iz);
    const e = pctErr(computed, analytic);
    samples.push({ z_mm: +z.toFixed(3), computed_T: computed, analytic_T: analytic, error_pct: +e.toFixed(4) });
    if (Math.abs(e) > Math.abs(worstPct)) { worstPct = e; worstZ = z; }
  }
  const tolerance_pct = 1.0;
  return {
    case: "loop", tolerance_pct,
    worstError_pct: +worstPct.toFixed(4), worstAt_z_mm: +worstZ.toFixed(3),
    loopRadius_mm: job.R, cellsAcrossDiameter: job.nx, cellSize_mm: +job.hm.toFixed(4),
    pass: Math.abs(worstPct) <= tolerance_pct,
    samples
  };
}

/* ---- case 3: sphere in a uniform field ------------------------------------------------------
 * Reference: B_in = 3 mu_r/(mu_r + 2) * mu0 H0, uniform throughout the sphere.
 * This is a deliberately harsh test. The interior field amplifies an error in the demagnetizing
 * factor by roughly mu_r/3, so a staircased sphere reads high, and the error grows with mu_r.
 * That sensitivity is exactly why this case is the probe for the reduced-potential mu_r ceiling. */
export function analyzeSphere(sol) {
  const { job } = sol, mr = job.p.murRot;
  const B0 = MU0 * job.H0;
  const analytic = 3 * mr / (mr + 2) * B0;

  let s = 0, cnt = 0;
  for (let q = 0; q < job.mu.length; q++) if (job.mu[q] > mr * 0.999) { s += sol.Bz[q]; cnt++; }
  const meanInside = s / cnt;

  const c = job.nx / 2;
  let centre = 0;
  for (const dz of [-1, 0]) centre += interpCentre(sol.Bz, job, c + dz) / 2;

  const cellsAcross = 2 * job.a / job.hm;
  // Tolerance scales with mu_r because the staircase error does: ~3% at mu_r 5, ~8% at mu_r 20 on
  // 20 cells across, and it converges away under refinement (case 10 measures the order).
  const tolerance_pct = Math.min(35, 2 + 0.35 * mr);

  return {
    case: "sphere", tolerance_pct,
    mu_r: mr, radius_mm: job.a, cellsAcrossSphere: +cellsAcross.toFixed(1),
    appliedB0_T: B0, analytic_T: analytic,
    meanInside_T: meanInside, meanInsideError_pct: +pctErr(meanInside, analytic).toFixed(3),
    centre_T: centre, centreError_pct: +pctErr(centre, analytic).toFixed(3),
    interiorCells: cnt,
    pass: Math.abs(pctErr(meanInside, analytic)) <= tolerance_pct
  };
}

/* ---- runners -------------------------------------------------------------------------------- */

export async function runLoopCase(spec, opts = {}) {
  const p = specToParams(spec);
  const job = buildLoop(p, opts.geometry);
  // mu = 1 everywhere, so there is no material response to solve for.
  const sol = await solveJob(job, { ...opts, currents: [1, 0, 0], skipPCG: true });
  return { sol, report: analyzeLoop(sol, opts.analysis) };
}

export async function runSphereCase(spec, opts = {}) {
  const p = specToParams(spec);
  const job = buildSphere(p, opts.geometry);
  const sol = await solveJob(job, { ...opts, uniformH: job.H0 });
  return { sol, report: analyzeSphere(sol) };
}
