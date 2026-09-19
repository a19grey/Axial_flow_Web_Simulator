/* Storage buffers and bind groups for one grid size. Reallocated only when the grid changes, so a
 * sweep over rotor angle or current angle reuses everything. */

export function ensureBuffers(G, job) {
  const key = `${job.nx}x${job.ny}x${job.nz}`;
  if (G.buf && G.buf.key === key) return G.buf;
  if (G.buf) for (const b of Object.values(G.buf)) if (b && b.destroy) b.destroy();

  const d = G.device, N = job.nx * job.ny * job.nz, parts = Math.ceil(N / 256);
  const need = 9 * N * 4;
  if (need > G.limits.maxStorageBufferBindingSize) {
    throw new Error(
      `This grid needs ${(need / 1048576).toFixed(0)} MB in one buffer but this device allows ` +
      `${(G.limits.maxStorageBufferBindingSize / 1048576).toFixed(0)} MB. ` +
      `That caps the uniform grid at about ${Math.floor(Math.cbrt(G.limits.maxStorageBufferBindingSize / 36))} cells per side. ` +
      `Choose a smaller grid.`);
  }

  const ST = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
  const mk = (size, usage = ST) => d.createBuffer({ size: Math.max(32, size), usage });
  const U = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, R = GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST;

  const B = {
    key, N, parts,
    params: mk(32, U), cur: mk(16, U), bsp: mk(64, U),
    cX: mk(N * 4), cY: mk(N * 4), cZ: mk(N * 4), diag: mk(N * 4), b: mk(N * 4),
    x: mk(N * 4), r: mk(N * 4), p: mk(N * 4), Ap: mk(N * 4),
    partA: mk(parts * 4), partB: mk(parts * 4), scal: mk(32),
    H: mk(9 * N * 4), Hs: mk(3 * N * 4),
    readScal: mk(32, R), readX: mk(N * 4, R), readHs: mk(3 * N * 4, R),
    segBuf: null, segKey: null
  };

  const ab = new ArrayBuffer(32), u = new Uint32Array(ab), f = new Float32Array(ab);
  u.set([job.nx, job.ny, job.nz, N, parts, job.nx, job.nx * job.ny]);
  f[7] = job.hm * 1e-3;
  d.queue.writeBuffer(B.params, 0, ab);

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
    rhs: bg(P.rhs, [B.params, B.cX, B.cY, B.cZ, B.diag, B.Hs, B.b])
  };
  G.buf = B;
  return B;
}

/* Total device memory this grid will occupy, for AFS.plan() to report before committing. */
export function bufferBytes(nx, ny, nz) {
  const N = nx * ny * nz;
  const storage = (4 + 1 + 4) * N * 4;      // cX cY cZ diag b + x r p Ap
  const source = (9 + 3) * N * 4;           // H + Hs
  const readback = (1 + 3) * N * 4;         // readX + readHs
  return { total: storage + source + readback, largestBinding: 9 * N * 4, cells: N };
}
