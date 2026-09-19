/* Orthogonal tensor-product mesh.
 *
 * A mesh is three independent lists of node coordinates. Cells are the boxes between them, so the
 * mesh is fully described by the edges and everything else — centres, widths, face areas, volumes,
 * neighbour distances — follows. A uniform grid is just the special case where the edges are
 * evenly spaced, so one code path serves both.
 *
 * Everything the finite-volume assembly needs is a face area and a neighbour distance, and
 * everything the solver needs is a per-face coefficient. That is why grading costs almost nothing
 * in the GPU kernels: the matvec already consumed per-face coefficient arrays.
 *
 * Lengths are millimetres. Conversion to metres happens where the physics needs it.
 */

/* Build a mesh from three edge arrays. Each must be strictly increasing. */
export function makeMesh(xe, ye, ze, kind = "cartesian") {
  const ax = axis(xe, "x"), ay = axis(ye, "y"), az = axis(ze, "z");
  const nx = ax.n, ny = ay.n, nz = az.n;
  return {
    kind, nx, ny, nz, N: nx * ny * nz,
    sy: nx, sz: nx * ny,
    xe: ax.e, ye: ay.e, ze: az.e,
    xc: ax.c, yc: ay.c, zc: az.c,
    dx: ax.d, dy: ay.d, dz: az.d,
    // Centre-to-centre distance to the next cell. The last entry is never used by an interior
    // equation; it is set to the cell width so no consumer can divide by zero.
    dxf: ax.df, dyf: ay.df, dzf: az.df,
    x0: ax.e[0], y0: ay.e[0], z0: az.e[0],
    x1: ax.e[nx], y1: ay.e[ny], z1: az.e[nz],
    uniform: ax.uniform && ay.uniform && az.uniform,
    // Representative cell size, for display and for the Biot-Savart core radius. The smallest cell
    // is the one that matters for both.
    hMin: Math.min(ax.min, ay.min, az.min),
    hMax: Math.max(ax.max, ay.max, az.max),
    // Worst cell aspect ratio, which is what degrades the conditioning of the solve.
    aspect: Math.max(ax.max, ay.max, az.max) / Math.min(ax.min, ay.min, az.min)
  };
}

function axis(e, name) {
  const n = e.length - 1;
  if (n < 1) throw new Error(`The ${name} axis needs at least two nodes.`);
  const E = e instanceof Float64Array ? e : Float64Array.from(e);
  const c = new Float64Array(n), d = new Float64Array(n), df = new Float64Array(n);
  let min = Infinity, max = 0;
  for (let i = 0; i < n; i++) {
    d[i] = E[i + 1] - E[i];
    if (!(d[i] > 0)) throw new Error(`The ${name} axis is not strictly increasing at node ${i}.`);
    c[i] = 0.5 * (E[i] + E[i + 1]);
    if (d[i] < min) min = d[i];
    if (d[i] > max) max = d[i];
  }
  for (let i = 0; i < n - 1; i++) df[i] = c[i + 1] - c[i];
  df[n - 1] = d[n - 1];
  // Treat spacing as uniform when it varies by less than a part in 1e9, so a mesh generated as
  // uniform is recognised as such despite floating-point accumulation.
  return { n, e: E, c, d, df, min, max, uniform: (max - min) <= 1e-9 * max };
}

/* A uniform mesh, which is what the tool used everywhere before grading existed. */
export function uniformMesh({ x0, y0, z0, nx, ny, nz, h }) {
  const lin = (start, n) => { const e = new Float64Array(n + 1); for (let i = 0; i <= n; i++) e[i] = start + i * h; return e; };
  return makeMesh(lin(x0, nx), lin(y0, ny), lin(z0, nz));
}

/* Cell-centre coordinates, millimetres. */
export function centre(m, ix, iy, iz) { return [m.xc[ix], m.yc[iy], m.zc[iz]]; }

export const index = (m, ix, iy, iz) => (iz * m.ny + iy) * m.nx + ix;

/* Split a flat cell index back into its three components. */
export function unindex(m, k) {
  const ix = k % m.nx, iy = ((k - ix) / m.nx) % m.ny;
  return [ix, iy, (k - ix - iy * m.nx) / (m.nx * m.ny)];
}

/* Face areas of the +x, +y and +z faces of cell (ix, iy, iz), in mm^2. On a Cartesian mesh a face
 * area depends only on the two transverse indices. */
export const areaX = (m, iy, iz) => m.dy[iy] * m.dz[iz];
export const areaY = (m, ix, iz) => m.dx[ix] * m.dz[iz];
export const areaZ = (m, ix, iy) => m.dx[ix] * m.dy[iy];
export const volume = (m, ix, iy, iz) => m.dx[ix] * m.dy[iy] * m.dz[iz];

/* The cell containing a coordinate, clamped to the mesh. Binary search, since the edges are not
 * evenly spaced and cannot be divided into. */
export function locate(edges, n, v) {
  if (v <= edges[0]) return 0;
  if (v >= edges[n]) return n - 1;
  let lo = 0, hi = n;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (edges[mid] <= v) lo = mid; else hi = mid; }
  return lo;
}

export const locateX = (m, x) => locate(m.xe, m.nx, x);
export const locateY = (m, y) => locate(m.ye, m.ny, y);
export const locateZ = (m, z) => locate(m.ze, m.nz, z);

/* Human-readable summary, for AFS.plan() and the solver panel. */
export function meshStats(m) {
  return {
    kind: m.kind,
    dimensions: [m.nx, m.ny, m.nz],
    cells: m.N,
    uniform: m.uniform,
    smallestCell_mm: m.hMin,
    largestCell_mm: m.hMax,
    worstAspectRatio: m.aspect,
    extent_mm: { x: [m.x0, m.x1], y: [m.y0, m.y1], z: [m.z0, m.z1] }
  };
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
