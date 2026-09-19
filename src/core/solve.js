/* Solve orchestration: geometry -> GPU -> field. The one function both the UI and the headless API
 * call. Progress arrives through a callback; nothing here knows the DOM exists. */

import { MU0 } from "./constants.js";
import { coefs } from "./assemble.js";
import { initGPU } from "../gpu/device.js";
import { ensureBuffers } from "../gpu/buffers.js";
import { runBiotSavart } from "../gpu/biotsavart.js";
import { runPCG, readBack, dispatch } from "../gpu/pcg.js";

/* Three-phase currents for rotor angle theta (mechanical) and current angle gamma (electrical,
 * measured from the rotor d-axis). */
export function phaseCurrents(p) {
  const phi = ((p.poles / 2) * p.theta + p.gamma) * Math.PI / 180;
  return [p.amps * Math.cos(phi), p.amps * Math.cos(phi - 2 * Math.PI / 3), p.amps * Math.cos(phi - 4 * Math.PI / 3)];
}

export async function solveJob(job, opts = {}) {
  const { onProgress, signal, currents, uniformH, skipPCG, solver = {} } = opts;
  const G = await initGPU(), B = ensureBuffers(G, job), d = G.device, t = {};

  let t0 = performance.now();
  if (job.segs) {
    if (B.segKey !== job.segKey) {
      await runBiotSavart(G, B, job, { onProgress, signal });
      t.bs = performance.now() - t0; t.bsCached = false;
    } else { t.bs = 0; t.bsCached = true; }
  }

  t0 = performance.now();
  const c = coefs(job);
  d.queue.writeBuffer(B.cX, 0, c.cX); d.queue.writeBuffer(B.cY, 0, c.cY);
  d.queue.writeBuffer(B.cZ, 0, c.cZ); d.queue.writeBuffer(B.diag, 0, c.diag);
  if (uniformH) {
    const Hs = new Float32Array(3 * B.N);
    for (let k = 0; k < B.N; k++) Hs[3 * k + 2] = uniformH;
    d.queue.writeBuffer(B.Hs, 0, Hs);
  } else {
    const I = currents || [1, 0, 0];
    d.queue.writeBuffer(B.cur, 0, new Float32Array([I[0], I[1], I[2], 0]));
    d.queue.submit([dispatch(G, B, [["combine", B.parts]]).finish()]);
  }
  t.setup = performance.now() - t0;

  let pcg = null;
  if (!skipPCG) pcg = await runPCG(G, B, { ...solver, onProgress, signal });

  t0 = performance.now();
  const { Hs, phi } = await readBack(G, B, !skipPCG);
  const F = fieldB(job, Hs, phi);
  t.post = performance.now() - t0;

  return { job, ...F, Hs, phi, pcg, t, N: B.N, nseg: job.segs ? job.segs.length / 8 : 0, adapter: G.name };
}

/* Flux-conservative reconstruction: B on each face is mu_face (Hs - dphi/dn), exactly the flux the
 * solver balanced. Cell-centre B averages the two faces in each direction, so normal B stays
 * continuous across material edges. */
export function fieldB(job, Hs, phi) {
  const { nx, ny, nz, mu } = job, h = job.hm * 1e-3, N = nx * ny * nz, sy = nx, sz = nx * ny;
  const Bx = new Float32Array(N), By = new Float32Array(N), Bz = new Float32Array(N);
  const fl = (k, s, c) => {
    const a = mu[k], b = mu[k + s];
    return MU0 * (2 * a * b / (a + b)) * (0.5 * (Hs[3 * k + c] + Hs[3 * (k + s) + c]) - (phi[k + s] - phi[k]) / h);
  };
  for (let iz = 1; iz < nz - 1; iz++) for (let iy = 1; iy < ny - 1; iy++) for (let ix = 1; ix < nx - 1; ix++) {
    const k = (iz * ny + iy) * nx + ix;
    Bx[k] = 0.5 * (fl(k, 1, 0) + fl(k - 1, 1, 0));
    By[k] = 0.5 * (fl(k, sy, 1) + fl(k - sy, sy, 1));
    Bz[k] = 0.5 * (fl(k, sz, 2) + fl(k - sz, sz, 2));
  }
  return { Bx, By, Bz };
}
