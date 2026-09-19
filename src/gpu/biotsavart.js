/* Free-space field of the trace segments, summed on the GPU.
 *
 * All three phase fields are accumulated in one pass at unit current, so any set of currents is a
 * linear combination of the three (see the `combine` shader). The result depends only on the
 * winding and the grid, so it is cached across rotor angles and current angles via job.segKey.
 *
 * Cost is O(cells x segments), split into chunks of segments so each GPU dispatch stays short
 * enough not to trip a watchdog, and so progress can be reported and the run cancelled.
 */

export async function runBiotSavart(G, B, job, { onProgress, signal } = {}) {
  const d = G.device, N = B.N, segs = job.segs, ns = segs.length / 8;
  if (B.segBuf) B.segBuf.destroy();
  B.segBuf = d.createBuffer({ size: Math.max(32, segs.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  d.queue.writeBuffer(B.segBuf, 0, segs);
  B.bg.bs = d.createBindGroup({
    layout: G.pl.bs.getBindGroupLayout(0),
    entries: [B.bsp, B.segBuf, B.H, B.xc, B.yc, B.zc].map((b, i) => ({ binding: i, resource: { buffer: b } }))
  });

  let enc = d.createCommandEncoder();
  enc.clearBuffer(B.H);
  d.queue.submit([enc.finish()]);

  // Target roughly 1.2e8 segment-cell evaluations per dispatch.
  const chunk = Math.max(64, Math.floor(1.2e8 / N / 64) * 64);
  const ab = new ArrayBuffer(64), u = new Uint32Array(ab), f = new Float32Array(ab);
  const m = job.mesh;
  // Finite-core radius regularizes the 1/r singularity at the wire itself. It is set from the
  // smallest cell, since that is the closest a sample point can come to a trace.
  const h = m.hMin * 1e-3;
  const eps = Math.max(0.25e-3, 0.5 * h);

  for (let s = 0; s < ns; s += chunk) {
    u.set([N, m.nx, m.ny, s, Math.min(ns, s + chunk), B.gridBS.gx, m.kind === "cylindrical" ? 1 : 0, 0]);
    f.set([0, 0, 0, h, eps * eps, 0, 0, 0], 8);
    d.queue.writeBuffer(B.bsp, 0, ab);
    enc = d.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(G.pl.bs);
    pass.setBindGroup(0, B.bg.bs);
    pass.dispatchWorkgroups(B.gridBS.gx, B.gridBS.gy);
    pass.end();
    d.queue.submit([enc.finish()]);
    await d.queue.onSubmittedWorkDone();
    onProgress && onProgress({ phase: "biotSavart", done: Math.min(ns, s + chunk), total: ns });
    if (signal?.aborted) throw new DOMException("Stopped.", "AbortError");
  }
  B.segKey = job.segKey;
}
