#!/usr/bin/env node
/* Headless driver: serves the repo, loads headless.html in Chrome, and calls window.AFS.
 *
 *   node cli/run.js capabilities
 *   node cli/run.js plan     [spec.json]
 *   node cli/run.js solve    [spec.json] [-o out.json] [--set path=value ...]
 *   node cli/run.js sweep    [spec.json] --path <spec.path> --from 0 --to 180 --step 15
 *   node cli/run.js validate [--case loop,sphere] [--spec spec.json]
 *
 * Progress goes to stderr, the JSON result to stdout, so the result can be piped.
 *
 * WebGPU in headless Chrome can silently fall back to SwiftShader, which is correct but ~1000x too
 * slow and makes every timing meaningless. The driver refuses to run on a software adapter unless
 * --allow-software is given, and stamps `softwareAdapter` into the output either way.
 */

import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, resolve, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".wgsl": "text/plain; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon"
};

/* ---- static server -------------------------------------------------------------------------- */

export function serve(root = ROOT) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
      const path = join(root, rel || "index.html");
      // Refuse anything that escapes the served root.
      if (!(path + sep).startsWith(root + sep) && path !== root) { res.writeHead(403).end("forbidden"); return; }
      const body = await readFile(path);
      res.writeHead(200, { "content-type": MIME[extname(path)] || "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise(ok => server.listen(0, "127.0.0.1", () => ok({ server, port: server.address().port })));
}

/* ---- browser -------------------------------------------------------------------------------- */

async function loadPlaywright() {
  try {
    return (await import("playwright")).chromium;
  } catch {
    throw new Error(
      "Playwright is not installed. From the repository root run:\n" +
      "  npm install\n" +
      "  npx playwright install chromium");
  }
}

/* Chrome flags that get a real hardware WebGPU adapter in headless mode.
 *
 * --use-angle=default matters more than it looks: without it, headless Chrome on macOS silently
 * hands back SwiftShader instead of Metal. Every driver in this repo must launch with these.
 */
export const CHROME_ARGS = [
  "--enable-unsafe-webgpu",
  "--enable-features=Vulkan,WebGPU",
  // Lets a run proceed on machines with no hardware adapter at all; callers still refuse to use a
  // software adapter unless asked explicitly.
  "--enable-unsafe-swiftshader",
  "--use-angle=default"
];

export async function withPage(fn, { allowSoftware = false, quiet = false, page: pageName = "headless.html" } = {}) {
  const chromium = await loadPlaywright();
  const { server, port } = await serve();
  const browser = await chromium.launch({ args: CHROME_ARGS });
  try {
    const page = await browser.newPage();
    page.on("console", m => { if (!quiet && m.type() === "error") process.stderr.write(`[page] ${m.text()}\n`); });
    page.on("pageerror", e => process.stderr.write(`[page error] ${e.message}\n`));
    await page.exposeFunction("__afsProgress", ev => { if (!quiet) writeProgress(ev); });
    await page.goto(`http://127.0.0.1:${port}/${pageName}`, { waitUntil: "load" });
    await page.waitForFunction("window.AFS && window.AFS.ready", null, { timeout: 30000 });

    const caps = await page.evaluate(() => window.AFS.capabilities().catch(e => ({ error: e.message })));
    if (caps.error) throw new Error("WebGPU did not start in headless Chrome: " + caps.error);
    if (!quiet) process.stderr.write(`adapter: ${caps.adapter}${caps.software ? "  [SOFTWARE]" : ""}\n`);
    if (caps.software && !allowSoftware) {
      throw new Error(
        `This run landed on a software WebGPU adapter (${caps.adapter}). Results would be correct but ` +
        `timings meaningless and large grids impractically slow. Pass --allow-software to proceed anyway.`);
    }
    return { result: await fn(page, caps), caps };
  } finally {
    await browser.close();
    server.close();
  }
}

let lastLine = 0;
function writeProgress(ev) {
  const now = Date.now();
  if (now - lastLine < 120 && ev.phase !== "rasterize") return;
  lastLine = now;
  let s;
  if (ev.phase === "biotSavart") s = `biot-savart  ${ev.done}/${ev.total} segments`;
  else if (ev.phase === "pcg") s = `potential    it ${ev.iteration}  residual ${ev.residual.toExponential(2)}`;
  else if (ev.phase === "sweep") s = `sweep        ${ev.index + 1}/${ev.total}  ${ev.path} = ${ev.value}`;
  else if (ev.phase === "rasterize") s = "rasterizing materials";
  else s = ev.phase;
  process.stderr.write(`\r\x1b[2K  ${s}`);
}
const endProgress = () => process.stderr.write("\r\x1b[2K");

/* ---- argument parsing ------------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = { _: [], set: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--set") out.set.push(argv[++i]);
    else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] === undefined || argv[i + 1].startsWith("--")) out[a.slice(2)] = true;
      else out[a.slice(2)] = argv[++i];
    } else if (a === "-o") out.out = argv[++i];
    else out._.push(a);
  }
  return out;
}

const numish = v => (v === "true" ? true : v === "false" ? false : Number.isFinite(+v) && v.trim() !== "" ? +v : v);

async function loadSpec(args) {
  let spec = null;
  const file = args.spec || args._[1];
  if (file) {
    if (!existsSync(file)) throw new Error(`No such spec file: ${file}`);
    spec = JSON.parse(await readFile(file, "utf8"));
  }
  return { spec, overrides: args.set.map(s => { const i = s.indexOf("="); return [s.slice(0, i), numish(s.slice(i + 1))]; }) };
}

const unwrap = r => { if (r && r.ok === false) { const e = new Error(r.error.message); e.stack = r.error.stack || e.stack; throw e; } return r && "value" in r ? r.value : r; };

/* ---- commands --------------------------------------------------------------------------------- */

const COMMANDS = {
  async capabilities(page) { return page.evaluate(() => window.AFS.capabilities()); },

  async plan(page, args) {
    const { spec, overrides } = await loadSpec(args);
    return page.evaluate(([s, ov]) => {
      const base = s || window.AFS.defaultSpec();
      for (const [p, v] of ov) window.AFS.setPathOn(base, p, v);
      return window.AFS.plan(base);
    }, [spec, overrides]);
  },

  async solve(page, args) {
    const { spec, overrides } = await loadSpec(args);
    return unwrap(await page.evaluate(([s, ov]) => {
      const base = s || window.AFS.defaultSpec();
      for (const [p, v] of ov) window.AFS.setPathOn(base, p, v);
      return window.AFS.solve(base);
    }, [spec, overrides]));
  },

  async sweep(page, args) {
    const { spec, overrides } = await loadSpec(args);
    if (!args.path) throw new Error("sweep needs --path, for example --path operatingPoint.currentAngle_elecDeg");
    const sw = {
      path: args.path,
      from: +(args.from ?? 0), to: +(args.to ?? 180),
      ...(args.step !== undefined ? { step: +args.step } : {}),
      ...(args.count !== undefined ? { count: +args.count } : {}),
      ...(args.values !== undefined ? { values: String(args.values).split(",").map(Number) } : {})
    };
    if (args.step === undefined && args.count === undefined && args.values === undefined) sw.step = 15;
    return unwrap(await page.evaluate(([s, ov, w]) => {
      const base = s || window.AFS.defaultSpec();
      for (const [p, v] of ov) window.AFS.setPathOn(base, p, v);
      return window.AFS.sweep(base, w);
    }, [spec, overrides, sw]));
  },

  async validate(page, args) {
    const { spec, overrides } = await loadSpec(args);
    const which = args.case ? String(args.case).split(",") : "all";
    return unwrap(await page.evaluate(([s, ov, w]) => {
      const base = s || window.AFS.defaultSpec();
      for (const [p, v] of ov) window.AFS.setPathOn(base, p, v);
      return window.AFS.validate(w, base);
    }, [spec, overrides, which]));
  }
};

const USAGE = `axial-flux headless driver

  node cli/run.js capabilities
  node cli/run.js plan     [spec.json] [--set path=value ...]
  node cli/run.js solve    [spec.json] [-o out.json] [--set path=value ...]
  node cli/run.js sweep    [spec.json] --path <spec.path> [--from 0 --to 180 --step 15 | --count N | --values a,b,c]
  node cli/run.js validate [--case loop,sphere] [--spec spec.json]

  --set design.rotor.airGap_mm=2.5     override any spec field, repeatable
  -o out.json                          write the result JSON to a file as well as stdout
  --allow-software                     proceed on a software WebGPU adapter (timings meaningless)
  --quiet                              no progress on stderr
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || args.help || !COMMANDS[cmd]) {
    process.stderr.write(USAGE);
    process.exit(cmd && !COMMANDS[cmd] ? 2 : 0);
  }
  const { result, caps } = await withPage(
    (page) => COMMANDS[cmd](page, args),
    { allowSoftware: !!args["allow-software"], quiet: !!args.quiet }
  );
  endProgress();

  const out = { command: cmd, adapter: caps.adapter, softwareAdapter: caps.software, ...result };
  const json = JSON.stringify(out, null, 2);
  if (args.out) { await writeFile(args.out, json + "\n"); process.stderr.write(`wrote ${args.out}\n`); }
  process.stdout.write(json + "\n");

  if (cmd === "validate" && result.pass === false) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("run.js")) {
  main().catch(e => { endProgress(); process.stderr.write(`\nerror: ${e.message}\n`); process.exit(1); });
}
