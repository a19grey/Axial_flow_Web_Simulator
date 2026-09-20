/* The results JSON. One shape, produced once, consumed by the UI panels, the project file, the
 * headless CLI and the optimizer's objective expressions. Units are in every field name.
 *
 * Physical quantities are NOT rounded here. Rounding is a presentation concern and belongs in the
 * UI formatters: an optimizer taking finite-difference gradients across a small design step needs
 * every digit the f32 solve actually produced, and a regression test comparing two runs needs to
 * be comparing the physics rather than the last decimal place. Timings are rounded, because they
 * are not reproducible anyway.
 */

import { derivedMetrics } from "./metrics.js";

export const RESULTS_VERSION = 3;

const ms = v => (Number.isFinite(v) ? +v.toPrecision(4) : null);

/* Built once per solution and cached on it.
 *
 * The page asks for this more than once — the result panel, the quality flags, the project file —
 * and the derived block walks every face of the mesh to integrate the co-energy. That is cheap
 * next to a solve and not cheap next to nothing, so it is computed on first use and kept. */
export function resultsSummary(sol) {
  if (!sol || sol.job.kind !== "motor") return null;
  if (sol.summary) return sol.summary;
  return (sol.summary = buildSummary(sol));
}

function buildSummary(sol) {
  const m = sol.m, job = sol.job, mesh = job.mesh;
  const mean = m.torque, spread = m.torqueSpread_pct;
  const legacyMean = m.legacyT.length ? m.legacyT.reduce((a, b) => a + b, 0) / m.legacyT.length : null;

  return {
    resultsVersion: RESULTS_VERSION,
    /* Averaged over every Maxwell-stress plane that fits in the air gap, with the spread across
     * them as the error bar. A single plane is sensitive to where it lands relative to the copper
     * and the pole face by a percent or two, independently of the field. */
    torque_mNm: mean === null ? null : mean * 1e3,
    torqueSurfaces_mNm: m.T.map(v => v * 1e3),
    torqueSurfaceZ_mm: m.planeZ_mm,
    torqueSurfaceSpread_pct: spread,
    /* The two-planes-nearest-mid-gap definition the single-file build used, kept so the regression
     * suite compares like with like. Not the headline number. */
    torqueLegacyTwoSurface_mNm: legacyMean === null ? null : legacyMean * 1e3,
    /* One entry per working gap. A dual-sided machine has two rotors on the same shaft; their
     * torques add, and because they are mirror images their disagreement is a meshing check. */
    rotors: m.rotors.map(r => ({
      name: r.name,
      torque_mNm: r.torque === null ? null : r.torque * 1e3,
      surfaces_mNm: r.T.map(v => v * 1e3),
      surfaceZ_mm: r.planeZ_mm,
      surfaceSpread_pct: r.spread_pct,
      midGapZ_mm: r.midGapZ_mm
    })),
    rotorImbalance_pct: m.rotorImbalance_pct ?? null,
    gapBzMean_mT: sol.m.gapBz * 1e3,
    gapBzMeanLower_mT: sol.m.gapBzLower === undefined ? null : sol.m.gapBzLower * 1e3,
    peakBInMagneticParts_mT: sol.m.bmaxMat * 1e3,
    phaseCurrents_A: sol.I ? [...sol.I] : null,
    mesh: {
      mode: job.p.mesh?.mode ?? "uniform",
      coordinates: mesh.kind,
      // How many copies of the modelled span make a full turn. A periodic sector solves one and
      // the torque is scaled up; everything else models the whole machine.
      sectors: mesh.sectors,
      periodicAngle: !!mesh.periodicY,
      cells: sol.N,
      dimensions: [mesh.nx, mesh.ny, mesh.nz],
      smallestCell_mm: mesh.hMin,
      largestCell_mm: mesh.hMax,
      worstAspectRatio: mesh.aspect,
      cellsAcrossAirGap: m.cellsAcrossAirGap,
      resolution: sol.resolution ?? null,
      torqueSurfaceCount: m.T.length
    },
    solver: {
      iterations: sol.pcg ? sol.pcg.iters : null,
      residual: sol.pcg ? sol.pcg.rel : null,
      converged: sol.pcg ? !!sol.pcg.converged : null,
      stopReason: sol.pcg ? sol.pcg.reason : null,
      segments: sol.nseg,
      biotSavartCached: !!sol.t.bsCached
    },
    timing_ms: {
      biotSavart: ms(sol.t.bs), setup: ms(sol.t.setup),
      potentialSolve: sol.pcg ? ms(sol.pcg.ms) : null, post: ms(sol.t.post)
    },
    /* Winding resistance, masses, energy and the per-unit figures. All of it is post-processing of
     * the one solve: nothing here costs another GPU pass. */
    derived: derivedMetrics(sol),
    quality: qualityFlags(sol, spread)
  };
}

/* Every reported number should carry the reason to trust it or not. */
function qualityFlags(sol, spread) {
  const job = sol.job, cellsInGap = sol.m.cellsAcrossAirGap;
  const flags = [];
  if (cellsInGap < 3) flags.push({ level: "error", code: "gapUnresolved", message: `Only ${cellsInGap.toFixed(1)} cells span the air gap. Torque and gap flux are not resolved; use a finer grid.` });
  else if (cellsInGap < 5) flags.push({ level: "warn", code: "gapCoarse", message: `${cellsInGap.toFixed(1)} cells span the air gap. Three is the practical minimum; five or more is comfortable.` });
  if (!sol.m.T.length) flags.push({ level: "error", code: "noStressSurface", message: "No Maxwell-stress surface fits inside the air gap, so no torque could be computed." });
  if (sol.m.rotorImbalance_pct !== null && sol.m.rotorImbalance_pct > 5) flags.push({ level: "warn", code: "rotorImbalance", message: `The two rotors of this dual-sided machine differ by ${sol.m.rotorImbalance_pct.toFixed(1)}% in torque. They are mirror images, so this is a mesh asymmetry rather than physics.` });
  if (spread !== null && spread > 5) flags.push({ level: "warn", code: "surfaceDisagreement", message: `Torque varies by ${spread.toFixed(1)}% across the ${sol.m.T.length} stress surfaces in the gap, which usually means the mesh is too coarse there.` });
  if (sol.pcg && !sol.pcg.converged) flags.push({ level: "warn", code: "notConverged", message: `The potential solve stopped at residual ${sol.pcg.rel.toExponential(1)} (${sol.pcg.reason}) rather than reaching tolerance.` });
  const maxMu = Math.max(job.p.murRot, job.g.back ? job.p.murBack : 1);
  if (maxMu > 200) flags.push({ level: "error", code: "muCeiling", message: `mu_r = ${maxMu} is past the reduced-scalar-potential ceiling of about 200 in f32. H inside the material is a small difference of large terms and is being lost to rounding. See docs/limitations.md.` });
  else if (maxMu > 100) flags.push({ level: "warn", code: "muNearCeiling", message: `mu_r = ${maxMu} approaches the reduced-scalar-potential ceiling of about 200 in f32.` });
  return flags;
}
