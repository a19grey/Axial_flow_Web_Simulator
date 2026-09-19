import { serve, CHROME_ARGS } from "../../cli/run.js";
const { chromium } = await import("playwright");
const { server, port } = await serve(process.cwd());
const b = await chromium.launch({ args: CHROME_ARGS });
const p = await b.newPage({ viewport: { width: 1600, height: 1200 } });
await p.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "load" });
await p.waitForFunction("window.AFS && window.AFS.ready");
const out = await p.evaluate(async () => {
  const spec = await (await fetch("./src/cases/scale-370mm.json")).json();
  const pj = await import("./src/ui/project.js");
  await pj.applyProject(spec);
  await new Promise(r => { const t=setInterval(()=>{ if(!document.getElementById("solve").disabled){clearInterval(t);r();} },50); });
  const c = await import("./src/ui/controls.js");
  const rs = c.readSpec();
  const api = await window.AFS.solve(spec);
  return { pageStatus: document.getElementById("status").textContent,
           pageTorque: +document.getElementById("res").textContent.match(/([\d.]+) mN·m/)[1],
           apiTorque: api.ok ? api.value.results.torque_mNm : null,
           pitch: rs.design.stator.tracePitch_mm, width: rs.design.stator.traceWidth_mm,
           maxIter: rs.solver.maxIterations, backGapCells: rs.mesh.cellsAcrossBackGap };
});
console.log(JSON.stringify(out, null, 1));
await b.close(); server.close();
