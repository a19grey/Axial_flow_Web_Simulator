/* The results JSON. One shape, produced once, consumed by the UI panels, the project file, the
 * headless CLI and the optimizer's objective expressions. Units are in every field name.
 *
 * Physical quantities are NOT rounded here. Rounding is a presentation concern and belongs in the
 * UI formatters: an optimizer taking finite-difference gradients across a small design step needs
 * every digit the f32 solve actually produced, and a regression test comparing two runs needs to
 * be comparing the physics rather than the last decimal place. Timings are rounded, because they
 * are not reproducible anyway.
 */

export const RESULTS_VERSION = 2;

const ms = v => (Number.isFinite(v) ? +v.toPrecision(4) : null);

export function resultsSummary(sol) {
  if (!sol || sol.job.kind !== "motor") return null;
  const T = sol.m.T, job = sol.job;
  const mean = T.length ? T.reduce((a, b) => a + b, 0) / T.length : null;
  const spread = T.length > 1 ? Math.abs(T[0] - T[1]) / Math.max(1e-12, Math.abs(mean)) * 100 : null;

  return {
    resultsVersion: RESULTS_VERSION,
    torque_mNm: mean === null ? null : mean * 1e3,
    torqueSurfaces_mNm: T.map(v => v * 1e3),
    torqueSurfaceSpread_pct: spread,
    gapBzMean_mT: sol.m.gapBz * 1e3,
    peakBInMagneticParts_mT: sol.m.bmaxMat * 1e3,
    phaseCurrents_A: sol.I ? [...sol.I] : null,
    mesh: {
      cells: sol.N,
      dimensions: [job.nx, job.ny, job.nz],
      cellSize_mm: job.hm,
      cellsAcrossAirGap: job.p.gap / job.hm,
      torqueSurfaceCount: T.length
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
    quality: qualityFlags(sol, spread)
  };
}

/* Every reported number should carry the reason to trust it or not. */
function qualityFlags(sol, spread) {
  const job = sol.job, cellsInGap = job.p.gap / job.hm;
  const flags = [];
  if (cellsInGap < 3) flags.push({ level: "error", code: "gapUnresolved", message: `Only ${cellsInGap.toFixed(1)} cells span the air gap. Torque and gap flux are not resolved; use a finer grid.` });
  else if (cellsInGap < 5) flags.push({ level: "warn", code: "gapCoarse", message: `${cellsInGap.toFixed(1)} cells span the air gap. Three is the practical minimum; five or more is comfortable.` });
  if (!sol.m.T.length) flags.push({ level: "error", code: "noStressSurface", message: "No Maxwell-stress surface fits inside the air gap, so no torque could be computed." });
  if (spread !== null && spread > 10) flags.push({ level: "warn", code: "surfaceDisagreement", message: `The two stress surfaces disagree by ${spread.toFixed(1)}%, which usually means the grid is too coarse in the gap.` });
  if (sol.pcg && !sol.pcg.converged) flags.push({ level: "warn", code: "notConverged", message: `The potential solve stopped at residual ${sol.pcg.rel.toExponential(1)} (${sol.pcg.reason}) rather than reaching tolerance.` });
  const maxMu = Math.max(job.p.murRot, job.p.back ? job.p.murBack : 1);
  if (maxMu > 200) flags.push({ level: "error", code: "muCeiling", message: `mu_r = ${maxMu} is past the reduced-scalar-potential ceiling of about 200 in f32. H inside the material is a small difference of large terms and is being lost to rounding. See docs/limitations.md.` });
  else if (maxMu > 100) flags.push({ level: "warn", code: "muNearCeiling", message: `mu_r = ${maxMu} approaches the reduced-scalar-potential ceiling of about 200 in f32.` });
  return flags;
}
