import { serve, CHROME_ARGS } from "../cli/run.js";
const { chromium } = await import("playwright");
const { server, port } = await serve(process.cwd().replace(/\/tests$/,""));
const b = await chromium.launch({ args: CHROME_ARGS });
const p = await b.newPage();
p.on("pageerror", e=>console.error("PAGEERR", e.message));
await p.goto(`http://127.0.0.1:${port}/headless.html`, { waitUntil: "load" });
await p.waitForFunction("window.AFS && window.AFS.ready");

const run = (sets) => p.evaluate(async (ov) => {
  const s = window.AFS.defaultSpec();
  for (const [k,v] of ov) window.AFS.setPathOn(s,k,v);
  const r = await window.AFS.solve(s);
  if(!r.ok) return {err:r.error.message};
  const q = r.value.results;
  return { T: q.torque_mNm, Ts: q.torqueSurfaces_mNm, spread: q.torqueSurfaceSpread_pct,
           cells: q.mesh.cells, gap: q.mesh.cellsAcrossAirGap, bz: q.gapBzMean_mT,
           it: q.solver.iterations, ms: q.timing_ms.potentialSolve + q.timing_ms.biotSavart };
}, sets);

console.log("UNIFORM (cells across whole box)");
for (const n of [96,128,160,200,256,320]) {
  const r = await run([["mesh.mode","uniform"],["mesh.cellsAcrossDiameter",n]]);
  if(r.err){console.log(n,"ERR",r.err);continue;}
  console.log(`  N=${String(n).padStart(3)}  gapCells=${r.gap.toFixed(2)}  T=${r.T.toFixed(5)} mN.m  spread=${r.spread.toFixed(1)}%  Bz=${r.bz.toFixed(3)}mT  cells=${(r.cells/1e6).toFixed(2)}M  ${r.ms.toFixed(0)}ms`);
}
console.log("\nGRADED (refining everything together)");
for (const k of [1,1.5,2,3,4]) {
  const r = await run([["mesh.mode","graded"],
    ["mesh.activeCellsAcrossDiameter", Math.round(120*k)],
    ["mesh.cellsAcrossAirGap", Math.round(4*k)],
    ["mesh.cellsAcrossPoleHeight", Math.round(3*k)],
    ["mesh.cellsAcrossYoke", Math.round(2*k)],
    ["mesh.cellsAcrossPcb", Math.round(3*k)],
    ["mesh.cellsAcrossBackPlate", Math.round(2*k)]]);
  if(r.err){console.log(k,"ERR",r.err);continue;}
  console.log(`  k=${k}  gapCells=${r.gap.toFixed(2)}  T=${r.T.toFixed(5)} mN.m  spread=${r.spread.toFixed(2)}%  Bz=${r.bz.toFixed(3)}mT  cells=${(r.cells/1e6).toFixed(2)}M  ${r.ms.toFixed(0)}ms`);
}
await b.close(); server.close();
