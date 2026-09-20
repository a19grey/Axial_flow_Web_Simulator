/* Model export: OBJ + printable STLs + a copper-pattern SVG + the project, packed as a zip.
 *
 * The zip is written by hand (stored, no compression) so the page has no dependencies.
 */

import { motorGeom, coilPolys } from "../core/geometry.js";
import { MeshB, annular, rotorSolid, ribbon, mirrorZ } from "../render/meshes.js";

const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
export function makeZip(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  let off = 0;
  for (const f of files) {
    const name = enc.encode(f.name), data = typeof f.data === "string" ? enc.encode(f.data) : f.data, crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(8, 0, true); h.setUint16(12, 33, true);
    h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true);
    parts.push(h.buffer, name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(14, 33, true);
    c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true); c.setUint32(42, off, true);
    central.push(c.buffer, name);
    off += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((s, b) => s + (b.byteLength ?? b.length), 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cdSize, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...central, e.buffer], { type: "application/zip" });
}
export function exportMeshes(p) {
  const g = motorGeom(p), polys = coilPolys(p), P2 = 2 * Math.PI / p.poles, half = p.arc * P2 / 2, th0 = p.theta * Math.PI / 180, out = {};
  let mb = new MeshB(); rotorSolid(mb, p, g, 0); out.rotor = mb;
  if (g.dual) { mb = new MeshB(); rotorSolid(mb, p, g, 0); out.rotor_lower = mirrorZ(mb); }
  else if (g.back) { mb = new MeshB(); annular(mb, g.Rri, g.Rro, 0, 2 * Math.PI, g.zBB, g.zBT, 0); out.back_plate = mb; }
  mb = new MeshB(); annular(mb, Math.max(0, p.ri - 3), p.ro + 3, 0, 2 * Math.PI, -g.pcbHalf, g.pcbHalf, 0); out.pcb_substrate = mb;
  ["A", "B", "C"].forEach((ph, i) => { const m = new MeshB(); for (const q of polys.filter(q => q.ph === i)) { ribbon(m, q.pts, g.pcbHalf + 0.035, p.traceW, 0); ribbon(m, q.pts, -g.pcbHalf - 0.035, p.traceW, 0); } out["traces_phase_" + ph] = m; });
  return { out, g, polys };
}
export function toOBJ(meshes, header) {
  const L = [header, "# units: millimetres. z is the motor axis; the PCB mid-plane is z = 0.", ""];
  let base = 1;
  for (const [name, mb] of Object.entries(meshes)) {
    const f = mb.f, n = f.length / 6;
    L.push(`o ${name}`);
    for (let i = 0; i < n; i++) L.push(`v ${f[6 * i].toFixed(4)} ${f[6 * i + 1].toFixed(4)} ${f[6 * i + 2].toFixed(4)}`);
    for (let i = 0; i < n; i++) L.push(`vn ${f[6 * i + 3].toFixed(4)} ${f[6 * i + 4].toFixed(4)} ${f[6 * i + 5].toFixed(4)}`);
    for (let i = 0; i < n; i += 3) { const a = base + i, b = a + 1, c = a + 2; L.push(`f ${a}//${a} ${b}//${b} ${c}//${c}`); }
    base += n; L.push("");
  }
  return L.join("\n");
}
export function toSTL(mb, name) {
  const f = mb.f, nt = f.length / 18, buf = new ArrayBuffer(84 + nt * 50), dv = new DataView(buf);
  const hdr = new TextEncoder().encode(("binary STL, mm: " + name).slice(0, 79)); new Uint8Array(buf, 0, 80).set(hdr);
  dv.setUint32(80, nt, true);
  for (let t = 0; t < nt; t++) {
    const v = k => [f[(3 * t + k) * 6], f[(3 * t + k) * 6 + 1], f[(3 * t + k) * 6 + 2]], a = v(0), b = v(1), c = v(2);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]], l = Math.hypot(...n) || 1;
    const o = 84 + t * 50;
    [n[0] / l, n[1] / l, n[2] / l, ...a, ...b, ...c].forEach((x, i) => dv.setFloat32(o + 4 * i, x, true));
  }
  return new Uint8Array(buf);
}
export function tracesSVG(p, polys) {
  const R = p.ro + 5, cols = ["#D0453A", "#2E9E5B", "#3569D6"];
  const paths = polys.map(q => `<path d="M${q.pts.map(([x, y]) => `${x.toFixed(3)},${(-y).toFixed(3)}`).join("L")}Z" stroke="${cols[q.ph]}" data-phase="${"ABC"[q.ph]}"/>`).join("\n    ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${2 * R}mm" height="${2 * R}mm" viewBox="${-R} ${-R} ${2 * R} ${2 * R}">
  <!-- Stator copper, one layer, viewed from +z (rotor side). Units: mm. Trace width ${p.traceW} mm, pitch ${p.pitch} mm. Every copper layer uses this pattern with the same winding sense. -->
  <circle r="${p.ro + 3}" fill="none" stroke="#888" stroke-width="0.15"/>
  <circle r="${Math.max(0, p.ri - 3)}" fill="none" stroke="#888" stroke-width="0.15"/>
  <g fill="none" stroke-width="${p.traceW}" stroke-linejoin="round">
    ${paths}
  </g>
</svg>`;
}
export const safeName = n => (String(n || "motor").replace(/[^A-Za-z0-9 _.-]/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "motor");

/* Everything a fabricator or a printer needs, plus the project that reproduces it. */
export function buildModelZip(p, project) {
  const { out, g, polys } = exportMeshes(p);
  const base = safeName(project.name);
  const files = [
    { name: `${base}/model.obj`, data: toOBJ(out, `# ${project.name} — axial-flux reluctance motor, exported ${project.savedAt}`) },
    { name: `${base}/rotor.stl`, data: toSTL(out.rotor, project.name + " rotor") },
    ...(out.back_plate ? [{ name: `${base}/back_plate.stl`, data: toSTL(out.back_plate, project.name + " back plate") }] : []),
    { name: `${base}/stator_traces.svg`, data: tracesSVG(p, polys) },
    { name: `${base}/project.json`, data: JSON.stringify(project, null, 2) },
    { name: `${base}/README.txt`, data:
`${project.name}

model.obj           All parts in millimetres, one object per part: rotor, back_plate, pcb_substrate, traces_phase_A/B/C.
rotor.stl           Rotor for printing: one closed, watertight solid with the poles fused to the yoke.
back_plate.stl      Back plate below the PCB, if the design has one.
stator_traces.svg   Copper pattern for one layer, as concentric turns. A real board needs spiral turns and vias between layers.
project.json        The design, view and results. Open it in the tool to restore everything.

Rotor: ${p.poles} poles, pole arc ${p.arc} of pitch, radius ${g.Rri}-${g.Rro} mm, pole height ${p.tooth} mm, yoke ${p.yoke} mm.
` }
  ];
  return { blob: makeZip(files), filename: `${base}-model.zip` };
}
