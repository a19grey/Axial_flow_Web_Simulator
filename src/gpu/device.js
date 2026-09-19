/* WebGPU device acquisition and compute-pipeline creation. No DOM.
 *
 * The device is a module-level singleton because pipelines and buffers are expensive to rebuild and
 * every solve in a sweep or an optimization reuses them.
 */

import { SH } from "./shaders.js";

let gpu = null;
const lostHandlers = new Set();

/* Scoped error capture.
 *
 * WebGPU reports validation and out-of-memory failures asynchronously. Without checking, a rejected
 * dispatch simply does nothing and the solve returns a field of zeros — which is how a mesh past
 * the workgroup-per-dimension cap once produced a confident torque of 0.000, faster than a correct
 * run.
 *
 * Error *scopes* rather than the global uncapturederror event, because a scope attributes the
 * failure to the work that caused it. A global latch would let an unrelated error — the renderer
 * failing to allocate a texture, say — surface as "the GPU rejected work during the potential
 * solve", which sends the reader somewhere else entirely.
 */
export function beginErrorScope(device) {
  device.pushErrorScope("out-of-memory");
  device.pushErrorScope("validation");
}

export async function endErrorScope(device, context) {
  const validation = await device.popErrorScope();
  const oom = await device.popErrorScope();
  const err = validation || oom;
  if (!err) return;
  throw new Error(`The GPU rejected work during ${context}: ${err.message}. ` +
                  `The result would have been wrong, so it was discarded.`);
}

/* Notified when the adapter drops the device (usually an out-of-memory grid). */
export function onDeviceLost(fn) { lostHandlers.add(fn); return () => lostHandlers.delete(fn); }

export function currentDevice() { return gpu; }

export async function initGPU() {
  if (gpu) return gpu;
  if (!navigator.gpu) throw new Error("WebGPU isn't available in this browser. Use a recent Chrome or Edge, or Safari 26+.");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No WebGPU adapter was found on this device.");
  const L = adapter.limits;
  const device = await adapter.requestDevice({
    requiredLimits: { maxStorageBufferBindingSize: L.maxStorageBufferBindingSize, maxBufferSize: L.maxBufferSize }
  });
  device.lost.then(info => {
    gpu = null;
    for (const fn of lostHandlers) { try { fn(info); } catch (e) { console.error(e); } }
  });

  // Anything not inside a scope — renderer work, mostly — still gets reported rather than lost.
  device.addEventListener("uncapturederror", ev => {
    console.error("WebGPU error (unscoped):", ev.error?.message || String(ev.error));
  });
  const mk = (code, constants) => device.createComputePipeline({
    layout: "auto",
    compute: { module: device.createShaderModule({ code }), entryPoint: "main", constants }
  });
  const info = adapter.info || {};
  gpu = {
    device, adapter, limits: device.limits,
    name: [info.vendor, info.architecture, info.device].filter(Boolean).join(" ") || "WebGPU adapter",
    info: { vendor: info.vendor || "", architecture: info.architecture || "", device: info.device || "", description: info.description || "" },
    pl: {
      init: mk(SH.init), matvec: mk(SH.matvec), update: mk(SH.update), pupdate: mk(SH.pupdate),
      red0: mk(SH.reduce, { MODE: 0 }), red1: mk(SH.reduce, { MODE: 1 }), red2: mk(SH.reduce, { MODE: 2 }),
      bs: mk(SH.bs), combine: mk(SH.combine), rhs: mk(SH.rhs)
    },
    buf: null
  };
  return gpu;
}

/* A software adapter (SwiftShader, llvmpipe, WARP) produces correct fields but meaningless timings,
 * and is far too slow for any serious grid. Callers that report performance must check this. */
export function isSoftwareAdapter(G) {
  const s = `${G.name} ${G.info.description}`.toLowerCase();
  return /swiftshader|llvmpipe|software|warp|lavapipe|basic render/.test(s);
}

export async function capabilities() {
  const G = await initGPU();
  const L = G.limits;
  return {
    adapter: G.name,
    info: G.info,
    software: isSoftwareAdapter(G),
    limits: {
      maxStorageBufferBindingSize: L.maxStorageBufferBindingSize,
      maxBufferSize: L.maxBufferSize,
      maxComputeWorkgroupsPerDimension: L.maxComputeWorkgroupsPerDimension
    },
    // The per-phase Biot-Savart field is the largest single binding at 9 floats per cell.
    maxCellsByBinding: Math.floor(L.maxStorageBufferBindingSize / (9 * 4))
  };
}
