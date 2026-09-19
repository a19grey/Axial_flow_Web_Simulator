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

## Running

**In a browser.** Serve the folder from any static host and open `index.html`. WebGPU needs a secure
context, so use HTTPS or `localhost` — `python3 -m http.server 8080` is enough. Use a recent Chrome
or Edge, or Safari 26+.

**Headless.** Once, `npm install && npx playwright install chromium`. Then:

    node cli/run.js capabilities
    node cli/run.js plan                                  # cells, memory, gap resolution — no solve
    node cli/run.js solve --set design.rotor.airGap_mm=2
    node cli/run.js sweep --path operatingPoint.currentAngle_elecDeg --from 0 --to 180 --step 15
    node cli/run.js validate

Progress goes to stderr and the JSON result to stdout, so results pipe cleanly. `--set <path>=<value>`
overrides any field of the spec and is repeatable. `-o out.json` also writes the result to a file.

The driver refuses to run on a software WebGPU adapter unless given `--allow-software`: SwiftShader
produces correct fields but meaningless timings, and headless Chrome will silently fall back to it.

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
  "mesh":   { "mode": "uniform", "cellsAcrossDiameter": 128, "marginFactor": 0.4, "marginMin_mm": 12 },
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

The box's bottom face sits in the air gap. Two boxes at different gap heights give two estimates, and
their agreement indicates whether the grid is fine enough.

For an ideal synchronous reluctance machine τ ∝ (L_d − L_q)·I²·sin 2γ, so torque peaks near γ = 45°
and is zero at 0° and 90°. The γ sweep plots this directly.

## Numerics

- **Grid.** Uniform cubic cells of side h = 2L/N. Resolve the air gap with at least 3 cells.
- **Materials.** Rotor and back plate are rasterized with 4×4 in-plane supersampling and exact
  z-overlap. A partially filled cell uses series blending, 1/μ = (1 − f) + f/μᵣ. Face permeability is
  the harmonic mean of the two neighbouring cells. Averaging μ arithmetically instead would make a
  partial cell behave as solid iron and silently shrink the gap.
- **Discretization.** Finite volume, 7-point stencil, one balance equation per cell:

  $$\sum_f \mu_f(\varphi_c - \varphi_n) = -h\sum_f (\mu_f - 1)\,\mathbf H_{s,f}\cdot\hat{\mathbf n}_f$$

- **Solver.** Jacobi-preconditioned conjugate gradients in f32 WGSL compute shaders. Dot products use
  workgroup reductions and the CG scalars stay on the GPU; only the residual is read back, once per
  check interval.
- **B reconstruction.** Face flux is B_f = μ₀μ_f(H_s,f − Δφ/h), exactly the flux the solver balanced.
  Cell values average the two faces per direction, so normal B stays continuous across material edges.

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
| `ui` | the real page: solve, both validation buttons, project round-trip, v1 migration, model export, view controls, and no console errors |

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
- **Uniform grid.** A 370 mm machine with a 3 mm gap cannot be resolved by a uniform grid at any
  practical cell count. Graded meshes are the next piece of work.
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
