import { serve, CHROME_ARGS } from "../../cli/run.js";
const { chromium } = await import("playwright");
const { server, port } = await serve(process.cwd());
const b = await chromium.launch({ args: CHROME_ARGS });
const p = await b.newPage({ viewport: { width: 1600, height: 1400 } });
await p.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "load" });
await p.waitForFunction("window.AFS && window.AFS.ready");
// load the 370 mm scale preset through the real project path
await p.evaluate(async () => {
  const spec = await (await fetch("./src/cases/scale-370mm.json")).json();
  const pj = await import("./src/ui/project.js");
  await pj.applyProject(spec);
});
await p.waitForFunction(() => !document.getElementById("solve").disabled, null, {timeout:180000});
await p.waitForTimeout(1500);
await p.screenshot({ path: "/tmp/yasa.png" });
console.log(await p.textContent("#status"));
console.log("mesh plan:", (await p.textContent("#meshPlan")).replace(/\s+/g," "));
await b.close(); server.close();
