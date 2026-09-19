/* Mesh convergence study with Richardson extrapolation.
 *
 * Two Maxwell-stress surfaces agreeing tells you the field is smooth between them. It does not
 * tell you the mesh is fine enough — both surfaces can be wrong together. The only honest evidence
 * is refining the mesh and watching the answer stop moving, so this runs the same design at a
 * sequence of refinements and reports:
 *
 *   - the observed order of convergence p, fitted rather than assumed;
 *   - the extrapolated value the sequence is heading towards;
 *   - the remaining error on the finest mesh, as a percentage.
 *
 * A second-order scheme on a smooth problem should give p near 2. A staircased material boundary
 * degrades that towards 1, which is itself worth knowing: it is the signature of a geometry the
 * mesh is not resolving.
 */

import { normalizeSpec, specToParams } from "./spec.js";
import { buildMesh } from "./geometry.js";

/* Scale every cell-count knob by `factor`. The effective cell size then falls roughly as 1/factor
 * in all directions at once, which is what makes a single convergence order meaningful. */
export function refineSpec(spec, factor) {
  const s = JSON.parse(JSON.stringify(spec));
  const m = s.mesh;
  if (m.mode === "graded") {
    for (const k of ["activeCellsAcrossDiameter", "cellsAcrossAirGap", "cellsAcrossPoleHeight",
                     "cellsAcrossYoke", "cellsAcrossPcb", "cellsAcrossBackPlate", "cellsAcrossBackGap"])
      m[k] = Math.max(1, Math.round(m[k] * factor));
  } else {
    m.cellsAcrossDiameter = Math.max(16, Math.round(m.cellsAcrossDiameter * factor));
  }
  return s;
}

/* Fit f(h) = f_ext + C h^p to the sampled values.
 *
 * h is taken as N^(-1/3), the mean cell size implied by the cell count, which handles a graded
 * mesh and unequal refinement ratios that a textbook three-point Richardson formula cannot.
 * For each trial p the fit is linear in (f_ext, C), so a scan over p with a least-squares solve
 * inside is both simple and robust — no derivatives, no failure to converge.
 */
export function fitOrder(points) {
  const pts = points.filter(q => Number.isFinite(q.value) && Number.isFinite(q.cells) && q.cells > 0);
  if (pts.length < 3) return null;
  const h = pts.map(q => Math.pow(q.cells, -1 / 3));
  const f = pts.map(q => q.value);
  const n = pts.length;

  const P_LO = 0.25, P_HI = 5.0;
  let best = null;
  for (let p = P_LO; p <= P_HI + 1e-9; p += 0.01) {
    const x = h.map(v => Math.pow(v, p));
    // Least squares for f = a + b x.
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sx += x[i]; sy += f[i]; sxx += x[i] * x[i]; sxy += x[i] * f[i]; }
    const det = n * sxx - sx * sx;
    if (Math.abs(det) < 1e-30) continue;
    const b = (n * sxy - sx * sy) / det, a = (sy - b * sx) / n;
    let ss = 0;
    for (let i = 0; i < n; i++) { const e = f[i] - (a + b * x[i]); ss += e * e; }
    if (!best || ss < best.ss) best = { p, a, b, ss };
  }
  if (!best) return null;

  const finest = pts[pts.length - 1], prev = pts[pts.length - 2];
  const extrapolated = best.a;
  const err = Math.abs(finest.value - extrapolated);
  const rel = Math.abs(extrapolated) > 0 ? err / Math.abs(extrapolated) * 100 : null;

  // The fitted order is only meaningful if it landed inside the scan. Pinned at a limit means the
  // sequence is not following a single power law — usually because it has already flattened into
  // solver noise, or because it is still in a pre-asymptotic regime. Say so rather than quoting a
  // number that looks like a measurement.
  const atLimit = best.p <= P_LO + 1e-6 || best.p >= P_HI - 1e-6;

  // The change over the last refinement is the most directly interpretable figure, and it needs no
  // model of how the error behaves.
  const lastStep_pct = Math.abs(finest.value) > 0
    ? Math.abs(finest.value - prev.value) / Math.abs(finest.value) * 100 : null;

  return {
    observedOrder: atLimit ? null : +best.p.toFixed(2),
    orderFitReliable: !atLimit,
    orderNote: atLimit
      ? `The power-law fit pinned at p = ${best.p.toFixed(2)}, the edge of the search, so the observed order is not a meaningful measurement here. Judge convergence from lastStep_pct instead.`
      : null,
    extrapolated,
    finest: finest.value,
    finestError_pct: rel,
    lastStep_pct,
    // Roache's grid convergence index with the usual 1.25 safety factor: a conservative error bar
    // on the finest result rather than the bare extrapolation difference.
    gci_pct: rel === null || atLimit ? null : 1.25 * rel,
    rmsResidual: Math.sqrt(best.ss / n),
    points: pts.length
  };
}

/* Run a design at a sequence of refinements and report the trend for each tracked quantity. */
export async function convergenceStudy(specIn, { factors = [1, 1.4, 2, 2.8], solveFn, onProgress, signal } = {}) {
  const { spec } = normalizeSpec(specIn);
  if (!solveFn) throw new Error("convergenceStudy needs a solveFn.");

  const levels = [];
  for (let i = 0; i < factors.length; i++) {
    if (signal?.aborted) break;
    const variant = refineSpec(spec, factors[i]);
    const p = specToParams(variant);
    let cells;
    try { cells = buildMesh(p).N; }
    catch (e) { levels.push({ factor: factors[i], error: e.message }); continue; }
    onProgress && onProgress({ phase: "convergence", index: i, total: factors.length, factor: factors[i], cells });
    const t0 = performance.now();
    const r = await solveFn(variant);
    levels.push({
      factor: factors[i], cells,
      cellsAcrossAirGap: r.mesh.cellsAcrossAirGap,
      torque_mNm: r.torque_mNm,
      gapBzMean_mT: r.gapBzMean_mT,
      torqueSurfaceSpread_pct: r.torqueSurfaceSpread_pct,
      iterations: r.solver.iterations,
      wall_ms: +(performance.now() - t0).toFixed(0)
    });
  }

  const usable = levels.filter(l => !l.error);
  const trends = {};
  for (const q of ["torque_mNm", "gapBzMean_mT"]) {
    trends[q] = fitOrder(usable.map(l => ({ cells: l.cells, value: l[q] })));
  }
  return { baseSpec: spec, factors, levels, trends };
}
