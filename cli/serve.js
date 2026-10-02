#!/usr/bin/env node
/* Local dev server, and the one place that knows how a run archive is mounted.
 *
 *   npm start                        -> http://localhost:8080
 *   npm start -- --port 9000 --open
 *   npm start -- --runs ~/elsewhere  -> serve study archives from somewhere else
 *
 * WebGPU needs a secure context, and localhost counts as one, so this is all that is required.
 *
 * Study results live *outside* the repository on purpose — they are not repository contents and a
 * static host has no business carrying a few hundred megabytes of them. So they are mounted rather
 * than copied: `/runs/` serves whatever directory holds them and `/runs/index.json` lists what is
 * there. `runs.html` then needs nothing but fetch, which is also what lets `cli/frames.js` drive the
 * very same page headless with no extra machinery.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { listRuns, DEFAULT_RUNS_ROOT } from "./archive.js";

export const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".md": "text/plain; charset=utf-8",
  ".jsonl": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".png": "image/png", ".wgsl": "text/plain; charset=utf-8"
};

const send = (res, path, body) => res.writeHead(200, {
  "content-type": MIME[extname(path)] || "application/octet-stream",
  // No caching: editing a module and reloading should show the edit, and a run being appended to
  // while it is being watched should show the new lines.
  "cache-control": "no-store"
}).end(body);

/* Serve the repository, with a run archive mounted under /runs/. Returns an unlistened server. */
export function createStaticServer({ root = REPO_ROOT, runsRoot = DEFAULT_RUNS_ROOT } = {}) {
  const ROOT = resolve(root), RUNS = resolve(runsRoot);
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");

      if (rel === "runs/index.json") { send(res, "x.json", JSON.stringify({ root: RUNS, runs: listRuns(RUNS) }, null, 2)); return; }
      if (rel === "runs" || rel.startsWith("runs/")) {
        const rp = join(RUNS, rel.slice(4).replace(/^[/\\]+/, ""));
        if (!(rp + sep).startsWith(RUNS + sep) && rp !== RUNS) { res.writeHead(403).end("forbidden"); return; }
        send(res, rp, await readFile(rp));
        return;
      }
      const path = join(ROOT, rel || "index.html");
      if (!(path + sep).startsWith(ROOT + sep) && path !== ROOT) { res.writeHead(403).end("forbidden"); return; }
      send(res, path, await readFile(path));
    } catch {
      res.writeHead(404).end("not found");
    }
  });
}

/* Listen on an ephemeral port. What every headless driver in this repo uses. */
export function serveEphemeral(opts = {}) {
  const server = createStaticServer(opts);
  return new Promise(ok => server.listen(0, "127.0.0.1", () => ok({ server, port: server.address().port })));
}

/* ---- the CLI ------------------------------------------------------------------------------------ */

if (process.argv[1] && /serve\.js$/.test(process.argv[1])) {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const i = args.indexOf("--" + name);
    return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true) : fallback;
  };
  const port = +flag("port", 8080);
  const runsRoot = resolve(flag("runs", true) === true ? DEFAULT_RUNS_ROOT : flag("runs"));
  const server = createStaticServer({ runsRoot });

  server.on("error", e => {
    if (e.code === "EADDRINUSE") {
      process.stderr.write(`Port ${port} is already in use. Try:  npm start -- --port ${port + 1}\n`);
      process.exit(1);
    }
    throw e;
  });
  server.listen(port, () => {
    const url = `http://localhost:${port}/`;
    process.stdout.write(
      `\n  Axial-flux simulator\n\n` +
      `    tool      ${url}\n` +
      `    runs      ${url}runs.html\n` +
      `    headless  ${url}headless.html\n` +
      `    agents    ${url}llms.txt\n\n` +
      `  Serving ${REPO_ROOT}\n  Runs    ${runsRoot}\n  Ctrl-C to stop.\n\n`);
    if (flag("open", false)) spawn("open", [url], { stdio: "ignore", detached: true }).unref();
  });
}
