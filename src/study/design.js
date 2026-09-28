/* The design variables: what a search is allowed to move, and in what units.
 *
 * Two rules, and they are the difference between a search that works and one that wanders.
 *
 * **Optimize in ratios, not millimetres.** A variable declared as `ri/ro` rather than `ri` makes the
 * space size-free, which matches a size-free objective and makes a result transferable to any
 * diameter instead of true only at 80 mm. It removes most of the coupling between variables —
 * millimetre thicknesses all move together when the diameter changes, ratios do not — and an
 * uncoupled space is enormously easier to search. And it makes the bounds mean something:
 * `0.3 < ri/ro < 0.75` is a statement about machines, `15 < ri < 40` is a statement about one
 * machine. So a declaration may write more than one spec field, through an expression over the other
 * variables and the baseline's own dimensions.
 *
 * **Do not treat manufacturing variables as continuous.** Copper layer count, copper weight, and
 * trace width and pitch come from a fab's process class; they are enumerated in an outer loop, not
 * optimized continuously and rounded afterwards. Optimizing a trace width of 0.237 mm and then
 * rounding it to the process minimum is a waste of the search. `values` declares such a variable and
 * this file keeps it out of the continuous vector.
 */

import { evalExpr } from "../core/expr.js";
import { getPath } from "../core/spec.js";
import { twoChainVariable, controlVariable, loftVariable, setDeep, inspectShape } from "./shape.js";

const clone = o => JSON.parse(JSON.stringify(o));

/* Short names for the baseline's own dimensions, so a `writes` expression can say `0.6 * ro` without
 * the caller having to restate the machine. */
export function baselineScope(spec) {
  const s = spec.design.stator, r = spec.design.rotor;
  return {
    ro: s.outerRadius_mm, ri: s.innerRadius_mm, poles: s.poles, layers: s.copperLayers,
    turns: s.turnsPerLayer, amps: s.peakCurrent_A, board_mm: s.thickness_mm,
    gap: r.airGap_mm, poleHeight: r.poleHeight_mm, yoke: r.yokeThickness_mm, mur: r.mu_r
  };
}

/* ---- compilation ------------------------------------------------------------------------------- */

/* Turn a list of declarations into one vector space plus the function that stamps a vector onto a
 * spec. Everything downstream — samplers, pattern search, CMA-ES, the archive — sees only
 * `{ dim, bounds, x0 }` and `apply(x)`, and never needs to know that entries 7 through 22 are a
 * rotor footprint. */
export function compileDesign(decls, baseSpec) {
  const groups = [], discrete = [];
  let dim = 0;
  const names = [], bounds = [], x0 = [];

  for (const d of decls) {
    if (d.values) { discrete.push({ name: d.name || d.path, path: d.path, values: d.values }); continue; }

    let g;
    if (d.kind === "footprint" || d.kind === "footprint.twoChain") g = twoChainVariable(d);
    else if (d.kind === "footprint.control") g = controlVariable(d);
    else if (d.kind === "loft") g = loftVariable(d);
    else g = scalarVariable(d, baseSpec);
    if (d.name) g.name = d.name;
    else if (!g.name) g.name = g.kind.replace(/^footprint\./, "");

    g.offset = dim;
    dim += g.dim;
    for (let i = 0; i < g.dim; i++) {
      names.push(g.dim === 1 ? (g.name || g.names[i]) : `${g.name || g.kind}.${g.names[i]}`);
      bounds.push(g.bounds[i]);
      x0.push(g.x0[i]);
    }
    groups.push(g);
  }

  const design = {
    dim, names, bounds, x0, groups, discrete,
    /* A spec from a vector. Pure: the baseline is deep-copied, so an optimizer can hold one design
     * object and stamp a thousand variants through it. */
    apply(x, choices = {}) {
      const spec = clone(baseSpec);
      const scope = { ...baselineScope(baseSpec) };
      for (const g of groups) if (g.dim === 1 && g.kind === "scalar") scope[g.name] = x[g.offset];
      for (const g of groups) g.write(spec, x.slice(g.offset, g.offset + g.dim), scope);
      for (const dv of discrete) if (choices[dv.name] !== undefined) setDeep(spec, dv.path, choices[dv.name]);
      return spec;
    },
    /* Named values, for the archive and for anything a human is going to read. */
    describe(x) {
      const out = {};
      for (let i = 0; i < dim; i++) out[names[i]] = x[i];
      return out;
    },
    /* Cheap rejection before a design costs a solve: a self-crossing footprint, or a loft that
     * pulls one outside its own pitch. Scalars are in-box by construction. */
    validate(x) {
      for (const g of groups) {
        if (!g.curve) continue;
        const loftGroup = groups.find(o => o.kind === "loft");
        const loft = loftGroup ? loftGroup.loft(x.slice(loftGroup.offset, loftGroup.offset + loftGroup.dim)) : null;
        const r = inspectShape(g, x.slice(g.offset, g.offset + g.dim), { loft });
        if (!r.ok) return { ok: false, reason: `${g.name || g.kind}: ${r.reason}` };
      }
      return { ok: true, reason: null };
    },
    clamp(x) {
      return x.map((v, i) => Math.min(bounds[i][1], Math.max(bounds[i][0], v)));
    }
  };
  return design;
}

/* ---- scalars ----------------------------------------------------------------------------------- */

function scalarVariable(d, baseSpec) {
  const name = d.name || d.path;
  if (!name) throw new Error("a design variable needs a name or a path");
  const writes = d.writes || (d.path ? [{ path: d.path, expr: name }] : null);
  if (!writes) throw new Error(`design variable "${name}" writes nothing: give it a path, or a writes list`);
  let init = d.init;
  if (!Number.isFinite(+init) && d.path) init = getPath(baseSpec, d.path);
  if (!Number.isFinite(+init)) init = 0.5 * (d.min + d.max);
  return {
    kind: "scalar", name, dim: 1, names: [name],
    bounds: [[+d.min, +d.max]], x0: [Math.min(+d.max, Math.max(+d.min, +init))],
    write(spec, x, scope) {
      const sc = { ...scope, [name]: x[0] };
      for (const w of writes) setDeep(spec, w.path, typeof w.expr === "number" ? w.expr : evalExpr(String(w.expr), sc));
    }
  };
}

/* ---- the discrete outer loop -------------------------------------------------------------------- */

/* Every combination of the enumerated variables. These are stack-ups and process classes, so the
 * product is small — two or three variables with a handful of values each — and running the whole
 * continuous search once per combination is the honest thing to do rather than pretending a layer
 * count has a gradient. */
export function discreteCombinations(discrete) {
  let out = [{}];
  for (const dv of discrete) {
    const next = [];
    for (const base of out) for (const v of dv.values) next.push({ ...base, [dv.name]: v });
    out = next;
  }
  return out;
}
