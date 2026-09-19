# Axial-Flux Web Simulator

A client-side 3D magnetostatic field solver and design test bed for axial-flux machines. It computes
the field, torque and gap flux on the GPU, renders the machine and its field in 3D, and saves designs
as project files.

Everything runs in the browser from static files. There is no server, no build step and no bundler.
The same modules also run headless, so a script or an agent can drive the solver and read JSON back.

    axialflow/
      index.html      the tool
      headless.html   the same solver with no interface, exposing window.AFS
      cli/run.js      a Playwright driver for the headless page

## Running it locally

Everything below runs from the repository root, `axialflow/`.

**First time:**

    cd axialflow
    npm run setup          # npm install + playwright's chromium, ~100 MB, once

**Open the tool:**

    npm start              # http://localhost:8080
    npm start -- --open    # ...and open the browser for you
    npm start -- --port 9000

`localhost` is a secure context, which is all WebGPU needs. Nothing is compiled or bundled: edit a
file under `src/`, reload the page, and the change is live. Use a recent Chrome or Edge, or
Safari 26+.

**Run the tests:**

    npm test               # all four suites, ~45 s
    npm run test:quick     # analytic + UI only, ~10 s — the one to use while editing
    npm run test:ui
    npm run test:convergence

**Drive it headlessly:**

    npm run capabilities
    npm run plan -- src/cases/scale-370mm.json     # cells, memory, gap resolution — no solve
    npm run solve -- src/cases/scale-370mm.json
    npm run solve -- --set mesh.mode=graded --set design.rotor.airGap_mm=2
    npm run cli -- sweep --path operatingPoint.currentAngle_elecDeg --from 0 --to 180 --step 15
    npm run cli -- convergence src/cases/scale-370mm.json --factors 0.6,0.8,1,1.3
    npm run cli -- validate

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
                   "turnsPerLayer": 10, "peakCurrent_A": 5, "thickness_mm": 1.6 },
    "rotor":     { "airGap_mm": 3, "mu_r": 20, "poleHeight_mm": 3,
                   "yokeThickness_mm": 4, "poleArcFraction": 0.5 },
    "backPlate": { "enabled": true, "mu_r": 20, "thickness_mm": 4, "gapBelowPcb_mm": 1 }
  },
  "operatingPoint": { "rotorAngle_deg": 0, "currentAngle_elecDeg": 45 },
  "mesh":   { "mode": "graded",
              "activeCellsAcrossDiameter": 160, "cellsAcrossAirGap": 6,
              "cellsAcrossPoleHeight": 4, "cellsAcrossYoke": 3, "cellsAcrossPcb": 4,
              "cellsAcrossBackPlate": 3, "cellsAcrossBackGap": 2,
              "growthRatio": 1.2, "farFieldCellFactor": 8, "maxCells": 40000000,
              "marginFactor": 0.4, "marginMin_mm": 12 },
  "solver": { "tolerance": 1e-5, "maxIterations": 4000, "checkInterval": 32, "stallPatience": 6 }
}
```

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
| Rotor | A yoke ring with P salient poles on its underside, facing the PCB across the air gap. Uniform relative permeability μᵣ. |
| Back plate | Optional ring below the PCB, with its own μᵣ, closing the flux path. |

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

For an ideal synchronous reluctance machine τ ∝ (L_d − L_q)·I²·sin 2γ, so torque peaks near γ = 45°
and is zero at 0° and 90°. The γ sweep plots this directly.

## Meshing

Three modes. `uniform` is the original single-cell-size grid, kept for cross-checking. `graded`
sizes each Cartesian axis from the geometry. `cylindrical` meshes in (r, θ, z) — the coordinates the
machine is actually built in — and is the default for both presets.

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
apart. The near-axis aspect ratio always reads high; that is inherent to the coordinate system, the
bore holds few cells and little field, and it is not worth chasing.

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
| `reference` | every design matches the frozen pre-split single-file build to 1e-9 relative |
| `ui` | the real page: solve, both validation buttons, project round-trip, v1 migration, model export, graded meshing, view controls, and no console errors |
| `convergence` | the answer stops moving under refinement; grading beats uniform per cell; a periodic sector reproduces the full turn exactly; cylindrical and Cartesian agree on a converged answer; the 370 mm case runs; a 14 M-cell solve returns a real answer rather than zeros |

`tests/reference/axial-flux-3d-webgpu.html` is the original single-file build, kept so the
regression is reproducible indefinitely. `tests/compare-reference.js` drives it through its own
controls and compares against the same design solved through the module API.

## Visualization

The 3D view draws the machine from its analytic geometry — smooth meshes for the rotor, back plate
and PCB, and ribbon traces coloured by phase. The field appears three ways: a ray-marched volume
glow of |B| from a filtered `rgba16float` 3D texture; RK2 streamlines of **B** seeded in proportion
to gap flux; and slices through the gap plane or an axial section. A cutaway mode removes y < 0.

## Project files

**Project (`.json`).** The spec, the view and camera, notes, and a summary of the last solve. The
field itself is not stored: the geometry is parametric, so the parameters *are* the geometry, and
opening a project re-solves and reports saved against recomputed torque.

**Model export (`.zip`).** `model.obj` (one object per part), `rotor.stl` (one watertight solid,
poles fused to the yoke), `back_plate.stl`, `stator_traces.svg`, and `project.json`.

**Browser library.** Projects saved in the browser are stored per site origin and show each design's
torque and gap field side by side.

## Limitations

See `docs/limitations.md` for the full statement. In short:

- **Linear materials only.** No B-H saturation yet.
- **μᵣ ≲ 200.** Inside high-permeability material H is a small difference of large terms, and f32
  loses it. WebGPU has no f64. Solves past this are flagged in the results rather than failing
  silently.
- **Cartesian modes still staircase in plane.** `graded` snaps the z interfaces exactly but cannot
  land on the bore or the pole arcs. Use `cylindrical` for anything where that matters; the
  Cartesian modes are kept for cross-checking and for geometry that is not annular.
- **Simplified windings.** Concentric loops rather than spirals; no vias or end connections.
- **Magnetostatics only.** No eddy currents, hysteresis, back-EMF or time stepping.

## Repository layout

    index.html  headless.html      the two pages
    src/core/                      spec, geometry, assembly, solve, torque, results, validation — no DOM
    src/gpu/                       device, buffers, shaders, Biot-Savart, CG — no DOM
    src/render/                    3D view and the analytic meshes it shares with the exporter
    src/ui/                        controls, panels, plots, project, export, page wiring
    src/afs.js                     publishes window.AFS
    cli/                           the headless driver
    tests/                         suites, the frozen reference build, golden files
    docs/                          physics, numerics, schema, limitations

`src/core` and `src/gpu` never touch the DOM. That is what makes the headless path the same code as
the page rather than a parallel implementation of it.
