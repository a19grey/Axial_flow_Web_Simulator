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
  const { nx, ny, nz, N, sy, sz, periodicY } = m;
  // On a cylindrical mesh these are (B_r, B_theta, B_z) in the mesh's own basis.
  const Bx = new Float32Array(N), By = new Float32Array(N), Bz = new Float32Array(N);
  const D = m.distM;
  const cyl = m.kind === "cylindrical";

  // Flux density on the face between cell k and cell k + step, given the distance across it.
  const fl = (k, step, comp, d) => {
    const a = mu[k], b = mu[k + step];
    return MU0 * (2 * a * b / (a + b)) * (0.5 * (Hs[3 * k + comp] + Hs[3 * (k + step) + comp]) - (phi[k + step] - phi[k]) / d);
  };

  // The cell centre lies exactly midway between its own two faces on each axis, whatever the
  // grading, so averaging the two face values stays the right interpolation.
  const iy0 = periodicY ? 0 : 1, iy1 = periodicY ? ny : ny - 1;
  // A cylindrical mesh has no boundary at the axis: the r = 0 face carries no flux, and B_r there
  // is zero by symmetry, so cell 0 averages that zero against its outer face.
  const ix0 = cyl ? 0 : 1;

  for (let iz = 1; iz < nz - 1; iz++) {
    const d0k = D[0].k[iz], d1k = D[1].k[iz], d2 = D[2].k[iz], d2m = D[2].k[iz - 1];
    for (let iy = iy0; iy < iy1; iy++) {
      const base = (iz * ny + iy) * nx;
      const d0jk = D[0].j[iy] * d0k;
      // Neighbour offsets along the wrapping axis, and the face distances either side.
      const lastY = iy === ny - 1;
      const yp = lastY ? sy - sz : sy;              // offset to the +y neighbour
      const ym = iy === 0 ? sy * (ny - 1) : -sy;    // offset to the -y neighbour
      const iym = iy === 0 ? ny - 1 : iy - 1;
      const d1p = D[1].j[iy] * d1k;                 // distance across this cell's +y face
      const d1m = D[1].j[iym] * d1k;                // ...and across the one below it
      for (let ix = ix0; ix < nx - 1; ix++) {
        const k = base + ix;
        const outerR = fl(k, 1, 0, D[0].i[ix] * d0jk);
        const innerR = ix === 0 ? 0 : fl(k - 1, 1, 0, D[0].i[ix - 1] * d0jk);
        Bx[k] = 0.5 * (outerR + innerR);
        By[k] = 0.5 * (fl(k, yp, 1, D[1].i[ix] * d1p) + fl(k + ym, -ym, 1, D[1].i[ix] * d1m));
        Bz[k] = 0.5 * (fl(k, sz, 2, d2) + fl(k - sz, sz, 2, d2m));
      }
    }
  }
  return { Bx, By, Bz };
}
