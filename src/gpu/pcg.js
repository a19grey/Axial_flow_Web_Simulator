/* Jacobi-preconditioned conjugate gradients for  div(mu grad phi) = div((mu-1) Hs),  on the GPU.
 *
 * The CG scalars (rho, alpha, beta, residual) stay in the `scal` buffer on the device; iterations
 * are submitted in batches so the CPU reads back the residual only once per check interval.
 */

/* Queue a list of [pipelineName, workgroupCount] into one command encoder. */
export function dispatch(G, B, list) {
  const enc = G.device.createCommandEncoder(), pass = enc.beginComputePass();
  for (const [name, n] of list) {
    pass.setPipeline(G.pl[name]);
    pass.setBindGroup(0, B.bg[name]);
    pass.dispatchWorkgroups(n);
  }
  pass.end();
  return enc;
}

export async function runPCG(G, B, { tolerance = 1e-5, maxIterations = 4000, checkInterval = 32, stallPatience = 6,
                                     onProgress, signal } = {}) {
  const d = G.device, g = B.parts;
  d.queue.submit([dispatch(G, B, [["rhs", g], ["init", g], ["red0", 1]]).finish()]);
  await d.queue.onSubmittedWorkDone();

  const t0 = performance.now(), batch = checkInterval, hist = [[0, 1]];
  let it = 0, rel = 1, best = Infinity, stall = 0, reason = "maxIterations";
  const one = [["matvec", g], ["red1", 1], ["update", g], ["red2", 1], ["pupdate", g]];
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
