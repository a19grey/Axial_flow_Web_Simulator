/* Solve orchestration: geometry -> GPU -> field. The one function both the UI and the headless API
 * call. Progress arrives through a callback; nothing here knows the DOM exists. */

import { MU0 } from "./constants.js";
import { coefs } from "./assemble.js";
import { initGPU, checkDeviceErrors, clearDeviceErrors } from "../gpu/device.js";
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
  const G = await initGPU();
  clearDeviceErrors();
  const B = ensureBuffers(G, job), d = G.device, t = {};

  let t0 = performance.now();
  if (job.segs) {
    if (B.segKey !== job.segKey) {
      await runBiotSavart(G, B, job, { onProgress, signal });
      checkDeviceErrors("the Biot-Savart pass");
      t.bs = performance.now() - t0; t.bsCached = false;
    } else { t.bs = 0; t.bsCached = true; }
  }

  t0 = performance.now();
  const c = coefs(job);
  d.queue.writeBuffer(B.cX, 0, c.cX); d.queue.writeBuffer(B.cY, 0, c.cY); d.queue.writeBuffer(B.cZ, 0, c.cZ);
  d.queue.writeBuffer(B.sX, 0, c.sX); d.queue.writeBuffer(B.sY, 0, c.sY); d.queue.writeBuffer(B.sZ, 0, c.sZ);
  d.queue.writeBuffer(B.diag, 0, c.diag);
  if (uniformH) {
    const Hs = new Float32Array(3 * B.N);
    for (let k = 0; k < B.N; k++) Hs[3 * k + 2] = uniformH;
    d.queue.writeBuffer(B.Hs, 0, Hs);
  } else {
    const I = currents || [1, 0, 0];
    d.queue.writeBuffer(B.cur, 0, new Float32Array([I[0], I[1], I[2], 0]));
    d.queue.submit([dispatch(G, B, [["combine", "cells"]]).finish()]);
  }
  t.setup = performance.now() - t0;

  let pcg = null;
  if (!skipPCG) pcg = await runPCG(G, B, { ...solver, onProgress, signal });
  checkDeviceErrors("the potential solve");

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
  const m = job.mesh, mu = job.mu;
  const { nx, ny, nz, N, sy, sz } = m;
  const Bx = new Float32Array(N), By = new Float32Array(N), Bz = new Float32Array(N);

  // Centre-to-centre distances in metres, one lookup per axis.
  const dxf = m.dxf, dyf = m.dyf, dzf = m.dzf;
  const fl = (k, s, c, d) => {
    const a = mu[k], b = mu[k + s];
    return MU0 * (2 * a * b / (a + b)) * (0.5 * (Hs[3 * k + c] + Hs[3 * (k + s) + c]) - (phi[k + s] - phi[k]) / (d * 1e-3));
  };
  // The cell centre lies exactly midway between its own two faces on each axis, whatever the
  // grading, so averaging the two face values stays the right interpolation.
  for (let iz = 1; iz < nz - 1; iz++) for (let iy = 1; iy < ny - 1; iy++) {
    const base = (iz * ny + iy) * nx;
    for (let ix = 1; ix < nx - 1; ix++) {
      const k = base + ix;
      Bx[k] = 0.5 * (fl(k, 1, 0, dxf[ix]) + fl(k - 1, 1, 0, dxf[ix - 1]));
      By[k] = 0.5 * (fl(k, sy, 1, dyf[iy]) + fl(k - sy, sy, 1, dyf[iy - 1]));
      Bz[k] = 0.5 * (fl(k, sz, 2, dzf[iz]) + fl(k - sz, sz, 2, dzf[iz - 1]));
    }
  }
  return { Bx, By, Bz };
}
