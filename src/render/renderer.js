/* The 3D view: WebGPU rendering of the machine and its field.
 *
 * The machine is drawn from its analytic geometry — smooth meshes for the rotor, back plate and
 * PCB, ribbon traces coloured by phase — not from the solver grid. The field appears three ways:
 *
 *   volume glow   |B| in a filtered rgba16float 3D texture, ray-marched per pixel
 *   field lines   RK2 streamlines of B, seeded in proportion to gap flux
 *   slices        a gap plane or an axial section, coloured by B_z or |B|
 *
 * Ported unchanged from the single-file build. This module owns the canvas and therefore does
 * touch the DOM; src/core and src/gpu do not.
 */

import { $ } from "../ui/dom.js";
import { INF, DIV, lutRow, css, fmtB, pctl } from "../ui/format.js";
import { initGPU } from "../gpu/device.js";
import { locate, CYLINDRICAL } from "../core/mesh.js";
import { buildMeshes } from "./meshes.js";

/* ---- small linear algebra, column-major ---- */
const M4 = {
  persp(fy, asp, n, f) { const t = 1 / Math.tan(fy / 2), m = new Float32Array(16); m[0] = t / asp; m[5] = t; m[10] = f / (n - f); m[11] = -1; m[14] = n * f / (n - f); return m; },
  look(e, c, u) {
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], nrm = a => { const l = Math.hypot(...a); return a.map(x => x / l); };
    const cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], dt = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const z = nrm(sub(e, c)), x = nrm(cr(u, z)), y = cr(z, x);
    return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dt(x, e), -dt(y, e), -dt(z, e), 1]);
  },
  mul(a, b) { const r = new Float32Array(16); for (let c = 0; c < 4; c++) for (let i = 0; i < 4; i++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + i] * b[c * 4 + k]; r[c * 4 + i] = s; } return r; },
  inv(m) {
    const a = m, o = new Float32Array(16);
    const b00 = a[0]*a[5]-a[1]*a[4], b01 = a[0]*a[6]-a[2]*a[4], b02 = a[0]*a[7]-a[3]*a[4], b03 = a[1]*a[6]-a[2]*a[5];
    const b04 = a[1]*a[7]-a[3]*a[5], b05 = a[2]*a[7]-a[3]*a[6], b06 = a[8]*a[13]-a[9]*a[12], b07 = a[8]*a[14]-a[10]*a[12];
    const b08 = a[8]*a[15]-a[11]*a[12], b09 = a[9]*a[14]-a[10]*a[13], b10 = a[9]*a[15]-a[11]*a[13], b11 = a[10]*a[15]-a[11]*a[14];
    const d = 1 / (b00*b11 - b01*b10 + b02*b09 + b03*b08 - b04*b07 + b05*b06);
    o[0]=(a[5]*b11-a[6]*b10+a[7]*b09)*d; o[1]=(a[2]*b10-a[1]*b11-a[3]*b09)*d; o[2]=(a[13]*b05-a[14]*b04+a[15]*b03)*d; o[3]=(a[10]*b04-a[9]*b05-a[11]*b03)*d;
    o[4]=(a[6]*b08-a[4]*b11-a[7]*b07)*d; o[5]=(a[0]*b11-a[2]*b08+a[3]*b07)*d; o[6]=(a[14]*b02-a[12]*b05-a[15]*b01)*d; o[7]=(a[8]*b05-a[10]*b02+a[11]*b01)*d;
    o[8]=(a[4]*b10-a[5]*b08+a[7]*b06)*d; o[9]=(a[1]*b08-a[0]*b10-a[3]*b06)*d; o[10]=(a[12]*b04-a[13]*b02+a[15]*b00)*d; o[11]=(a[9]*b02-a[8]*b04-a[11]*b00)*d;
    o[12]=(a[5]*b07-a[4]*b09-a[6]*b06)*d; o[13]=(a[0]*b09-a[1]*b07+a[2]*b06)*d; o[14]=(a[13]*b01-a[12]*b03-a[14]*b00)*d; o[15]=(a[8]*b03-a[9]*b01+a[10]*b00)*d;
    return o;
  }
};

/* Trilinear sampling of the solved field at an arbitrary Cartesian point, returning Cartesian
 * components.
 *
 * On a graded mesh the bracketing cell has to be found by search rather than division, and the
 * weight is the fraction of the centre-to-centre distance rather than of a fixed cell size. On a
 * cylindrical mesh the point is first converted to (r, theta, z), theta is folded into the modelled
 * span — which is exactly what periodicity means, and is how a one-pole-pair sector still draws the
 * whole machine — and the interpolated (B_r, B_theta) are rotated back into (B_x, B_y).
 */
export function makeSampler(sol) {
  const { job, Bx, By, Bz } = sol, m = job.mesh;
  const { nx, ny, nz, xc, yc, zc } = m;
  const cyl = m.kind === CYLINDRICAL;
  const span = m.y1 - m.y0;

  // Bracket a value between cell centres: returns the lower index and the fraction across.
  const brk = (c, n, v) => {
    if (v <= c[0]) return [0, 0];
    if (v >= c[n - 1]) return [n - 2, 1];
    const i = locate(c, n - 1, v);
    return [i, (v - c[i]) / (c[i + 1] - c[i])];
  };
  // Angular bracket, wrapping between the last cell centre and the first across the seam.
  const brkTheta = (v) => {
    let t = m.y0 + (((v - m.y0) % span) + span) % span;
    if (t < yc[0]) {
      const d = (yc[0] - m.y0) + (m.y1 - yc[ny - 1]);
      return [ny - 1, d > 0 ? ((t - m.y0) + (m.y1 - yc[ny - 1])) / d : 0, true];
    }
    if (t > yc[ny - 1]) {
      const d = (yc[0] - m.y0) + (m.y1 - yc[ny - 1]);
      return [ny - 1, d > 0 ? (t - yc[ny - 1]) / d : 0, true];
    }
    const j = locate(yc, ny - 1, t);
    return [j, (t - yc[j]) / (yc[j + 1] - yc[j]), false];
  };

  return function sample(x, y, z, o) {
    let i, fu, j, fv, wrapJ = false;
    let ct = 1, st = 0;
    if (cyl) {
      const r = Math.hypot(x, y);
      if (r > 1e-9) { ct = x / r; st = y / r; }
      [i, fu] = brk(xc, nx, r);
      [j, fv, wrapJ] = brkTheta(Math.atan2(y, x));
    } else {
      [i, fu] = brk(xc, nx, x);
      [j, fv] = brk(yc, ny, y);
    }
    const [k, fw] = brk(zc, nz, z);
    const jNext = wrapJ ? 0 : j + 1;
    let b0 = 0, b1 = 0, b2 = 0;
    for (let c = 0; c < 8; c++) {
      const di = c & 1, dj = (c >> 1) & 1, dk = c >> 2;
      const wt = (di ? fu : 1 - fu) * (dj ? fv : 1 - fv) * (dk ? fw : 1 - fw);
      if (wt === 0) continue;
      const q = ((k + dk) * ny + (dj ? jNext : j)) * nx + i + di;
      b0 += wt * Bx[q]; b1 += wt * By[q]; b2 += wt * Bz[q];
    }
    if (cyl) { o[0] = b0 * ct - b1 * st; o[1] = b0 * st + b1 * ct; }
    else { o[0] = b0; o[1] = b1; }
    o[2] = b2;
    return o;
  };
}

/* The Cartesian bounding box of the mesh, which is what the 3D view draws into. */
export function boundingBox(m) {
  if (m.kind === CYLINDRICAL) return [[-m.x1, -m.x1, m.z0], [m.x1, m.x1, m.z1]];
  return [[m.x0, m.y0, m.z0], [m.x1, m.y1, m.z1]];
}

/* ---- field lines: RK2 streamlines of B, seeded in proportion to flux ---- */
function traceLines(sol, bScale) {
  const { job } = sol, mesh = job.mesh;
  const bb = boundingBox(mesh);
  const m = 1.5 * mesh.hMax;
  const S = makeSampler(sol);
  let zs, rA, rB;
  if (job.kind === "motor") { zs = (Math.max(...job.zLay) + job.g.zTB) / 2; rA = job.p.ri + 0.5; rB = job.p.ro - 0.5; }
  else if (job.kind === "sphere") { zs = 0; rA = 0; rB = 1.8 * job.a; }
  else { zs = 0; rA = 0.1 * job.R; rB = 0.92 * job.R; }
  const o = [0, 0, 0], cand = [];
  let bmax = 0;
  for (let ir = 0; ir < 7; ir++) for (let ia = 0; ia < 120; ia++) {
    const r = rA + (rB - rA) * (ir + 0.5) / 7, a = 2 * Math.PI * (ia + 0.5 * (ir % 2)) / 120;
    const x = r * Math.cos(a), y = r * Math.sin(a), bz = Math.abs(S(x, y, zs, o)[2]);
    cand.push([x, y, bz * r]); bmax = Math.max(bmax, bz * r);
  }
  let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const seeds = cand.filter(c => rnd() < 0.42 * c[2] / bmax).map(c => [c[0], c[1], zs]);
  // Step along the line with the finest cell, so a line through the gap is not stepped over.
  const ds = 0.5 * mesh.hMin, floor = bScale * 1e-3, segs = [];
  const step = (p, sgn) => {
    const b = S(p[0], p[1], p[2], o), l = Math.hypot(...b); if (l < floor) return null;
    const mid = [p[0] + sgn * b[0] / l * ds / 2, p[1] + sgn * b[1] / l * ds / 2, p[2] + sgn * b[2] / l * ds / 2];
    const b2 = S(mid[0], mid[1], mid[2], o), l2 = Math.hypot(...b2); if (l2 < floor) return null;
    return [[p[0] + sgn * b2[0] / l2 * ds, p[1] + sgn * b2[1] / l2 * ds, p[2] + sgn * b2[2] / l2 * ds], l2];
  };
  const inside = p => p[0] > bb[0][0] + m && p[0] < bb[1][0] - m && p[1] > bb[0][1] + m && p[1] < bb[1][1] - m
                   && p[2] > bb[0][2] + m && p[2] < bb[1][2] - m;
  for (const s0 of seeds) {
    for (const sgn of [1, -1]) {
      let p = s0, lp = Math.hypot(...S(p[0], p[1], p[2], o));
      for (let n = 0; n < 900; n++) {
        const r = step(p, sgn); if (!r) break;
        const [q, l] = r; if (!inside(q)) break;
        const ta = Math.min(1, Math.sqrt(lp / bScale)), tb = Math.min(1, Math.sqrt(l / bScale));
        segs.push(p[0], p[1], p[2], ta, q[0], q[1], q[2], tb);
        p = q; lp = l;
        if (n > 30 && Math.hypot(p[0] - s0[0], p[1] - s0[1], p[2] - s0[2]) < ds) break;
      }
    }
  }
  return { data: new Float32Array(segs), count: segs.length / 8, seeds: seeds.length };
}

/* ---- float16 packing for the field texture ---- */
const _f = new Float32Array(1), _u = new Uint32Array(_f.buffer);
function half(v) {
  _f[0] = v; const x = _u[0], s = (x >>> 16) & 0x8000; let e = ((x >>> 23) & 255) - 112, m = x & 0x7fffff;
  if (e <= 0) { if (e < -10) return s; m = (m | 0x800000) >> (1 - e); return s | ((m + 0x1000) >> 13); }
  if (e >= 31) return s | 0x7c00;
  return s | ((e << 10) + ((m + 0x1000) >> 13));
}

/* ---- WGSL ---- */
const FRAME = `struct Frame { vp: mat4x4f, ivp: mat4x4f, cam: vec4f, bmin: vec4f, bmax: vec4f, a: vec4f, b: vec4f, c: vec4f };
@group(0) @binding(0) var<uniform> F: Frame;
fn clipped(p: vec3f) -> bool { return F.bmin.w > 0.5 && p.y < -0.001; }`;
const WG_MESH = `${FRAME}
struct VO { @builtin(position) pos: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f, @location(2) col: vec4f };
@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) c: vec4f) -> VO {
  var o: VO; o.pos = F.vp * vec4f(p, 1.0); o.wp = p; o.n = n; o.col = c; return o;
}
struct FO { @location(0) c: vec4f, @location(1) d: vec4f };
fn fo(c: vec4f, wp: vec3f) -> FO { var o: FO; o.c = c; o.d = vec4f(length(wp - F.cam.xyz), 0.0, 0.0, 1.0); return o; }
@fragment fn fs(v: VO) -> FO {
  if (clipped(v.wp)) { discard; }
  let V = normalize(F.cam.xyz - v.wp);
  var N = normalize(v.n); if (dot(N, V) < 0.0) { N = -N; }
  let L1 = normalize(vec3f(0.35, -0.55, 0.75)); let L2 = normalize(vec3f(-0.6, 0.45, 0.35));
  let d = max(dot(N, L1), 0.0) * 0.8 + max(dot(N, L2), 0.0) * 0.3;
  let hemi = 0.5 + 0.5 * N.z;
  let sp = pow(max(dot(N, normalize(L1 + V)), 0.0), 48.0) * v.col.a;
  let rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  let col = v.col.rgb * (0.16 + 0.2 * hemi + 0.75 * d) + vec3f(sp * 0.7) + vec3f(0.55, 0.65, 0.8) * rim * 0.18;
  return fo(vec4f(col, 1.0), v.wp);
}
@fragment fn fsGhost(v: VO) -> FO {
  if (clipped(v.wp)) { discard; }
  let V = normalize(F.cam.xyz - v.wp); let f = pow(1.0 - abs(dot(normalize(v.n), V)), 2.5);
  return fo(vec4f(mix(v.col.rgb * 1.8, vec3f(0.8, 0.88, 1.0), 0.45), 0.05 + 0.5 * f), v.wp);
}`;
const WG_SLICE = `${FRAME}
@group(0) @binding(1) var ftex: texture_3d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var lut: texture_2d<f32>;
struct SO { @builtin(position) pos: vec4f, @location(0) wp: vec3f };
@vertex fn vs(@location(0) p: vec3f) -> SO { var o: SO; o.pos = F.vp * vec4f(p, 1.0); o.wp = p; return o; }
struct FO { @location(0) c: vec4f, @location(1) d: vec4f };
@fragment fn fs(v: SO) -> FO {
  if (clipped(v.wp)) { discard; }
  let b = textureSampleLevel(ftex, samp, (v.wp - F.bmin.xyz) / (F.bmax.xyz - F.bmin.xyz), 0.0);
  var col: vec3f; var a: f32;
  if (F.b.z > 0.5) {
    let t = clamp(0.5 + 0.5 * b.z / F.b.w, 0.0, 1.0);
    col = textureSampleLevel(lut, samp, vec2f(t, 0.75), 0.0).rgb; a = 0.12 + 0.83 * smoothstep(0.04, 0.35, abs(t - 0.5) * 2.0);
  } else {
    let t = clamp(b.w / F.a.x, 0.0, 1.0);
    col = textureSampleLevel(lut, samp, vec2f(t, 0.25), 0.0).rgb; a = 0.12 + 0.83 * smoothstep(0.03, 0.3, t);
  }
  var o: FO; o.c = vec4f(col, a);
  o.d = vec4f(select(65000.0, length(v.wp - F.cam.xyz), a > 0.35), 0.0, 0.0, 1.0); return o;
}`;
const WG_LINES = `${FRAME}
@group(0) @binding(1) var<storage, read> segs: array<vec4f>;
@group(0) @binding(2) var lut: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
struct LO { @builtin(position) pos: vec4f, @location(0) wp: vec3f, @location(1) t: f32 };
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> LO {
  let a = segs[2u * ii]; let b = segs[2u * ii + 1u];
  let ca = F.vp * vec4f(a.xyz, 1.0); let cb = F.vp * vec4f(b.xyz, 1.0);
  let res = F.b.xy;
  var d = (cb.xy / cb.w - ca.xy / ca.w) * res; let L = length(d);
  d = select(vec2f(1.0, 0.0), d / L, L > 1e-5);
  var ends = array<u32, 6>(0u, 0u, 1u, 1u, 0u, 1u);
  var sides = array<f32, 6>(-1.0, 1.0, -1.0, -1.0, 1.0, 1.0);
  let e = ends[vi];
  var c = select(ca, cb, e == 1u);
  let off = vec2f(-d.y, d.x) * sides[vi] * F.a.w / res;
  c = vec4f(c.xy + off * c.w, c.z, c.w);
  var o: LO; o.pos = c; o.wp = select(a.xyz, b.xyz, e == 1u); o.t = select(a.w, b.w, e == 1u); return o;
}
struct FO { @location(0) c: vec4f, @location(1) d: vec4f };
@fragment fn fs(v: LO) -> FO {
  if (clipped(v.wp)) { discard; }
  let col = textureSampleLevel(lut, samp, vec2f(0.3 + 0.7 * v.t, 0.25), 0.0).rgb;
  var o: FO; o.c = vec4f(col * 1.15 + vec3f(0.04), 1.0); o.d = vec4f(length(v.wp - F.cam.xyz), 0.0, 0.0, 1.0); return o;
}`;
const WG_FINAL = `${FRAME}
@group(0) @binding(1) var ftex: texture_3d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var lut: texture_2d<f32>;
@group(0) @binding(4) var dtex: texture_2d<f32>;
@group(0) @binding(5) var stex: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let px = vec2i(fc.xy);
  let scene = textureLoad(stex, px, 0).rgb;
  let dist = textureLoad(dtex, px, 0).r;
  if (F.c.x < 0.5) { return vec4f(scene, 1.0); }
  let res = F.b.xy;
  let ndc = vec2f(fc.x / res.x * 2.0 - 1.0, 1.0 - fc.y / res.y * 2.0);
  let pn = F.ivp * vec4f(ndc, 0.0, 1.0); let pf = F.ivp * vec4f(ndc, 1.0, 1.0);
  let ro = pn.xyz / pn.w; let rd = normalize(pf.xyz / pf.w - ro);
  let inv = 1.0 / rd;
  let t0 = (F.bmin.xyz - ro) * inv; let t1 = (F.bmax.xyz - ro) * inv;
  let tn = min(t0, t1); let tf = max(t0, t1);
  let tmin = max(max(tn.x, tn.y), max(tn.z, 0.0));
  var tmax = min(tf.x, min(tf.y, tf.z));
  if (dist < 60000.0) { tmax = min(tmax, dist - length(ro - F.cam.xyz)); }
  if (tmax <= tmin) { return vec4f(scene, 1.0); }
  let ext = F.bmax.xyz - F.bmin.xyz;
  let dt = length(ext) / 360.0;
  var t = tmin + dt * fract(sin(dot(fc.xy, vec2f(12.9898, 78.233))) * 43758.5453);
  var acc = vec3f(0.0); var al = 0.0;
  for (var i = 0; i < 720; i++) {
    if (t >= tmax || al > 0.97) { break; }
    let p = ro + rd * t;
    if (!clipped(p)) {
      let tt = clamp(textureSampleLevel(ftex, samp, (p - F.bmin.xyz) / ext, 0.0).w / F.a.x, 0.0, 1.0);
      let dens = pow(smoothstep(F.a.z, 1.0, tt), 1.4);
      let a = 1.0 - exp(-F.a.y * dens * dt);
      let col = textureSampleLevel(lut, samp, vec2f(tt, 0.25), 0.0).rgb;
      acc += (1.0 - al) * a * col * 1.5; al += (1.0 - al) * a;
    }
    t += dt;
  }
  return vec4f(scene * (1.0 - al) + acc, 1.0);
}`;

/* ---- renderer state ---- */
export const V = {
  ok: false, dirty: true, dev: null, ctx: null, fmt: null, W: 0, H: 0, tex: null,
  cam: { az: -2.25, el: 0.5, dist: 120, target: [0, 0, 2] }, home: null,
  opt: { volume: true, lines: true, slice: "off", sliceField: "bz", rotor: "ghost", pcb: true, back: true, cut: false, density: 0.35, thr: 0.18, sliceZ: 0 },
  mesh: {}, lines: null, field: null, box: [[-50, -50, -30], [50, 50, 30]], bScale: 1, bzScale: 1, job: null
};
export async function initRenderer() {
  const G = await initGPU(), dev = G.device, cv = $("#gl");
  V.dev = dev; V.fmt = navigator.gpu.getPreferredCanvasFormat();
  V.ctx = cv.getContext("webgpu"); V.ctx.configure({ device: dev, format: V.fmt, alphaMode: "opaque" });
  const mod = code => dev.createShaderModule({ code });
  const mMesh = mod(WG_MESH), mSlice = mod(WG_SLICE), mLines = mod(WG_LINES), mFinal = mod(WG_FINAL);
  const meshVB = [{ arrayStride: 28, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }, { shaderLocation: 1, offset: 12, format: "float32x3" }, { shaderLocation: 2, offset: 24, format: "unorm8x4" }] }];
  const blend = { color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } };
  const ds = w => ({ format: "depth32float", depthWriteEnabled: w, depthCompare: "less" });
  const ms = { count: 4 }, prim = { topology: "triangle-list", cullMode: "none" };
  const minB = { color: { operation: "min", srcFactor: "one", dstFactor: "one" }, alpha: { operation: "min", srcFactor: "one", dstFactor: "one" } };
  const T = (b, dw = true) => [b ? { format: V.fmt, blend: b } : { format: V.fmt }, dw ? { format: "rgba16float", blend: minB } : { format: "rgba16float", writeMask: 0 }];
  V.pl = {
    mesh: dev.createRenderPipeline({ layout: "auto", vertex: { module: mMesh, entryPoint: "vs", buffers: meshVB }, fragment: { module: mMesh, entryPoint: "fs", targets: T(null) }, primitive: prim, depthStencil: ds(true), multisample: ms }),
    ghost: dev.createRenderPipeline({ layout: "auto", vertex: { module: mMesh, entryPoint: "vs", buffers: meshVB }, fragment: { module: mMesh, entryPoint: "fsGhost", targets: T(blend, false) }, primitive: prim, depthStencil: ds(false), multisample: ms }),
    slice: dev.createRenderPipeline({ layout: "auto", vertex: { module: mSlice, entryPoint: "vs", buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }] }, fragment: { module: mSlice, entryPoint: "fs", targets: T(blend) }, primitive: prim, depthStencil: ds(false), multisample: ms }),
    lines: dev.createRenderPipeline({ layout: "auto", vertex: { module: mLines, entryPoint: "vs" }, fragment: { module: mLines, entryPoint: "fs", targets: T(null) }, primitive: prim, depthStencil: ds(true), multisample: ms }),
    final: dev.createRenderPipeline({ layout: "auto", vertex: { module: mFinal, entryPoint: "vs" }, fragment: { module: mFinal, entryPoint: "fs", targets: [{ format: V.fmt }] }, primitive: { topology: "triangle-list" } })
  };
  V.ubo = dev.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  V.samp = dev.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", addressModeW: "clamp-to-edge" });
  V.lut = dev.createTexture({ size: [256, 2], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  const lutData = new Uint8Array(2048); lutData.set(lutRow(INF), 0); lutData.set(lutRow(DIV), 1024);
  dev.queue.writeTexture({ texture: V.lut }, lutData, { bytesPerRow: 1024 }, [256, 2]);
  setField(new Uint16Array(4), 1, 1, 1);
  V.bgMesh = dev.createBindGroup({ layout: V.pl.mesh.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: V.ubo } }] });
  V.bgGhost = dev.createBindGroup({ layout: V.pl.ghost.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: V.ubo } }] });
  new ResizeObserver(() => { V.dirty = true; }).observe(cv);
  hookCamera(cv);
  V.ok = true; V.dirty = true;
  requestAnimationFrame(frame);
}
export function setField(data, nx, ny, nz) {
  if (V.field) V.field.destroy();
  V.field = V.dev.createTexture({ size: [nx, ny, nz], dimension: "3d", format: "rgba16float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  V.dev.queue.writeTexture({ texture: V.field }, data, { bytesPerRow: nx * 8, rowsPerImage: ny }, [nx, ny, nz]);
  V.bgSlice = V.dev.createBindGroup({ layout: V.pl.slice.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: V.ubo } }, { binding: 1, resource: V.field.createView() }, { binding: 2, resource: V.samp }, { binding: 3, resource: V.lut.createView() }] });
  V.tex = null;
}
function ensureTargets() {
  const cv = $("#gl"), dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = Math.max(64, Math.round(cv.clientWidth * dpr)), H = Math.max(64, Math.round(cv.clientHeight * dpr));
  if (V.tex && V.W === W && V.H === H) return;
  cv.width = W; cv.height = H; V.W = W; V.H = H;
  if (V.tex) for (const t of Object.values(V.tex)) t.destroy();
  const d = V.dev, RA = GPUTextureUsage.RENDER_ATTACHMENT, TB = GPUTextureUsage.TEXTURE_BINDING;
  V.tex = {
    msaa: d.createTexture({ size: [W, H], format: V.fmt, sampleCount: 4, usage: RA }),
    scene: d.createTexture({ size: [W, H], format: V.fmt, usage: RA | TB }),
    depth: d.createTexture({ size: [W, H], format: "depth32float", sampleCount: 4, usage: RA }),
    distMs: d.createTexture({ size: [W, H], format: "rgba16float", sampleCount: 4, usage: RA }),
    dist: d.createTexture({ size: [W, H], format: "rgba16float", usage: RA | TB })
  };
  V.bgFinal = d.createBindGroup({ layout: V.pl.final.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: V.ubo } }, { binding: 1, resource: V.field.createView() }, { binding: 2, resource: V.samp },
    { binding: 3, resource: V.lut.createView() }, { binding: 4, resource: V.tex.dist.createView() }, { binding: 5, resource: V.tex.scene.createView() }] });
}
function vbuf(mesh) {
  const b = V.dev.createBuffer({ size: Math.max(28, mesh.data.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  V.dev.queue.writeBuffer(b, 0, mesh.data); return { buf: b, count: mesh.count };
}
export function buildSlices() {
  const [mn, mx] = V.box, job = V.job, z = V.opt.sliceZ, pts = [];
  if (!job) return;
  if (V.opt.slice === "gap") {
    const R = job.kind === "motor" ? job.g.Rro + 8 : 0.9 * (mx[0] - mn[0]) / 2, n = 160;
    for (let i = 0; i < n; i++) { const a0 = 2 * Math.PI * i / n, a1 = 2 * Math.PI * (i + 1) / n; pts.push(0, 0, z, R * Math.cos(a0), R * Math.sin(a0), z, R * Math.cos(a1), R * Math.sin(a1), z); }
  } else if (V.opt.slice === "axial") {
    const q = [[mn[0], 0, mn[2]], [mx[0], 0, mn[2]], [mx[0], 0, mx[2]], [mn[0], 0, mx[2]]];
    for (const i of [0, 1, 2, 0, 2, 3]) pts.push(...q[i]);
  }
  if (V.sliceBuf) V.sliceBuf.buf.destroy();
  V.sliceBuf = pts.length ? vbuf({ data: new Float32Array(pts), count: pts.length / 3 }) : null;
  V.dirty = true;
}
/* The volume texture must be uniformly spaced, because the shader samples it with a hardware
 * linear filter and one texel step has to mean one distance step. A graded mesh therefore gets
 * resampled onto a uniform lattice covering the same box.
 *
 * This also caps the texture: a 12 M-cell solve does not need a 12 M-texel glow, and uploading one
 * would cost more than the solve. The lattice is sized to the box aspect within a texel budget.
 */
const VIZ_TEXELS = 160 * 160 * 160;

function resampleField(sol, mesh) {
  const bb = boundingBox(mesh);
  const ex = bb[1][0] - bb[0][0], ey = bb[1][1] - bb[0][1], ez = bb[1][2] - bb[0][2];
  // Keep the texel aspect close to cubic, then scale the whole lattice into the budget.
  const scale = Math.cbrt(VIZ_TEXELS / (ex * ey * ez));
  const dim = e => Math.max(8, Math.min(256, Math.round(e * scale)));
  const tx = dim(ex), ty = dim(ey), tz = dim(ez);

  const S = makeSampler(sol);
  const o = [0, 0, 0];
  const data = new Uint16Array(4 * tx * ty * tz);
  for (let k = 0; k < tz; k++) {
    const z = bb[0][2] + ez * (k + 0.5) / tz;
    for (let j = 0; j < ty; j++) {
      const y = bb[0][1] + ey * (j + 0.5) / ty;
      for (let i = 0; i < tx; i++) {
        const x = bb[0][0] + ex * (i + 0.5) / tx;
        S(x, y, z, o);
        const bx = o[0] * 1e3, by = o[1] * 1e3, bz = o[2] * 1e3;
        const q = 4 * ((k * ty + j) * tx + i);
        data[q] = half(bx); data[q + 1] = half(by); data[q + 2] = half(bz); data[q + 3] = half(Math.hypot(bx, by, bz));
      }
    }
  }
  return [data, tx, ty, tz];
}

export function updateScene(sol, keepView) {
  if (!V.ok) return;
  const job = sol.job, mesh = job.mesh;
  const { nx, ny, nz } = mesh;
  const cyl = mesh.kind === CYLINDRICAL;
  V.job = job;
  V.box = boundingBox(mesh);

  // Colour scale from the field inside the machine, ignoring the far field where nothing happens.
  const mag = [], bzs = [];
  const stepY = cyl ? 1 : 2;
  for (let iz = 1; iz < nz - 1; iz += 1) for (let iy = 1; iy < ny - 1; iy += stepY) for (let ix = 1; ix < nx - 1; ix += 2) {
    const r = cyl ? mesh.xc[ix] : Math.hypot(mesh.xc[ix], mesh.yc[iy]);
    const z = mesh.zc[iz];
    if (job.kind === "motor" && (r > job.g.Rro + 4 || z < (job.p.back ? job.g.zBB : -1) - 3 || z > job.g.zYT + 3)) continue;
    const k = (iz * ny + iy) * nx + ix; mag.push(Math.hypot(sol.Bx[k], sol.By[k], sol.Bz[k])); bzs.push(Math.abs(sol.Bz[k]));
  }
  V.bScale = pctl(mag, 0.99) * 1e3; V.bzScale = pctl(bzs, 0.99) * 1e3;
  setField(...resampleField(sol, mesh));
  for (const m of Object.values(V.mesh)) m.buf.destroy();
  V.mesh = {}; for (const [k, m] of Object.entries(buildMeshes(job))) V.mesh[k] = vbuf(m);
  const L = traceLines(sol, V.bScale * 1e-3);
  if (V.lines) V.lines.buf.destroy();
  if (L.count) { const b = V.dev.createBuffer({ size: L.data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }); V.dev.queue.writeBuffer(b, 0, L.data);
    V.lines = { buf: b, count: L.count, bg: V.dev.createBindGroup({ layout: V.pl.lines.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: V.ubo } }, { binding: 1, resource: { buffer: b } }, { binding: 2, resource: V.lut.createView() }, { binding: 3, resource: V.samp }] }), seeds: L.seeds }; }
  else V.lines = null;
  const zs = $("#sliceZ");
  zs.min = V.box[0][2]; zs.max = V.box[1][2]; zs.step = mesh.hMin / 2;
  if (!keepView) {
    V.opt.sliceZ = job.kind === "motor" ? (Math.max(...job.zLay) + job.g.zTB) / 2 : 0;
    const zc = job.kind === "motor" ? ((job.p.back ? job.g.zBB : -1) + job.g.zYT) / 2 : 0, R = job.kind === "motor" ? job.g.Rro : job.kind === "loop" ? job.R * 1.6 : job.a * 2.2;
    V.home = { az: -2.25, el: 0.55, dist: R * 2.7, target: [0, 0, zc] }; Object.assign(V.cam, JSON.parse(JSON.stringify(V.home)));
  }
  zs.value = V.opt.sliceZ;
  buildSlices(); updateLegend();
  $("#empty").hidden = true;
  V.dirty = true;
}
export function updateLegend() {
  const bar = (id, row) => { const c = $(id), x = c.getContext("2d"), im = x.createImageData(256, 1), L = lutRow(row); im.data.set(L); x.putImageData(im, 0, 0); };
  bar("#barB", INF); bar("#barS", V.opt.sliceField === "bz" ? DIV : INF);
  $("#barBmax").textContent = fmtB(V.bScale * 1e-3);
  $("#barSmin").textContent = V.opt.sliceField === "bz" ? "−" + fmtB(V.bzScale * 1e-3) : "0";
  $("#barSmax").textContent = fmtB((V.opt.sliceField === "bz" ? V.bzScale : V.bScale) * 1e-3);
  $("#sliceLegend").hidden = V.opt.slice === "off";
  $("#sliceZval").textContent = `${(+V.opt.sliceZ).toFixed(1)} mm`;
  $("#lineInfo").textContent = V.lines ? `${V.lines.seeds} field lines, seeded in proportion to gap flux` : "";
}
function frame() {
  requestAnimationFrame(frame);
  if (!V.ok || !V.dirty) return;
  V.dirty = false;
  ensureTargets();
  const { az, el, dist, target } = V.cam;
  const eye = [target[0] + dist * Math.cos(el) * Math.cos(az), target[1] + dist * Math.cos(el) * Math.sin(az), target[2] + dist * Math.sin(el)];
  const view = M4.look(eye, target, [0, 0, 1]), proj = M4.persp(0.7, V.W / V.H, Math.max(0.5, dist * 0.02), dist * 6);
  const vp = M4.mul(proj, view), ivp = M4.inv(vp), o = V.opt, u = new Float32Array(64);
  u.set(vp, 0); u.set(ivp, 16);
  u.set([...eye, 0], 32); u.set([...V.box[0], o.cut ? 1 : 0], 36); u.set([...V.box[1], 0], 40);
  u.set([V.bScale, o.density * 0.6, o.thr, 1.35 * Math.min(window.devicePixelRatio || 1, 2)], 44);
  u.set([V.W, V.H, o.sliceField === "bz" ? 1 : 0, V.bzScale], 48);
  u.set([o.volume && V.job ? 1 : 0, 0, 0, 0], 52);
  V.dev.queue.writeBuffer(V.ubo, 0, u);
  const enc = V.dev.createCommandEncoder();
  const p = enc.beginRenderPass({
    colorAttachments: [{ view: V.tex.msaa.createView(), resolveTarget: V.tex.scene.createView(), clearValue: { r: 0.043, g: 0.058, b: 0.082, a: 1 }, loadOp: "clear", storeOp: "discard" },
                       { view: V.tex.distMs.createView(), resolveTarget: V.tex.dist.createView(), clearValue: { r: 65000, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "discard" }],
    depthStencilAttachment: { view: V.tex.depth.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" } });
  const drawMesh = (m, pl, bg) => { if (!m) return; p.setPipeline(pl); p.setBindGroup(0, bg); p.setVertexBuffer(0, m.buf); p.draw(m.count); };
  if (o.pcb) drawMesh(V.mesh.pcb, V.pl.mesh, V.bgMesh);
  drawMesh(V.mesh.traces, V.pl.mesh, V.bgMesh);
  if (o.back) drawMesh(V.mesh.back, V.pl.mesh, V.bgMesh);
  if (o.rotor === "solid") drawMesh(V.mesh.rotor, V.pl.mesh, V.bgMesh);
  if (o.lines && V.lines) { p.setPipeline(V.pl.lines); p.setBindGroup(0, V.lines.bg); p.draw(6, V.lines.count); }
  if (o.slice !== "off" && V.sliceBuf) { p.setPipeline(V.pl.slice); p.setBindGroup(0, V.bgSlice); p.setVertexBuffer(0, V.sliceBuf.buf); p.draw(V.sliceBuf.count); }
  if (o.rotor === "ghost") drawMesh(V.mesh.rotor, V.pl.ghost, V.bgGhost);
  p.end();
  const q = enc.beginRenderPass({ colorAttachments: [{ view: V.ctx.getCurrentTexture().createView(), loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: "store" }] });
  q.setPipeline(V.pl.final); q.setBindGroup(0, V.bgFinal); q.draw(3); q.end();
  V.dev.queue.submit([enc.finish()]);
}
function hookCamera(cv) {
  let drag = null;
  cv.addEventListener("pointerdown", e => { drag = { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button === 2 }; cv.setPointerCapture(e.pointerId); });
  cv.addEventListener("pointermove", e => {
    if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
    const c = V.cam;
    if (drag.pan) {
      const s = c.dist * 0.0016, rx = [-Math.sin(c.az), Math.cos(c.az), 0], ux = [-Math.sin(c.el) * Math.cos(c.az), -Math.sin(c.el) * Math.sin(c.az), Math.cos(c.el)];
      for (let i = 0; i < 3; i++) c.target[i] += (-dx * rx[i] + dy * ux[i]) * s;
    } else { c.az -= dx * 0.008; c.el = Math.max(-1.5, Math.min(1.5, c.el + dy * 0.008)); }
    V.dirty = true;
  });
  const end = () => { drag = null; };
  cv.addEventListener("pointerup", end); cv.addEventListener("pointercancel", end);
  cv.addEventListener("contextmenu", e => e.preventDefault());
  cv.addEventListener("wheel", e => { e.preventDefault(); V.cam.dist *= Math.exp(e.deltaY * 0.0012); V.dirty = true; }, { passive: false });
  cv.addEventListener("dblclick", () => { if (V.home) { Object.assign(V.cam, JSON.parse(JSON.stringify(V.home))); V.dirty = true; } });
}
export function hookViewControls() {
  const seg = (attr, key, after) => document.querySelectorAll(`[${attr}]`).forEach(b => b.onclick = () => {
    V.opt[key] = b.getAttribute(attr); document.querySelectorAll(`[${attr}]`).forEach(x => x.setAttribute("aria-pressed", x === b)); after && after(); updateLegend(); V.dirty = true; });
  seg("data-slice", "slice", buildSlices); seg("data-sfield", "sliceField"); seg("data-rotor", "rotor");
  for (const [id, key] of [["#oVolume", "volume"], ["#oLines", "lines"], ["#oPcb", "pcb"], ["#oBack", "back"], ["#oCut", "cut"]])
    $(id).onchange = e => { V.opt[key] = e.target.checked; V.dirty = true; };
  $("#oDensity").oninput = e => { V.opt.density = +e.target.value; V.dirty = true; };
  $("#oThr").oninput = e => { V.opt.thr = +e.target.value; V.dirty = true; };
  $("#sliceZ").oninput = e => { V.opt.sliceZ = +e.target.value; buildSlices(); updateLegend(); };
  $("#oCut").addEventListener("change", e => { if (e.target.checked && V.opt.slice === "off") document.querySelector('[data-slice="axial"]').click(); });
}

