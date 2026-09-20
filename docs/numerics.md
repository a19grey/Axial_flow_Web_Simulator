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

## Torque by two independent methods

Maxwell stress integrates the field over a surface in the air gap. Virtual work differentiates the
magnetic co-energy, a volume integral over the whole domain, with respect to rotor position at
constant current. They share the field and nothing else, so their agreement says something that no
amount of surface-to-surface comparison can.

| | Virtual work | Maxwell stress | Apart |
|---|---|---|---|
| 370 mm scale case | 3761.98 mN·m | 3765.47 mN·m | **0.09%** |
| 80 mm machine, preset mesh | 0.12096 mN·m | 0.11897 mN·m | 1.67% |

The small machine sits in the band it always sits in: its reluctance torque is a difference between
two larger reluctances, so it carries the discretization error of both. Refining its mesh by 0.7,
1.0, 1.4 and 2.0 gave disagreements of 0.93%, 1.67%, 0.58% and 1.28% — a band, with no trend.

The derivative is taken from a symmetric stencil, not a single central difference. Over one degree
of rotation the material co-energy changes by about a percent, which is uncomfortably close to
where the step is either too large to be a derivative or too small to be above the noise. Sampling
seven points gives the 2nd-, 4th- and 6th-order estimates at once:

| Stencil order | 2 | 4 | 6 |
|---|---|---|---|
| 370 mm torque, mN·m | 3735.83 | 3771.08 | 3761.98 |

The two-point estimate alone would have read 0.8% low and looked like a real disagreement. The
spread across orders is reported with the answer.

**The co-energy has to be summed on faces, not at cell centres.** This is not a refinement. The
solver's unknowns are face fluxes, and the discrete statement that ∇·B = 0 is a statement about
those and nothing else; only a face sum inherits it. Separately, Hₛ is singular at the filaments,
so cell-centre B and cell-centre Hₛ sample that singularity differently and their difference near a
trace is two large mismatched numbers. Summed at cell centres, the material inductance of the 80 mm
machine came out at 37 mH against a free-space 29 µH — a factor of a thousand — and the energy
computed two ways disagreed by 25%. On faces the same two routes agree to 0.06%.

## Inductance

Split into the half that comes from the winding alone and the half the material adds:
L = L₀ + ΔL. L₀ is Neumann's double integral over the filaments, in closed form over all space;
ΔL comes from the solved field by reciprocity, ΔL_jk = ∫ H_sj·(B_k − μ₀H_sk) dV.

L₀ is checked against a case with an exact answer — a circular loop, L = μ₀R(ln(8R/GMD) − 2):

| Loop segments | 128 | 256 | 512 |
|---|---|---|---|
| Error against the closed form | −0.62% | −0.34% | −0.20% |

The residual is the polygon perimeter, which is why it falls as the loop is refined rather than
settling on a bias.

Three properties then have to hold, and all three are asserted:

| Property | Why it must hold | Measured |
|---|---|---|
| L_jk = L_kj | reciprocity is a theorem | 0.0034% worst asymmetry |
| L₀ has no saliency | the free-space matrix of a symmetric 3-phase winding is circulant | 0.6 pH out of 32.9 µH |
| reciprocity error falls under refinement | it is discretization, not a bug | 6.5× smaller on doubling the angular mesh |

That last row is what makes the asymmetry usable as an error bar rather than a curiosity. Measured
on the 80 mm machine, angular cells per pole pitch against worst asymmetry:

| Cells per pole pitch | 16 | 32 | 64 |
|---|---|---|---|
| Reciprocity asymmetry | 0.098% | 0.022% | 0.0043% |

Roughly fourth-order in the angular cell count — faster than the torque converges, so it is a
sensitive probe rather than a proxy.

The 80 mm machine reads Ld = 59.8 µH, Lq = 57.7 µH, of which 32.9 µH is air-core and identical in
both axes. All of the saliency is in the material response, as it must be: the winding does not
move, so L₀ cannot depend on rotor angle.

## Rasterized volume against exact volume

Every region of the machine is an annular sector extrusion with a volume known in closed form. What
the mesh actually laid down is accumulated as the rasterizer runs, so the two can be compared
directly — a check on the discretization that involves no field at all.

| Mesh | Worst region error |
|---|---|
| Cylindrical | 1.3 × 10⁻¹²% |
| Graded Cartesian | 0.016% |
| Uniform Cartesian | 0.025% |

Cylindrical is exact by construction: every region is a coordinate box, so the filled fraction is a
product of three closed-form one-dimensional overlaps. The Cartesian figures are the in-plane
staircase, softened by 4×4 supersampling.

This check found a real bug on its first run. The Cartesian rasterizer was accumulating into an
undefined array index — silently, because writing past the end of a typed array is a no-op — and
reported zero volume for every region.

## Torque ripple and skew

One electrical period of rotor rotation is 720/P mechanical degrees: over that span the rotor
returns to an identical position *and* the phase currents, which advance by 2π, return to their
starting values.

The 80 mm machine, 12 rotor positions across 180°:

| Pole skew | 0° | 15° | 30° |
|---|---|---|---|
| Mean torque | 0.0940 mN·m | 0.0916 mN·m | 0.0867 mN·m |
| Ripple, peak-to-peak | 85.9% | 76.8% | 43.5% |

Skew halves the ripple for 8% of the mean torque, which is what skew is for. The ripple is almost
entirely the 6th harmonic of the electrical period — the classical harmonic for a three-phase
machine with a non-sinusoidal MMF — and the machine has a lot of it, being a concentrated-winding
salient-pole reluctance motor with no skew by default.

## Core loss, and where it is refused

Core loss is a rotor-frame quantity: a fixed cell in the laboratory frame is iron only part of the
time, so tracking B there would mix iron and air.

On a cylindrical mesh with uniform angular cells the rotor frame is exactly one index shift away —
rotate by s cells and cell (i, j, k) of the rotor sits at angular index (j + s) mod nθ — and the
(r, θ, z) components of B are already in a basis that rotates with it. So the waveform is recovered
with no interpolation at all. On a Cartesian mesh it is not, and the tool reports core loss as
unavailable with the reason rather than returning a number it cannot justify.

The loss model is Steinmetz scaling of a datasheet figure, p = p_ref (B/B_ref)^β (f/f_ref)^α,
applied to each field component separately and summed. Defaults are 4.0 W/kg at 1.5 T and 50 Hz —
which is what the grade name M400-50A states — with the textbook exponents β = 2, α = 1.6. Those
exponents are not a fit to any particular steel and are documented as such in the output.

The iron mass the accumulator sums over is recovered from the rasterized permeability field by
inverting the series blend. On the 80 mm machine it comes to 0.19629 kg against an analytic rotor
mass of 0.19629 kg.

The dual-rotor 370 mm preset at 1500 rpm reports 0.76 W over 25.3 kg of rotor iron, 0.03 W/kg, with
a peak flux amplitude of 0.32 T. That is small, and it is *supposed* to be small: in a synchronous
machine the fundamental armature field is stationary in the rotor frame, so the rotor sees only the
harmonics. A lab-frame calculation would have reported the whole fundamental as loss and been an
order of magnitude too high — which is the reason for going to the trouble of the frame shift.

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
