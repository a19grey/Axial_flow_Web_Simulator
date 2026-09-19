/* Physical and modelling constants. Lengths are millimetres unless a name says otherwise. */

export const MU0 = 4e-7 * Math.PI;

/* PCB construction. These were hard-coded literals in the single-file version; they are named here
   so the spec can expose them, but the defaults reproduce the original numbers exactly. */
export const PCB = {
  thickness_mm: 1.6,        // board thickness; half-thickness 0.8 sets the stator faces
  tracePitch_mm: 0.5,       // radial pitch between concentric turns
  traceWidth_mm: 0.34,      // copper width, used by the SVG export
  edgeMargin_mm: 0.4,       // clearance from the coil outline to the first turn
  arcSegments: 10           // straight segments per trapezoid arc
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
