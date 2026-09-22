# Axial-Flux Web Simulator

A client-side 3D magnetostatic field solver and design test bed for axial-flux machines. It computes
the field, torque and gap flux on the GPU, renders the machine and its field in 3D, and saves designs
as project files.

Everything runs in the browser from static files. There is no server, no build step and no bundler.
The same modules also run headless, so a script or an agent can drive the solver and read JSON back.

## Quick start

Everything runs from the repository root, `axialflow/`.

```sh
cd axialflow
npm run setup          # once: npm install + Playwright's chromium
npm start              # http://localhost:8080
npm test               # all four suites
```

```
axialflow/
  index.html      the tool
  headless.html   the same solver with no interface, exposing window.AFS
  cli/run.js      a Playwright driver for the headless page
```

## Running it locally

**Open the tool:**

    npm start              # http://localhost:8080
    npm start -- --open    # ...and open the browser for you
    npm start -- --port 9000

`localhost` is a secure context, which is all WebGPU needs. Nothing is compiled or bundled: edit a
file under `src/`, reload the page, and the change is live (the dev server sends `no-store`). Use a
recent Chrome or Edge, or Safari 26+.

The page solves its default design as soon as it loads, so it opens on a field and a torque rather
than on an empty view; Stop interrupts it like any other solve, and `index.html?autosolve=0` turns
it off for a driver that wants to set the design up first. **Sweep current angle γ** walks γ from 0
to 180° in 15° steps, fits sin 2γ, and then solves once more at the peak that fit predicts — which
is usually between two sampled angles — leaving the page showing the machine at its best current
angle and the form set to it.

**Run the tests:**

    npm test               # every suite, ~55 s
    npm run test:quick     # analytic + closed forms + UI, ~20 s — the one to use while editing
    npm run test:ui
    npm run test:convergence
    npm run test:metrics
    npm run test:geometry

Three suites need a real GPU and are local-only. CI runs `analytic`, `geometry` and the closed-form
half of `metrics` (both need no GPU at all), and `ui` on SwiftShader's
software adapter, where the UI suite shrinks every mesh and visibly skips the assertions that depend
on resolution. See `docs/numerics.md` for what runs where and why.

**Drive it headlessly:**

    npm run capabilities
    npm run plan -- src/cases/scale-370mm.json     # cells, memory, gap resolution — no solve
    npm run solve -- src/cases/scale-370mm.json
    npm run solve -- --set mesh.mode=graded --set design.rotor.airGap_mm=2
    npm run cli -- sweep --path operatingPoint.currentAngle_elecDeg --from 0 --to 180 --step 15
    npm run cli -- convergence src/cases/scale-370mm.json --factors 0.6,0.8,1,1.3
    npm run cli -- validate

    npm run cli -- virtualwork src/cases/scale-370mm.json   # torque again, a different way
    npm run cli -- inductance                               # L matrix, Ld/Lq, reciprocity
    npm run cli -- angle --count 24                         # ripple, harmonics, core loss
    npm run cli -- energy                                   # stored energy, two ways

The `--` is npm's separator: everything after it goes to the script. `npm run cli -- <command>`
reaches any subcommand; `node cli/run.js <command>` works identically if you prefer.

Progress goes to stderr and the JSON result to stdout, so results pipe cleanly. `--set <path>=<value>`
overrides any field of the spec and is repeatable. `-o out.json` also writes the result to a file.

The driver refuses to run on a software WebGPU adapter unless given `--allow-software`: SwiftShader
produces correct fields but meaningless timings, and headless Chrome will silently fall back to it.

**Hosting.** Copy the folder to any static host and open `index.html`. There is no build step, so
what you develop against is what ships.

## The spec

One versioned JSON object is the only input to a solve. Both the page and the CLI build one, so a
headless result and a result on screen come from the same code path rather than from two that agree.
Every numeric field carries its unit in its name.

```json
{
  "format": "axial-flux-project", "version": 2,
  "design": {
    "stator":    { "poles": 4, "copperLayers": 2, "innerRadius_mm": 15, "outerRadius_mm": 40,
                   "turnsPerLayer": 10, "peakCurrent_A": 5, "thickness_mm": 1.6,
                   "copperThickness_um": 35,
                   "coilCount": null, "phasePattern": null, "coilSense": null,
                   "coilSpanFraction": 1, "coilSkew_deg": 0, "coilShape": null },
    "rotor":     { "airGap_mm": 3, "mu_r": 20, "poleHeight_mm": 3,
                   "yokeThickness_mm": 4, "poleArcFraction": 0.5,
                   "dualSided": false, "poleSkew_deg": 0, "poleShape": null,
                   "density_kg_m3": 7650,
                   "coreLoss": { "specificLoss_W_per_kg": 4.0, "atFlux_T": 1.5,
                                 "atFrequency_Hz": 50, "fluxExponent": 2.0,
                                 "frequencyExponent": 1.6 } },
    "backPlate": { "enabled": true, "mu_r": 20, "thickness_mm": 4, "gapBelowPcb_mm": 1 }
  },
  "operatingPoint": { "rotorAngle_deg": 0, "currentAngle_elecDeg": 45,
                      "speed_rpm": 0, "windingTemperature_C": 20 },
  "mesh":   { "mode": "cylindrical",
              "activeCellsAcrossDiameter": 160, "cellsAcrossAirGap": 6,
              "cellsAcrossPoleHeight": 4, "cellsAcrossYoke": 3, "cellsAcrossPcb": 4,
              "cellsAcrossBackPlate": 3, "cellsAcrossBackGap": 2,
              "cellsAcrossPoleArc": 64, "sector": true,
              "growthRatio": 1.2, "farFieldCellFactor": 8, "maxCells": 40000000,
              "marginFactor": 0.4, "marginMin_mm": 12 },
  "solver": { "tolerance": 1e-5, "maxIterations": 4000, "checkInterval": 32, "stallPatience": 6 }
}
```

`null` means "use the default": the classical winding layout in the three `coil*` fields, and a
plain arc in `coilShape` and `poleShape` — see [shape profiles](#shape-profiles). Speed,
winding temperature, copper thickness and the densities never enter the field solve — they turn a
solved field into resistance, loss and mass.

Version 1 project files from the single-file tool load unchanged; the grid setting moves from
`solver.gridCellsAcrossDiameter` to `mesh.cellsAcrossDiameter` on the way in.

## `window.AFS`

Published by both pages. Every call takes plain JSON and returns plain JSON.

| Call | Returns |
|---|---|
| `AFS.capabilities()` | adapter name, device limits, whether the adapter is software |
| `AFS.plan(spec)` | mesh size, cell count, memory, cells across the gap — **without solving** |
| `AFS.solve(spec, opts)` | `{ok, value: {spec, specHash, results, warnings}}` |
| `AFS.sweep(spec, sweepSpec, opts)` | one entry per point |
| `AFS.validate(which, spec)` | the validation report, with pass/fail per case |
| `AFS.convergence(spec, opts)` | the same design at several refinements, with a fitted order and an error bar |
| `AFS.virtualWork(spec)` | torque from the co-energy derivative, next to the Maxwell-stress torque — 7 solves |
| `AFS.inductance(spec)` | the 3×3 inductance matrix, Ld and Lq, and the reciprocity check — 3 solves |
| `AFS.torqueVsAngle(spec, {count})` | one electrical period: mean torque, ripple, harmonics, core loss |
| `AFS.energyCheck(spec)` | stored energy from the field against stored energy from the inductance matrix |
| `AFS.defaultSpec()` / `AFS.normalizeSpec(s)` | build and check a spec |

`solve`, `sweep` and `validate` resolve to `{ok: true, value}` or `{ok: false, error}` rather than
rejecting, because a rejected promise does not survive an automation boundary intact.

Results are **not rounded**. A finite-difference gradient across a small design step needs every
digit the f32 solve produced; formatting is the interface's job.

## Model

The motor axis is **z**, the PCB mid-plane is **z = 0**, and all lengths are in millimetres.

| Part | Description |
|---|---|
| Stator PCB | 1.6 mm board carrying 2 or 4 copper layers, with 1.5·P concentrated coils. Each coil is concentric trapezoidal turns at 0.5 mm pitch with 0.34 mm traces. Coil *k* belongs to phase *k* mod 3. The board is non-magnetic. |
| Rotor | A yoke ring with P salient poles on its underside, facing the PCB across the air gap. Uniform relative permeability μᵣ. Poles can be skewed linearly with radius, or given a free footprint with a [shape profile](#shape-profiles). |
| Second rotor | Optional mirror image below the board — the dual-sided topology. Both rotors are on one shaft, so their torques add, and the opposite rotor replaces the back plate as the flux return. |
| Back plate | Optional ring below the PCB, with its own μᵣ, closing the flux path. Ignored on a dual-sided machine. |

Every magnetic part is described as an **annular sector extrusion** — a radial interval, an axial
interval, and either a full annulus or a regular pattern of arcs — held in a list rather than as
branches in the rasterizer. A second rotor is two more entries in that list, and the mass
calculation evaluates exactly the same geometry the solve discretized.

The winding layout is data too. The default is the classical arrangement — 1.5·P concentrated
coils, phase *k* mod 3, all wound the same way round — but `coilCount`, `phasePattern` and
`coilSense` describe any other single-layer layout, and the angular period is then *derived* from
the pattern rather than assumed. A winding that alternates the sense of same-phase coils has no
plain period and correctly reports one sector, i.e. the full turn.

### Shape profiles

A width fraction and a skew angle can only draw a straight-sided trapezoid. The shapes an
axial-flux machine actually uses are not that, so any repeated wedge — a rotor pole, a coil — can
instead carry a **profile**: a small table read against normalized radius, 0 at the inner radius
and 1 at the outer.

```json
"poleShape": [
  { "atRadius": 0.0, "widthFraction": 0.26, "offset_deg": 18 },
  { "atRadius": 0.35, "widthFraction": 0.50, "offset_deg": 11 },
  { "atRadius": 0.7,  "widthFraction": 0.72, "offset_deg": 3 },
  { "atRadius": 1.0,  "widthFraction": 0.80, "offset_deg": -4 }
]
```

`widthFraction` is the fraction of the feature's pitch the wedge occupies there, so 1.0 means
neighbours touch; `offset_deg` swings its centre line. Rows are interpolated linearly and the ends
are held flat, so two rows are a trapezoid and one row is a plain arc — which is exactly what
`poleArcFraction` and `poleSkew_deg` describe, and unprofiled designs produce bit-for-bit the
current paths and material fractions they always did.

Two things this buys, both in `src/cases/yasa-shapes-demo.json`:

- **YASA-style coils.** A coil whose centre line swings further across its radial span than one
  coil pitch: a straight radial line leaves one coil and enters its neighbour part way out, rather
  than crossing a clean gap. The coils still clear each other *at every radius* — overlap along a
  radius is the point, overlap at a radius would be a short, and `shapeClearance` distinguishes
  them.
- **Comma-shaped poles.** A narrow tail at the bore swung ahead of a broad head at the rim: a
  footprint a 3D-printed rotor can have and a laminated one cannot.

The area a profile sweeps is available in closed form, so the volume a region *should* occupy is
compared against the volume the rasterizer laid down — the check that a shape which draws
convincingly also solves as drawn. On a cylindrical mesh a profiled wedge is still rasterized
**exactly**: its edges stay coordinate surfaces in θ, and the radial variation inside a cell is
integrated rather than sampled, by cutting each cell at the profile's knots and at every radius
where an edge crosses the cell and applying Simpson's rule where the integrand is quadratic. The
audit agrees to 1e-12 %, the same as for a plain arc.

Phase currents for rotor angle θᵣ (mechanical) and current angle γ (electrical, from the rotor d-axis):

$$I_k = I\cos\!\left(\tfrac{P}{2}\theta_r + \gamma - k\cdot 120^\circ\right),\quad k = 0,1,2$$

## Physics

Magnetostatics: no eddy currents, no time dependence, linear materials.

$$\nabla\times\mathbf H = \mathbf J,\qquad \nabla\cdot\mathbf B = 0,\qquad \mathbf B = \mu_0\mu_r\mathbf H$$

Because every current flows in non-magnetic copper, the field splits into a known source part and a
magnetization response, which avoids a 3D vector potential.

**1. Source field (Biot-Savart).** Each trace is a chain of straight segments from **a** to **b**,
with **d** = **b** − **a**, **r₁** = **x** − **a**, **r₂** = **x** − **b**:

$$\mathbf H_s = \frac{I}{4\pi}\,\frac{\mathbf r_1\times\mathbf r_2}{|\mathbf r_1\times\mathbf r_2|^2 + \varepsilon^2|\mathbf d|^2}\left(\frac{\mathbf d\cdot\mathbf r_1}{|\mathbf r_1|} - \frac{\mathbf d\cdot\mathbf r_2}{|\mathbf r_2|}\right)$$

A core radius ε = max(0.25 mm, h/2) regularizes the singularity at the wire. The field is computed
once per phase at unit current and cached, so any set of currents is a linear combination of three,
and a sweep over current angle or rotor angle pays for it once.

**2. Material response (reduced scalar potential).** Write **H** = **H**ₛ − ∇φ. Since ∇·**H**ₛ = 0,
∇·**B** = 0 becomes

$$\nabla\cdot(\mu_r\nabla\varphi) = \nabla\cdot\big((\mu_r - 1)\,\mathbf H_s\big)$$

The right-hand side is non-zero only where permeability varies, so it acts as magnetic "charge" at
material boundaries. The outer box holds φ = 0, with a margin of max(12 mm, 0.4·Rₒ) around the machine.

**3. Torque (Maxwell stress).** Integrated over a closed box in air around the rotor:

$$T_{ij} = \frac{1}{\mu_0}\left(B_iB_j - \tfrac12\delta_{ij}B^2\right),\qquad \tau_z = \oint \big(\mathbf r\times(\mathsf T\cdot\hat{\mathbf n})\big)_z\,dA$$

On a cylindrical mesh this reduces to an annulus in the gap, the cylinder at the outer radius and
an annulus above the rotor, with only B_θB_z and B_θB_r surviving. On a Cartesian mesh it is a
six-faced box and the full tensor.

Either way the torque is averaged over **every mesh plane in the central 64% of the gap**, and the
spread across them is reported as the error bar.

One plane is not enough: refining only z, with the in-plane mesh fixed, moved a single-plane torque
by 2% as the plane hopped between mesh nodes, without the field meaningfully changing. Planes right
next to the copper or right under a pole face are worse still — they sit in the trace-by-trace
structure and the pole-edge singularity — which is why the extremes of the gap are excluded.

Mean gap B_z is interpolated to exactly mid-gap rather than sampled on the nearest cell layer. The
old definition moved 2.8% under z-refinement purely because the sampled layer moved; the new one
moves 0.65% and does not drift.

**4. Torque again, by virtual work.** The rate of change of magnetic co-energy with rotor position
at constant current, τ = ∂W′/∂θ|_I. A surface integral in the air gap against a volume integral over
the whole domain: they share the field and nothing else, which makes their agreement a far stronger
statement than two stress surfaces agreeing. On the 370 mm machine they are **0.09% apart**.

The co-energy is summed on *faces*, not at cell centres — see `docs/numerics.md` for why that is
the difference between a right answer and one that is off by a factor of a thousand.

**5. Flux linkage and inductance.** By reciprocity, λ_j = ∫ H_sj·**B** dV with H_sj the free-space
field of coil *j* alone. Applied to the material response only, since the surface term of that
identity lives at infinity, so L = L₀ + ΔL: the air-core half in closed form from Neumann's double
integral over the filaments, the material half from the solve. Ld and Lq follow from an
amplitude-invariant Park transform at the rotor's electrical angle.

This comes with a check that costs nothing: L_jk = L_kj is a theorem, so any asymmetry is pure
discretization error. It measures 0.003% on the 80 mm machine and falls fourth-order with angular
refinement. And L₀, being circulant for a symmetric three-phase winding, must have Ld = Lq exactly —
so all of a machine's saliency has to appear in the material half, and it does.

For an ideal synchronous reluctance machine τ ∝ (L_d − L_q)·I²·sin 2γ, so torque peaks near γ = 45°
and is zero at 0° and 90°. The γ sweep plots this directly.

## What a solve reports

Beyond the field, every solve carries winding resistance at the stated temperature, copper loss at
the stated current, the mass of each part, torque density, torque per amp and per √W, and the
volume the mesh gave each region against that region's exact volume. None of it costs another GPU
pass.

The characterizations that genuinely need more solves are separate calls, so their cost is visible:

| Call | Cost | Gives |
|---|---|---|
| `virtualWork` | 7 solves | torque by a second, independent method |
| `inductance` | 3 solves | L matrix, Ld/Lq, saliency, reciprocity error |
| `torqueVsAngle` | one per position | mean torque, ripple, harmonics, core loss |
| `energyCheck` | 4 solves | stored energy two ways |

Core loss needs the rotor frame, which a cylindrical mesh recovers exactly as an index shift and a
Cartesian mesh cannot. On a Cartesian mesh the tool reports core loss as unavailable, with the
reason, rather than returning a number it cannot justify.

## Meshing

Three modes. `uniform` is the original single-cell-size grid, kept for cross-checking. `graded`
sizes each Cartesian axis from the geometry. `cylindrical` meshes in (r, θ, z) — the coordinates the
machine is actually built in — and is the default: for the presets, for a fresh page, and for any
spec that does not name a mode. A version 1 project file still migrates to `uniform`, which is what
it was solved with.

### Why cylindrical

A uniform grid does not scale. A 370 mm machine with a 3 mm air gap needs ~1 mm cells for three
across the gap, in a box ~520 mm on a side: about 54 million cells, of which the great majority sit
in the bore, the box corners, or far field where nothing is happening. Six cells across the gap
would be 432 million.

Graded mode sizes each axis from the geometry instead:

1. A **size function** gives the target cell size at each point — the smallest constraint covering
   it, falling back to a far-field maximum.
2. **Gradient limiting** caps the ratio between neighbouring cells (default 1.2), so the mesh
   cannot jump from 0.4 mm to 8 mm in one step.
3. Nodes are placed at equal intervals of ∫dx/s(x), which follows the size function's shape while
   landing exactly on both ends of each interval.
4. **Material interfaces are hard points**, so every z boundary lands on a cell face. This matters
   as much as the grading: a partially filled cell has its permeability blended, so an air gap
   thinner than one cell simply averages away.

Cylindrical mode then goes further, because in (r, θ, z) the machine's geometry *is* the coordinate
system:

- The bore, the outer rim and the pole arcs are coordinate surfaces, so material fractions are
  computed in closed form instead of supersampled. A cell's filled fraction is the product of three
  exact one-dimensional overlaps — area-weighted in r, arc-weighted in θ, exact in z. No staircase
  anywhere.
- The far field costs almost nothing: cells grow with radius by themselves.
- θ is periodic, so **one pole pair stands in for the whole machine**. For an 8-pole machine that is
  a quarter of the cells. The full turn and the sector agree to 6 × 10⁻⁸ relative — it is an exact
  symmetry, not an approximation.
- Torque collapses to two terms. On a constant-z annulus the azimuthal traction is B_θB_z/μ₀ and on
  the outer cylinder it is B_θB_r/μ₀; the B² terms are isotropic and carry no moment about the axis.
  The Cartesian version needs six faces and the full tensor.

For the 370 mm case at the same six cells across the gap:

| Mesh | Cells | Memory | GPU time | Torque |
|---|---|---|---|---|
| Uniform | 54,080,000 | 5.8 GB | — | out of reach |
| Graded Cartesian | 2,709,504 | 289 MB | 1210 ms | 3.726 N·m |
| **Cylindrical, ¼ sector** | **622,080** | **66 MB** | **322 ms** | **3.765 N·m** |

Refined until settled, cylindrical extrapolates to 3.771 N·m and graded Cartesian to 3.777 N·m —
two coordinate systems, different staircasing, different stress surfaces, agreeing to 0.2%.

`AFS.plan(spec)` reports all of this — cell count, size range, aspect ratio, memory, cells across
the gap — without solving, and the page shows it live as the mesh controls are changed.

Accuracy per cell, on the 80 mm machine against a 15 M-cell Cartesian reference:

| Mesh | Cells | Cells in gap | Torque | Error |
|---|---|---|---|---|
| Uniform, 200 across the box | 3,440,000 | 5.3 | 0.10773 mN·m | 7.70% |
| Graded, 200 across the machine | 2,057,216 | 7.0 | 0.11573 mN·m | 0.84% |
| Cylindrical, refined | 1,314,048 | 10 | 0.11787 mN·m | 0.98% (the other way) |

The last row is the cross-check rather than a ranking: the two coordinate systems bracket the
answer from opposite sides, 1% apart, which is the strongest statement either can make about being
right. Refining either one alone cannot say that.

**Tuning a cylindrical mesh.** The knob that most often limits it is `cellsAcrossPoleArc`. Radial
and axial resolution look generous while the angular cells stay long and the pole edges smear —
`plan()` measures the arc length at the rim against the radial cell size and says so when they drift
apart. The default is 64 per pole pitch, chosen so that the default machine's angular cell is
comparable to its radial one rather than five times longer. The near-axis aspect ratio always reads
high; that is inherent to the coordinate system, the bore holds few cells and little field, and it
is not worth chasing.

## Numerics

- **Mesh.** An orthogonal tensor-product mesh: three independent lists of node coordinates. Face
  areas and neighbour distances factorize over the three axes in both coordinate systems, so the
  assembly, the solver kernels and the reconstruction are written once and a coordinate system is
  just a table of factors. A uniform grid is the evenly spaced Cartesian case.
- **Periodicity.** Axis 1 can wrap. The stencil resolves its own neighbour indices, so a sector mesh
  needs no ghost cells and no special boundary condition.
- **Materials.** Rotor and back plate are rasterized with 4×4 in-plane supersampling and exact
  z-overlap. A partially filled cell uses series blending, 1/μ = (1 − f) + f/μᵣ. Face permeability is
  the harmonic mean of the two neighbouring cells. Averaging μ arithmetically instead would make a
  partial cell behave as solid iron and silently shrink the gap.
- **Discretization.** Finite volume, 7-point stencil, one balance equation per cell:

  $$\sum_f \mu_f \frac{A_f}{d_f}(\varphi_c - \varphi_n) = -\sum_f (\mu_f - 1)A_f\,\mathbf H_{s,f}\cdot\hat{\mathbf n}_f$$

  with A_f the face area and d_f the centre-to-centre distance across it. Both sides are divided by
  a reference length, which leaves φ unchanged and keeps the coefficients near unity in f32; on a
  uniform mesh it cancels and these reduce exactly to the single-size form μ_f and (μ_f − 1)h.

- **Solver.** Jacobi-preconditioned conjugate gradients in f32 WGSL compute shaders. Dot products use
  workgroup reductions and the CG scalars stay on the GPU; only the residual is read back, once per
  check interval.
- **B reconstruction.** Face flux is B_f = μ₀μ_f(H_s,f − Δφ/d_f), exactly the flux the solver
  balanced. Cell values average the two faces per direction — the cell centre is midway between its
  own two faces whatever the grading — so normal B stays continuous across material edges.
- **Dispatch.** WebGPU caps workgroups per dimension at 65535, which at 64 threads runs out at
  4.2 M cells. Every cell-wide kernel dispatches a 2D grid and linearises the index itself. The
  device's `uncapturederror` events are latched and raised, because a rejected dispatch otherwise
  does nothing and the solve returns a confident field of zeros.

## Validation

`node cli/run.js validate`, or the buttons under **Validation tests**. Pass thresholds live in
`src/core/validate.js`, not in the interface, so a case cannot pass on the page and fail in CI.

| Case | Reference | Typical result |
|---|---|---|
| Circular loop, on-axis B_z | μ₀IR²/2(R² + z²)^{3/2} | 0.09% worst error over \|z\| ≤ 30 mm |
| Sphere in uniform field | B_in = 3μᵣ/(μᵣ + 2)·μ₀H₀ | 5.2% at μᵣ = 20, 32 cells across; converges with refinement |

The sphere test is deliberately harsh: the interior field amplifies an error in the demagnetizing
factor by roughly μᵣ/3, so a staircased sphere reads a few percent high.

The motor model carries three further sanity checks — torque is zero at γ = 0° and 90°, torque is
antisymmetric between 45° and 135°, and the two stress surfaces agree.

## Tests

    node tests/run-tests.js

| Suite | What it proves |
|---|---|
| `analytic` | the closed-form cases above |
| `reference` | *(needs a GPU)* every design matches the frozen pre-split single-file build to 1e-9 relative |
| `ui` | the real page: the solve it runs by itself on load, both validation buttons, project round-trip, v1 migration, model export, graded meshing, the current-angle sweep and its confirming solve at the fitted peak, view controls, and no console errors |
| `convergence` | *(needs a GPU)* the answer stops moving under refinement; grading beats uniform per cell; a periodic sector reproduces the full turn exactly; cylindrical and Cartesian agree on a converged answer; the 370 mm case runs; a 14 M-cell solve returns a real answer rather than zeros |
| `geometry` | *(no GPU)* the expression language: arithmetic and precedence against hand-computed values, a closed grammar that refuses assignment, member access and host objects, error messages that name the nearest identifier in scope and spell out a dependency cycle, scopes that resolve in any declaration order |
| `metrics` | *(GPU for half of it)* loop self-inductance against its closed form; cylindrical cell volumes tiling an annulus exactly; rasterized region volumes against exact ones; the winding period derived rather than assumed; the sin 2γ fit recovering a peak the sweep grid does not contain; Maxwell stress against virtual work; reciprocity of the inductance matrix and its convergence; stored energy two ways; the two rotors of a dual-sided machine; skew trading ripple for torque |

`tests/reference/axial-flux-3d-webgpu.html` is the original single-file build, kept so the
regression is reproducible indefinitely. `tests/compare-reference.js` drives it through its own
controls and compares against the same design solved through the module API.

## Visualization

The 3D view draws the machine from its analytic geometry — smooth meshes for the rotor, back plate
and PCB, and ribbon traces coloured by phase. The field appears three ways: a ray-marched volume
glow of |B| from a filtered `rgba16float` 3D texture; RK2 streamlines of **B** seeded in proportion
to gap flux; and slices through the gap plane or an axial section. A cutaway mode removes y < 0.

How many field lines are drawn is a control, from a quarter of the default count to six times it.
Where they are is still information — seeds are drawn in proportion to the local gap flux at any
setting — but a sparse field can look arbitrary, so the count is the reader's choice. Line tracing
runs on the solved field already on the page, so moving the control re-traces without re-solving,
and the seed and segment budgets it stops at are reported rather than hidden.

**Worked examples.** The Project panel loads the case files under `src/cases/` — the same files the
headless driver runs, not copies of them — including the shape demo above.

## Project files

**Project (`.json`).** The spec, the view and camera, notes, and a summary of the last solve. The
field itself is not stored: the geometry is parametric, so the parameters *are* the geometry, and
opening a project re-solves and reports saved against recomputed torque.

**Model export (`.zip`).** `model.obj` (one object per part), `rotor.stl` (one watertight solid,
poles fused to the yoke), `back_plate.stl`, `stator_traces.svg`, and `project.json`.

**Browser library.** Projects saved in the browser are stored per site origin and show each design's
torque and gap field side by side.

## Documentation

- `docs/numerics.md` — every measured number: scale, convergence, accuracy per cell, why torque uses
  many surfaces, dispatch limits, and which suite runs where.
- `docs/limitations.md` — what the solver cannot do, why, and what would lift each restriction.

## Limitations

See `docs/limitations.md` for the full statement. In short:

- **Linear materials only.** No B-H saturation yet, and no permanent magnets — so no cogging
  torque and no back-EMF constant.
- **μᵣ ≲ 200.** Inside high-permeability material H is a small difference of large terms, and f32
  loses it. WebGPU has no f64. Solves past this are flagged in the results rather than failing
  silently.
- **Cartesian modes still staircase in plane.** `graded` snaps the z interfaces exactly but cannot
  land on the bore or the pole arcs. Use `cylindrical` for anything where that matters; the
  Cartesian modes are kept for cross-checking and for geometry that is not annular.
- **Simplified windings.** Concentric loops rather than spirals; no vias or end connections.
- **Magnetostatics only.** No eddy currents, hysteresis or time stepping; an angle sweep is a
  sequence of static solves, not a transient.
- **Core loss is indicative.** Steinmetz scaling of a datasheet figure with textbook exponents.
  Replace the coefficients before quoting a number.
- **Winding resistance and copper mass are lower bounds.** They count the modelled traces only —
  no run-outs, vias or star point.

## Repository layout

    index.html  headless.html      the two pages
    src/core/                      spec, geometry, shapes, assembly, solve, torque, metrics, studies, results — no DOM
    src/cases/                     worked examples, shared by the page's dropdown and the CLI
    src/gpu/                       device, buffers, shaders, Biot-Savart, CG — no DOM
    src/render/                    3D view and the analytic meshes it shares with the exporter
    src/ui/                        controls, panels, plots, project, export, page wiring
    src/afs.js                     publishes window.AFS
    cli/                           the headless driver
    tests/                         suites, the frozen reference build, golden files
    docs/                          physics, numerics, schema, limitations

`src/core` and `src/gpu` never touch the DOM. That is what makes the headless path the same code as
the page rather than a parallel implementation of it.
