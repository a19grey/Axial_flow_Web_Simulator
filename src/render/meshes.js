/* Analytic surface meshes of the machine, in millimetres.
 *
 * Nothing here is rasterized: the rotor, back plate, PCB and trace ribbons are built from the same
 * parameters the solver uses, as smooth arcs. Shared by the 3D view and the OBJ/STL export, so the
 * model you print is the model you see.
 *
 * Vertex layout is 7 floats: position (3), normal (3), packed colour (1).
 */

import { css } from "../ui/format.js";

export const rgba = (hex, spec = 0) => { const n = parseInt(hex.slice(1), 16); return ((n >> 16) & 255) | (((n >> 8) & 255) << 8) | ((n & 255) << 16) | (Math.round(spec * 255) << 24); };
export class MeshB {
  constructor() { this.f = []; this.c = []; }
  v(p, n, c) { this.f.push(p[0], p[1], p[2], n[0], n[1], n[2]); this.c.push(c); }
  quad(a, b, c, d, na, nb, nc, nd, col) { this.v(a, na, col); this.v(b, nb, col); this.v(c, nc, col); this.v(a, na, col); this.v(c, nc, col); this.v(d, nd, col); }
  pack() {
    const n = this.c.length, ab = new ArrayBuffer(n * 28), f = new Float32Array(ab), u = new Uint32Array(ab);
    for (let i = 0; i < n; i++) { for (let k = 0; k < 6; k++) f[i * 7 + k] = this.f[i * 6 + k]; u[i * 7 + 6] = this.c[i]; }
    return { data: f, count: n };
  }
}
export function annular(mb, r0, r1, a0, a1, z0, z1, col) {
  // Closed annular sector with outward-facing winding (counter-clockwise seen from outside), so exports are valid solids.
  const full = a1 - a0 >= 2 * Math.PI - 1e-6, n = Math.max(6, Math.ceil((a1 - a0) / (2 * Math.PI) * 192));
  const P = (r, t, z) => [r * Math.cos(t), r * Math.sin(t), z], R = t => [Math.cos(t), Math.sin(t), 0], Rn = t => [-Math.cos(t), -Math.sin(t), 0];
  const up = [0, 0, 1], dn = [0, 0, -1], ang = i => i === n ? a1 : a0 + (a1 - a0) * i / n;
  for (let i = 0; i < n; i++) {
    const t0 = ang(i), t1 = full && i === n - 1 ? a0 : ang(i + 1);
    mb.quad(P(r0, t0, z1), P(r1, t0, z1), P(r1, t1, z1), P(r0, t1, z1), up, up, up, up, col);
    mb.quad(P(r0, t0, z0), P(r0, t1, z0), P(r1, t1, z0), P(r1, t0, z0), dn, dn, dn, dn, col);
    mb.quad(P(r1, t0, z0), P(r1, t1, z0), P(r1, t1, z1), P(r1, t0, z1), R(t0), R(t1), R(t1), R(t0), col);
    if (r0 > 0) mb.quad(P(r0, t0, z0), P(r0, t0, z1), P(r0, t1, z1), P(r0, t1, z0), Rn(t0), Rn(t0), Rn(t1), Rn(t1), col);
  }
  if (!full) {
    const n0 = [Math.sin(a0), -Math.cos(a0), 0], n1 = [-Math.sin(a1), Math.cos(a1), 0];
    mb.quad(P(r0, a0, z0), P(r1, a0, z0), P(r1, a0, z1), P(r0, a0, z1), n0, n0, n0, n0, col);
    mb.quad(P(r0, a1, z0), P(r0, a1, z1), P(r1, a1, z1), P(r1, a1, z0), n1, n1, n1, n1, col);
  }
}
export function rotorSolid(mb, p, g, col) {
  // One watertight solid: a yoke ring with the salient poles fused to its underside.
  const TAU = 2 * Math.PI, P2 = TAU / p.poles, half = p.arc * P2 / 2, th0 = p.theta * Math.PI / 180;
  const wrap = a => ((a % TAU) + TAU) % TAU, brk = new Set();
  for (let i = 0; i < 384; i++) brk.add(+(TAU * i / 384).toFixed(12));
  for (let k = 0; k < p.poles; k++) { const c = th0 + k * P2; brk.add(+wrap(c - half).toFixed(12)); brk.add(+wrap(c + half).toFixed(12)); }
  const A = [...brk].sort((a, b) => a - b).filter((a, i, arr) => i === 0 || a - arr[i - 1] > 1e-9);
  const inPole = t => { let d = t - th0; d = ((d % P2) + P2 + P2 / 2) % P2 - P2 / 2; return Math.abs(d) < half; };
  const { Rri: r0, Rro: r1, zTB, zTT, zYT } = g, n = A.length;
  /* A skewed pole twists with radius. Applying the twist inside the vertex constructor skews every
   * face at once; the normals are left unrotated, which is a shading approximation and nothing
   * more — no geometry in the solve comes from here. */
  const skew = (p.skew || 0) * Math.PI / 180, rMid = 0.5 * (r0 + r1), rSpan = Math.max(1e-9, r1 - r0);
  const tw = r => (skew ? skew * (r - rMid) / rSpan : 0);
  const P = (r, t, z) => { const a = t + tw(r); return [r * Math.cos(a), r * Math.sin(a), z]; };
  const R = t => [Math.cos(t), Math.sin(t), 0], Rn = t => [-Math.cos(t), -Math.sin(t), 0];
  const up = [0, 0, 1], dn = [0, 0, -1];
  const pole = A.map((a, i) => { const b = i === n - 1 ? A[0] + TAU : A[i + 1]; return inPole((a + b) / 2); });
  for (let i = 0; i < n; i++) {
    const t0 = A[i], t1 = A[(i + 1) % n], zb = pole[i] ? zTB : zTT;
    mb.quad(P(r0, t0, zYT), P(r1, t0, zYT), P(r1, t1, zYT), P(r0, t1, zYT), up, up, up, up, col);
    mb.quad(P(r0, t0, zb), P(r0, t1, zb), P(r1, t1, zb), P(r1, t0, zb), dn, dn, dn, dn, col);
    const levels = pole[i] ? [zTB, zTT, zYT] : [zTT, zYT];
    for (let j = 0; j < levels.length - 1; j++) {
      const za = levels[j], zc = levels[j + 1];
      mb.quad(P(r1, t0, za), P(r1, t1, za), P(r1, t1, zc), P(r1, t0, zc), R(t0), R(t1), R(t1), R(t0), col);
      mb.quad(P(r0, t0, za), P(r0, t0, zc), P(r0, t1, zc), P(r0, t1, za), Rn(t0), Rn(t0), Rn(t1), Rn(t1), col);
    }
    const next = pole[(i + 1) % n];
    if (pole[i] !== next) {
      const t = t1, nt = pole[i] ? [-Math.sin(t), Math.cos(t), 0] : [Math.sin(t), -Math.cos(t), 0];
      if (pole[i]) mb.quad(P(r0, t, zTB), P(r0, t, zTT), P(r1, t, zTT), P(r1, t, zTB), nt, nt, nt, nt, col);
      else mb.quad(P(r0, t, zTB), P(r1, t, zTB), P(r1, t, zTT), P(r0, t, zTT), nt, nt, nt, nt, col);
    }
  }
}
export function ribbon(mb, pts, z, w, col, closed = true) {
  const n = pts.length, off = [], nz = [0, 0, 1];
  for (let i = 0; i < n; i++) {
    const p = pts[(i - 1 + n) % n], c = pts[i], q = pts[(i + 1) % n];
    const e1 = [c[0] - p[0], c[1] - p[1]], e2 = [q[0] - c[0], q[1] - c[1]];
    const l1 = Math.hypot(...e1) || 1, l2 = Math.hypot(...e2) || 1;
    const n1 = [-e1[1] / l1, e1[0] / l1], n2 = [-e2[1] / l2, e2[0] / l2];
    let m = [n1[0] + n2[0], n1[1] + n2[1]]; const lm = Math.hypot(...m) || 1; m = [m[0] / lm, m[1] / lm];
    const s = Math.min(3, 1 / Math.max(0.3, m[0] * n2[0] + m[1] * n2[1]));
    off.push([m[0] * s * w / 2, m[1] * s * w / 2]);
  }
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const j = (i + 1) % n, a = pts[i], b = pts[j], oa = off[i], ob = off[j];
    mb.quad([a[0] - oa[0], a[1] - oa[1], z], [b[0] - ob[0], b[1] - ob[1], z], [b[0] + ob[0], b[1] + ob[1], z], [a[0] + oa[0], a[1] + oa[1], z], nz, nz, nz, nz, col);
  }
}
export function sphereMesh(mb, R, col) {
  const nu = 64, nv = 32, P = (u, v) => [R * Math.sin(v) * Math.cos(u), R * Math.sin(v) * Math.sin(u), R * Math.cos(v)], N = (u, v) => P(u, v).map(x => x / R);
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const u0 = 2 * Math.PI * i / nu, u1 = 2 * Math.PI * (i + 1) / nu, v0 = Math.PI * j / nv, v1 = Math.PI * (j + 1) / nv;
    mb.quad(P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1), N(u0, v0), N(u1, v0), N(u1, v1), N(u0, v1), col);
  }
}
/* Mirror a built mesh through z = 0: negate the z of every position and normal, and reverse the
 * winding of each triangle so the faces still point outwards. Used for the lower rotor of a
 * dual-sided machine, which is the upper one reflected. */
export function mirrorZ(mb) {
  const f = mb.f;
  for (let i = 0; i < f.length; i += 6) { f[i + 2] = -f[i + 2]; f[i + 5] = -f[i + 5]; }
  for (let t = 0; t + 17 < f.length; t += 18) for (let c = 0; c < 6; c++) {
    const a = t + c, b = t + 12 + c, v = f[a]; f[a] = f[b]; f[b] = v;
  }
  return mb;
}

export function buildMeshes(job) {
  const out = {}, phaseHex = [css("--pa") || "#D0453A", css("--pb") || "#2E9E5B", css("--pc") || "#3569D6"];
  const toHex = s => s.startsWith("#") && s.length === 7 ? s : "#C87533";
  const tcol = phaseHex.map(h => rgba(toHex(h), 0.9));
  if (job.kind === "motor") {
    const { p, g } = job, P2 = 2 * Math.PI / p.poles, half = p.arc * P2 / 2, th0 = p.theta * Math.PI / 180;
    let mb = new MeshB(); rotorSolid(mb, p, g, rgba("#5A6070", 0.35)); out.rotor = mb.pack();
    if (g.dual) { mb = new MeshB(); rotorSolid(mb, p, g, rgba("#5A6070", 0.35)); out.rotorLower = mirrorZ(mb).pack(); }
    else if (g.back) { mb = new MeshB(); annular(mb, g.Rri, g.Rro, 0, 2 * Math.PI, g.zBB, g.zBT, rgba("#4B5361", 0.3)); out.back = mb.pack(); }
    mb = new MeshB(); annular(mb, Math.max(0, p.ri - 3), p.ro + 3, 0, 2 * Math.PI, -g.pcbHalf, g.pcbHalf, rgba("#1B2029", 0.25)); out.pcb = mb.pack();
    mb = new MeshB();
    for (const { pts, ph } of job.polys) { ribbon(mb, pts, g.pcbHalf + 0.035, 0.34, tcol[ph]); ribbon(mb, pts, -g.pcbHalf - 0.035, 0.34, tcol[ph]); }
    out.traces = mb.pack();
  } else if (job.kind === "loop") {
    const mb = new MeshB(); ribbon(mb, job.polys[0].pts, 0, 0.8, tcol[0]); out.traces = mb.pack();
  } else {
    const mb = new MeshB(); sphereMesh(mb, job.a, rgba("#5A6070", 0.35)); out.rotor = mb.pack();
  }
  return out;
}

