/* Storage buffers and bind groups for one mesh. Reallocated only when the mesh dimensions change,
 * so a sweep over rotor angle or current angle reuses everything. */

export function ensureBuffers(G, job) {
  const m = job.mesh;
  const key = `${m.nx}x${m.ny}x${m.nz}`;
  if (G.buf && G.buf.key === key) { writeMeshCoords(G, G.buf, m); return G.buf; }
  if (G.buf) for (const b of Object.values(G.buf)) if (b && b.destroy) b.destroy();

  const d = G.device, N = m.N;
  // WebGPU caps workgroups per dimension, so a large mesh is dispatched as a 2D grid and the
  // kernels linearise the index themselves. See dispatchGrid().
  const grid = dispatchGrid(G, N, 256);
  const parts = grid.gx * grid.gy;
  const need = 9 * N * 4;
  if (need > G.limits.maxStorageBufferBindingSize) {
    throw new Error(
      `This mesh needs ${(need / 1048576).toFixed(0)} MB in one buffer but this device allows ` +
      `${(G.limits.maxStorageBufferBindingSize / 1048576).toFixed(0)} MB, which caps it at about ` +
      `${Math.floor(G.limits.maxStorageBufferBindingSize / 36 / 1e6)} M cells. Use a coarser mesh.`);
  }

  const ST = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
  const mk = (size, usage = ST) => d.createBuffer({ size: Math.max(32, size), usage });
  const U = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, R = GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST;

  const B = {
    key, N, parts,
    grid, gridBS: dispatchGrid(G, N, 64),
    params: mk(48, U), cur: mk(16, U), bsp: mk(64, U),
    cX: mk(N * 4), cY: mk(N * 4), cZ: mk(N * 4), diag: mk(N * 4), b: mk(N * 4),
    sX: mk(N * 4), sY: mk(N * 4), sZ: mk(N * 4),
    x: mk(N * 4), r: mk(N * 4), p: mk(N * 4), Ap: mk(N * 4),
    partA: mk(parts * 4), partB: mk(parts * 4), scal: mk(32),
    H: mk(9 * N * 4), Hs: mk(3 * N * 4),
    // Cell-centre coordinate tables, metres, read by the Biot-Savart shader.
    xc: mk(m.nx * 4), yc: mk(m.ny * 4), zc: mk(m.nz * 4),
    readScal: mk(32, R), readX: mk(N * 4, R), readHs: mk(3 * N * 4, R),
    segBuf: null, segKey: null
  };

  const ab = new ArrayBuffer(48), u = new Uint32Array(ab), f = new Float32Array(ab);
  u.set([m.nx, m.ny, m.nz, N, parts, m.sy, m.sz, grid.gx]);
  f[8] = m.hMin * 1e-3;   // retained for shaders that want a representative length
  u[9] = m.periodicY ? 1 : 0;
  d.queue.writeBuffer(B.params, 0, ab);
  writeMeshCoords(G, B, m);

  const bg = (pl, list) => d.createBindGroup({
    layout: pl.getBindGroupLayout(0),
    entries: list.map((buf, i) => ({ binding: i, resource: { buffer: buf } }))
  });
  const P = G.pl;
  B.bg = {
    init: bg(P.init, [B.params, B.diag, B.b, B.x, B.r, B.p, B.partA, B.partB]),
    matvec: bg(P.matvec, [B.params, B.cX, B.cY, B.cZ, B.diag, B.p, B.Ap, B.partA]),
    update: bg(P.update, [B.params, B.diag, B.x, B.r, B.p, B.Ap, B.partA, B.partB, B.scal]),
    pupdate: bg(P.pupdate, [B.params, B.diag, B.r, B.p, B.scal]),
    red0: bg(P.red0, [B.params, B.partA, B.partB, B.scal]),
    red1: bg(P.red1, [B.params, B.partA, B.partB, B.scal]),
    red2: bg(P.red2, [B.params, B.partA, B.partB, B.scal]),
    combine: bg(P.combine, [B.params, B.cur, B.H, B.Hs]),
    rhs: bg(P.rhs, [B.params, B.sX, B.sY, B.sZ, B.diag, B.Hs, B.b])
  };
  G.buf = B;
  return B;
}

/* Cell-centre coordinate tables for the Biot-Savart kernel. They change whenever the mesh is
 * regraded, even at the same cell counts.
 *
 * Length axes are converted to metres; an angular axis is radians and must be left alone. */
function writeMeshCoords(G, B, m) {
  const pow = m.coordPow || [1, 1, 1];
  const f32 = (a, p) => {
    const f = p === 0 ? 1 : 1e-3, o = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) o[i] = a[i] * f;
    return o;
  };
  G.device.queue.writeBuffer(B.xc, 0, f32(m.xc, pow[0]));
  G.device.queue.writeBuffer(B.yc, 0, f32(m.yc, pow[1]));
  G.device.queue.writeBuffer(B.zc, 0, f32(m.zc, pow[2]));
}

/* Split a flat thread count across a 2D workgroup grid within the device's per-dimension cap. */
export function dispatchGrid(G, count, workgroupSize) {
  const total = Math.ceil(count / workgroupSize);
  const cap = G.limits.maxComputeWorkgroupsPerDimension;
  const gx = Math.min(cap, total);
  const gy = Math.ceil(total / gx);
  if (gy > cap) throw new Error(`This mesh needs ${total.toLocaleString()} workgroups, more than this device can dispatch even as a 2D grid.`);
  return { gx, gy, total };
}

/* Device memory this mesh will occupy, for AFS.plan() to report before committing. */
export function bufferBytes(N) {
  const storage = 12 * N * 4;   // cX cY cZ sX sY sZ diag b x r p Ap
  const source = 12 * N * 4;    // H (9) + Hs (3)
  const readback = 4 * N * 4;   // readX (1) + readHs (3)
  return { total: (storage + source + readback), largestBinding: 9 * N * 4, cells: N };
}
