/* Canvas plots: the torque-vs-current-angle sweep and the convergence / loop-validation panel. */

import { $, ui } from "./dom.js";
import { css } from "./format.js";
import { MU0 } from "../core/constants.js";
import { interpCentre } from "../core/torque.js";

function niceTicks(a, b, count = 5) {
  const raw = (b - a) / count || 1, mag = 10 ** Math.floor(Math.log10(Math.abs(raw))), e = raw / mag;
  const step = mag * (e < 1.5 ? 1 : e < 3 ? 2 : e < 7 ? 5 : 10), t = [];
  for (let v = Math.ceil(a / step) * step; v <= b + step * 1e-9; v += step) t.push(+v.toFixed(10));
  return t;
}
function drawPlot(cv, cfg) {
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const ink = css("--ink"), muted = css("--muted"), line = css("--line");
  const m = { l: 58, r: 12, t: 12, b: 38 }, pw = W - m.l - m.r, ph = H - m.t - m.b;
  const [x0, x1] = cfg.xr, [y0, y1] = cfg.yr;
  const X = x => m.l + (x - x0) / (x1 - x0) * pw, Y = y => m.t + ph - (y - y0) / (y1 - y0) * ph;
  g.font = "12px IBM Plex Sans, sans-serif"; g.lineWidth = 1; g.strokeStyle = line; g.fillStyle = muted;
  g.textAlign = "right"; g.textBaseline = "middle";
  for (const t of cfg.yticks) { g.beginPath(); g.moveTo(m.l, Y(t)); g.lineTo(m.l + pw, Y(t)); g.stroke(); g.fillText(cfg.yfmt(t), m.l - 6, Y(t)); }
  g.textAlign = "center"; g.textBaseline = "top";
  for (const t of cfg.xticks) g.fillText(cfg.xfmt(t), X(t), m.t + ph + 6);
  g.fillText(cfg.xlabel, m.l + pw / 2, H - 16);
  g.save(); g.translate(12, m.t + ph / 2); g.rotate(-Math.PI / 2); g.textBaseline = "middle"; g.fillText(cfg.ylabel, 0, 0); g.restore();
  g.save(); g.beginPath(); g.rect(m.l, m.t, pw, ph); g.clip();
  for (const s of cfg.series) {
    g.strokeStyle = g.fillStyle = s.color; g.lineWidth = 2;
    if (s.style === "dots") for (const [x, y] of s.pts) { g.beginPath(); g.arc(X(x), Y(y), 4, 0, 7); g.fill(); }
    else { g.beginPath(); s.pts.forEach(([x, y], i) => i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y))); g.stroke(); }
  }
  g.restore();
  let lx = m.l + 10; g.textAlign = "left"; g.textBaseline = "middle";
  for (const s of cfg.series) { g.fillStyle = s.color; g.fillRect(lx, m.t + 8, 10, 3); g.fillStyle = ink; g.fillText(s.label, lx + 14, m.t + 10); lx += g.measureText(s.label).width + 34; }
}
/* Torque through one electrical period of rotor rotation, on the same canvas as the current-angle
 * sweep. The two are alternatives — one holds the rotor still and turns the current vector, the
 * other turns both together — so whichever ran last owns the plot. */
export function drawAngleSweep(r) {
  ui.sweep = null;
  ui.angle = r;
  const cv = $("#sweepPlot"), t = $("#p1title");
  if (t) t.innerHTML = `Torque vs rotor angle <span class="muted" style="font-weight:400">— one electrical period, ripple ${r.ripple_pct === null ? "—" : r.ripple_pct.toFixed(1) + "%"} peak-to-peak</span>`;
  const pts = r.points.filter(p => p.torque_mNm !== null).map(p => [p.rotorAngle_deg, p.torque_mNm]);
  if (!pts.length) return;
  // Close the loop: the waveform is periodic, so the first point is also the last.
  const closed = [...pts, [pts[0][0] + r.period_deg, pts[0][1]]];
  const x0 = closed[0][0], x1 = closed[closed.length - 1][0];
  const ys = pts.map(p => p[1]), lo = Math.min(0, ...ys), hi = Math.max(...ys);
  const pad = 0.12 * Math.max(1e-9, hi - lo);
  const mean = ys.reduce((a, b) => a + b, 0) / ys.length;
  drawPlot(cv, { xr: [x0, x1], yr: [lo - pad, hi + pad], xticks: niceTicks(x0, x1, 6), yticks: niceTicks(lo - pad, hi + pad),
    xfmt: v => v.toFixed(0) + "°", yfmt: v => (Math.abs(hi) < 1 ? v.toFixed(3) : v.toFixed(1)),
    xlabel: "rotor angle (mechanical)", ylabel: "torque (mN·m)",
    series: [{ pts: [[x0, mean], [x1, mean]], color: css("--muted"), label: `mean ${mean.toFixed(4)} mN·m` },
             { pts: closed, color: css("--gpu"), label: "GPU solve per position" }] });
}

/* Least-squares fit of T = A sin2γ + B cos2γ to a current-angle sweep.
 *
 * Reluctance torque follows sin 2γ to first order, so two coefficients describe the whole sweep.
 * The fit is unit-agnostic — it is used on mN·m here for the plot and on N·m by the sweep action —
 * and the peak angle does not depend on either. Written as T = R cos(2γ − φ) with φ = atan2(A, B),
 * the maximum sits at γ = φ/2, folded into [0, 180) because γ has an electrical period of 180°.
 */
export function sin2Fit(pts) {
  let a = 0, b = 0, ss = 0, cc = 0, sc = 0;
  for (const [g, T] of pts) {
    const s = Math.sin(2 * g * Math.PI / 180), c = Math.cos(2 * g * Math.PI / 180);
    a += T * s; b += T * c; ss += s * s; cc += c * c; sc += s * c;
  }
  const det = ss * cc - sc * sc;
  const A = det ? (a * cc - b * sc) / det : 0, B = det ? (b * ss - a * sc) / det : 0;
  return {
    A, B, amp: Math.hypot(A, B),
    peak: det ? ((Math.atan2(A, B) * 180 / Math.PI) / 2 + 180) % 180 : NaN,
    at: g => A * Math.sin(2 * g * Math.PI / 180) + B * Math.cos(2 * g * Math.PI / 180)
  };
}

export function drawSweep() {
  const sw = ui.sweep, cv = $("#sweepPlot");
  // The rotor-angle plot owns the canvas until a current-angle sweep replaces it.
  if (!sw && ui.angle) { drawAngleSweep(ui.angle); return; }
  const title = $("#p1title");
  if (title && !ui.angle) title.innerHTML = `Torque vs current angle <span class="muted" style="font-weight:400">— reluctance torque should follow sin 2γ</span>`;
  if (!sw || !sw.pts.length) { drawPlot(cv, { xr: [0, 180], yr: [-1, 1], xticks: niceTicks(0, 180, 6), yticks: niceTicks(-1, 1), xfmt: v => v + "°", yfmt: v => v, xlabel: "current angle γ (electrical)", ylabel: "torque (mN·m)", series: [] }); return; }
  const pts = sw.pts.map(([g, T]) => [g, T * 1e3]);
  const f = sin2Fit(pts);
  const fit = []; for (let g = 0; g <= 180; g += 2) fit.push([g, f.at(g)]);
  sw.fit = { amp: f.amp, peak: f.peak };
  /* The confirming solve at the fitted peak, once it has run. It is drawn as its own series rather
   * than folded into the sweep, because it is the one point the fit predicted instead of one the
   * fit was made from: how far it sits off the curve is the only check the fit gets. */
  const peak = sw.peak ? [[sw.peak.gamma_deg, sw.peak.torque_mNm]] : [];
  const ymax = Math.max(1e-6, ...pts.map(p => Math.abs(p[1])), ...fit.map(p => Math.abs(p[1])),
                        ...peak.map(p => Math.abs(p[1]))) * 1.15;
  const series = [
    { pts: fit, color: css("--muted"), label: `sin 2γ fit, peak ${f.amp.toFixed(2)} mN·m at ${f.peak.toFixed(0)}°` },
    { pts, style: "dots", color: css("--gpu"), label: "GPU solve" }
  ];
  if (peak.length) series.push({ pts: peak, style: "dots", color: css("--good"),
    label: `solved at the peak: ${sw.peak.torque_mNm.toFixed(2)} mN·m at ${sw.peak.gamma_deg.toFixed(1)}°` });
  drawPlot(cv, { xr: [0, 180], yr: [-ymax, ymax], xticks: niceTicks(0, 180, 6), yticks: niceTicks(-ymax, ymax),
    xfmt: v => v + "°", yfmt: v => Math.abs(ymax) < 1 ? v.toFixed(2) : v.toFixed(1), xlabel: "current angle γ (electrical)", ylabel: "torque (mN·m)",
    series });
}
export function drawP2() {
  const sol = ui.sol, cv = $("#p2");
  if (sol && sol.job.kind === "loop") {
    $("#p2title").textContent = "Loop test: axial field on the axis";
    const { job } = sol, m = job.mesh, pts = [], ana = [];
    for (let iz = 1; iz < m.nz - 1; iz++) pts.push([m.zc[iz], interpCentre(sol.Bz, job, iz) * 1e6]);
    for (let z = m.z0; z <= m.z1; z += 0.5) ana.push([z, MU0 * job.R ** 2 / (2 * ((job.R * 1e-3) ** 2 + (z * 1e-3) ** 2) ** 1.5) * 1e-6 * 1e6]);
    const ymax = Math.max(...ana.map(p => p[1])) * 1.1;
    drawPlot(cv, { xr: [m.z0, m.z1], yr: [0, ymax], xticks: niceTicks(m.z0, m.z1), yticks: niceTicks(0, ymax), xfmt: v => v, yfmt: v => v.toFixed(0), xlabel: "z on axis (mm)", ylabel: "B_z (μT per A)",
      series: [{ pts: ana, color: css("--muted"), label: "analytic" }, { pts, style: "dots", color: css("--gpu"), label: "GPU Biot-Savart" }] });
    return;
  }
  $("#p2title").textContent = "Convergence of the potential solve";
  const h = sol && sol.pcg ? sol.pcg.hist.map(([i, r]) => [i, Math.log10(Math.max(r, 1e-12))]) : [];
  const xm = Math.max(32, ...h.map(p => p[0])), ym = Math.min(-6, Math.floor(Math.min(0, ...h.map(p => p[1]))));
  drawPlot(cv, { xr: [0, xm], yr: [ym, 0.3], xticks: niceTicks(0, xm), yticks: niceTicks(ym, 0).filter(Number.isInteger), xfmt: v => v, yfmt: v => "1e" + v, xlabel: "CG iteration", ylabel: "relative residual",
    series: h.length ? [{ pts: h, color: css("--gpu"), label: "GPU f32, Jacobi-preconditioned CG" }] : [] });
}

