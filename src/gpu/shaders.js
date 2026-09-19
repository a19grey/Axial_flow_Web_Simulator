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

export const WP = `struct Params { nx:u32, ny:u32, nz:u32, count:u32, nParts:u32, sy:u32, sz:u32, h:f32 };
@group(0) @binding(0) var<uniform> P: Params;`;
const RED = `
  sA[l] = a; sB[l] = c; workgroupBarrier();
  for (var s = 128u; s > 0u; s = s >> 1u) { if (l < s) { sA[l] += sA[l + s]; sB[l] += sB[l + s]; } workgroupBarrier(); }
  if (l == 0u) { partA[w.x] = sA[0]; partB[w.x] = sB[0]; }`;
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
  let i = gi.x; var a = 0.0; var c = 0.0;
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
  let i = gi.x; var a = 0.0;
  if (i < P.count) {
    let d = diag[i];
    if (d > 0.0) {
      let sy = P.sy; let sz = P.sz;
      let v = d * p[i] - cX[i] * p[i + 1u] - cX[i - 1u] * p[i - 1u]
                       - cY[i] * p[i + sy] - cY[i - sy] * p[i - sy]
                       - cZ[i] * p[i + sz] - cZ[i - sz] * p[i - sz];
      Ap[i] = v; a = p[i] * v;
    } else { Ap[i] = 0.0; }
  }
  sA[l] = a; workgroupBarrier();
  for (var s = 128u; s > 0u; s = s >> 1u) { if (l < s) { sA[l] += sA[l + s]; } workgroupBarrier(); }
  if (l == 0u) { partA[w.x] = sA[0]; }
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
  let i = gi.x; var a = 0.0; var c = 0.0; let al = scal[2];
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
  let i = gi.x;
  if (i < P.count) { let d = diag[i]; if (d > 0.0) { p[i] = r[i] / d + scal[3] * p[i]; } }
}`;
SH.bs = `struct BSP { count:u32, nx:u32, ny:u32, segStart:u32, segEnd:u32, p0:u32, p1:u32, p2:u32, origin:vec4f, misc:vec4f };
struct Seg { a: vec4f, b: vec4f };
@group(0) @binding(0) var<uniform> Q: BSP;
@group(0) @binding(1) var<storage, read> segs: array<Seg>;
@group(0) @binding(2) var<storage, read_write> H: array<f32>;
var<workgroup> tile: array<Seg, 64>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gi: vec3u, @builtin(local_invocation_index) l: u32) {
  let i = gi.x;
  let ix = i % Q.nx; let iy = (i / Q.nx) % Q.ny; let iz = i / (Q.nx * Q.ny);
  let pos = Q.origin.xyz + (vec3f(f32(ix), f32(iy), f32(iz)) + vec3f(0.5)) * Q.origin.w;
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
  if (i < Q.count) {
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
  let i = gi.x;
  if (i < P.count) {
    let o = 9u * i;
    for (var c = 0u; c < 3u; c = c + 1u) { Hs[3u * i + c] = I.x * H[o + c] + I.y * H[o + 3u + c] + I.z * H[o + 6u + c]; }
  }
}`;
SH.rhs = `${WP}
@group(0) @binding(1) var<storage, read> cX: array<f32>;
@group(0) @binding(2) var<storage, read> cY: array<f32>;
@group(0) @binding(3) var<storage, read> cZ: array<f32>;
@group(0) @binding(4) var<storage, read> diag: array<f32>;
@group(0) @binding(5) var<storage, read> Hs: array<f32>;
@group(0) @binding(6) var<storage, read_write> b: array<f32>;
fn hs(k: u32, c: u32) -> f32 { return Hs[3u * k + c]; }
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gi: vec3u) {
  let i = gi.x;
  if (i < P.count) {
    if (diag[i] > 0.0) {
      let sy = P.sy; let sz = P.sz;
      let s = (cX[i] - 1.0) * 0.5 * (hs(i, 0u) + hs(i + 1u, 0u)) - (cX[i - 1u] - 1.0) * 0.5 * (hs(i, 0u) + hs(i - 1u, 0u))
            + (cY[i] - 1.0) * 0.5 * (hs(i, 1u) + hs(i + sy, 1u)) - (cY[i - sy] - 1.0) * 0.5 * (hs(i, 1u) + hs(i - sy, 1u))
            + (cZ[i] - 1.0) * 0.5 * (hs(i, 2u) + hs(i + sz, 2u)) - (cZ[i - sz] - 1.0) * 0.5 * (hs(i, 2u) + hs(i - sz, 2u));
      b[i] = -P.h * s;
    } else { b[i] = 0.0; }
  }
}`;

