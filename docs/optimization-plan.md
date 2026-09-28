# Scoring, peak-finding and searching the design space

*Written 2026-09-25. Status: approved, not started — except the shape parameterization, which is
landed as `src/core/curves.js`. Objective and gates chosen 2026-09-25; shape-vector ladder added
2026-09-27.*

## The problem, stated honestly

Three questions, in the order they have to be answered:

1. **What is a design's score?** A single solve returns a torque at whatever rotor angle and current phase
   the spec happened to name. That is not a property of the design — it is a property of the design *and* an
   arbitrary operating point. Scoring a design means first putting it at its own best operating point.
2. **How do we find that operating point cheaply?** Sweeping rotor angle × current angle is 24 × 12 solves
   per design, which makes any search over geometry unaffordable.
3. **How do we search a geometry space that is, honestly, infinite — and a rotor/stator *pairing* space that
   is its square?**

The second turns out to be much easier than it looks, and the answer to it reshapes the other two.

---

## 1. The operating point is not a search. It is arithmetic.

With linear materials the reduced-scalar-potential system

    div(mu grad phi) = div(mu Hs),     B = mu0 mu (Hs - grad phi)

is **linear in the source currents**, because mu does not depend on the field. So for a fixed rotor angle
theta, three solves at unit current in each phase give `B_1, B_2, B_3`, and the field at *any* current
vector is `B(I) = I_1 B_1 + I_2 B_2 + I_3 B_3` — exactly, not approximately.

Maxwell stress is quadratic in B, so torque is a quadratic form in the current vector:

    T(I) = I^T Q I,    Q_jk = (1/2) [ T(B_j + B_k) - T(B_j) - T(B_k) ]

and `Q` costs nothing extra: it is six evaluations of the *existing* stress integrator on already-solved
fields. No new GPU work, no new physics, no new integrator.

Now substitute the balanced three-phase current set the tool already uses,
`I_k = A cos(phi - 2 pi k / 3)` with `phi = (P/2) theta + gamma`. Every product `I_j I_k` contains only a
constant and a `2 phi` term, so

    T(gamma) = A^2 [ c0 + c1 sin(2 (gamma - gamma_0)) ]     exactly.

Three consequences, all of which we get for the price of three solves at one rotor angle:

- **The optimal current phase is closed form.** `gamma* = gamma_0 + 45 deg` (mod 90). No bracket, no
  parabola, no 5-degree tolerance — the *exact* peak of the exact curve. For the default machine this should
  land near the 45 deg the spec already defaults to, and the amount it does not is real saliency information.
- **The current amplitude is closed form too.** Torque scales as `A^2`. So "the best torque at a fixed copper
  loss budget" — which is the only fair way to compare designs, since raw torque is maximized by turning the
  current up — needs no extra solve: pick `A` to hit the loss budget and scale.
- **`gamma` stops being a design variable at all.** It comes out of the evaluation rather than going into it,
  which removes one dimension from every search below.

This also makes the inductance study nearly free alongside it: the three unit-current solves it needs are
the same three.

### Validity, and what happens when it ends

Superposition holds because mu is field-independent. It will stop holding the day P3 (nonlinear steel)
lands. So the evaluator **checks its own assumption every time**: after computing `gamma*` analytically, do
one confirming solve at `gamma*` and compare the measured torque to the predicted one. Agreement to a
fraction of a percent is the evidence the quadratic form is exact; disagreement is a loud failure, not a
silent wrong answer. That single check is also the regression test.

The fallback for the nonlinear case is the bracket-and-parabola search the request described: three solves
at `gamma in {30, 45, 60}` warm-started from the previous design's optimum, a parabola vertex, a step of the
bracket if the vertex falls outside it, and a stop when the bracket is under 10 deg — which delivers the
"within ~5 deg" the request asks for. It is written now and exercised against the exact answer, so that when
superposition dies we already know the fallback is right.

### Rotor angle: average, do not peak

Rotor angle is *not* symmetric with current phase. Moving the rotor changes the geometry, so nothing
superposes and each angle costs its own solves.

More importantly, **the peak over rotor angle is the wrong score.** At a fixed current phase the ideal
machine's torque is independent of rotor angle; all the variation that exists is ripple — cogging and MMF
harmonics. A motor running under load passes through every rotor angle, so what it delivers is the *mean*.
Scoring on the peak over theta would hand the highest score to the design with the worst ripple, which is
backwards. The score is the mean over one electrical period; peak, trough and ripple percentage are reported
beside it and are available as constraints.

The mean is cheap if we use the harmonic structure instead of brute force. For a three-phase machine the
torque waveform against theta is dominated by the 6th electrical harmonic. The mean of **three** samples
spaced evenly over one period of that harmonic — that is, `120/P` mechanical degrees apart — cancels the 6th
and the 12th exactly and aliases only the 18th, which is typically well under half a percent. Three samples,
not twenty-four, and the error is bounded by something we can measure once and then trust.

### The evaluation ladder

| Tier | Solves | What it gives | Used by |
|---|---|---|---|
| **screen** | 3 (one theta, three phases) | exact `gamma*`, torque at that theta, `Ld/Lq` | global scan |
| **score** | 9 (three theta, three phases) + 1 confirm | mean torque, ripple, `gamma*` for the mean, shear stress | ranking and local search |
| **confirm** | 24-point angle sweep + virtual work + mesh convergence | the defensible number, with an error bar | the final few designs only |

Every tier shares **one Biot-Savart pass**: the winding does not move when the rotor turns or the currents
change, so `job.segKey` is unchanged and the cached source field is reused across all nine solves. That is
already how `sweep()` behaves; the evaluator keeps it.

Warm-starting `phi` from the previous solve in the ladder is the obvious further win and is still unbuilt
(`SH.init` zeroes `x`). It is worth doing here rather than as a generic feature, because this is the
workload that re-solves nearly identical systems nine times in a row.

---

## 2. The score

The objective is an expression over the results JSON — `src/core/expr.js` already parses and evaluates
exactly this — so nothing below is hard-coded. What matters is choosing the default well, because the
default is what the search will actually chase.

**Primary objective (chosen): mean air-gap shear stress at a fixed copper-loss budget.**

- *Shear stress* rather than torque, for the reason it was added last week: torque gets a free win from a
  larger rotor, and we want to know whether the machine is good, not whether it is big.
- *At a fixed loss budget* rather than at fixed current, because torque is quadratic in current and any
  objective that does not fix the thermal input is really an objective about how much current you were
  willing to type in. The budget is imposed analytically — solve at unit current, scale by the amplitude
  that hits the budget — so it costs nothing.
- *The budget defaults to the baseline design's own copper loss*, not to a number someone picked. That
  leaves the starting design scored exactly as it is today, and makes every variant a statement about
  equal heat rather than about equal amps. An explicit watt figure overrides it.
- *Mean* over the ripple period, per the argument above.

**Gates — a design that fails one is not scored, rather than scored badly:**

| Gate | Why |
|---|---|
| no `error`-level quality flag | an unresolved gap or a missing stress surface is not a low score, it is not a measurement |
| `torqueSurfaceSpread_pct` over threshold | the design's own numerical error bar says the number is not worth ranking |
| manufacturability | trace width and pitch from the PCB process class, minimum printed feature for the rotor, coils that clear each other at every radius (already checked) |

**Reported beside the score, and available as optional constraints, but not gates by default:**
`ripple_pct` and `peakBInMagneticParts_mT`. Ripple is a real trade rather than a disqualification, and a
threshold on it is most useful *swept* — that sweep is what draws the Pareto front. The saturation ceiling
is left off because linear mu_r is the current model's honest boundary either way and clamping it silently
would hide that; it is flagged in the report and becomes a gate when P3 lands.

Weighted-sum scalarizations hide exactly the trade-offs one wants to see. Everything that is not the primary
objective is a constraint, and the sweep over a constraint's threshold is what produces the Pareto picture.

### Before any of this is trusted: the noise floor

An optimizer will happily chase a 0.3 % difference that is really the mesh. So the first deliverable of this
phase is not an optimizer, it is a **measured noise floor**:

1. Re-evaluate the same spec repeatedly — the result must be bit-identical, which is what makes the
   evaluation cache honest.
2. Evaluate a handful of designs at three mesh refinements and record how much the score moves. Any score
   difference below that is not a difference, and the search's convergence tolerance is set from it, not
   guessed.
3. Establish that the cheap screening mesh **ranks** designs the same way the fine mesh does — Spearman
   correlation over ~20 sampled designs. Multi-fidelity screening is only legitimate if that number is high,
   and if it is not, we find out now rather than after a thousand wasted evaluations.

This also decides the search algorithm. At a ~0.5 % noise floor, finite-difference gradients are noise
amplifiers, so the local search is derivative-free (pattern search) by measurement rather than by taste.

---

## 3. Searching the geometry

### Change the parameterization first

Two changes, and they are different in kind. The first is hygiene: optimize in **ratios, not
millimetres**. The second is the interesting one: the *shape* is a design vector too, and it is a vector
whose length we choose.

#### Ratios, not millimetres The spec grows a `parameters` block of named dimensionless design
variables, and geometry fields become expressions over it — machinery `expr.js` already provides and the
geometry plan already anticipates. Examples: `ri/ro`, `gap/ro`, `poleHeight/gap`, pole arc as a fraction of
pole pitch, skew in units of pole pitch, coil span as a fraction of coil pitch.

This is not tidying. It does three things:

- It makes the search space size-free, which matches a size-free objective and makes a result transferable
  to any diameter rather than true only at 80 mm.
- It removes most of the coupling between variables — millimetre thicknesses all move together when the
  diameter changes, ratios do not — and an uncoupled space is enormously easier to search.
- It makes the bounds meaningful. `0.3 < ri/ro < 0.75` is a statement about machines. `15 < ri < 40` is a
  statement about one machine.

#### The shape is a vector, and refinement is a ladder

The scalar ratios above describe a machine whose pole is still a wedge and whose coil is still a
trapezoid. That is not the machine we are trying to find. The rotor is *printed*, so its pole can be a
shape no arc can draw, and the point of the tool is to be able to look for those shapes — not because a
comma-shaped pole is going to add twenty percent (it will not), but because the simulator's job is to make
the whole space reachable, and a shape space we cannot search is a shape space we do not really have.

So: the coil footprint and the rotor pole footprint are each a **closed control-point curve** — ten to
thirty points — and the pole's sweep from gap face to yoke is a small Bezier per channel (`scale`,
`widen`, `twist`, `shift`). `src/core/curves.js` is landed and tested; `docs/geometry-plan.md` §2b is the
reasoning. Three properties of that parameterization are what make the resulting thirty-to-sixty
dimensional space tractable rather than decorative:

- **Every variable lives in the same box**, because control points are in normalized wedge coordinates:
  `u ∈ [0,1]` across the feature's annulus, `v ∈ [-0.5, 0.5]` in units of its pitch. A design inside the
  box stays in its annulus and cannot collide with its neighbour.
- **The box is not enough on its own, and the measurement says so.** Eight points drawn uniformly and
  taken in the order they were drawn produce a simple outline only **6 %** of the time — the rest are bow
  ties. A rejection loop at that rate would eat the whole budget. So the low rungs draw the footprint as
  *two radially monotone chains* with non-overlapping angular ranges — trailing edge at `v ≤ 0`, leading
  edge at `v ≥ 0` — which cannot cross: **100 %** simple over the same 4000 draws, at a mean area
  fraction of 0.36. That layout is also precisely the generalization of today's width/offset profile, so
  the machine we already have sits inside it. Higher rungs leave the layout behind via `refine()` and are
  legal by *locality* instead — the search is perturbing a shape already known to be simple — with
  `inspectCurve` gating regardless. Both rates are asserted in `tests/geometry.js`.
- **Local support.** A closed cubic B-spline control point touches four spans, so a sensitivity screen on
  control point 7 measures something local and repeatable. On a degree-14 Bezier it would not.
- **Refinement is exact**, and this is the one that actually beats the dimension count. `refine()` doubles
  the control points and returns the *same curve* to the last bit. So the search runs as a **ladder**:

  | Rung | Footprint | Dimension (two footprints + loft) | Algorithm |
  |---|---|---|---|
  | 1 | 4 points, radii pinned | ~8 + 4 scalars | pattern search |
  | 2 | 8 points, radii pinned | ~16 + 4 | pattern search / CMA-ES |
  | 3 | 8 points, radii free | ~32 + 6 | CMA-ES |
  | 4 | 16 points, radii free | ~64 + 6 | CMA-ES, short, from rung 3 |

  Each rung *starts exactly where the previous one finished* — not near it, at it — because the coarse
  optimum is a member of the finer space rather than an approximation to one. Each rung therefore only has
  to buy the improvement its extra freedom is worth, and a rung that buys nothing measurable is where we
  stop and say so. `curveToVector` / `curveFromVector` / `curveBounds` are the interface; `fixU` is what
  pins the radii on the lower rungs and halves the dimension.

Pattern search dies above roughly ten dimensions — its cost per improvement is linear in the dimension and
it has no way to learn that the shape's variables are correlated, which they overwhelmingly are.
**CMA-ES** is the algorithm for rungs 3 and 4: derivative-free, invariant to rotations of the space (so a
correlated shape basis costs it nothing), and it adapts its own step length, which matters because the
noise floor sets a hard lower bound on a useful step. It goes behind the same interface as pattern search,
so which one wins is measured on this problem rather than asserted from the literature.

Two things stay honest about the cost. A spline footprint is **not** a coordinate sector, so it rasterizes
on the sampled path rather than the exact one: `plan()` reports the per-solid volume error and the score
carries it. And a careless spline costs Biot-Savart segments, which is linear in wall time, so the
tessellation runs to a chord tolerance under a budget and hitting the budget is reported rather than
quietly coarsened.

### Do not treat manufacturing variables as continuous

The constraint pair is *PCB stator, printed rotor*, and it partitions the variables:

- **Discrete, from a catalogue**: copper layer count (2/4/6/8), copper weight, trace width and pitch from the
  fab's process class. These are enumerated in an outer loop, not optimized continuously and rounded after.
- **Continuous but floored**: printed pole height, yoke thickness, pole arc — bounded below by the nozzle,
  and by what iron-filled filament can actually hold.
- **Fixed by the build**: outer radius, mu_r of the printed material, minimum air gap from runout and
  tolerance stack.

Optimizing a trace width of 0.237 mm and then rounding it to the process minimum is a waste of the search.

### The pairing problem

The rotor/stator pair is not a product space if it is parameterized relationally. What the physics cares
about is *alignment*: pole arc against coil span, relative skew, radial overlap. So the pair is described by
a handful of **relative** variables rather than two independent profiles, and the cross product collapses.
Relative variables are how the *pair* is described; the control-point curves above are how each half is
described. Both are needed — the alignment variables are what the physics is most sensitive to, and the
footprints are where the manufacturing freedom lives. The ladder is what keeps the combination affordable:
alignment and the scalar ratios are screened on rung 1, where each footprint is four points and the whole
vector is small enough for a one-at-a-time screen to mean something.

### Staged search, cheapest stage first

1. **Screen (2N evaluations).** One-at-a-time perturbation of every candidate variable around the baseline.
   The output is not an optimum, it is a ranking of which variables move the score at all — and variables
   whose effect is under the noise floor are *dropped*, with the measurement recorded. This is the step that
   turns "the space is infinite" into a space of five to eight variables.
2. **Scan (~150 evaluations, screening tier).** Sobol or Latin hypercube over the survivors. Its job is the
   shape of the landscape — is it multimodal, where are the constraint walls — not the optimum.
3. **Refine (~200 evaluations per rung, score tier).** Pattern search on the low rungs, CMA-ES on the high
   ones, from the best few scan points, with the step floor set by the noise floor. Independent restarts
   from separate basins rather than one long run. Then climb the ladder: refine the footprints, restart
   from the exact same design in the larger space, and record what each rung bought. A rung whose
   improvement is inside the noise floor is where the parameterization stops being worth refining, and
   that measurement is a result worth publishing in its own right.
4. **Confirm (~5 designs, confirm tier).** Fine mesh, full angle sweep, virtual-work torque as an
   independent method, and a mesh-convergence study on the winner. A design that does not survive
   refinement was never a design. The winner must also **reproduce when re-solved from its own saved spec**,
   which is the geometry plan's G4 exit criterion.

At the measured ~0.3 s per solve on the cylindrical sector mesh, the screening tier is roughly a second per
design and the scoring tier three to four, so the whole ladder above is tens of minutes headless — worth
measuring rather than assuming, which is step 0 below.

---

## Deliverables

```
src/study/operatingPoint.js   quadratic-form evaluator: gamma* closed form, mean-over-theta, confirm solve,
                              nonlinear bracket/parabola fallback
src/study/objectives.js       score and constraint expressions over the results JSON, gates, loss-budget scaling
src/study/design.js           design-variable declarations: path, bounds, scale, discrete set, derived expressions
src/study/sample.js           Sobol / LHS
src/study/search.js           pattern search, CMA-ES and differential evolution behind one interface
src/study/shape.js            footprints and lofts as design vectors over curves.js: pack, unpack, bounds,
                              and the ladder step that re-enters a larger space at the same design
src/study/cache.js            specHash-keyed evaluation cache, JSONL, resumable
cli/run.js                    screen | scan | optimize | confirm, streaming JSONL, resumable
docs/optimization.md          regenerated from the run reports, so published numbers cannot drift
```

Order of work: **A** operating-point evaluator and its tests → **B** score, noise floor and screening-mesh
rank correlation → **C** design variables and the sensitivity screen → **D** scan and refine → **E** confirm
and report.

## How this gets validated

| Claim | Test |
|---|---|
| Torque is a quadratic form in the currents | predicted torque at `gamma*` matches a direct solve at `gamma*` to well under a percent |
| `gamma*` is the true optimum | a dense 24-point `gamma` sweep on three different designs peaks within the tolerance of the closed-form value |
| The bracket-and-parabola fallback works | within 5 deg and 1 % of the dense sweep's peak, on the same three designs — the request's tolerance, as an assertion |
| Three rotor angles give the mean | against a 24-point angle sweep, on three designs |
| Refining the shape does not change the design | a refined footprint evaluates to the same score, and its curve matches the coarse one pointwise to 1e-14 — asserted in `tests/geometry.js` today, and end-to-end through a solve once the rasterizer reads curves |
| The shape box is feasible by construction | the fraction of uniform draws from the normalized box that pass the validity and manufacturability gates, measured and reported; if it is not high, the parameterization is wrong, not the sampler |
| A rung of the ladder bought something | each rung's improvement reported against the noise floor, so "more control points did not help" is a measurement rather than a shrug |
| The cache is honest | same spec, same score, bit-for-bit |
| The screening mesh may be used for ranking | Spearman correlation against the fine mesh over ~20 designs |
| A known optimum is recovered | pole-arc-only optimization reproduces the optimum of a dense one-dimensional sweep |
| The optimizer's output is real | the winner reproduces from its own saved spec, and survives mesh refinement |
