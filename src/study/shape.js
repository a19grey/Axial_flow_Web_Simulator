/* Footprints and lofts as design vectors, and the ladder that makes them searchable.
 *
 * A thirty-to-sixty dimensional shape space is only tractable because of three properties of the
 * parameterization in `src/core/curves.js`, and this file is where they are turned into an
 * optimizer's interface:
 *
 *   - **Every variable lives in the same box.** Control points are in normalized wedge coordinates:
 *     u from 0 at the feature's inner radius to 1 at its outer, v in units of the feature's pitch,
 *     so v = +-0.5 is where neighbouring copies touch. A design inside the box stays in its annulus
 *     and cannot collide with its neighbour. No constraint handling, no repair step.
 *
 *   - **The box is not enough on its own.** Eight points drawn uniformly from it and taken in the
 *     order they were drawn produce a simple outline only about 6 % of the time — the rest are bow
 *     ties, and a rejection loop at that rate would eat the whole budget. The low rungs therefore
 *     draw the footprint as two radially monotone chains with non-overlapping angular ranges, which
 *     cannot cross whatever numbers they are given: 100 % simple over the same draws. That layout is
 *     also exactly the generalization of the width/offset profile the tool already had, so today's
 *     machine sits inside it.
 *
 *   - **Refinement is exact.** `refine()` doubles the control points and returns the *same* curve to
 *     the last bit. So the search runs as a ladder: each rung starts not near where the previous one
 *     finished but exactly at it, because the coarse optimum is a member of the finer space rather
 *     than an approximation to one. A rung then only has to buy the improvement its extra freedom is
 *     worth, and a rung that buys nothing measurable is where the parameterization stops being worth
 *     refining — which is a result, not a shrug.
 *
 * The ladder's step from the two-chain layout to free control points is the one place the exactness
 * matters most and is easiest to get wrong. Going from n stations to 2n *stations* in the two-chain
 * form is not exact: the u positions move. Going from the two-chain curve to its own `refine()` is,
 * so that is what the step does, and the shape leaves the layout behind at the same moment it gains
 * the freedom to need to.
 */

import { twoSidedCurve, twoSidedBounds, curveToVector, curveFromVector, curveBounds, refine, inspectCurve, curveFrame, closedCurve } from "../core/curves.js";
import { footprintLoft } from "../core/ir.js";

/* ---- the two-chain footprint ------------------------------------------------------------------ */

/* n radial stations per side, so 2n variables: the trailing edge's angles (each in [-maxV, 0]) then
 * the leading edge's (each in [0, maxV]). A sampler needs to know nothing else. */
export function twoChainVariable(decl) {
  const n = Math.max(2, Math.round(decl.stations ?? 4));
  const maxV = Number.isFinite(+decl.maxV) ? +decl.maxV : 0.45;
  const half = Number.isFinite(+decl.init) ? +decl.init : maxV * 0.6;
  return {
    kind: "footprint.twoChain",
    target: decl.target || "design.rotor.poleCurve",
    dim: 2 * n,
    names: [...Array.from({ length: n }, (_, i) => `trail${i}`), ...Array.from({ length: n }, (_, i) => `lead${i}`)],
    bounds: twoSidedBounds(n, { maxV }),
    x0: [...Array.from({ length: n }, () => -half), ...Array.from({ length: n }, () => half)],
    meta: { stations: n, maxV, u0: decl.u0 ?? 0.05, u1: decl.u1 ?? 0.95, degree: decl.degree ?? 3, chordTolerance_mm: decl.chordTolerance_mm ?? 0.002 },
    write(spec, x) {
      const m = this.meta;
      setDeep(spec, this.target, {
        trailing: x.slice(0, n), leading: x.slice(n),
        u0: m.u0, u1: m.u1, degree: m.degree, chordTolerance_mm: m.chordTolerance_mm
      });
    },
    curve(x) { const m = this.meta; return twoSidedCurve(x.slice(0, n), x.slice(n), { u0: m.u0, u1: m.u1, degree: m.degree }); }
  };
}

/* ---- free control points ---------------------------------------------------------------------- */

/* The upper rungs. `fixU` pins each control point to its radius and halves the dimension, which is
 * what rungs 1 and 2 of the ladder use; releasing it is a rung of its own. */
export function controlVariable(decl) {
  const template = closedCurve(decl.controlPoints, { degree: decl.degree ?? 3 });
  const fixU = !!decl.fixU;
  return {
    kind: "footprint.control",
    target: decl.target || "design.rotor.poleCurve",
    dim: template.spans * (fixU ? 1 : 2),
    names: Array.from({ length: template.spans }, (_, i) => (fixU ? [`v${i}`] : [`u${i}`, `v${i}`])).flat(),
    bounds: curveBounds(template, { fixU, uRange: decl.uRange ?? [0, 1], vRange: decl.vRange ?? [-0.5, 0.5] }),
    x0: curveToVector(template, { fixU }),
    meta: { fixU, degree: template.degree, template, chordTolerance_mm: decl.chordTolerance_mm ?? 0.002 },
    write(spec, x) {
      const c = this.curve(x);
      setDeep(spec, this.target, { controlPoints: c.control, degree: c.degree, chordTolerance_mm: this.meta.chordTolerance_mm });
    },
    curve(x) { return curveFromVector(x, this.meta.template, { fixU: this.meta.fixU }); }
  };
}

/* ---- the loft ---------------------------------------------------------------------------------- */

/* How the footprint changes between the gap face and the yoke: one short Bezier control list per
 * channel against normalized height. One value is a constant, two a ramp, three the quadratic flare
 * or waist. Small dimension, and the channel that matters most (`scale`) is the one a moulding
 * process could not draw at all. */
export const LOFT_RANGES = { scale: [0.5, 1.6], widen: [0.5, 1.6], twist: [-0.25, 0.25], shift: [-0.3, 0.3] };

export function loftVariable(decl) {
  const chans = decl.channels || { scale: 3, widen: 2 };
  const names = [], bounds = [], x0 = [], layout = [];
  for (const [ch, count] of Object.entries(chans)) {
    const n = Math.max(1, Math.round(count));
    const range = decl[ch + "Range"] || LOFT_RANGES[ch] || [-1, 1];
    const neutral = ch === "scale" || ch === "widen" ? 1 : 0;
    layout.push([ch, n]);
    for (let i = 0; i < n; i++) { names.push(`${ch}${i}`); bounds.push(range.slice()); x0.push(neutral); }
  }
  return {
    kind: "loft",
    target: decl.target || "design.rotor.poleLoft",
    dim: names.length, names, bounds, x0,
    meta: { layout, pivot: decl.pivot ?? 0.5 },
    write(spec, x) {
      const out = { pivot: this.meta.pivot };
      let i = 0;
      for (const [ch, n] of this.meta.layout) { out[ch] = x.slice(i, i + n); i += n; }
      setDeep(spec, this.target, out);
    },
    loft(x) { const s = {}; let i = 0; for (const [ch, n] of this.meta.layout) { s[ch] = x.slice(i, i + n); i += n; } s.pivot = this.meta.pivot; return footprintLoft(s); }
  };
}

/* ---- validity --------------------------------------------------------------------------------- */

/* Whether a shape vector describes a footprint worth solving. The two-chain layout cannot produce a
 * bow tie, so on the low rungs this always passes and costs a tessellation; on the upper rungs,
 * where legality comes from locality instead — the search is perturbing a shape already known to be
 * simple — it is the gate that keeps a self-crossing outline out of the rasterizer, where it would
 * produce a plausible and wrong permeability rather than an error. */
export function inspectShape(variable, x, { r0 = 1, r1 = 2, count = 8, loft = null,
                                            tolerance_mm = 0.05, uRange = [0, 1],
                                            maxPitchFraction = 1 } = {}) {
  let curve;
  try { curve = variable.curve(x); }
  catch (e) { return { ok: false, reason: e.message }; }
  const frame = curveFrame({ r0, r1, centre: 0, count });
  const insp = inspectCurve(curve, frame, { loft, tolerance_mm });
  const reasons = [];
  if (!insp.simple) reasons.push("the outline crosses itself");
  /* The control points are bounded, but the loft is applied *after* them: `widen` fans the outline
   * angularly and `scale` grows it radially about the pivot, so a vector well inside its own box
   * can still describe a pole lying across its neighbour or hanging off the rim. These two read
   * the extents `inspectCurve` measured with the loft already applied, which is the only place the
   * question can be answered honestly. */
  if (2 * insp.maxAbsV > maxPitchFraction + 1e-9) reasons.push(
    `the footprint spans ${(200 * insp.maxAbsV).toFixed(0)} % of its own pole pitch, so neighbouring copies collide`);
  if (insp.uMin < uRange[0] - 1e-9 || insp.uMax > uRange[1] + 1e-9) reasons.push(
    `the footprint reaches ${insp.uMin.toFixed(3)}..${insp.uMax.toFixed(3)} of the annulus, outside the ` +
    `${uRange[0]}..${uRange[1]} it is allowed, so the pole hangs off the rotor`);
  return { ok: reasons.length === 0, reason: reasons.join("; ") || null, inspection: insp };
}

/* ---- the ladder ------------------------------------------------------------------------------- */

/* One rung up: the same shape, in a space twice the size.
 *
 * Returns a new variable declaration and the vector that reproduces the incoming design *exactly*
 * in it. The check that it does is the ladder's whole claim, and it is asserted in tests rather
 * than trusted: `refine()` is exact to the last bit, so the refined curve and the coarse one agree
 * pointwise to around 1e-16.
 */
export function ladderStep(variable, x, { releaseU = null } = {}) {
  const curve = variable.curve(x);
  const finer = refine(curve);
  const fixU = releaseU === null
    ? (variable.kind === "footprint.control" ? variable.meta.fixU : true)
    : !releaseU;
  const next = controlVariable({
    target: variable.target,
    controlPoints: finer.control,
    degree: finer.degree,
    fixU,
    chordTolerance_mm: variable.meta.chordTolerance_mm
  });
  return { variable: next, x: next.x0.slice(), from: variable.kind, dim: next.dim };
}

/* ---- plumbing --------------------------------------------------------------------------------- */

export function setDeep(obj, path, value) {
  const parts = path.split(".");
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    // Copy on the way down, so writing a variant never mutates the object a caller still holds.
    o[k] = (o[k] && typeof o[k] === "object") ? (Array.isArray(o[k]) ? o[k].slice() : { ...o[k] }) : {};
    o = o[k];
  }
  o[parts[parts.length - 1]] = value;
  return obj;
}
