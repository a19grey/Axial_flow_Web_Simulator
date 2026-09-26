# Scoring, peak-finding and searching the design space

*Written 2026-09-25. Status: approved, not started. Objective and gates chosen 2026-09-25.*

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

Optimize in **ratios, not millimetres**. The spec grows a `parameters` block of named dimensionless design
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
Where a genuinely independent profile is wanted, the shape tables (`coilShape`, `poleShape`) are held to
**two or three control points** — width fraction and offset at the inner, middle and outer radius. Free-form
splines are not optimizable at this budget and are not manufacturable insight; more control points get added
only if the screen shows the profile matters *and* the optimum sits on a control point's bound.

### Staged search, cheapest stage first

1. **Screen (2N evaluations).** One-at-a-time perturbation of every candidate variable around the baseline.
   The output is not an optimum, it is a ranking of which variables move the score at all — and variables
   whose effect is under the noise floor are *dropped*, with the measurement recorded. This is the step that
   turns "the space is infinite" into a space of five to eight variables.
2. **Scan (~150 evaluations, screening tier).** Sobol or Latin hypercube over the survivors. Its job is the
   shape of the landscape — is it multimodal, where are the constraint walls — not the optimum.
3. **Refine (~200 evaluations, score tier).** Pattern search from the best few scan points, with the step
   floor set by the noise floor. Independent restarts from separate basins rather than one long run.
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
src/study/search.js           pattern search; differential evolution behind the same interface
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
| The cache is honest | same spec, same score, bit-for-bit |
| The screening mesh may be used for ranking | Spearman correlation against the fine mesh over ~20 designs |
| A known optimum is recovered | pole-arc-only optimization reproduces the optimum of a dense one-dimensional sweep |
| The optimizer's output is real | the winner reproduces from its own saved spec, and survives mesh refinement |
