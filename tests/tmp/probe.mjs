import { serve, CHROME_ARGS } from "../../cli/run.js";
import { readFile } from "node:fs/promises";
const { chromium } = await import("playwright");
const { server, port } = await serve(process.cwd());
const b = await chromium.launch({ args: CHROME_ARGS });
const p = await b.newPage();
await p.goto(`http://127.0.0.1:${port}/headless.html`, { waitUntil: "load" });
await p.waitForFunction("window.AFS && window.AFS.ready");
const small = JSON.parse(await readFile("src/cases/pcb-reluctance-80mm.json","utf8"));
const solve = s => p.evaluate(async x => { const r = await window.AFS.solve(x); return r.ok ? r.value.results : {error:r.error.message}; }, s);

// Hold the in-plane resolution fixed, refine ONLY z. If the wobble is the in-plane pole-edge
// staircase, torque should be smooth here.
console.log("refine z only (in-plane fixed at 160 cells across the machine):");
for (const g of [4,5,6,8,10,12,16]) {
  const r = await solve({...small, mesh:{...small.mesh, mode:"graded", activeCellsAcrossDiameter:160,
    cellsAcrossAirGap:g, cellsAcrossPoleHeight:Math.round(g*0.7), cellsAcrossYoke:Math.round(g*0.5),
    cellsAcrossPcb:Math.round(g*0.7), cellsAcrossBackPlate:Math.round(g*0.5)}});
  console.log(`  gapCells=${String(g).padStart(2)}  cells=${r.mesh.cells.toLocaleString().padStart(10)}  T=${r.torque_mNm.toFixed(5)}  Bz=${r.gapBzMean_mT.toFixed(4)}`);
}
console.log("\nrefine in-plane only (gap fixed at 6 cells):");
for (const a of [100,140,180,220,260,320,400]) {
  const r = await solve({...small, mesh:{...small.mesh, mode:"graded", activeCellsAcrossDiameter:a, cellsAcrossAirGap:6}});
  console.log(`  inPlane=${String(a).padStart(3)}  cells=${r.mesh.cells.toLocaleString().padStart(10)}  T=${r.torque_mNm.toFixed(5)}  Bz=${r.gapBzMean_mT.toFixed(4)}`);
}
await b.close(); server.close();
