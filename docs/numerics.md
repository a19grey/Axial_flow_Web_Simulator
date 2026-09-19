# Numerics: what was measured

Every figure here was measured on an Apple M-series GPU (`apple metal-3`) via headless Chrome, most
of them by `node tests/convergence.js`. Regenerate with `npm run test:convergence`; the raw report
lands in `tests/out/convergence.json`.

## The scale problem

A 370 mm outer diameter with a 3 mm air gap, meshed for six cells across the gap:

| Mesh | Cells | Device memory | GPU time | Torque |
|---|---|---|---|---|
| Uniform Cartesian | 54,080,000 (3 cells in gap) / 432 M (6 cells) | 5.8 GB | — | out of reach |
| Graded Cartesian | 2,709,504 | 289 MB | 1210 ms | 3.726 N·m |
| Cylindrical, ¼ sector | 622,080 | 66 MB | 322 ms | 3.765 N·m |

Refined until settled, graded Cartesian extrapolates to **3.777 N·m** and cylindrical to
**3.771 N·m**. Two coordinate systems with different staircasing and different Maxwell-stress
surfaces, 0.2% apart.

## Mesh refinement

370 mm case, cylindrical, refining radial, angular and axial counts together:

| Factor | Cells | Cells in gap | Torque | Surface spread | Wall time |
|---|---|---|---|---|---|
| ×0.6 | 192,000 | 4.0 | 3.7194 N·m | 1.33% | 108 ms |
| ×0.8 | 335,744 | 5.0 | 3.7538 N·m | 0.12% | 169 ms |
| ×1.0 | 622,080 | 6.0 | 3.7655 N·m | 1.81% | 322 ms |
| ×1.3 | 1,126,944 | 8.0 | 3.7708 N·m | 0.87% | 570 ms |
| ×1.7 | 2,182,800 | 10.0 | 3.7660 N·m | 1.29% | 1217 ms |

Extrapolated 3.7714 N·m; the finest mesh is 0.14% from it and the last refinement moved the answer
0.13%.

The 80 mm machine settles less cleanly, to a band of about 2%. Its reluctance torque is the
difference between the d- and q-axis reluctances, so it is a small number carrying the
discretization error of two larger ones. The large machine, whose features span many more cells,
does not have this problem.

## Accuracy per cell

80 mm machine, against a 15 M-cell graded Cartesian reference (0.11672 mN·m):

| Mesh | Cells | Cells in gap | Torque | Error |
|---|---|---|---|---|
| Uniform, 200 across the box | 3,440,000 | 5.3 | 0.10773 mN·m | 7.70% |
| Graded, 200 across the machine | 2,057,216 | 7.0 | 0.11573 mN·m | 0.84% |
| Cylindrical, refined | 1,314,048 | 10 | 0.11787 mN·m | 0.98% (other side) |

The last row is a cross-check, not a ranking. The two coordinate systems bracket the answer from
opposite sides about 1% apart, which is a stronger statement than refining either one alone can
make.

## Sector symmetry is exact

A machine with P poles repeats every 4π/P: the rotor repeats every pole pitch and the winding every
three coils, and with the phase currents fixed at an instant the whole pattern including the
sources repeats. Modelling one pole pair with a periodic θ boundary is therefore an exact symmetry,
not an approximation.

| | Cells | Torque |
|---|---|---|
| Full turn | 798,720 | 0.11897007 mN·m |
| One sector | 399,360 | 0.11897008 mN·m |

6 × 10⁻⁸ relative. The test asserts better than 10⁻⁶, so a wrong wrap index or a wrong sector
scaling cannot pass.

## Why torque uses many surfaces

A single Maxwell-stress plane is sensitive to where it lands, independently of the field. Refining
only z on the 80 mm machine, with the in-plane mesh held fixed, moved a single-plane torque by 2% as
the plane hopped between mesh nodes.

Planes at the extremes of the gap are worse: right against the copper they sit in the trace-by-trace
structure, and right under a pole face in the pole-edge singularity. With a finely resolved gap those
disagreed with the middle by nearly 20% while the converged torque was settled to under 1%.

The tool therefore averages every plane in the central 64% of the gap and reports the spread. That
spread runs 1–3% where refinement shows the answer is 0.1–0.8% from converged, so it is a
conservative error bar rather than a tight one.

## Mean gap B_z

Sampling the single cell layer nearest mid-gap moved this metric 2.8% under z-refinement, with no
trend — the layer was moving, not the field. Interpolating between the two layers that straddle
mid-gap moves 0.65% and does not drift.

| Cells across gap | 4 | 5 | 6 | 8 | 10 | 12 | 16 |
|---|---|---|---|---|---|---|---|
| Old (nearest layer) | 5.890 | 5.778 | 5.744 | 5.872 | 5.759 | 5.903 | 5.884 |
| New (interpolated) | 5.828 | 5.845 | 5.866 | 5.844 | 5.834 | 5.841 | 5.842 |

## Analytic cases against resolution

Both closed-form cases, solved at a range of grid sizes. The tolerances in `src/core/validate.js`
are set against these, not chosen to make a particular run pass.

| Grid | Loop, worst on-axis error (tol 1%) | Sphere, cells across | Sphere error (tol 9%) |
|---|---|---|---|
| 48 | 0.749% | 12 | 11.07% — fails |
| 64 | 0.413% | 16 | 8.48% |
| 80 | 0.258% | 20 | 7.73% |
| 96 | 0.173% | 24 | 6.51% |
| 128 | 0.088% | 32 | 5.22% |

The loop case is pure Biot-Savart with no material response, and converges at close to second order:
halving the cell size roughly quarters the error. The sphere case converges at closer to first
order, because a staircased sphere on a Cartesian grid has a boundary error that falls only as the
cell size. That is the case's whole point — the interior field amplifies an error in the
demagnetizing factor by roughly μᵣ/3, so it is the most sensitive probe available of the material
response, and of the reduced-potential ceiling.

CI runs this at grid 80. Wall time for the whole analytic suite on a software adapter, which is
what a runner has:

| Grid | 64 | 80 | 96 | 128 |
|---|---|---|---|---|
| Local SwiftShader | 16 s | 36 s | 75 s | ~190 s |
| GitHub runner | — | — | — | over 300 s, timed out |

Grid 48 is the first that fails, so 64 is the floor and 80 leaves a margin on both the tolerance
and the clock.

## Solver

Jacobi-preconditioned conjugate gradients, f32, residual read back once per 32 iterations.

Iteration counts grow with refinement and with anisotropy. On the 80 mm machine, cylindrical:
384 iterations at 75 k cells, 736 at 460 k, 1472 at 3.1 M. Cells near the axis are strongly
anisotropic because the arc length goes to zero there; this is inherent to cylindrical coordinates
and is the main reason iteration counts are higher than the Cartesian equivalent. It has not been
worth fixing, because the cell count falls by much more than the iteration count rises.

A line-implicit (z-direction tridiagonal) preconditioner and a multigrid V-cycle are the next two
options if this becomes the bottleneck. Neither is built.

## Dispatch limits

WebGPU caps workgroups per dimension at 65535. At 64 threads per workgroup the Biot-Savart kernel
ran out at 4.2 M cells, and at 256 threads the CG kernels at 16.7 M. Past those limits the dispatch
was rejected and the solve returned a field of zeros — a confident torque of 0.00000, produced
faster than a correct run.

Every cell-wide kernel now dispatches a 2D workgroup grid and linearises the index itself, and each
solve runs inside `pushErrorScope` / `popErrorScope` so a rejected dispatch fails loudly and is
attributed to the pass that caused it — a global latch would let an unrelated renderer failure
surface as a solver error. The convergence suite carries a regression for this: a 14 M-cell solve
must return a real answer.

## What runs where

| Suite | Needs a GPU | On CI |
|---|---|---|
| `analytic` | no — SwiftShader computes the same f32 arithmetic, just slowly | yes |
| `ui` | no — meshes are shrunk and physics assertions skip, visibly | yes |
| `reference` | yes, in practice: eight designs up to 1.8 M cells | no |
| `convergence` | yes: meshes to 15 M cells | no |

A software adapter gives correct fields and meaningless timings, so anything asserting a timing or
a convergence claim is local-only. Both drivers refuse a software adapter unless given
`--allow-software`, and stamp `softwareAdapter` into their output either way.
