/* Shared UI plumbing: element lookup, the status line, the busy flag, and the page-level state
 * the panels and the renderer both read. Everything DOM-facing that more than one UI module needs
 * lives here, so there is one definition of each rather than one per file. */

export const $ = s => document.querySelector(s);

export const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/* The page's view of the last solve. The solver itself is stateless; this is presentation state. */
export const ui = {
  sol: null,        // the last solution, fields included
  sweep: null,      // { pts: [[gamma_deg, torque_Nm], ...], base: spec }
  angle: null,      // the last torque-vs-rotor-angle study, which shares the sweep canvas
  busy: false,
  abort: null,      // AbortController for the run in flight
  adapterName: "",
  field: "bz"
};

export function setStatus(message, isError) {
  const s = $("#status");
  if (!s) return;
  s.textContent = message;
  s.classList.toggle("err", !!isError);
}

/* Buttons that start work are disabled while work is in flight; Stop is the inverse. */
const BUSY_DISABLES = ["#solve", "#sweep", "#vLoop", "#vSphere"];

export function setBusy(b) {
  ui.busy = b;
  if (b) ui.abort = new AbortController();
  BUSY_DISABLES.forEach(i => { const el = $(i); if (el) el.disabled = b; });
  const stop = $("#stop");
  if (stop) stop.disabled = !b;
}

export function requestStop() { ui.abort?.abort(); }

/* Wrap an action so a failure lands on the status line instead of the console only. */
export async function guarded(fn) {
  setBusy(true);
  try {
    await fn(ui.abort.signal);
  } catch (e) {
    if (e?.name === "AbortError") setStatus("Stopped.");
    else { console.error(e); setStatus(e?.message || String(e), true); }
  }
  setBusy(false);
}
