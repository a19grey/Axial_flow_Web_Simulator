#!/usr/bin/env node
/* The agent entry points: that an agent arriving at the hosted site can find the API, and that
 * what llms.txt says about it is true.
 *
 * This suite exists because the failure it guards is silent. llms.txt and the prose on
 * headless.html describe window.AFS, and nothing but a human rereading them connects that
 * description to the code — the first version of this check caught headless.html claiming that
 * .plan() and .capabilities() return {ok, value}, which they have never done. A driver written
 * against that sentence would mistake every plan for an error.
 *
 * So the assertions below are deliberately literal. The list of methods is scraped out of
 * llms.txt rather than written here, and each is called for real, so adding a method to the API
 * without documenting it is fine, and documenting one that does not exist is not.
 *
 *   node tests/agent-entry.js [--out report.json] [--allow-software] [--force-software]
 */

import { writeFile, mkdir } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { serveEphemeral } from "../cli/serve.js";
import { chromeArgs } from "../cli/run.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const outPath = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
const allowSoftware = args.includes("--allow-software");
/* --force-software reproduces what a GPU-less CI runner sees. Nothing here solves, so the
 * software adapter is not a degraded run of this suite, it is the same run. */
const forceSoftware = args.includes("--force-software");

const problems = [];
const report = { generatedAt: new Date().toISOString(), cases: {} };
const ok = (label, cond, detail = "") => {
  process.stderr.write(`  ${cond ? "ok  " : "FAIL"}  ${label}${detail ? "  " + detail : ""}\n`);
  if (!cond) problems.push(label);
};

/* The two pages that define window.AFS. index.html is here as well as headless.html because the
 * claim that they share one module is the reason an agent may use either, and it is the kind of
 * claim that quietly stops being true. */
const PAGES = ["headless.html", "index.html?autosolve=0"];

/* Methods that return their value directly and throw on a bad design, against methods that cost
 * GPU time and hand errors back as values. llms.txt documents the split; this is the same split
 * written where it can be executed. */
const INSPECTION = ["capabilities", "plan", "defaultSpec", "normalizeSpec", "specHash", "cases"];
const WORK = ["solve", "score", "sweep", "validate", "convergence",
              "virtualWork", "inductance", "torqueVsAngle", "energyCheck"];

const { server, port } = await serveEphemeral();
const origin = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ args: chromeArgs(forceSoftware) });

try {
  /* 1. a file an agent can find without being told */
  process.stderr.write("\n1. discovery\n");
  const res = await fetch(`${origin}/llms.txt`);
  ok("llms.txt is served from the site root", res.status === 200, `status ${res.status}`);
  ok("...as text/plain, so it reads as text rather than downloading",
     /text\/plain/.test(res.headers.get("content-type") || ""), res.headers.get("content-type") || "");
  const txt = await res.text();
  ok("...and says what the tool is in its first lines", /axial-flux/i.test(txt.slice(0, 400)));

  for (const rel of new Set([...txt.matchAll(/\]\(\.\/([^)]+)\)/g)].map(m => m[1]))) {
    const r = await fetch(`${origin}/${rel}`);
    ok(`every page llms.txt links to exists: ./${rel}`, r.status === 200, `status ${r.status}`);
  }

  /* A link rel=alternate in the head is the pointer an agent follows when it was handed a URL
   * rather than a filename, which is the case the user asked about. */
  for (const page of [...PAGES, "runs.html"]) {
    const html = await (await fetch(`${origin}/${page.split("?")[0]}`)).text();
    ok(`${page.split("?")[0]} points at llms.txt without being opened`,
       /rel="alternate"[^>]*href="\.\/llms\.txt"/.test(html) || /href="\.\/llms\.txt"/.test(html));
  }

  /* 2. the methods llms.txt advertises are the methods there are */
  process.stderr.write("\n2. the API is what the document says\n");
  const advertised = [...new Set([...txt.matchAll(/(?:window\.)?AFS\.(\w+)\(/g)].map(m => m[1]))];
  ok("llms.txt advertises the whole API", advertised.length >= INSPECTION.length + WORK.length,
     `${advertised.length} methods named`);
  const undocumented = [...INSPECTION, ...WORK].filter(m => !advertised.includes(m));
  ok("no method of the API goes undocumented", undocumented.length === 0, undocumented.join(", "));

  report.cases.documented = { advertised, undocumented };

  for (const page of PAGES) {
    process.stderr.write(`\n3. ${page}\n`);
    const p = await browser.newPage();
    const errs = [];
    p.on("pageerror", e => errs.push(e.message));
    await p.goto(`${origin}/${page}`, { waitUntil: "load" });
    await p.waitForFunction(() => !!window.AFS, null, { timeout: 60000 });

    const types = await p.evaluate(ms => Object.fromEntries(ms.map(m => [m, typeof window.AFS[m]])), advertised);
    const missing = Object.entries(types).filter(([, t]) => t !== "function").map(([k]) => k);
    ok("every method llms.txt names exists and is callable", missing.length === 0, missing.join(", "));

    const caps = await p.evaluate(() => window.AFS.capabilities());
    ok("capabilities() reports an adapter", !!caps.adapter,
       `${caps.adapter}${caps.software ? "  [software]" : ""}`);
    ok("...and says whether it is software, which is the flag a timing claim rests on",
       typeof caps.software === "boolean");
    if (caps.software && !allowSoftware)
      process.stderr.write("  note  software adapter: fields are right, timings are not\n");
    report.cases[page] = { adapter: caps.adapter, software: caps.software, apiVersion: caps.apiVersion };

    /* The inspection contract: the value itself, and a throw on a design that cannot exist. */
    const plan = await p.evaluate(() => window.AFS.plan(window.AFS.defaultSpec()));
    ok("plan() returns its value directly, not wrapped in {ok, value}",
       !("ok" in plan) && !!plan.mesh, Object.keys(plan).slice(0, 4).join(","));

    const thrown = await p.evaluate(async () => {
      const bad = window.AFS.defaultSpec();
      bad.design.stator.outerRadius_mm = bad.design.stator.innerRadius_mm;
      try { await window.AFS.plan(bad); return null; } catch (e) { return e.message; }
    });
    ok("plan() throws on an impossible design, as llms.txt warns", !!thrown, (thrown || "").slice(0, 52));

    /* And the trap llms.txt spends a paragraph on: a misspelled field is not an error. If this
     * ever starts failing the tool got stricter, which is good — but the paragraph must go. */
    const quiet = await p.evaluate(() => window.AFS.plan({ garbage: true }).then(v => !!v.mesh, () => false));
    ok("...but silently ignores unknown keys, which llms.txt documents as a trap", quiet);

    /* The work contract: never rejects. Asserted with a design that cannot exist rather than with
     * nonsense, both because it is the sharper claim — the error path returns a value — and
     * because nonsense normalizes to the default design and would solve it for real. */
    const work = await p.evaluate(() => {
      const bad = window.AFS.defaultSpec();
      bad.design.stator.outerRadius_mm = bad.design.stator.innerRadius_mm;
      return window.AFS.solve(bad);
    });
    ok("a work call hands its error back as a value rather than rejecting",
       work.ok === false && !!work.error?.message, (work.error?.message || Object.keys(work).join(",")).slice(0, 52));

    ok("the page loaded without a single error", errs.length === 0, errs.join(" | "));
    await p.close();
  }

  /* 4. the claim that both pages are one module, which is why either URL will do */
  process.stderr.write("\n4. one solver, two pages\n");
  const versions = [];
  for (const page of PAGES) {
    const p = await browser.newPage();
    await p.goto(`${origin}/${page}`, { waitUntil: "load" });
    await p.waitForFunction(() => !!window.AFS, null, { timeout: 60000 });
    versions.push(await p.evaluate(() => ({ api: window.AFS.version, hash: window.AFS.specHash(window.AFS.defaultSpec()) })));
    await p.close();
  }
  ok("the full page and the headless page run the same API version",
     versions[0].api === versions[1].api, versions.map(v => v.api).join(" vs "));
  ok("...and build a bit-identical default spec, so a result does not depend on which you loaded",
     versions[0].hash === versions[1].hash, versions.map(v => String(v.hash).slice(0, 12)).join(" vs "));
  report.cases.sharedModule = { versions };
} finally {
  await browser.close();
  server.close();
}

if (outPath) {
  report.problems = problems;
  await mkdir(dirname(resolve(ROOT, outPath)), { recursive: true });
  await writeFile(resolve(ROOT, outPath), JSON.stringify(report, null, 2) + "\n");
  process.stderr.write(`\nwrote ${outPath}\n`);
}

process.stderr.write(problems.length
  ? `\n${problems.length} problem${problems.length > 1 ? "s" : ""}:\n  ${problems.join("\n  ")}\n`
  : "\nan agent handed only the URL can find the API, and it behaves as documented\n");
process.exit(problems.length ? 1 : 0);
