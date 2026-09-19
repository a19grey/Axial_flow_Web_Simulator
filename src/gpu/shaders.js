/* Solver compute shaders (WGSL), verbatim from the validated single-file build.
 *
 * Pipeline per solve:
 *   bs       Biot-Savart: per-phase free-space H from the trace segments, 9 floats/cell
 *   combine  weight the three cached phase fields by the actual currents -> Hs
 *   rhs      magnetic-charge source at material boundaries -> b
 *   init     CG start: x = 0, r = b, p = M^-1 r, and the first two dot products
 *   matvec / reduce / update / pupdate   one Jacobi-preconditioned CG iteration
 *
 * The CG scalars live in `scal` on the GPU; only the residual is read back, once per check interval.
 */

/* Shared uniform block.
 *
 * `gx` is the number of workgroups dispatched along x. WebGPU caps workgroups per dimension at
 * 65535, which at 256 threads each is only 16.7 M cells — and the Biot-Savart kernel, at 64
 * threads, runs out at 4.2 M. Meshes larger than that are exactly the point of grading, so every
 * cell-wide kernel dispatches a 2D grid and linearises the index itself. */
export const WP = `struct Params { nx:u32, ny:u32, nz:u32, count:u32, nParts:u32, sy:u32, sz:u32, gx:u32, h:f32, periodicY:u32, pad1:u32, pad2:u32 };
@group(0) @binding(0) var<uniform> P: Params;
fn cellIndex(gi: vec3u, wg: u32) -> u32 { return gi.y * P.gx * wg + gi.x; }
fn partIndex(w: vec3u) -> u32 { return w.y * P.gx + w.x; }

/* Neighbour indices along axis 1, which wraps when that axis is periodic.
 *
 * A full machine in cylindrical coordinates is periodic in theta: the last angular row and the
 * first are neighbours, with no boundary between them. The face coefficient is always the +theta
 * coefficient of the *lower* cell, so cY[ym] is correct either way. The branch is uniform across
 * the dispatch and the divisions are skipped entirely on a Cartesian mesh. */
struct Nb { yp: u32, ym: u32 };
fn yNeighbours(i: u32) -> Nb {
  var n: Nb;
  n.yp = i + P.sy; n.ym = i - P.sy;
  if (P.periodicY == 1u) {
    let iy = (i / P.nx) % P.ny;
    if (iy == P.ny - 1u) { n.yp = i + P.sy - P.sz; }
    if (iy == 0u) { n.ym = i - P.sy + P.sz; }
  }
  return n;
}`;
const RED = `
  sA[l] = a; sB[l] = c; workgroupBarrier();
  for (var s = 128u; s > 0u; s = s >> 1u) { if (l < s) { sA[l] += sA[l + s]; sB[l] += sB[l + s]; } workgroupBarrier(); }
  if (l == 0u) { let pi = partIndex(w); partA[pi] = sA[0]; partB[pi] = sB[0]; }`;
const BI = `@builtin(global_invocation_id) gi: vec3u, @builtin(local_invocation_index) l: u32, @builtin(workgroup_id) w: vec3u`;

export const SH = {};
SH.init = `${WP}
@group(0) @binding(1) var<storage, read> diag: array<f32>;
@group(0) @binding(2) var<storage, read> b: array<f32>;
@group(0) @binding(3) var<storage, read_write> x: array<f32>;
@group(0) @binding(4) var<storage, read_write> r: array<f32>;
@group(0) @binding(5) var<storage, read_write> p: array<f32>;
@group(0) @binding(6) var<storage, read_write> partA: array<f32>;
@group(0) @binding(7) var<storage, read_write> partB: array<f32>;
var<workgroup> sA: array<f32, 256>; var<workgroup> sB: array<f32, 256>;
@compute @workgroup_size(256)
fn main(${BI}) {
  let i = cellIndex(gi, 256u); var a = 0.0; var c = 0.0;
  if (i < P.count) {
    let d = diag[i]; x[i] = 0.0;
    if (d > 0.0) { let ri = b[i]; r[i] = ri; let z = ri / d; p[i] = z; a = ri * z; c = ri * ri; }
    else { r[i] = 0.0; p[i] = 0.0; }
  }${RED}
}`;
SH.matvec = `${WP}
@group(0) @binding(1) var<storage, read> cX: array<f32>;
@group(0) @binding(2) var<storage, read> cY: array<f32>;
@group(0) @binding(3) var<storage, read> cZ: array<f32>;
@group(0) @binding(4) var<storage, read> diag: array<f32>;
@group(0) @binding(5) var<storage, read> p: array<f32>;
@group(0) @binding(6) var<storage, read_write> Ap: array<f32>;
@group(0) @binding(7) var<storage, read_write> partA: array<f32>;
var<workgroup> sA: array<f32, 256>;
@compute @workgroup_size(256)
fn main(${BI}) {
  let i = cellIndex(gi, 256u); var a = 0.0;
  if (i < P.count) {
    let d = diag[i];
    if (d > 0.0) {
      let sz = P.sz; let nb = yNeighbours(i);
      let v = d * p[i] - cX[i] * p[i + 1u] - cX[i - 1u] * p[i - 1u]
                       - cY[i] * p[nb.yp] - cY[nb.ym] * p[nb.ym]
                       - cZ[i] * p[i + sz] - cZ[i - sz] * p[i - sz];
      Ap[i] = v; a = p[i] * v;
    } else { Ap[i] = 0.0; }
  }
  sA[l] = a; workgroupBarrier();
  for (var s = 128u; s > 0u; s = s >> 1u) { if (l < s) { sA[l] += sA[l + s]; } workgroupBarrier(); }
  if (l == 0u) { partA[partIndex(w)] = sA[0]; }
}`;
SH.reduce = `${WP}
override MODE: u32 = 0u;
@group(0) @binding(1) var<storage, read> partA: array<f32>;
@group(0) @binding(2) var<storage, read> partB: array<f32>;
@group(0) @binding(3) var<storage, read_write> scal: array<f32>;
var<workgroup> sA: array<f32, 256>; var<workgroup> sB: array<f32, 256>;
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) l: u32) {
  var a = 0.0; var c = 0.0;
  for (var k = l; k < P.nParts; k = k + 256u) { a += partA[k]; c += partB[k]; }
  sA[l] = a; sB[l] = c; workgroupBarrier();
  for (var s = 128u; s > 0u; s = s >> 1u) { if (l < s) { sA[l] += sA[l + s]; sB[l] += sB[l + s]; } workgroupBarrier(); }
  if (l == 0u) {
    let A = sA[0]; let C = sB[0];
    if (MODE == 0u) { scal[0] = A; scal[4] = C; scal[5] = C; scal[6] = 0.0; }
    else if (MODE == 1u) { scal[1] = A; let al = scal[0] / A; scal[2] = select(0.0, al, A > 0.0 && abs(al) < 3.0e38); }
    else { let rz = scal[0]; let be = A / rz; scal[3] = select(0.0, be, rz > 0.0 && abs(be) < 3.0e38); scal[0] = A; scal[4] = C; scal[6] = scal[6] + 1.0; }
  }
}`;
SH.update = `${WP}
@group(0) @binding(1) var<storage, read> diag: array<f32>;
@group(0) @binding(2) var<storage, read_write> x: array<f32>;
@group(0) @binding(3) var<storage, read_write> r: array<f32>;
@group(0) @binding(4) var<storage, read> p: array<f32>;
@group(0) @binding(5) var<storage, read> Ap: array<f32>;
@group(0) @binding(6) var<storage, read_write> partA: array<f32>;
@group(0) @binding(7) var<storage, read_write> partB: array<f32>;
@group(0) @binding(8) var<storage, read> scal: array<f32>;
var<workgroup> sA: array<f32, 256>; var<workgroup> sB: array<f32, 256>;
@compute @workgroup_size(256)
fn main(${BI}) {
  let i = cellIndex(gi, 256u); var a = 0.0; var c = 0.0; let al = scal[2];
  if (i < P.count) {
    let d = diag[i];
    if (d > 0.0) { x[i] = x[i] + al * p[i]; let ri = r[i] - al * Ap[i]; r[i] = ri; a = ri * ri / d; c = ri * ri; }
  }${RED}
}`;
SH.pupdate = `${WP}
@group(0) @binding(1) var<storage, read> diag: array<f32>;
@group(0) @binding(2) var<storage, read> r: array<f32>;
@group(0) @binding(3) var<storage, read_write> p: array<f32>;
@group(0) @binding(4) var<storage, read> scal: array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gi: vec3u) {
  let i = cellIndex(gi, 256u);
  if (i < P.count) { let d = diag[i]; if (d > 0.0) { p[i] = r[i] / d + scal[3] * p[i]; } }
}`;
SH.bs = `struct BSP { count:u32, nx:u32, ny:u32, segStart:u32, segEnd:u32, gx:u32, cyl:u32, p2:u32, origin:vec4f, misc:vec4f };
struct Seg { a: vec4f, b: vec4f };
@group(0) @binding(0) var<uniform> Q: BSP;
@group(0) @binding(1) var<storage, read> segs: array<Seg>;
@group(0) @binding(2) var<storage, read_write> H: array<f32>;
// Cell-centre coordinates in metres, one table per axis. A uniform grid is just the case where
// these are evenly spaced, so there is one code path.
@group(0) @binding(3) var<storage, read> xc: array<f32>;
@group(0) @binding(4) var<storage, read> yc: array<f32>;
@group(0) @binding(5) var<storage, read> zc: array<f32>;
var<workgroup> tile: array<Seg, 64>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gi: vec3u, @builtin(local_invocation_index) l: u32) {
  let i = gi.y * Q.gx * 64u + gi.x;
  let ix = i % Q.nx; let iy = (i / Q.nx) % Q.ny; let iz = i / (Q.nx * Q.ny);
  let live = i < Q.count;
  /* Axis tables hold (x, y, z) on a Cartesian mesh and (r, theta, z) on a cylindrical one. */
  let ct = cos(yc[iy]); let st = sin(yc[iy]);
  let cart = vec3f(xc[ix], yc[iy], zc[iz]);
  let cyl = vec3f(xc[ix] * ct, xc[ix] * st, zc[iz]);
  let pos = select(vec3f(0.0), select(cart, cyl, Q.cyl == 1u), live);
  let eps2 = Q.misc.x;
  var hA = vec3f(0.0); var hB = vec3f(0.0); var hC = vec3f(0.0);
  for (var base = Q.segStart; base < Q.segEnd; base = base + 64u) {
    let j = base + l;
    if (j < Q.segEnd) { tile[l] = segs[j]; }
    workgroupBarrier();
    let cnt = min(64u, Q.segEnd - base);
    for (var t = 0u; t < cnt; t = t + 1u) {
      let s = tile[t];
      let d = s.b.xyz - s.a.xyz; let r1 = pos - s.a.xyz; let r2 = pos - s.b.xyz;
      let L1 = max(length(r1), 1e-9); let L2 = max(length(r2), 1e-9);
      let c = cross(r1, r2);
      let f = (dot(d, r1) / L1 - dot(d, r2) / L2) / (dot(c, c) + eps2 * dot(d, d)) * 0.0795774715459;
      let dh = c * f;
      let ph = u32(s.a.w + 0.5);
      if (ph == 0u) { hA += dh; } else if (ph == 1u) { hB += dh; } else { hC += dh; }
    }
    workgroupBarrier();
  }
  if (live) {
    /* Store Hs in the mesh's own basis, so the assembly's face normals and the components line up.
     * On a cylindrical mesh that means rotating (Hx, Hy) into (H_r, H_theta). */
    if (Q.cyl == 1u) {
      hA = vec3f( hA.x * ct + hA.y * st, -hA.x * st + hA.y * ct, hA.z);
      hB = vec3f( hB.x * ct + hB.y * st, -hB.x * st + hB.y * ct, hB.z);
      hC = vec3f( hC.x * ct + hC.y * st, -hC.x * st + hC.y * ct, hC.z);
    }
    let o = 9u * i;
    H[o] += hA.x; H[o + 1u] += hA.y; H[o + 2u] += hA.z;
    H[o + 3u] += hB.x; H[o + 4u] += hB.y; H[o + 5u] += hB.z;
    H[o + 6u] += hC.x; H[o + 7u] += hC.y; H[o + 8u] += hC.z;
  }
}`;
SH.combine = `${WP}
@group(0) @binding(1) var<uniform> I: vec4f;
@group(0) @binding(2) var<storage, read> H: array<f32>;
@group(0) @binding(3) var<storage, read_write> Hs: array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gi: vec3u) {
  let i = cellIndex(gi, 256u);
  if (i < P.count) {
    let o = 9u * i;
    for (var c = 0u; c < 3u; c = c + 1u) { Hs[3u * i + c] = I.x * H[o + c] + I.y * H[o + 3u + c] + I.z * H[o + 6u + c]; }
  }
}`;
SH.rhs = `${WP}
@group(0) @binding(1) var<storage, read> sX: array<f32>;
@group(0) @binding(2) var<storage, read> sY: array<f32>;
@group(0) @binding(3) var<storage, read> sZ: array<f32>;
@group(0) @binding(4) var<storage, read> diag: array<f32>;
@group(0) @binding(5) var<storage, read> Hs: array<f32>;
@group(0) @binding(6) var<storage, read_write> b: array<f32>;
fn hs(k: u32, c: u32) -> f32 { return Hs[3u * k + c]; }
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gi: vec3u) {
  let i = cellIndex(gi, 256u);
  if (i < P.count) {
    if (diag[i] > 0.0) {
      let sz = P.sz; let nb = yNeighbours(i);
      // Magnetic charge at material boundaries: the net outward flux of (mu_f - 1) Hs over the
      // cell's six faces. sX/sY/sZ already carry (mu_f - 1) A_f, so no geometry factor is needed.
      // Hs is stored in the mesh's own basis, so component 1 is Hs_theta on a cylindrical mesh.
      let s = sX[i] * 0.5 * (hs(i, 0u) + hs(i + 1u, 0u)) - sX[i - 1u] * 0.5 * (hs(i, 0u) + hs(i - 1u, 0u))
            + sY[i] * 0.5 * (hs(i, 1u) + hs(nb.yp, 1u)) - sY[nb.ym] * 0.5 * (hs(i, 1u) + hs(nb.ym, 1u))
            + sZ[i] * 0.5 * (hs(i, 2u) + hs(i + sz, 2u)) - sZ[i - sz] * 0.5 * (hs(i, 2u) + hs(i - sz, 2u));
      b[i] = -s;
    } else { b[i] = 0.0; }
  }
}`;
