/* Jacobi-preconditioned conjugate gradients for  div(mu grad phi) = div((mu-1) Hs),  on the GPU.
 *
 * The CG scalars (rho, alpha, beta, residual) stay in the `scal` buffer on the device; iterations
 * are submitted in batches so the CPU reads back the residual only once per check interval.
 */

/* Queue a list of pipeline names into one command encoder.
 *
 * "cells" dispatches one thread per cell across the 2D workgroup grid; "one" is a single
 * workgroup, used by the scalar reductions. */
export function dispatch(G, B, list) {
  const enc = G.device.createCommandEncoder(), pass = enc.beginComputePass();
  for (const [name, kind] of list) {
    pass.setPipeline(G.pl[name]);
    pass.setBindGroup(0, B.bg[name]);
    if (kind === "one") pass.dispatchWorkgroups(1);
    else pass.dispatchWorkgroups(B.grid.gx, B.grid.gy);
  }
  pass.end();
  return enc;
}

export async function runPCG(G, B, { tolerance = 1e-5, maxIterations = 4000, checkInterval = 32, stallPatience = 6,
                                     onProgress, signal } = {}) {
  const d = G.device;
  d.queue.submit([dispatch(G, B, [["rhs", "cells"], ["init", "cells"], ["red0", "one"]]).finish()]);
  await d.queue.onSubmittedWorkDone();

  const t0 = performance.now(), batch = checkInterval, hist = [[0, 1]];
  let it = 0, rel = 1, best = Infinity, stall = 0, reason = "maxIterations";
  const one = [["matvec", "cells"], ["red1", "one"], ["update", "cells"], ["red2", "one"], ["pupdate", "cells"]];
  const seq = [];
  for (let k = 0; k < batch; k++) seq.push(...one);

  while (it < maxIterations) {
    const enc = dispatch(G, B, seq);
    enc.copyBufferToBuffer(B.scal, 0, B.readScal, 0, 32);
    d.queue.submit([enc.finish()]);
    await B.readScal.mapAsync(GPUMapMode.READ);
    const s = new Float32Array(B.readScal.getMappedRange().slice(0));
    B.readScal.unmap();
    it += batch;
    rel = Math.sqrt(Math.max(s[4], 0) / s[5]);
    hist.push([it, rel]);
    onProgress && onProgress({ phase: "pcg", iteration: it, residual: rel });
    if (!isFinite(rel)) { reason = "diverged"; break; }
    if (rel < tolerance) { reason = "tolerance"; break; }
    // Stopping mid-solve returns the partial potential rather than discarding it, so the caller
    // can still show a (clearly labelled) under-converged field. Callers that must not accept one
    // check `converged`.
    if (signal?.aborted) { reason = "aborted"; break; }
    if (rel < best * 0.95) { best = rel; stall = 0; }
    else if (++stall >= stallPatience) { reason = "stalled"; break; }
  }
  return { iters: it, rel, ms: performance.now() - t0, hist, reason, converged: reason === "tolerance" };
}

/* The per-phase free-space field, 9 floats per cell: three components for each of three phases at
 * unit current, exactly as the Biot-Savart kernel left them.
 *
 * This is 36 bytes a cell, four times the size of anything else read back, so it is fetched only
 * when a caller asks — the flux-linkage and inductance metrics are the only things that need it.
 * The staging buffer is created and destroyed per call rather than living in the buffer set, so a
 * plain solve never pays for it.
 */
export async function readPhaseH(G, B) {
  const d = G.device, bytes = 9 * B.N * 4;
  const staging = d.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  try {
    const enc = d.createCommandEncoder();
    enc.copyBufferToBuffer(B.H, 0, staging, 0, bytes);
    d.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const H = new Float32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    return H;
  } finally { staging.destroy(); }
}

/* Copy the source field, and optionally the potential, back to the CPU. */
export async function readBack(G, B, withPhi) {
  const d = G.device, N = B.N, enc = d.createCommandEncoder();
  enc.copyBufferToBuffer(B.Hs, 0, B.readHs, 0, 3 * N * 4);
  if (withPhi) enc.copyBufferToBuffer(B.x, 0, B.readX, 0, N * 4);
  d.queue.submit([enc.finish()]);
  await B.readHs.mapAsync(GPUMapMode.READ);
  const Hs = new Float32Array(B.readHs.getMappedRange().slice(0));
  B.readHs.unmap();
  let phi = new Float32Array(N);
  if (withPhi) {
    await B.readX.mapAsync(GPUMapMode.READ);
    phi = new Float32Array(B.readX.getMappedRange().slice(0));
    B.readX.unmap();
  }
  return { Hs, phi };
}
