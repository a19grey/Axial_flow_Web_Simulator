#!/usr/bin/env node
/* Runs every test suite and prints one summary.
 *
 *   node tests/run-tests.js [--allow-software] [--only <name>]
 *
 * Suites:
 *   analytic    closed-form validation cases through the headless API
 *   reference   the split modules against the frozen pre-split build, design by design
 *   ui          the full page: solve, validation buttons, project round-trip, export, view controls
 *
 * Exits non-zero if any suite fails, so CI can gate on it.
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

const SUITES = [
  { name: "analytic", cmd: ["cli/run.js", "validate", "--quiet"], note: "closed-form reference cases" },
  { name: "reference", cmd: ["tests/compare-reference.js"], note: "vs the frozen pre-split build" },
  { name: "ui", cmd: ["tests/smoke-ui.js"], note: "the full page end to end" },
  { name: "convergence", cmd: ["tests/convergence.js", "--out", "tests/out/convergence.json"], note: "mesh refinement and the 370 mm scale case" }
];

function run(script, extra) {
  return new Promise(done => {
    const p = spawn(process.execPath, [resolve(ROOT, script[0]), ...script.slice(1), ...extra],
                    { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    p.stdout.on("data", d => { out += d; });
    p.on("close", code => done({ code, out }));
  });
}

const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const extra = args.filter(a => a === "--allow-software");

const results = [];
for (const s of SUITES) {
  if (only && s.name !== only) continue;
  process.stderr.write(`\n=== ${s.name} — ${s.note} ===\n`);
  const t0 = Date.now();
  const { code } = await run(s.cmd, extra);
  results.push({ name: s.name, pass: code === 0, seconds: +((Date.now() - t0) / 1000).toFixed(1) });
}

process.stderr.write("\n=== summary ===\n");
for (const r of results) process.stderr.write(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(10)} ${r.seconds}s\n`);
const failed = results.filter(r => !r.pass);
process.stderr.write(failed.length ? `\n${failed.length} suite(s) failed\n` : `\nall suites passed\n`);
process.exit(failed.length ? 1 : 0);
