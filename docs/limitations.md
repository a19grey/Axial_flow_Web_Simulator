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

*Fixed by `mesh.mode: "cylindrical"`, which is now the default for both presets. This section
describes the Cartesian modes, which are kept for cross-checking and for non-annular geometry.*

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
and layer-to-layer vias. Only the 1.5·P concentrated layout is expressible; distributed, lap and wave
windings are not.

## Magnetostatics only

No eddy currents, no hysteresis loss, no back-EMF, no time stepping. Dynamic behaviour has to be
inferred by sweeping rotor angle or current angle. There is also no flux linkage, no Ld/Lq, no copper
or core loss, and no mass or torque density, so the tool computes a field but does not yet
characterize a machine.

## Mesh-limited accuracy

Gap field and torque accuracy depend on how many cells span the gap. Fewer than three and the result
is not meaningful; the results carry a `gapUnresolved` error flag below three and a `gapCoarse`
warning below five.

Torque is averaged over every stress plane in the central band of the gap and the spread across them
is reported; `surfaceDisagreement` fires past 5%. That spread tracks the real discretization error
reasonably well (1–3% where refinement shows the answer is 0.3–0.8% from converged), but every plane
uses the same method, so it bounds the discretization error and not a systematic error in the method
itself. A virtual-work torque would be a genuinely independent second estimate; it does not exist
yet.

`node cli/run.js convergence` is the real check: it solves the same design at several refinements
and reports how far the finest one is from the extrapolated limit.

One quantity converges less cleanly than the rest. Reluctance torque is the difference between the
d- and q-axis reluctances, so on a small machine it is a small number carrying the discretization
error of two larger ones, and it settles into a band of a percent or two rather than onto a value.
The 370 mm machine, whose features span many more cells, settles to 0.3%.

## Software-adapter fallback

Headless Chrome will silently hand back SwiftShader instead of a hardware adapter if the launch
flags are not exactly right — in particular `--use-angle=default` is required on macOS. Fields
computed on a software adapter are correct; timings are meaningless and large grids are impractical.
Every driver in this repository checks `capabilities().software` and refuses to proceed without
`--allow-software`, and stamps `softwareAdapter` into its output either way.
