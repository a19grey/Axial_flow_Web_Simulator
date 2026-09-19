/* Attaches the API to `window.AFS`.
 *
 * Loaded by headless.html on its own, and by the UI shell alongside the interface, so an agent can
 * drive the real page exactly as it drives the headless one.
 *
 * Progress callbacks cannot cross the browser-automation boundary, so every long-running call also
 * publishes its latest progress to AFS.progress and, if the page defines one, calls
 * window.__afsProgress(ev) — which cli/run.js binds to stream status to the terminal.
 */

import * as api from "./core/api.js";

const AFS = {
  version: api.API_VERSION,
  ready: true,
  progress: null,
  lastError: null,

  defaultSpec: api.defaultSpec,
  normalizeSpec: s => api.normalizeSpec(s).spec,
  specHash: api.specHash,
  getPathOn: api.getPath,
  setPathOn: api.setPath,
  capabilities: api.capabilities,
  plan: api.plan,
  cases: () => Object.entries(api.VALIDATION_CASES).map(([name, c]) => ({ name, title: c.title, reference: c.reference })),

  solve: (spec, opts) => call(() => api.solve(spec, withProgress(opts))),
  sweep: (spec, sweepSpec, opts) => call(() => api.sweep(spec, sweepSpec, withProgress(opts))),
  validate: (which, spec, opts) => call(() => api.validate(which, spec, withProgress(opts))),
  convergence: (spec, opts) => call(() => api.convergence(spec, withProgress(opts)))
};

function withProgress(opts = {}) {
  const user = opts.onProgress;
  return {
    ...opts,
    onProgress: ev => {
      AFS.progress = ev;
      if (typeof window.__afsProgress === "function") { try { window.__afsProgress(ev); } catch { /* the driver went away */ } }
      user && user(ev);
    }
  };
}

/* Automation reads errors far more reliably as a returned value than as a rejected promise that
 * has already crossed a serialization boundary. */
async function call(fn) {
  AFS.lastError = null;
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    const err = { message: e?.message || String(e), name: e?.name || "Error", stack: e?.stack || null };
    AFS.lastError = err;
    return { ok: false, error: err };
  }
}

window.AFS = AFS;
window.dispatchEvent(new CustomEvent("afs-ready"));
export default AFS;
