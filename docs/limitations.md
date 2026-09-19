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

## Uniform grid

Cells are cubes of a single size across the whole box, sized as 2L/N where L includes a margin of
max(12 mm, 0.4·Rₒ) around the machine.

This does not scale. A 370 mm machine with a 3 mm air gap needs h ≈ 1 mm for three cells across the
gap, in a box roughly 520 mm on a side — about 116 million cells, of which some 88% are in the bore,
the box corners, or far field where nothing is happening. Run `node cli/run.js plan` on such a design
and it will say so.

The fix is a graded mesh: per-axis non-uniform spacing driven by a size function, fine through the
gap and stretched into the far field, with grid nodes snapped exactly onto material interfaces. That
removes the z-direction staircase error at the same time, because a partly filled cell currently
blends its permeability and a gap thinner than one cell simply averages away.

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

## Grid-limited accuracy

Gap field and torque accuracy depend on how many cells span the gap. Fewer than three and the result
is not meaningful; the results carry a `gapUnresolved` error flag below three and a `gapCoarse`
warning below five. Close agreement between the two Maxwell-stress surfaces is the practical
convergence check, and a `surfaceDisagreement` flag fires past 10%.

Both stress surfaces use the same method, so their agreement bounds the discretization error but not
a systematic error in the method itself. A virtual-work torque would be a genuinely independent
second estimate; it does not exist yet.

## Software-adapter fallback

Headless Chrome will silently hand back SwiftShader instead of a hardware adapter if the launch
flags are not exactly right — in particular `--use-angle=default` is required on macOS. Fields
computed on a software adapter are correct; timings are meaningless and large grids are impractical.
Every driver in this repository checks `capabilities().software` and refuses to proceed without
`--allow-software`, and stamps `softwareAdapter` into its output either way.
