#!/usr/bin/env node
/* Local dev server. Serves the repository root so index.html can load its modules.
 *
 *   npm start                 -> http://localhost:8080
 *   npm start -- --port 9000
 *   npm start -- --open
 *
 * WebGPU needs a secure context, and localhost counts as one, so this is all that is required.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".md": "text/plain; charset=utf-8"
};

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true) : fallback;
};
const port = +flag("port", 8080);

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
    const path = join(ROOT, rel || "index.html");
    if (!(path + sep).startsWith(ROOT + sep) && path !== ROOT) { res.writeHead(403).end("forbidden"); return; }
    const body = await readFile(path);
    // No caching: editing a module and reloading should show the edit.
    res.writeHead(200, { "content-type": MIME[extname(path)] || "application/octet-stream", "cache-control": "no-store" }).end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

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
    `    headless  ${url}headless.html\n\n` +
    `  Serving ${ROOT}\n  Ctrl-C to stop.\n\n`);
  if (flag("open", false)) spawn("open", [url], { stdio: "ignore", detached: true }).unref();
});
