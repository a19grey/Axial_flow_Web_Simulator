# Generalizing the geometry engine

*Status: plan, not yet built. Written 2026-09-20.*

## Why

Today the machine is a fixed list. `motorRegions()` in `src/core/geometry.js` returns four hard-coded
annular-sector extrusions — pole, yoke, mirrored pole, mirrored yoke, back plate — and `coilPolys()`
returns concentric trapezoids from `poles`, `ri`, `ro`, `turns`, `pitch`, `edge`. Every knob in the spec is
a number that feeds those two functions. That was exactly right for proving the solver: the geometry is
*analytically known*, which is what makes the cylindrical rasterizer exact and the mass and rasterization
checks meaningful.

It is also the ceiling. The designs we now want to reach cannot be written down in that vocabulary:

- **Apostrophe / teardrop nested coils.** A YASA-class stator coil is not a trapezoid. Its outline is a
  traced curve, and its turns are inward offsets of that curve.
- **A 3D-printed rotor.** The whole point of printing it is that it need not be a prism with a straight
  pole. Tapers, twists, lightening pockets, scalloped back-iron, stepped poles, non-radial pole edges.
- **Cores in the coil window.** A ten-turn coil rarely fills its own window. The space left in the
  middle is somewhere a stator core could go — a slug rising off the back plate into the coil, to
  confine and shape the field. Deferred (see below), but the kind of thing the language has to be
  able to grow into rather than be rebuilt for.

And it is the wrong shape for the customer we said we would have. The tool is headless and agent-drivable,
so "point your own LLM at it" should mean an agent can *author a machine*, not just move sliders on ours.
An agent authoring geometry needs three things this repo does not have: a declarative shape language, a
fast check-and-see loop that does not require a solve, and error messages that say what is wrong with the
shape rather than what is wrong with the JSON.

**Success criterion.** A general enough tool that *we* use it, headless, to optimize a rotor/stator pair
under the real manufacturing constraint pair — stator is a PCB, rotor is 3D printed — over a design
described entirely in the new language, with today's default machine reproduced as one of its examples.

## What must not break

Three properties of the current engine are worth more than the generality we are adding, and the plan is
arranged around keeping them:

1. **Exact rasterization on a cylindrical mesh.** Every region today is a coordinate box in (r, θ, z), so
   the volume fraction is a product of three closed-form 1-D overlaps. That is why the 370 mm preset's
   rasterization error is rounding and not tenths of a percent, and why `rasterizationCheck()` is a real
   audit of the discretizer. A general shape language must not silently throw this away.
2. **Interface snapping.** `axialGrading()` feeds the z interfaces to `gradedAxis()` as hard points, so a
   3 mm gap is bounded by mesh faces rather than smeared. New geometry must *supply* hard points, not
   bypass them.
3. **Closed-form volumes as an independent check.** `regionVolume()` computes each region's volume without
   reference to the mesh, and `massBreakdown()` and `rasterizationCheck()` compare against it. Any new
   primitive owes an exact — or provably tight — volume.

## The shape of the answer

Introduce an intermediate representation (IR) between "what the user asked for" and "what the rasterizer
sees", and make today's machine a *generator* that emits it.

```
  spec.parameters     ->  expression scope (named, resolvable, optimizable)
  spec.geometry       ->  IR: solids[], each a profile x an extrusion, with repeats and booleans
  spec.windings       ->  IR: coils[], each a traced outline x an offset rule x layers
        |                        |
        |                        +--> segments (Biot-Savart)  +--> DRC  +--> copper SVG
        +--> rasterizer (exact where the profile is a coordinate sector, sampled otherwise)
        +--> mesher    (hard points and size constraints read off the IR, not off parameter names)
        +--> triangulator (render + STL + OBJ)
        +--> closed-form volume / mass
```

Nothing downstream asks "is this the yoke?" again. It asks the IR for its z-stations, its radial extent,
its material, its motion group.

### 1. Parameters and expressions

The single highest-leverage piece, and the cheapest.

```json
"parameters": { "ri": 15, "ro": 40, "gap": 3, "poles": 8, "poleArc": 0.62, "taper": 0.8 }
```

Any numeric field anywhere in the geometry may be a string expression over that scope plus derived
landmarks the generator publishes (`polePitch`, `zGapTop`, `zYokeTop`, `boardTop`, …):

```json
{ "r0": "ri + 2", "r1": "ro - 1", "to": "polePitch * poleArc / 2", "scale": "taper" }
```

A **small hand-written evaluator** — numbers, identifiers, `+ - * / %`, parentheses, unary minus, and a
fixed function table (`min max abs sqrt sin cos tan atan2 deg rad floor ceil round hypot pi`). No `eval`,
no `Function`. Dependency graph resolved once with cycle detection; unknown identifiers are an error that
names the identifier and lists what *is* in scope.

Why it matters beyond convenience: **this is the optimizer's variable space, for free.** A design variable
is a parameter name with bounds. Change `ro` and every dependent coordinate moves consistently — which is
precisely what today's hard-coded geometry gives us and what a coordinate-list geometry would lose.

### 2. Profiles — the traced 2-D outline

A profile is a closed curve in the (x, y) plane, authored in a polar-friendly vocabulary because axial-flux
geometry is polar:

| Primitive | Meaning |
|---|---|
| `{"annulus": {"r0", "r1"}}` | full ring |
| `{"sector": {"r0", "r1", "from", "to"}}` | annular sector — today's regions |
| `{"circle": {"at": [r, theta], "radius"}}` | lightening holes, vias, bolt circles |
| `{"polygon": {"points": [[x,y], …]}}` | escape hatch |
| `{"path": [ …segments… ]}` | the general case |

Path segments, all closed implicitly and checked for closure:

```json
{"arc":    {"r": "ro-1", "from": "-half", "to": "half"}}     // constant radius
{"radial": {"theta": "half", "from": "ro-1", "to": "ri+1"}}  // constant angle
{"line":   {"to": ["x","y"]}}                                // straight in xy
{"spline": {"through": [[r, th], …], "tension": 0.5}}        // Catmull-Rom, polar control points
{"fillet": {"radius": 1.5}}                                  // applies to the joint just formed
```

Modifiers on a profile: `mirror` (about a radial line), `offset` (grow/shrink by a distance),
`round` (fillet every convex corner), `repeat` (n copies about the axis).

**The exactness gate.** A profile whose segments are only `arc` and `radial`, with no fillets, is a
*coordinate sector*: the rasterizer keeps the closed-form product path, byte-identical to today. Anything
else falls back to angular supersampling — still exact in r and z, since those remain coordinate
intervals, and sampled only in θ. `plan()` reports, per solid, which path it took and the resulting
volume error against the closed form. The message when a shape drops off the exact path is a *note, not a
warning*: it is a legitimate trade, the author just deserves to know they made it.

### 3. Solids — the third dimension

```json
{ "id": "pole", "material": "smc", "group": "rotorTop",
  "profile": {...},
  "extrude": { "from": "zGapTop", "to": "zYokeBottom",
               "stations": [ {"at": 0, "scale": 1.0, "twist": 0},
                             {"at": 1, "scale": 0.8, "twist": "rad(4)"} ] },
  "repeat":  { "count": "poles", "phase": "theta" },
  "subtract": [ {"profile": {...}, "extrude": {...}} ] }
```

`stations` covers taper, skew (twist is the existing `poleSkew_deg`, generalized), stepped poles (two
stations at the same `at`), and lofts. `subtract` covers lightening pockets, cooling channels, and the
window a core would later occupy. A solid carries `material` (a name into the material table —
which is where P3's B-H curves will land) and `group` (`rotorTop`, `rotorBottom`, `stator`), so torque
grouping and mass breakdown work unchanged.

**Overlap.** Today's rasterizer relies on regions never overlapping in z and simply sums volume fractions.
General solids can overlap. Fix: solids carry an implicit priority (list order); the rasterizer accumulates
fractions with a running clamp, and reports any cell where the raw sum exceeded 1 + 1e-6. An overlap is
almost always an authoring bug, and it must be loud, because the series blend
`1/mu = (1-f) + sum f_m/mu_m` quietly produces a plausible wrong answer otherwise.

### 4. Windings — traced coils and nested turns

```json
"windings": {
  "coils": [ { "id": "A1", "phase": 0, "sense": 1,
               "outline": {"path": [...]},          // the apostrophe
               "turns": 10,
               "nest": { "pitch": "tracePitch", "start": "edgeMargin", "join": "miter" },
               "layers": [0, 1, 2, 3] } ],
  "repeat": { "count": 12, "phase": 0 },
  "keepOut": [ {"circle": {...}} ]
}
```

The turn generator is the one genuinely hard algorithm in this plan: **inward offsetting of an arbitrary
closed outline**, repeated `turns` times. Today it is analytic (shrink `ri`, grow `ro`, shrink the
half-angle by `d/r`). In general:

- Primary: per-edge offset with miter/bevel joins, then a self-intersection sweep that removes the
  degenerate loops an offset creates at concave corners. Standard, fast, adequate for the shapes a motor
  coil actually has.
- Fallback for pathological outlines: sample a signed-distance field on a fine polar grid and march the
  `d = k·pitch` contours. Slower, robust, and it degrades to "this turn vanished" honestly.
- **Regression contract:** for the trapezoid outline the generator must reproduce today's `coilPolys()`
  vertices to 1e-9 and the resulting torque bit-for-bit. That is what proves the general path is not a
  different physics.

Other pieces: per-coil `layers` (today all coils live on every layer); a chord-tolerance tessellation with
a **segment budget**, because Biot-Savart cost is linear in segment count and a careless spline can cost
more than the mesh; `keepOut` profiles that the validator tests every turn against; and optional
`terminal`/`via` annotations that affect the copper SVG and the resistance estimate but not the field.

Anti-periodicity: `angularPeriod()` currently infers symmetry from `poles` and the coil pattern. With
general geometry it must be *declared* (via `repeat.count`) and then **verified numerically** — sample
every solid and coil, rotate by 2π/s, confirm the set maps onto itself within tolerance. Declared-then-
verified, never inferred, because a wrong sector count is a silently wrong machine.

### 5. Deferred: cores in the coil window

Not built. Recorded so the language is not designed in a way that forecloses it.

A nested coil rarely fills its own window. That window is a natural place for a stator core: a slug of the
back plate's own steel, extruded up off the plate, through a hole in the board, into the middle of the
coil. It is the step from a coreless machine toward a slotted one, and it is **magnetically significant** —
unlike a plain clearance hole, which changes nothing at all, because the board is non-magnetic and is not
even a region in the solve today.

What it would need, none of which is special-case work:

- a solid whose profile is derived from a coil outline — the window is `outline` offset inward by
  `turns * pitch`, which the offsetting machinery in G2 computes as a by-product;
- axial grading across a solid that spans the board plane, which means the mesher takes its hard points
  from the IR rather than from a fixed landmark list — already required by G0;
- the flux concentration showing up honestly in the gap-flux metric and in the mu-cap diagnostics, since a
  slug is exactly where a reduced-scalar-potential formulation will feel its ceiling.

So it is a later assembly of parts G0–G2 build anyway, and it is off the critical path.


### 6. What the agent gets

The language is only half of it. An LLM authoring geometry needs a loop that is fast, blind-friendly, and
diagnostic. Concretely, added to `window.AFS` and to `cli/run.js`:

| Call | Returns | Why an agent needs it |
|---|---|---|
| `AFS.schema()` | JSON Schema of the geometry language, with per-field docs and worked examples | One document to condition on; no guessing field names |
| `AFS.validate(spec)` | structured errors: JSON path, what is wrong, what would fix it | Fix loops without a human |
| `AFS.preview(spec)` | SVG of the copper layout, r–θ and r–z slices, per-solid volume/mass, mesh plan, DRC report — **no GPU, no solve** | The fast loop. Milliseconds, and the SVG is text the model can read |
| `AFS.plan(spec)` (extended) | + per-solid exact/sampled flag, rasterization error estimate, symmetry verification | Know the cost and the fidelity before spending a solve |
| `AFS.check(spec)` | manufacturability verdict against the PCB and print rule sets | The constraint the optimizer is gated on |

Plus `docs/agent-guide.md`: a single self-contained reference written *for a model* — the grammar, the
landmark names, five worked examples building up from today's default machine to an apostrophe-coil YASA
stator over a tapered, twisted, pocketed printed rotor, and a list of the mistakes the validator most often reports. The defaults ship as
examples in that document, which is what the user asked for and also the best regression suite we have.

### 7. Manufacturability as a first-class object

The success criterion names the constraints, so they belong in the spec rather than in our heads:

```json
"manufacturing": {
  "pcb":   { "minTrace_mm": 0.15, "minClearance_mm": 0.15, "minAnnularRing_mm": 0.15,
             "copperLayers": 4, "copperThickness_um": 35 },
  "print": { "minWall_mm": 1.2, "minFeature_mm": 0.8, "maxOverhang_deg": 45, "nozzle_mm": 0.4 }
}
```

The checker reports violations with the offending coordinate. The optimizer treats a violation as
infeasible rather than penalized-but-allowed, so it cannot converge to a design that cannot be built —
which is the failure mode this whole exercise exists to avoid.

Overhang checking on a swept solid is the only non-obvious one: for each pair of adjacent z-stations,
the maximum lateral profile displacement over the height difference gives the local overhang angle
directly, which is enough for the shapes this language can express.

---

## Phases

Each phase ends green — all five suites pass, presets reproduce — so the tool is never half-converted.

### G0 — IR and the port (no behaviour change)

- `src/core/expr.js`: the safe expression evaluator + scope resolution + cycle detection.
- `src/core/ir.js`: solid/profile/extrusion/coil types, normalization, and the exactness classifier.
- `src/core/generators.js`: today's machine as a generator emitting IR from the v2 `design.*` fields.
- Rewrite `rasterizeCylindrical` / `rasterizeCartesian` against the IR, with the dual exact/sampled path,
  overlap clamping, and per-solid provenance.
- Mesher reads hard points and size constraints **off the IR**.
- Spec v3: `parameters` / `geometry` / `windings` / `manufacturing`, with v2 → v3 migration that simply
  records "generated by the classic generator".

**Exit:** `tests/compare-reference.js` matches at 1e-9 on all 8 designs; all presets reproduce torque
bit-for-bit; per-solid rasterization error unchanged.

### G1 — Profiles, paths, solids

Path segments, fillets, splines, mirror/offset/repeat, `subtract`, z-stations. Triangulator (ear clipping
with hole bridging) so render and STL/OBJ follow arbitrary shapes — `meshes.js::rotorSolid` becomes one
case of the general path. Minimal `preview()` (we need it ourselves before G2).

**Exit:** two things. A shape expressed two ways — as a `sector` and as an equivalent `path` — meshes to
the same volume and solves to the same torque within the sampled-rasterization error bar, and that bar is
reported. And a printed rotor that today's code cannot express — tapered poles, a twist, and lightening
pockets — meshes, solves, exports a watertight STL whose volume matches the closed form, and passes the
overhang check.

### G2 — Traced coils

Outline tracing, general inward offsetting with the self-intersection sweep, SDF fallback, per-coil layers,
keep-outs, chord tolerance and segment budget, declared-and-verified symmetry.

**Exit:** the trapezoid outline reproduces `coilPolys()` to 1e-9; an apostrophe-coil stator solves, and its
copper SVG, mass, resistance and field are mutually consistent.

### G3 — The agent surface

`schema()`, structured `validate()`, full `preview()`, extended `plan()`, `check()`, CLI subcommands,
`docs/agent-guide.md`, and a deliberate pass over error-message wording. Then the honest test: hand the
guide to a fresh model, ask for three named machines, and count how many attempts each takes. That number
goes in the doc.

### G4 — Optimize a real pair

Design variables from `parameters`, the manufacturability gate, and the headline run: an apostrophe-coil
PCB stator against a printed rotor, ≥ 6 variables, headless, with the best design reproducing when
re-solved from its own saved spec. Shares machinery with the existing P5 plan.

---

## Risks, stated plainly

- **Loss of exactness** is the real cost of generality. Mitigated by the dual path and by *reporting*
  rather than hiding which path each solid took. A traced pole edge is genuinely less accurate than an arc;
  the tool should say so rather than let the number look the same.
- **Offsetting arbitrary outlines** is where the bugs will be. Two independent implementations (edge offset
  and SDF contour) that must agree is the plan; disagreement is a test failure, not a fallback.
- **Segment-count blowup** in Biot-Savart. Budget, chord tolerance, and a plan() warning.
- **Triangulation with holes** for export. Boring and fiddly; the guard is that the STL must be watertight
  and its volume must match the closed-form volume.
- **Scope.** This is bigger than any phase so far, and it is orthogonal to P3 (nonlinear steel). P3 is a
  μ(|B|) loop around the linear solve and touches none of this; it can be built before, after, or beside
  it. Doing geometry first is the right call only because a nonlinear solve of a shape we cannot express
  is worth less than a linear solve of one we can.
