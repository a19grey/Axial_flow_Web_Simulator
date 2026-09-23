# Limitations

What this solver cannot currently do, why, and what would lift each restriction. Anything listed
here is reported in the results rather than left to be discovered.

## The μᵣ ≈ 200 ceiling

**The restriction.** Relative permeability above roughly 200 gives quietly wrong answers inside the
material.

**Why.** The solver uses a *reduced* scalar potential: **H** = **H**ₛ − ∇φ, where **H**ₛ is the
free-space field of the coils. Inside a high-permeability body, **H** is small while both **H**ₛ and
∇φ are large and nearly cancel. The relative error of the difference grows like μᵣ times the relative
error of each term. In f32, with about 7 decimal digits, that is fine at μᵣ = 20 and gone by μᵣ ≈ 200.

**Why not just use f64.** WebGPU has no f64. This is a hard limit of the platform, not a choice.

**What this permits, honestly.**

| Material class | Typical μᵣ | Usable? |
|---|---|---|
| Iron-filled polymer filament | 5–30 | yes, comfortably |
| SMC / soft magnetic composite (Somaloy class) | 200–500 | marginal — right at the ceiling |
| Ferrite | 1,000–3,000 | no |
| Laminated electrical steel, unsaturated | 2,000–5,000 | no |
| Any steel driven well into saturation | < 200 | yes, in that regime only |

**How it is reported.** Every solve emits a `muCeiling` quality flag at μᵣ > 200 and a
`muNearCeiling` warning above 100, in both the results JSON and the page.

**What would lift it.** A total scalar potential with coil cuts: ψ everywhere, with each coil
represented as a prescribed jump in ψ across a cut surface spanning it. There is then no
`Hₛ − ∇φ` difference to lose, so the formulation is exact at any μᵣ, and it removes Biot-Savart from
the solve path entirely. The hard part is constructing the cut surfaces; for parametric coils the
geometry is known analytically, which makes it tractable. Specified but not started.

The classic two-potential method (total potential inside iron, reduced outside) is the textbook fix,
but when a coil encircles an iron tooth the interface potential becomes path-dependent and needs
cuts anyway — so it inherits the hard part without shedding the Biot-Savart cost.

## Linear materials only

No B-H saturation. Acceptable for filled polymers, wrong for any steel worked near its saturation
flux density. The nonlinear machinery is a μ(|B|) update loop around the existing linear solve and is
the next substantial piece of physics work; note that it interacts with the ceiling above, since
the materials most worth saturating are also the ones past it until the formulation changes.

## Cartesian modes: in-plane boundaries are staircased

*Fixed by `mesh.mode: "cylindrical"`, which is now the default everywhere — in the presets, on a
fresh page, and for any spec that does not name a mode. This section describes the Cartesian modes,
which are kept for cross-checking and for non-annular geometry.*

Grading removes the z-direction staircase completely, because the interfaces that matter there — the
PCB faces, the pole face, the yoke, the back plate — are planes, and the mesh generator makes every
one of them a cell face.

Radial and angular boundaries cannot be treated the same way. The bore, the outer rim and the pole
arcs are curved surfaces that no Cartesian tensor mesh can land on, so they remain staircased and
their cells carry a blended permeability. In-plane refinement converges smoothly (measured: the
80 mm machine's torque rises monotonically from 0.11477 to 0.11851 mN·m as the in-plane count goes
from 100 to 400, with the steps shrinking), so this is an accuracy cost rather than a correctness
problem — but it is the dominant remaining discretization error.

The cylindrical backend fixes it: the bore, the rim and the pole arcs are coordinate surfaces, the
filled fraction of a cell is the product of three exact one-dimensional overlaps, and one pole pair
is modelled with periodic boundaries instead of the whole machine.

What cylindrical costs, in exchange: cells near the axis are very anisotropic, because the arc
length goes to zero there. That is inherent to the coordinate system. It shows up as a high reported
aspect ratio and somewhat more conjugate-gradient iterations, and it is largely harmless — the bore
holds few cells and little field. It also means a cylindrical mesh cannot represent a machine that
is not roughly annular.

Uniform mode is retained, and is still the right choice for a small machine or for cross-checking
the graded path, but it does not scale: the 370 mm case needs 54 million cells for three across the
gap and 432 million for six. `node cli/run.js plan` reports this before you commit to a solve.

## Simplified windings

Turns are concentric trapezoidal loops rather than spirals, and there are no vias or end-connection
currents. The exported SVG is a valid copper pattern in outline but a real board needs spiral turns
and layer-to-layer vias.

The coil count, the phase each coil carries and its winding sense are all settable
(`design.stator.coilCount`, `phasePattern`, `coilSense`), and the angular period is *derived* from
whatever pattern results rather than assumed — a layout with no symmetry correctly reports
`sectors: 1` and is modelled over the full turn. What is still missing is the generation of
distributed, lap and wave layouts: those need coils that span more than one slot pitch, which the
single concentric-trapezoid coil shape cannot express.

Because the traces are modelled as filaments, winding resistance and copper mass count the modelled
turns only. No run-outs, no vias, no star point. Both are therefore lower bounds for a real board,
and the results say so.

## Derived metrics: what each one is worth

The tool now characterizes a machine as well as solving its field, but the quantities differ a lot
in how much they can be trusted.

| Quantity | Basis | Trust |
|---|---|---|
| Torque, Maxwell stress | field, surface integral, averaged over every plane in the gap | converged to ~0.1% on a large machine; error bar reported |
| Torque, virtual work | field, co-energy derivative | agrees with the above to 0.09% (370 mm) and 1.7% (80 mm) |
| ΔL, Ld − Lq, saliency | field, reciprocity identity | reciprocal to 0.003%; all saliency lives here |
| Stored energy | field, face sum | two routes agree to 0.06% |
| Air-gap shear stress | torque ÷ the r-weighted gap area | exactly as good as the torque; the area is closed form |
| Mass, volumes | closed form from the region list | exact; cross-checked against what the mesh laid down |
| Winding resistance | modelled trace length and cross-section | a lower bound: no interconnect |
| L₀, the air-core inductance | Neumann over filaments, GMD-regularized | ~0.2% against a closed form, but a filament model of a real trace |
| Core loss | Steinmetz scaling of a datasheet figure | order of magnitude only — see below |
| Torque ripple, harmonics | a solve per rotor position | as good as the underlying torque |

**Core loss is the weakest of these and should be treated as indicative.** The exponents are
textbook values rather than a fit to a datasheet; the rotating field is decomposed into orthogonal
alternating components and their losses added, which is conservative for a circular locus; there is
no minor-loop or excess-loss term; the whole core is assumed to have the rotor's material
properties; and a stator-fixed back plate is excluded entirely because its flux waveform is not a
rotor-frame quantity. Replace the coefficients with a fit to the steel actually being used before
quoting a number.

**Ld and Lq carry the filament model.** Saliency and torque do not — the winding does not move, so
L₀ cannot depend on rotor angle and cancels out of everything angular — but the absolute values do,
to the extent that a rectangular trace is not a filament with a geometric mean distance.

## Magnetostatics only

No eddy currents, no hysteresis, no back-EMF, no time stepping. The torque-versus-angle study is a
sequence of static solves, not a transient simulation: it shows what the machine would do at each
rotor position, not how it gets between them.

There are also no permanent magnets, so there is no cogging torque, no no-load flux linkage and no
back-EMF constant Kₑ. The machines this models are reluctance machines, where all the torque comes
from saliency and all the flux from the winding.

## Mesh-limited accuracy

Gap field and torque accuracy depend on how many cells span the gap. Fewer than three and the result
is not meaningful; the results carry a `gapUnresolved` error flag below three and a `gapCoarse`
warning below five.

Torque is averaged over every stress plane in the central band of the gap and the spread across them
is reported; `surfaceDisagreement` fires past 5%. That spread tracks the real discretization error
reasonably well (1–3% where refinement shows the answer is 0.3–0.8% from converged), but every plane
uses the same method, so it bounds the discretization error and not a systematic error in the method
itself.

`AFS.virtualWork(spec)` is the independent second estimate: the derivative of magnetic co-energy
with rotor position, a volume quantity that shares only the field with the surface integral. On the
370 mm machine the two agree to 0.09%. It costs seven solves, which is why it is a separate call
rather than part of every run.

`node cli/run.js convergence` is the real check: it solves the same design at several refinements
and reports how far the finest one is from the extrapolated limit.

One quantity converges less cleanly than the rest. Reluctance torque is the difference between the
d- and q-axis reluctances, so on a small machine it is a small number carrying the discretization
error of two larger ones, and it settles into a band of a percent or two rather than onto a value.
The 370 mm machine, whose features span many more cells, settles to 0.3%.

## Dual-sided machines

A second rotor mirrored below the board is supported and is the topology most axial-flux machines
of any size actually use. Two things to know about it.

The back plate is ignored when `dualSided` is set: the opposite rotor *is* the flux return, and
modelling both would be describing a machine nobody builds. The back-plate controls stay visible but
inactive, so a loaded project does not appear to have lost settings it still holds.

Each rotor gets its own Maxwell-stress surface, on its own side of the stator, and the two torques
are added because the rotors are on one shaft. They are mirror images, so their disagreement is a
meshing asymmetry rather than physics — it is reported as `rotorImbalance_pct` and warns past 5%.
Measured on the 80 mm machine it is 0.01%.

## Pole skew is approximate in the 3-D view only

Skew is exact in the solve: on a cylindrical mesh the arc centre moves with radius and the angular
overlap is still computed in closed form, at the cost of an n_r × n_θ table instead of an n_θ one.
On a Cartesian mesh it is supersampled like every other in-plane feature.

The 3-D view twists the rotor's vertex positions but leaves the surface normals unrotated, which is
a shading approximation. Nothing in the solve comes from the view geometry.

## Software-adapter fallback

Headless Chrome will silently hand back SwiftShader instead of a hardware adapter if the launch
flags are not exactly right — in particular `--use-angle=default` is required on macOS. Fields
computed on a software adapter are correct; timings are meaningless and large grids are impractical.
Every driver in this repository checks `capabilities().software` and refuses to proceed without
`--allow-software`, and stamps `softwareAdapter` into its output either way.
