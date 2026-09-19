/* Colour maps and value formatting shared by the 3D view, the plots and the result panels. */

/* Perceptually-ordered map for magnitudes (|B|), and a diverging map for signed fields (B_z). */
export const INF = [[0,0,4],[40,11,84],[101,21,110],[159,42,99],[212,72,66],[245,125,21],[250,193,39],[252,255,164]];
export const DIV = [[120,220,255],[40,110,230],[20,30,90],[6,8,12],[110,30,20],[230,110,30],[255,225,120]];
export function lutRow(stops) {
  const L = new Uint8Array(1024);
  for (let i = 0; i < 256; i++) { const t = i / 255 * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(t)), f = t - k;
    for (let c = 0; c < 3; c++) L[4 * i + c] = stops[k][c] * (1 - f) + stops[k + 1][c] * f; L[4 * i + 3] = 255; }
  return L;
}
export const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
export const fmtB = v => Math.abs(v) >= 0.1 ? v.toFixed(2) + " T" : (v * 1e3).toFixed(Math.abs(v) >= 0.01 ? 1 : 2) + " mT";
export function pctl(vals, q) { const s = Array.from(vals).sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))] || 1e-12; }

