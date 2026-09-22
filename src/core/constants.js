/* Physical and modelling constants. Lengths are millimetres unless a name says otherwise. */

export const MU0 = 4e-7 * Math.PI;

/* PCB construction. These were hard-coded literals in the single-file version; they are named here
   so the spec can expose them, but the defaults reproduce the original numbers exactly. */
export const PCB = {
  thickness_mm: 1.6,        // board thickness; half-thickness 0.8 sets the stator faces
  tracePitch_mm: 0.5,       // radial pitch between concentric turns
  traceWidth_mm: 0.34,      // copper width, used by the SVG export
  edgeMargin_mm: 0.4,       // clearance from the coil outline to the first turn
  arcSegments: 10,          // straight segments per trapezoid arc
  /* Samples along each radial side of a *profiled* coil turn. A straight-sided turn has none: its
   * sides are single chords, which is the geometry rather than a coarse sampling of it. */
  coilSideSegments: 12
};

/* Layer z-positions (mm, relative to the board mid-plane) for 2- and 4-layer stacks. */
export const LAYER_Z = {
  2: [-0.7, 0.7],
  4: [-0.7, -0.233, 0.233, 0.7]
};

/* Material rasterization: in-plane supersampling factor per axis. */
export const RASTER_SUPERSAMPLE = 4;

/* Solver defaults. */
export const SOLVER_DEFAULTS = {
  tolerance: 1e-5,
  maxIterations: 4000,
  checkInterval: 32,   // CG iterations between residual read-backs
  stallPatience: 6     // consecutive non-improving checks before giving up
};

/* Material properties used by the derived metrics. None of these enter the field solve; they turn
 * a solved field into engineering numbers, and every one of them is overridable in the spec. */
export const MATERIALS = {
  // Copper at 20 C, and its temperature coefficient of resistivity.
  copperResistivity_ohm_m: 1.68e-8,
  copperTempCoeff_perK: 3.93e-3,
  copperDensity_kg_m3: 8960,
  // FR-4 laminate, without the copper.
  boardDensity_kg_m3: 1850,
  // Electrical steel / SMC. 7650 is typical of a silicon steel lamination stack.
  ironDensity_kg_m3: 7650
};

/* Core loss, anchored to the number on a lamination datasheet rather than to fitted coefficients.
 *
 * A grade designation states its own specific loss: "M400-50A" is 4.00 W/kg at 1.5 T and 50 Hz.
 * Scaling that with the classical Steinmetz exponents,
 *
 *     p(B, f) = p_ref (B/B_ref)^beta (f/f_ref)^alpha
 *
 * gives a loss estimate traceable to a published figure. The exponents are the usual textbook
 * values and are *not* a fit to any particular steel; replace them with a datasheet fit before
 * quoting a loss number as anything but an order of magnitude.
 */
export const CORE_LOSS_DEFAULTS = {
  specificLoss_W_per_kg: 4.0,
  atFlux_T: 1.5,
  atFrequency_Hz: 50,
  fluxExponent: 2.0,
  frequencyExponent: 1.6
};

/* Copper foil weight. 1 oz/ft^2 is 34.8 um. */
export const COPPER_THICKNESS_UM = 35;
