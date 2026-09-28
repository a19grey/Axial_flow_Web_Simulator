#!/usr/bin/env node
/* Turn a run into a frame sequence, and a frame sequence into a movie.
 *
 *   node cli/frames.js <run-dir>                       every improvement, in order
 *   node cli/frames.js <run-dir> --mode feasible       every design that scored
 *   node cli/frames.js <run-dir> --size 1080 --hold 3  square frames, each held 3 frames
 *   node cli/frames.js <run-dir> --video               also run ffmpeg, if it is installed
 *
 * It drives `runs.html` — the same page a person scrubs, with `?frames=1` stripping the chrome — and
 * screenshots it once per design. Driving the real viewer rather than a bespoke renderer means there
 * is one drawing path to get wrong, and that anything you can see by hand you can also render.
 *
 * Frames are written *into the run directory*, beside the designs they came from, because they
 * belong to the run and not to this repository. Nothing here is committed and nothing here is
 * served by the site.
 */

import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { serveEphemeral } from "./serve.js";
import { CHROME_ARGS } from "./run.js";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] === undefined || argv[i + 1].startsWith("--")) out[a.slice(2)] = true;
      else out[a.slice(2)] = argv[++i];
    } else out._.push(a);
  }
  return out;
}

const USAGE = `render a run's designs to a frame sequence

  node cli/frames.js <run-dir> [options]

  --mode best|feasible|all   which designs to render (default best: one per improvement)
  --tier <name>              only this evaluation tier (default: the run's primary tier)
  --size <px>                square frame size; the default is 1600x900 instead
  --width/--height <px>      a non-square frame instead
  --hold <n>                 repeat each frame n times, so a slow section reads (default 1)
  --out <dir>                where the PNGs go (default <run-dir>/frames)
  --fps <n>                  frame rate written into the ffmpeg command (default 6)
  --video                    run ffmpeg as well, if it is on PATH
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runDir = args._[0] && resolve(args._[0]);
  if (!runDir || !existsSync(join(runDir, "run.json"))) { process.stderr.write(USAGE); process.exit(runDir ? 2 : 0); }

  const runId = basename(runDir);
  const runsRoot = dirname(runDir);
  /* 16:9 by default, because the frame is a shape *and* its numbers and that does not fit a square.
   * --size still gives a square, for a still or a social crop. */
  const size = args.size ? +args.size : null;
  const width = +(args.width || size || 1600), height = +(args.height || size || 900);
  const hold = Math.max(1, +(args.hold || 1));
  const fps = +(args.fps || 6);
  const outDir = resolve(args.out || join(runDir, "frames"));
  mkdirSync(outDir, { recursive: true });

  const { chromium } = await import("playwright");
  const { server, port } = await serveEphemeral({ runsRoot });
  const browser = await chromium.launch({ args: CHROME_ARGS });
  let n = 0;
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    page.on("pageerror", e => process.stderr.write(`[page error] ${e.message}\n`));
    const q = new URLSearchParams({ run: runId, frames: "1", mode: args.mode || "best" });
    await page.goto(`http://127.0.0.1:${port}/runs.html?${q}`, { waitUntil: "load" });
    await page.waitForFunction("window.RUNVIEW && window.RUNVIEW.ready", null, { timeout: 60000 });
    if (args.tier) await page.evaluate(t => window.RUNVIEW.setTier(t), args.tier);

    const count = await page.evaluate(() => window.RUNVIEW.count);
    if (!count) throw new Error("that run has no designs to render in this mode");
    process.stderr.write(`${count} designs -> ${outDir}\n`);

    const index = [];
    for (let i = 0; i < count; i++) {
      const cur = await page.evaluate(i => window.RUNVIEW.goto(i), i);
      // One paint, so the canvas is the design the viewer was asked for and not the previous one.
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      for (let k = 0; k < hold; k++) {
        const file = join(outDir, String(n++).padStart(5, "0") + ".png");
        await page.screenshot({ path: file });
      }
      index.push({ frame: n - hold, hold, seq: cur?.seq ?? null, hash: cur?.hash ?? null, score: cur?.score ?? null, stage: cur?.stage ?? null });
      if ((i + 1) % 20 === 0 || i === count - 1) process.stderr.write(`\r\x1b[2K  ${i + 1}/${count}`);
    }
    process.stderr.write("\n");
    /* A frame-to-design map, so a still lifted out of the movie can be traced back to the design it
     * shows — which is the difference between a nice video and evidence. */
    writeFileSync(join(outDir, "frames.json"), JSON.stringify({ runId, mode: args.mode || "best", fps, width, height, frames: index }, null, 2) + "\n");
  } finally {
    await browser.close();
    server.close();
  }

  const mp4 = join(runDir, `${runId}.mp4`);
  const ff = ["-y", "-framerate", String(fps), "-i", join(outDir, "%05d.png"),
              "-c:v", "libx264", "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", mp4];
  process.stdout.write(`${n} frames in ${outDir}\n\n  ffmpeg ${ff.join(" ")}\n\n`);
  if (args.video) {
    try { execFileSync("ffmpeg", ff, { stdio: "inherit" }); process.stdout.write(`\nwrote ${mp4}\n`); }
    catch (e) { process.stderr.write(`ffmpeg failed or is not installed: ${e.message}\n`); }
  }
}

main().catch(e => { process.stderr.write(`\nerror: ${e.message}\n`); process.exit(1); });
