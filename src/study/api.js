/* The one call a study makes per design.
 *
 * Kept out of `src/core/api.js` on purpose: the core API is the solver's interface and knows nothing
 * about searching, while this knows about both. The dependency runs study -> core and never back.
 *
 * `score()` is the whole evaluation: put the design at its own best operating point, gate it, and
 * reduce it to one number a maximizer wants larger. The record it returns is what the run archive
 * stores, so it carries the full results JSON of the confirming solve alongside the score — the
 * score is what the search reads, and the record is what a human reads six hours later when they
 * want to know why that design won.
 */

import { normalizeSpec, specHash } from "../core/spec.js";
import { evaluateDesign } from "./operatingPoint.js";
import { scoreDesign, gateDesign, checkExpressions } from "./objectives.js";

export async function score(specIn, opts = {}) {
  const { spec } = normalizeSpec(specIn);

  /* Gates that read only the spec run first and can reject a design before it is meshed. A trace
   * narrower than the fab allows is not a design worth three solves. */
  const pre = gateDesign(spec, null, opts.objective);
  if (!pre.feasible) return {
    specHash: specHash(spec), score: null, feasible: false, gates: pre.gates,
    objective: (opts.objective || {}).maximize || "shear_kPa",
    rejectedBefore: "solve", record: null
  };

  const record = await evaluateDesign(spec, opts);
  const s = scoreDesign(spec, record, opts.objective);
  return {
    specHash: record.specHash,
    score: s.score, feasible: s.feasible, gates: s.gates, error: s.error,
    objective: s.objective,
    record
  };
}

/* Check a study's expressions against the names a record actually carries, before it runs all
 * night. */
export { checkExpressions, gateDesign, scoreDesign };
