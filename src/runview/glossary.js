/* What every number on the run viewer means.
 *
 * Two kinds of help live here, and the split matters.
 *
 * **Fixed vocabulary** — the metrics, the winding plan, the run manifest. These are properties of
 * the tool, so they are written out once, here, next to nothing else. Each definition says how the
 * number is *computed*, not what it is called: "shear" is a word, "torque divided by the r-weighted
 * swept area of every working gap" is a definition, and only the second one lets a reader decide
 * whether to trust a comparison. Where a figure has a scale worth knowing against, it is given.
 *
 * **Generated vocabulary** — the design vector. A study names its own variables and nothing in this
 * file can know them: `gapOverRo` is a choice some study made at 2 a.m., and a hard-coded
 * description of it would be a lie the day someone renames it. But the archive keeps the study's own
 * declaration in `run.json` under `studySpec`, bounds and `writes` expressions included, so the help
 * for `gapOverRo` is *derived from the thing that defined it*. The only prose is for the two
 * conventions a shape group's members follow, which are properties of the shape language rather than
 * of any study.
 *
 * The audience is a person hovering and an agent reading the DOM, which want the same thing: the
 * definition in the page rather than in a document somewhere else.
 */

/* ---- the fixed vocabulary ----------------------------------------------------------------------- */

/* Keyed by the label the viewer prints, so a row and its help cannot drift apart without the row
 * visibly losing its tooltip. */
export const HELP = {
  /* metrics */
  "shear": "Mean tangential traction in the air gap: the mean torque divided by the r-weighted swept " +
    "area of every working gap, n·(2π/3)·(ro³−ri³) over the active annulus — the radial span the " +
    "coils and poles share, not the rotor's outer diameter. The point of dividing is that it is " +
    "size-free, so a bigger machine does not win for being bigger. For scale: a good air-cooled " +
    "permanent-magnet machine reaches 20–40 kPa and a liquid-cooled YASA-class one 60–100 kPa.",
  "mean torque": "Torque averaged over one full ripple period of rotor angle, not at one angle. " +
    "Averaging matters: this geometry runs from 2.8 to 5.4 mN·m across its period, so a single-angle " +
    "number can be off by a factor of two in either direction.",
  "ripple": "Peak-to-peak torque variation over the ripple period, as a percentage of the mean. " +
    "Reported, not constrained — no study gates on it yet, so a design can win here by being " +
    "violently uneven.",
  "current phase": "The electrical angle between the current and the rotor, in degrees, chosen by " +
    "closed form rather than swept: torque is a quadratic form in the phase currents, so the best " +
    "phase has an exact solution. A 36-point sweep agrees with it to 1.4e-3 % (tests/study.js §7).",
  "current": "Peak phase current the design was scored at. An *output*, not an input: the current is " +
    "solved for so that the copper loss lands on the run's loss budget, which is what makes two " +
    "designs a comparison at equal heat rather than at equal amps.",
  "copper loss": "I²R in the traces at that current, from the real routed turn geometry. Every " +
    "design in a run is held to the same value — see the run's loss budget.",
  "peak B in iron": "Largest flux density anywhere in the magnetic parts. The solver is linear, so " +
    "nothing saturates here no matter how high this gets; a value far above ~1.5 T means the design " +
    "is claiming a field real steel would not give it.",
  "surface spread": "Disagreement between the independent Maxwell-stress surfaces the torque is " +
    "integrated over. Two surfaces in the same field should give the same torque, so this is a mesh " +
    "error bar, not physics. Studies gate designs out above 10 %.",
  "superposition": "Whether the three phases' fields still add up: the torque rebuilt from the " +
    "per-phase solutions against a direct solve at the same currents. It checks the linearity the " +
    "closed-form phase choice depends on, and runs in the 1e-3 % range.",
  "mass": "Total mass of copper and magnetic parts from the meshed volumes.",
  "cells": "Mesh cells in the solve. Set by the tier, not by the design.",
  "gap cells": "Cells across the air gap — the one mesh number that decides whether the gap is " +
    "resolved at all. The screening tier uses 5, the confirm tier 10.",
  "CG iterations": "Conjugate-gradient iterations to reach the solver tolerance. A proxy for how " +
    "badly conditioned the design made the operator.",
  "solves": "Field solves this evaluation cost, and the wall time they took. One evaluation is " +
    "several solves: three phases, at each rotor angle in the ripple average.",

  /* the winding, re-derived in the browser from the design's own spec */
  "coil outline": "How the coil's shape is described. `wedge` is the classic pair of angles at each " +
    "radius; `traced` is a control-point curve that can be any closed shape, including ones no pair " +
    "of angles can draw.",
  "turns per coil": "Turns the router actually fitted — an output, not an input. The turns are true " +
    "planar offsets of the outline, inset one trace pitch at a time until something stops them.",
  "fill fraction": "How far into the outline to wind, as a fraction of the room the outline actually " +
    "has. This is the input the turn count falls out of. Every turn inward links less flux than the " +
    "one outside it and adds its whole perimeter to the resistance, so at fixed copper loss there is " +
    "a depth past which the next turn makes the machine worse; a sweep puts that at about 85 %.",
  "room in the outline": "The deepest inset the outline admits before it closes on itself, measured " +
    "on a distance field. The denominator the fill fraction is a fraction of.",
  "wound to": "How deep the last turn actually sits, measured inward from the outline. Equal to the " +
    "room in the outline only when the fill fraction is 1 and the turns happened to divide it evenly.",
  "stopped on": "Why the router stopped adding turns. `fill` — it reached the depth the fill " +
    "fraction asked for, the intended case. `depth` — the outline ran out of room first. `split` — " +
    "the offset pinched and broke into two loops, which is the interesting failure: it means the " +
    "outline has a waist. `cap` — it hit the turn limit.",
  "winding": "The winding could not be routed from this design, or the design was never saved.",

  /* the run manifest */
  "study": "The study spec that generated this run, from `studies/`.",
  "objective": "The quantity being maximized. Every score in the run is this number.",
  "adapter": "The GPU the solves ran on. A software adapter would invalidate every timing here, so " +
    "the driver refuses one unless told otherwise.",
  "status": "`running`, `complete`, `stopped` (out of time or budget), or `failed`.",
  "started": "When the run began. Runs are resumable, so this is the first start, not the last.",
  "evaluations": "Designs scored, and how many of those were served from the cache rather than " +
    "solved. A design is cached by the hash of its normalized spec, so a search that revisits a " +
    "point pays nothing.",
  "field solves": "Total field solves across the run — the real unit of work, several per evaluation.",
  "solver time": "Wall time inside the solver, which is less than the run's elapsed time.",
  "noise floor": "How much the score moves for reasons that are not the design, measured by scoring " +
    "the same design at two or three mesh refinements. No improvement smaller than this means " +
    "anything, and the search's own step sizes are floored by it.",
  "loss budget": "The copper loss every design in the run is scored at, taken from the baseline's " +
    "own loss. Designs are given whatever current puts them on this number, so the comparison is at " +
    "equal heat. It is far above what a board this size would survive thermally — shear at fixed " +
    "loss is very nearly scale-free, so the ranking transfers and the absolute watts do not.",
  "best": "Best score on the run's primary tier. Tiers are tracked separately on purpose: a " +
    "screening-mesh score and a confirm-mesh score are two different numbers about the same design.",
  "commit": "The git commit the run was launched from, so a result can be traced to the code that " +
    "produced it."
};

/* ---- the generated vocabulary ------------------------------------------------------------------- */

/* The two conventions a shape group's members follow. Properties of the shape language in
 * `src/core/curves.js`, not of any one study, which is why they can be written down here. */
const SHAPE_HELP = {
  trail: "Trailing edge of the outline at station {n}. A v coordinate: the angle of that side, in " +
    "units of the feature's own pitch, so ±0.5 is where neighbouring features would touch. The " +
    "stations march from the inner radius to the outer. The trailing and leading chains cannot " +
    "cross, which is why the low rungs of the ladder use this layout.",
  lead: "Leading edge of the outline at station {n}. See the trailing edge — same coordinate, other " +
    "side of the shape.",
  v: "Angular position of control point {n}, in units of the feature's pitch; ±0.5 is where " +
    "neighbours touch. Free control points are what a ladder rung refines the two edge chains into, " +
    "so the shape is no longer obliged to be two monotone sides.",
  u: "Radial position of control point {n}: 0 at the feature's inner radius, 1 at its outer.",
  scale: "Loft `scale` control value {n}: radial-and-angular size about the pivot as the shape " +
    "climbs from the gap face to the yoke. Below 1 pinches, above 1 flares. The channel a moulding " +
    "process could not draw at all.",
  widen: "Loft `widen` control value {n}: extra angular-only factor, so the feature can fan out " +
    "without growing radially.",
  twist: "Loft `twist` control value {n}: centre-line swing in pitch units — the general form of " +
    "pole skew.",
  shift: "Loft `shift` control value {n}: radial translation, in normalized units."
};

const LOFT_SHAPE = ["a constant — the same at every height", "a ramp from the gap face to the yoke",
                    "a quadratic: a flare or a waist"];

/* The loft channel ranges `src/study/shape.js` falls back to when a study does not state one. */
const LOFT_RANGES = { scale: [0.5, 1.6], widen: [0.5, 1.6], twist: [-0.25, 0.25], shift: [-0.3, 0.3] };

/* The box one entry of the vector is searched in, reconstructed from the declaration the study made.
 *
 * Mirrors `twoSidedBounds` and `LOFT_RANGES`, which is a duplication and is the right trade: the
 * alternative is importing the study layer into a page that is deliberately free of it. A member
 * whose bounds cannot be reconstructed honestly — the free control points a ladder rung produces,
 * whose box is per-point and comes from the template curve — returns null and simply says less. */
function boxFor(decl, member) {
  if (!decl) return null;
  if (!member) return Number.isFinite(decl.min) && Number.isFinite(decl.max) ? [decl.min, decl.max] : null;
  const m = /^([A-Za-z]+)(\d*)$/.exec(member);
  if (!m) return null;
  const ch = m[1];
  if (decl.kind === "footprint" || decl.kind === "footprint.twoChain") {
    const maxV = Number.isFinite(+decl.maxV) ? +decl.maxV : 0.45;
    if (ch === "trail") return [-maxV, 0];
    if (ch === "lead") return [0, maxV];
    return null;
  }
  if (decl.kind === "loft") return decl[ch + "Range"] || LOFT_RANGES[ch] || null;
  return null;
}

/* The study's own declaration of a variable, found by the name the ledger records it under. A shape
 * group's members are `group.member`, so a dotted name splits. */
function declFor(name, studySpec) {
  const vars = studySpec?.variables || [];
  const direct = vars.find(v => (v.name || v.path) === name);
  if (direct) return { decl: direct, member: null };
  const dot = name.lastIndexOf(".");
  if (dot < 0) return { decl: null, member: null };
  const group = name.slice(0, dot), member = name.slice(dot + 1);
  const g = vars.find(v => (v.name || v.path) === group);
  return g ? { decl: g, member } : { decl: null, member };
}

const WRITES = { "design.stator.innerRadius_mm": "the stator's inner radius",
                 "design.rotor.airGap_mm": "the air gap",
                 "design.rotor.poleHeight_mm": "the rotor pole's axial height",
                 "design.rotor.yokeThickness_mm": "the rotor's back-iron thickness",
                 "design.stator.fillFraction": "the coil fill fraction — how far into the outline to wind" };

/* Help for one entry of the design vector, and where in its own range the value sits.
 *
 * The description is assembled rather than looked up: what the declaration writes, through what
 * expression, between what bounds. A study that renames a variable or moves a bound gets correct
 * help for free, and a study this file has never heard of still gets everything but the prose. */
export function variableHelp(name, value, studySpec) {
  const { decl, member } = declFor(name, studySpec);
  const parts = [];

  if (member) {
    const m = /^([A-Za-z]+)(\d*)$/.exec(member);
    const kind = m && SHAPE_HELP[m[1]];
    if (kind) parts.push(kind.replace("{n}", m[2] === "" ? "0" : m[2]));
    if (decl?.kind === "loft" && m) {
      const n = decl.channels?.[m[1]];
      if (n) parts.push(`This channel has ${n} control value${n === 1 ? "" : "s"}, which makes it ` +
                        `${LOFT_SHAPE[Math.min(n, 3) - 1]}.`);
    }
    if (decl?.target) parts.push(`Part of "${decl.name}", which writes ${decl.target}.`);
  } else if (decl) {
    const writes = decl.writes || (decl.path ? [{ path: decl.path, expr: name }] : []);
    let derived = false;
    for (const w of writes) {
      if (w.expr === name) { parts.push(`Sets ${WRITES[w.path] || w.path}.`); continue; }
      derived = true;
      parts.push(`Sets ${WRITES[w.path] || w.path} to ${w.expr}` +
                 (/\bro\b/.test(w.expr) ? ", where ro is the baseline's outer radius." : "."));
    }
    if (!writes.length) parts.push("A design variable this study declared.");
    /* Only for the variables that are actually ratios. A fill fraction is already dimensionless and
     * telling its reader it has been made size-free would be noise. */
    if (derived) parts.push("Declared as a ratio rather than a millimetre length, which is what " +
               "makes the result transferable to another diameter instead of true only at this one.");
  } else {
    parts.push("A design variable this study declared. The run's own study spec is in run.json.");
  }

  /* Where the value sits in its box, which is the thing worth noticing: a variable parked on a bound
   * is the search telling you the bound is in the way. */
  const box = boxFor(decl, member);
  const lo = box ? box[0] : null, hi = box ? box[1] : null;
  if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo && Number.isFinite(value)) {
    const f = (value - lo) / (hi - lo);
    const where = f <= 0.02 ? "on its lower bound" : f >= 0.98 ? "on its upper bound"
                : f <= 0.1 ? "near its lower bound" : f >= 0.9 ? "near its upper bound"
                : `${(f * 100).toFixed(0)} % of the way up its range`;
    /* Why a value is pinned is not the same question everywhere. A scalar on a bound means the box
     * is in the way. But an edge chain's bound at zero is the feature's own centre line, which is as
     * far as that side can go without crossing the other one — a structural limit of the shape
     * language, and widening it would not be a bigger box but a self-crossing outline. */
    const centreLine = member && /^(trail|lead)/.test(member) &&
                       ((lo === 0 && f <= 0.02) || (hi === 0 && f >= 0.98));
    parts.push(`Range ${lo} to ${hi}; this design is ${where}.` +
               (f > 0.02 && f < 0.98 ? ""
                : centreLine ? " That side has collapsed onto the feature's own centre line, which is as far " +
                               "as it can go without crossing the other side."
                : " A value pinned to a bound usually means the box is too small."));
  }
  return parts.join(" ");
}

/* The headline's chips, which are about the evaluation rather than the design. */
export const CHIP_HELP = {
  stage: "The stage of the study that produced this design. Stages run in order: baseline, noise, " +
    "screen, scan, rankcheck, refine, ladder, confirm.",
  tier: "The mesh this design was evaluated on. `screen` is coarse and cheap, `score` is the " +
    "search's working mesh, `confirm` is fine and is only spent on the finalists.",
  seq: "Position in the run's ledger — the order the search actually tried things in."
};
