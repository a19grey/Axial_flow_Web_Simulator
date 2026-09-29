/* The run viewer: flipping through a night's worth of designs.
 *
 * A study writes an archive of plain JSON Lines outside the repository (see `docs/runs.md`); this
 * reads one back and draws it. The point is to be able to *look* at eight hours of search — to page
 * through the designs in the order the optimizer found them, watch the pole shape change, and see
 * which change moved the score.
 *
 * Nothing here solves anything. Every design's footprint is drawn from its own spec through the same
 * `src/core/curves.js` the solver rasterized it with, so a frame costs a millisecond and the whole
 * run can be scrubbed at video rate. That is deliberate: a viewer that had to re-solve to show you a
 * design would be a viewer nobody scrubs. The fields are in the tool itself — "Open in the tool"
 * hands the design to `index.html`, which will solve it.
 *
 * `window.RUNVIEW` is the automation surface: `count`, `goto(i)`, `ready`. `cli/frames.js` drives it
 * to grab a PNG per design, which is what turns a run into a movie.
 */

import { footprintCurve, footprintLoft } from "../core/ir.js";
import { curveFrame, tessellate, loftAt, toPolar, polarToXY } from "../core/curves.js";

const $ = s => document.querySelector(s);
const fmt = (v, d = 4) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : (+v).toPrecision(d));
const pct = v => (Number.isFinite(v) ? (v >= 0 ? "+" : "") + v.toFixed(2) + "%" : "—");

const state = {
  base: null,          // URL prefix of the run directory
  manifest: null,
  ledger: [],
  view: [],            // the filtered, ordered list being flipped through
  index: 0,
  mode: "best",        // best | all | feasible
  tier: null,
  designs: new Map(),  // hash -> { spec, record }
  playing: false
};

/* ---- loading ----------------------------------------------------------------------------------- */

async function fetchJSON(url) { const r = await fetch(url, { cache: "no-store" }); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); }
async function fetchJSONL(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) return [];
  return (await r.text()).split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

async function listRuns() {
  try { return await fetchJSON("runs/index.json"); }
  catch { return { root: "(not mounted)", runs: [] }; }
}

async function openRun(runId) {
  state.base = `runs/${runId}/`;
  status(`loading ${runId}…`);
  state.manifest = await fetchJSON(state.base + "run.json");
  state.ledger = await fetchJSONL(state.base + "ledger.jsonl");
  state.tier = state.manifest.primaryTier || "score";
  state.designs.clear();
  rebuild();
  status("");
  $("#runmeta").innerHTML = runSummary(state.manifest, state.ledger);
  history.replaceState(null, "", `?run=${encodeURIComponent(runId)}`);
}

/* The order things get flipped through in.
 *
 *   best      one entry per improvement of the score, in order — the storyboard, and the only
 *             sequence that tells a story rather than showing a search
 *   feasible  every design that scored, in evaluation order
 *   all       everything, including the designs that were rejected before they were meshed
 */
function rebuild() {
  const tier = state.tier;
  const ofTier = state.ledger.filter(e => !tier || e.tier === tier);
  if (state.mode === "all") state.view = ofTier;
  else if (state.mode === "feasible") state.view = ofTier.filter(e => e.score !== null);
  else {
    let best = -Infinity;
    state.view = ofTier.filter(e => { if (e.score === null || e.score <= best) return false; best = e.score; return true; });
  }
  state.index = Math.min(state.index, Math.max(0, state.view.length - 1));
  $("#scrub").max = String(Math.max(0, state.view.length - 1));
  $("#scrub").value = String(state.index);
  const tiers = [...new Set(state.ledger.map(e => e.tier))];
  $("#tier").innerHTML = tiers.map(t => `<option value="${t}"${t === tier ? " selected" : ""}>${t}</option>`).join("");
  show();
}

async function show() {
  const e = state.view[state.index];
  if (!e) { $("#vars").textContent = "nothing to show"; return; }
  $("#counter").textContent = `${state.index + 1} / ${state.view.length}`;
  $("#headline").innerHTML = headline(e);
  $("#scrub").value = String(state.index);

  let d = state.designs.get(e.hash);
  if (!d) {
    try { d = await fetchJSON(`${state.base}designs/${e.hash}.json`); }
    catch { d = { spec: null, record: null }; }
    state.designs.set(e.hash, d);
  }
  drawPlan($("#plan"), d.spec);
  drawLoft($("#loft"), d.spec);
  drawTrace($("#trace"), e);
  $("#vars").innerHTML = varTable(e, d);
  $("#open").onclick = () => {
    if (!d.spec) return;
    sessionStorage.setItem("afs-import-spec", JSON.stringify(d.spec));
    window.open("index.html#imported", "_blank");
  };
  $("#download").onclick = () => {
    if (!d.spec) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(d.spec, null, 2)], { type: "application/json" }));
    a.download = `${e.hash}.json`; a.click();
  };
}

/* ---- drawing ------------------------------------------------------------------------------------ */

const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function fit(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}

/* Plan view: the machine looked at down the shaft. The pole footprints are traced through exactly
 * the curve code the rasterizer used, at the height the loft makes widest and narrowest, so a flare
 * shows as two outlines rather than having to be imagined. */
function drawPlan(canvas, spec) {
  const { g, w, h } = fit(canvas);
  if (!spec) return;
  const s = spec.design.stator, r = spec.design.rotor;
  const ri = s.innerRadius_mm, ro = s.outerRadius_mm;
  const R = ro * 1.06;
  const k = Math.min(w, h) / (2 * R), cx = w / 2, cy = h / 2;
  const X = (x, y) => [cx + k * x, cy - k * y];

  // The stator: the active annulus and the coil pitch, so the pole can be read against what it faces.
  g.strokeStyle = css("--line"); g.lineWidth = 1;
  for (const rad of [ri, ro]) { g.beginPath(); g.arc(cx, cy, k * rad, 0, 2 * Math.PI); g.stroke(); }
  const coils = s.coilCount || Math.round(1.5 * s.poles);
  g.strokeStyle = css("--gpu"); g.globalAlpha = 0.22;
  for (let i = 0; i < coils; i++) {
    const a = (i + 0.5) * 2 * Math.PI / coils;
    g.beginPath(); g.moveTo(...X(ri * Math.cos(a), ri * Math.sin(a))); g.lineTo(...X(ro * Math.cos(a), ro * Math.sin(a))); g.stroke();
  }
  g.globalAlpha = 1;

  const poles = s.poles;
  const loft = footprintLoft(r.poleLoft);
  let curve = null;
  try { curve = footprintCurve(r.poleCurve); } catch { curve = null; }

  /* Two heights: the gap face and the yoke. On a constant sweep they coincide and one outline is
   * drawn; on a flared or twisted one the pair is the whole point. */
  const heights = loft ? [0, 1] : [0];
  for (let hi = 0; hi < heights.length; hi++) {
    const sH = heights[hi];
    g.lineWidth = hi === 0 ? 2 : 1;
    g.setLineDash(hi === 0 ? [] : [4, 3]);
    g.strokeStyle = hi === 0 ? css("--warn") : css("--muted");
    g.fillStyle = css("--warn"); g.globalAlpha = hi === 0 ? 0.13 : 0;
    for (let p = 0; p < poles; p++) {
      const centre = (p + 0.5) * 2 * Math.PI / poles;
      const pts = curve
        ? tessellate(curve, curveFrame({ r0: ri, r1: ro, centre, count: poles }), { loft, s: sH, tolerance_mm: 0.05 }).points
        : arcOutline(ri, ro, centre, 2 * Math.PI / poles * (r.poleArcFraction ?? 0.5));
      if (!pts || pts.length < 3) continue;
      g.beginPath();
      g.moveTo(...X(pts[0][0], pts[0][1]));
      for (let i = 1; i < pts.length; i++) g.lineTo(...X(pts[i][0], pts[i][1]));
      g.closePath();
      // Only the gap face is filled; the yoke outline is a dashed line over it, so a flare or a
      // waist reads as the offset between the two rather than as a second solid shape.
      if (hi === 0) { g.globalAlpha = 0.13; g.fill(); g.globalAlpha = 1; }
      g.stroke();
    }
  }
  g.setLineDash([]); g.globalAlpha = 1;
  g.fillStyle = css("--muted"); g.font = "11px ui-monospace, monospace";
  g.fillText(`${poles} poles   ${ri.toFixed(1)}–${ro.toFixed(1)} mm`, 8, h - 8);
  if (loft) g.fillText("solid: gap face    dashed: yoke", 8, h - 22);
}

function arcOutline(ri, ro, centre, span) {
  const pts = [], n = 24;
  for (let i = 0; i <= n; i++) { const a = centre - span / 2 + span * i / n; pts.push(polarToXY(ri, a)); }
  for (let i = n; i >= 0; i--) { const a = centre - span / 2 + span * i / n; pts.push(polarToXY(ro, a)); }
  return pts;
}

/* Side view: the pole's radial extent against height, which is what the loft's `scale` and `shift`
 * channels actually do and what no plan view can show. */
function drawLoft(canvas, spec) {
  const { g, w, h } = fit(canvas);
  if (!spec) return;
  const s = spec.design.stator, r = spec.design.rotor;
  const ri = s.innerRadius_mm, ro = s.outerRadius_mm, H = r.poleHeight_mm;
  const loft = footprintLoft(r.poleLoft);
  let curve = null;
  try { curve = footprintCurve(r.poleCurve); } catch { /* an arc pole has no curve */ }
  const pad = 26;
  const kx = (w - 2 * pad) / (ro * 1.05), ky = (h - 2 * pad) / (H * 1.6 || 1);
  const X = rad => pad + kx * rad, Y = z => h - pad - ky * z;

  g.strokeStyle = css("--line"); g.lineWidth = 1;
  g.beginPath(); g.moveTo(pad, Y(0)); g.lineTo(w - pad, Y(0)); g.stroke();      // the gap face
  g.beginPath(); g.moveTo(pad, Y(H)); g.lineTo(w - pad, Y(H)); g.stroke();      // the yoke

  const levels = loft ? 21 : 2;
  const lo = [], hi = [];
  for (let i = 0; i < levels; i++) {
    const t = levels === 1 ? 0 : i / (levels - 1);
    const m = loftAt(loft, t);
    const frame = curveFrame({ r0: ri, r1: ro, centre: 0, count: s.poles });
    let rmin = Infinity, rmax = -Infinity;
    if (curve) {
      for (const [uu] of curve.control) {
        const { r: rad } = toPolar(frame, uu, 0, m);
        rmin = Math.min(rmin, rad); rmax = Math.max(rmax, rad);
      }
    } else { rmin = ri; rmax = ro; }
    lo.push([rmin, t * H]); hi.push([rmax, t * H]);
  }
  g.fillStyle = css("--warn"); g.globalAlpha = 0.16;
  g.beginPath();
  g.moveTo(X(lo[0][0]), Y(lo[0][1]));
  for (const [rad, z] of lo) g.lineTo(X(rad), Y(z));
  for (let i = hi.length - 1; i >= 0; i--) g.lineTo(X(hi[i][0]), Y(hi[i][1]));
  g.closePath(); g.fill();
  g.globalAlpha = 1; g.strokeStyle = css("--warn"); g.lineWidth = 1.5; g.stroke();

  g.fillStyle = css("--muted"); g.font = "11px ui-monospace, monospace";
  g.fillText("gap face", pad, Y(0) + 14);
  g.fillText("yoke", pad, Y(H) - 5);
  g.fillText(`pole ${H.toFixed(2)} mm tall`, w - pad - 110, h - 8);
}

/* The search, as one line. Every evaluation on the current tier against its sequence number, with
 * the improvements marked and the design being shown highlighted — so a design is always seen in the
 * context of what the optimizer was doing when it found it. */
function drawTrace(canvas, current) {
  const { g, w, h } = fit(canvas);
  const pts = state.ledger.filter(e => e.tier === state.tier && e.score !== null);
  if (!pts.length) return;
  const xs = pts.map(e => e.seq), ys = pts.map(e => e.score);
  const x0 = Math.min(...xs), x1 = Math.max(...xs, x0 + 1);
  const y0 = Math.min(...ys), y1 = Math.max(...ys, y0 + 1e-12);
  const pad = 22;
  const X = v => pad + (w - 2 * pad) * (v - x0) / (x1 - x0);
  const Y = v => h - pad - (h - 2 * pad) * (v - y0) / (y1 - y0);

  // Stage boundaries, so the shape of the search is visible: a scan looks nothing like a CMA-ES run.
  const stages = [...new Set(pts.map(e => e.stage))];
  const palette = [css("--gpu"), css("--good"), css("--pa"), css("--pb"), css("--pc"), css("--muted")];
  g.globalAlpha = 0.85;
  pts.forEach(e => {
    g.fillStyle = palette[stages.indexOf(e.stage) % palette.length];
    g.fillRect(X(e.seq) - 1, Y(e.score) - 1, 2, 2);
  });
  g.globalAlpha = 1;

  let best = -Infinity; const run = [];
  for (const e of pts) { if (e.score > best) best = e.score; run.push([e.seq, best]); }
  g.strokeStyle = css("--ink"); g.lineWidth = 1.5;
  g.beginPath(); run.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y)))); g.stroke();

  if (current && current.score !== null) {
    g.strokeStyle = css("--warn"); g.lineWidth = 1;
    g.beginPath(); g.moveTo(X(current.seq), pad); g.lineTo(X(current.seq), h - pad); g.stroke();
    g.fillStyle = css("--warn");
    g.beginPath(); g.arc(X(current.seq), Y(current.score), 3.5, 0, 2 * Math.PI); g.fill();
  }
  g.fillStyle = css("--muted"); g.font = "11px ui-monospace, monospace";
  g.fillText(`${fmt(y1)}`, 3, pad - 6);
  g.fillText(`${fmt(y0)}`, 3, h - 6);
  g.fillText(stages.map((s, i) => s).join("  ·  "), pad + 4, 12);
}

/* ---- text --------------------------------------------------------------------------------------- */

function runSummary(m, ledger) {
  const solves = ledger.reduce((a, e) => a + (e.cost?.solves || 0), 0);
  const secs = ledger.reduce((a, e) => a + (e.cost?.elapsed_ms || 0), 0) / 1000;
  const nf = m.noiseFloor?.floor_pct;
  return [
    ["study", m.study], ["objective", m.objective], ["adapter", m.adapter],
    ["status", m.status], ["started", (m.started || "").replace("T", " ").slice(0, 19)],
    ["evaluations", ledver(ledger.length, m.cacheHits)], ["field solves", solves.toLocaleString()],
    ["solver time", `${(secs / 60).toFixed(1)} min`],
    ["noise floor", nf === null || nf === undefined ? "—" : nf.toFixed(2) + "%"],
    ["loss budget", m.lossBudget_W ? m.lossBudget_W.toFixed(2) + " W" : "—"],
    ["best", fmt(m.bestScore)], ["commit", (m.commit || "").slice(0, 8)]
  ].map(([k, v]) => `<dt>${k}</dt><dd>${v ?? "—"}</dd>`).join("");
}
const ledver = (n, hits) => `${n}${hits ? ` (+${hits} cached)` : ""}`;

function headline(e) {
  const m = e.metrics || {};
  const best = state.manifest?.bestScore;
  const rel = best && e.score !== null ? (e.score - best) / Math.abs(best) * 100 : null;
  return `<strong>${fmt(e.score, 5)}</strong> <span class="unit">${e.objective || "score"}</span>` +
    `<span class="chip">${e.stage}</span><span class="chip">${e.tier}</span>` +
    `<span class="chip">seq ${e.seq}</span>` +
    (e.score === null ? `<span class="chip bad">${e.rejectedBefore ? "rejected before " + e.rejectedBefore : "no score"}</span>` : "") +
    (rel !== null && rel < 0 ? `<span class="chip">${pct(rel)} of best</span>` : rel === 0 ? `<span class="chip good">best of the run</span>` : "") +
    (Number.isFinite(m.ripple_pct) ? `<span class="chip">ripple ${m.ripple_pct.toFixed(1)}%</span>` : "");
}

function varTable(e, d) {
  const m = e.metrics || {};
  const rows = [
    ["shear", fmt(m.shear_kPa) + " kPa"], ["mean torque", fmt(m.torque_mNm) + " mN·m"],
    ["ripple", Number.isFinite(m.ripple_pct) ? m.ripple_pct.toFixed(1) + " %" : "—"],
    ["current phase", Number.isFinite(m.gamma_deg) ? m.gamma_deg.toFixed(2) + "° elec" : "—"],
    ["current", fmt(m.amps_A, 4) + " A peak"], ["copper loss", fmt(m.copperLoss_W, 4) + " W"],
    ["peak B in iron", fmt(m.peakB_mT, 4) + " mT"],
    ["surface spread", Number.isFinite(m.surfaceSpread_pct) ? m.surfaceSpread_pct.toFixed(2) + " %" : "—"],
    ["superposition", Number.isFinite(m.confirmError_pct) ? m.confirmError_pct.toExponential(1) + " %" : "—"],
    ["mass", fmt(m.mass_kg, 4) + " kg"],
    ["cells", m.cells ? m.cells.toLocaleString() : "—"],
    ["gap cells", fmt(m.gapCells, 3)], ["CG iterations", m.iterations ?? "—"],
    ["solves", `${e.cost?.solves ?? "—"} in ${((e.cost?.elapsed_ms || 0) / 1000).toFixed(2)} s`]
  ];
  const failed = (e.gates || []).filter(g => !g.pass);
  const gates = failed.length
    ? `<div class="gates">${failed.map(g => `<div class="bad">✕ ${g.name}${g.detail ? ": " + g.detail : ""}</div>`).join("")}</div>`
    : `<div class="gates"><div class="good">✓ every gate passed</div></div>`;
  const vars = e.vars
    ? `<table class="vars">${Object.entries(e.vars).map(([k, v]) =>
        `<tr><th>${k}</th><td>${(+v).toFixed(4)}</td></tr>`).join("")}</table>`
    : "";
  return `<dl class="metrics">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>${gates}` +
    (vars ? `<div class="vecblock"><h4>design vector</h4>${vars}</div>` : "") +
    (d.record?.results?.quality?.length ? `<h4>quality</h4>${d.record.results.quality.map(f => `<div class="${f.level === "error" ? "bad" : "warn"}">${f.message}</div>`).join("")}` : "");
}

const status = s => { $("#status").textContent = s; };

/* ---- wiring -------------------------------------------------------------------------------------- */

function step(n) { state.index = Math.max(0, Math.min(state.view.length - 1, state.index + n)); show(); }

async function boot() {
  const { root, runs } = await listRuns();
  $("#root").textContent = root;
  /* Someone arriving at the hosted copy has no runs folder and no reason to know that. Rather than
   * an empty dropdown over an empty canvas, hand them the three commands that produce one. */
  if (!runs.length) {
    $("#empty").classList.add("on");
    for (const sel of ["#viewer", "aside", "#hint"]) { const el = $(sel); if (el) el.style.display = "none"; }
  }
  $("#runs").innerHTML = runs.length
    ? runs.map(r => `<option value="${r.runId}">${r.runId} — ${r.study || "?"} — best ${fmt(r.best)} (${r.status || "?"})</option>`).join("")
    : `<option value="">no runs found</option>`;
  $("#runs").onchange = () => $("#runs").value && openRun($("#runs").value);
  $("#mode").onchange = () => { state.mode = $("#mode").value; state.index = 0; rebuild(); };
  $("#tier").onchange = () => { state.tier = $("#tier").value; state.index = 0; rebuild(); };
  $("#scrub").oninput = () => { state.index = +$("#scrub").value; show(); };
  $("#prev").onclick = () => step(-1);
  $("#next").onclick = () => step(1);
  $("#play").onclick = () => play(!state.playing);
  $("#reload").onclick = () => state.manifest && openRun(state.manifest.runId);
  window.addEventListener("keydown", ev => {
    if (ev.key === "ArrowLeft") step(-1);
    else if (ev.key === "ArrowRight") step(1);
    else if (ev.key === " ") { play(!state.playing); ev.preventDefault(); }
    else if (ev.key === "Home") { state.index = 0; show(); }
    else if (ev.key === "End") { state.index = state.view.length - 1; show(); }
  });
  window.addEventListener("resize", () => show());

  const want = new URL(location.href).searchParams;
  const pick = want.get("run") || (runs[0] && runs[0].runId);
  if (want.get("frames")) document.body.classList.add("frames");
  if (pick) { $("#runs").value = pick; await openRun(pick); }
  if (want.get("mode")) { state.mode = want.get("mode"); $("#mode").value = state.mode; rebuild(); }
  RUNVIEW.ready = true;
}

let timer = null;
function play(on) {
  state.playing = on;
  $("#play").textContent = on ? "pause" : "play";
  clearInterval(timer);
  if (on) timer = setInterval(() => {
    if (state.index >= state.view.length - 1) { play(false); return; }
    step(1);
  }, +$("#fps").value > 0 ? 1000 / +$("#fps").value : 250);
}

/* The automation surface. `cli/frames.js` waits for `ready`, reads `count`, and calls `goto` once
 * per frame — which is also exactly what a person does with the arrow keys, so there is only one
 * code path to get wrong. */
const RUNVIEW = {
  ready: false,
  get count() { return state.view.length; },
  get current() { return state.view[state.index] || null; },
  async goto(i) { state.index = Math.max(0, Math.min(state.view.length - 1, i | 0)); await show(); return RUNVIEW.current; },
  open: openRun,
  setMode(m) { state.mode = m; state.index = 0; rebuild(); },
  setTier(t) { state.tier = t; state.index = 0; rebuild(); }
};
window.RUNVIEW = RUNVIEW;

boot().catch(e => status("could not load: " + e.message));
