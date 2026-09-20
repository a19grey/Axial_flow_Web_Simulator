/* Orthogonal tensor-product mesh, Cartesian or cylindrical.
 *
 * A mesh is three independent lists of node coordinates. Cells are the boxes between them, so
 * everything else — centres, widths, face areas, volumes, neighbour distances — follows.
 *
 * The finite-volume assembly needs exactly two things per face: its area and the distance across
 * it. In both coordinate systems those *factorize* over the three axes:
 *
 *   Cartesian (x, y, z)        A_x = dy dz          d_x = dxf
 *                              A_y = dx dz          d_y = dyf
 *                              A_z = dx dy          d_z = dzf
 *                              V   = dx dy dz
 *
 *   Cylindrical (r, theta, z)  A_r = r_face dth dz  d_r = drf
 *                              A_th = dr dz         d_th = r_c dthf     <- depends on r as well
 *                              A_z = dA_r dth       d_z = dzf           dA_r = (r1^2 - r0^2)/2
 *                              V   = dA_r dth dz
 *
 * So each is stored as three per-axis arrays whose product gives the value. The assembly, the
 * solver kernels and the reconstruction are then written once, and adding a coordinate system is a
 * matter of filling in the factors.
 *
 * Axis 1 (y, or theta) can be periodic. A full machine in cylindrical coordinates always is:
 * theta = 0 and theta = 2*pi are the same place, so there is no boundary there to hold at phi = 0.
 *
 * Lengths are millimetres; theta is radians. Conversion to metres happens where the physics needs it.
 */

export const CARTESIAN = "cartesian";
export const CYLINDRICAL = "cylindrical";

/* Build a mesh from three edge arrays. Each must be strictly increasing. */
export function makeMesh(e0, e1, e2, opts = {}) {
  const kind = opts.kind || CARTESIAN;
  const a0 = axis(e0, "0"), a1 = axis(e1, "1"), a2 = axis(e2, "2");
  const n0 = a0.n, n1 = a1.n, n2 = a2.n;

  const m = {
    kind, nx: n0, ny: n1, nz: n2, N: n0 * n1 * n2,
    sy: n0, sz: n0 * n1,
    // Axis 1 wraps: the last cell's + neighbour is the first cell.
    periodicY: !!opts.periodicY,
    // Angular span modelled, and how many times it repeats to make the whole machine. A sector
    // solve reports torque for the sector; the full-machine value is that times `sectors`.
    sectors: opts.sectors || 1,

    xe: a0.e, ye: a1.e, ze: a2.e,
    xc: a0.c, yc: a1.c, zc: a2.c,
    dx: a0.d, dy: a1.d, dz: a2.d,
    dxf: a0.df, dyf: a1.df, dzf: a2.df,
    x0: a0.e[0], y0: a1.e[0], z0: a2.e[0],
    x1: a0.e[n0], y1: a1.e[n1], z1: a2.e[n2]
  };

  // Periodic axis 1: the "distance to the next cell" for the last cell wraps around.
  if (m.periodicY) m.dyf[n1 - 1] = (a1.e[n1] - a1.c[n1 - 1]) + (a1.c[0] - a1.e[0]);

  if (kind === CYLINDRICAL) cylindricalFactors(m);
  else cartesianFactors(m);

  siFactors(m);

  const ext = physicalExtents(m);
  m.hMin = ext.min; m.hMax = ext.max;
  m.aspect = ext.max / Math.max(ext.min, 1e-12);
  m.uniform = kind === CARTESIAN && a0.uniform && a1.uniform && a2.uniform;
  return m;
}

function axis(e, name) {
  const n = e.length - 1;
  if (n < 1) throw new Error(`Mesh axis ${name} needs at least two nodes.`);
  const E = e instanceof Float64Array ? e : Float64Array.from(e);
  const c = new Float64Array(n), d = new Float64Array(n), df = new Float64Array(n);
  let min = Infinity, max = 0;
  for (let i = 0; i < n; i++) {
    d[i] = E[i + 1] - E[i];
    if (!(d[i] > 0)) throw new Error(`Mesh axis ${name} is not strictly increasing at node ${i}.`);
    c[i] = 0.5 * (E[i] + E[i + 1]);
    if (d[i] < min) min = d[i];
    if (d[i] > max) max = d[i];
  }
  for (let i = 0; i < n - 1; i++) df[i] = c[i + 1] - c[i];
  df[n - 1] = d[n - 1];
  return { n, e: E, c, d, df, min, max, uniform: (max - min) <= 1e-9 * max };
}

const ones = n => { const a = new Float64Array(n); a.fill(1); return a; };

function cartesianFactors(m) {
  const { nx, ny, nz } = m;
  m.area = [
    { i: ones(nx), j: m.dy,      k: m.dz },
    { i: m.dx,     j: ones(ny),  k: m.dz },
    { i: m.dx,     j: m.dy,      k: ones(nz) }
  ];
  m.dist = [
    { i: m.dxf,    j: ones(ny),  k: ones(nz) },
    { i: ones(nx), j: m.dyf,     k: ones(nz) },
    { i: ones(nx), j: ones(ny),  k: m.dzf }
  ];
  m.vol = { i: m.dx, j: m.dy, k: m.dz };
  /* Powers of length carried by each factor, so the assembly can convert to metres without
   * guessing. Every face area totals 2 and every distance totals 1. */
  m.areaPow = [[0, 1, 1], [1, 0, 1], [1, 1, 0]];
  m.distPow = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  m.volPow = [1, 1, 1];
  m.coordPow = [1, 1, 1];   // x, y, z are all lengths
}

function cylindricalFactors(m) {
  const { nx: nr, ny: nt, nz: nz, xe: re, xc: rc, dx: dr, dy: dth, dyf: dthf, dz, dxf: drf, dzf } = m;

  // Area of the annulus swept by one radial cell per unit angle: (r1^2 - r0^2)/2.
  const rArea = new Float64Array(nr);
  for (let i = 0; i < nr; i++) rArea[i] = 0.5 * (re[i + 1] * re[i + 1] - re[i] * re[i]);
  // The +r face of cell i sits at re[i+1]. At the axis the -r face has zero area, which is exactly
  // right: no flux crosses r = 0, so no coefficient is needed there.
  const rFacePlus = new Float64Array(nr);
  for (let i = 0; i < nr; i++) rFacePlus[i] = re[i + 1];

  m.area = [
    { i: rFacePlus, j: dth,      k: dz },       // A_r   = r_face * dtheta * dz
    { i: dr,        j: ones(nt), k: dz },       // A_th  = dr * dz
    { i: rArea,     j: dth,      k: ones(nz) }  // A_z   = dA_r * dtheta
  ];
  m.dist = [
    { i: drf,       j: ones(nt), k: ones(nz) }, // d_r  = drf
    { i: rc,        j: dthf,     k: ones(nz) }, // d_th = r_c * dthetaf   (arc length)
    { i: ones(nr),  j: ones(nt), k: dzf }       // d_z  = dzf
  ];
  m.vol = { i: rArea, j: dth, k: dz };          // V = dA_r * dtheta * dz
  // theta factors are radians and carry no length; rArea is an area and carries two.
  m.areaPow = [[1, 0, 1], [1, 0, 1], [2, 0, 0]];
  m.distPow = [[1, 0, 0], [1, 0, 0], [0, 0, 1]];
  m.volPow = [2, 0, 1];
  m.coordPow = [1, 0, 1];   // r and z are lengths, theta is radians
  m.rArea = rArea;
}

/* Face areas, neighbour distances and volumes converted to metres once, so the assembly and the
 * field reconstruction share one definition instead of each re-deriving the unit bookkeeping.
 * Angular factors are radians and are left alone; areaPow / distPow / volPow say which is which. */
function siFactors(m) {
  const MM = 1e-3;
  const conv = (a, pow) => {
    if (pow === 0) return a;
    const f = Math.pow(MM, pow), o = new Float64Array(a.length);
    for (let i = 0; i < a.length; i++) o[i] = a[i] * f;
    return o;
  };
  m.areaM = m.area.map((f, d) => ({
    i: conv(f.i, m.areaPow[d][0]), j: conv(f.j, m.areaPow[d][1]), k: conv(f.k, m.areaPow[d][2])
  }));
  m.distM = m.dist.map((f, d) => ({
    i: conv(f.i, m.distPow[d][0]), j: conv(f.j, m.distPow[d][1]), k: conv(f.k, m.distPow[d][2])
  }));
  m.volM = { i: conv(m.vol.i, m.volPow[0]), j: conv(m.vol.j, m.volPow[1]), k: conv(m.vol.k, m.volPow[2]) };
}

/* Cell volume in cubic metres. */
export const volumeM = (m, ix, iy, iz) => m.volM.i[ix] * m.volM.j[iy] * m.volM.k[iz];

/* Cell cross-sectional "footprint" weight for averaging over a z-plane: the area of the cell in
 * the plane, square metres. */
export const planeAreaM = (m, ix, iy) => m.areaM[2].i[ix] * m.areaM[2].j[iy];

/* Smallest and largest physical cell dimension anywhere, used for the Biot-Savart core radius,
 * the field-line step and the reported aspect ratio. In cylindrical the angular extent shrinks
 * towards the axis, so it is measured, not assumed. */
function physicalExtents(m) {
  let min = Infinity, max = 0;
  const take = v => { if (v > 0) { if (v < min) min = v; if (v > max) max = v; } };
  for (let i = 0; i < m.nx; i++) take(m.dx[i]);
  for (let k = 0; k < m.nz; k++) take(m.dz[k]);
  if (m.kind === CYLINDRICAL) {
    // Arc length varies with radius; the widest and narrowest both matter.
    let dthMin = Infinity, dthMax = 0;
    for (let j = 0; j < m.ny; j++) { dthMin = Math.min(dthMin, m.dy[j]); dthMax = Math.max(dthMax, m.dy[j]); }
    take(m.xc[0] * dthMin);
    take(m.xc[m.nx - 1] * dthMax);
  } else {
    for (let j = 0; j < m.ny; j++) take(m.dy[j]);
  }
  return { min, max };
}

/* A uniform Cartesian mesh, which is what the tool used everywhere before grading existed. */
export function uniformMesh({ x0, y0, z0, nx, ny, nz, h }) {
  const lin = (start, n) => { const e = new Float64Array(n + 1); for (let i = 0; i <= n; i++) e[i] = start + i * h; return e; };
  return makeMesh(lin(x0, nx), lin(y0, ny), lin(z0, nz));
}

export const index = (m, ix, iy, iz) => (iz * m.ny + iy) * m.nx + ix;

/* Cell centre in Cartesian coordinates, millimetres — what Biot-Savart and the 3D view need. */
export function centreXYZ(m, ix, iy, iz) {
  if (m.kind === CYLINDRICAL) {
    const r = m.xc[ix], t = m.yc[iy];
    return [r * Math.cos(t), r * Math.sin(t), m.zc[iz]];
  }
  return [m.xc[ix], m.yc[iy], m.zc[iz]];
}

/* Rotate a field vector from the mesh's own basis into Cartesian. In cylindrical the solver's
 * components are (B_r, B_theta, B_z). */
export function toCartesianVector(m, iy, v0, v1, v2) {
  if (m.kind !== CYLINDRICAL) return [v0, v1, v2];
  const t = m.yc[iy], ct = Math.cos(t), st = Math.sin(t);
  return [v0 * ct - v1 * st, v0 * st + v1 * ct, v2];
}

/* The cell containing a coordinate, clamped to the mesh. Binary search, since the edges are not
 * evenly spaced and cannot be divided into. */
export function locate(edges, n, v) {
  if (v <= edges[0]) return 0;
  if (v >= edges[n]) return n - 1;
  let lo = 0, hi = n;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (edges[mid] <= v) lo = mid; else hi = mid; }
  return lo;
}

/* How many cells span [a, b] along an axis. Fractional, so "2.4 cells across the gap" reads
 * honestly rather than rounding up to a comfortable-looking 3. */
export function cellsAcross(edges, n, a, b) {
  if (b <= a) return 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const lo = Math.max(a, edges[i]), hi = Math.min(b, edges[i + 1]);
    if (hi > lo) count += (hi - lo) / (edges[i + 1] - edges[i]);
  }
  return count;
}

/* Human-readable summary, for AFS.plan() and the solver panel. */
export function meshStats(m) {
  const s = {
    kind: m.kind,
    dimensions: [m.nx, m.ny, m.nz],
    cells: m.N,
    uniform: m.uniform,
    periodicY: m.periodicY,
    sectors: m.sectors,
    smallestCell_mm: m.hMin,
    largestCell_mm: m.hMax,
    worstAspectRatio: m.aspect
  };
  if (m.kind === CYLINDRICAL) {
    s.extent = { r_mm: [m.x0, m.x1], theta_deg: [m.y0 * 180 / Math.PI, m.y1 * 180 / Math.PI], z_mm: [m.z0, m.z1] };
    s.angularCells = m.ny;
    s.sectorSpan_deg = (m.y1 - m.y0) * 180 / Math.PI;
  } else {
    s.extent_mm = { x: [m.x0, m.x1], y: [m.y0, m.y1], z: [m.z0, m.z1] };
  }
  return s;
}
