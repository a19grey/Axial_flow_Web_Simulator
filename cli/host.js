/* A browser page that survives an eight-hour run.
 *
 * `cli/run.js` opens a page, does one thing and closes it, which is right for one command. A study
 * is different: it makes thousands of calls over hours, and on that timescale the page is not a
 * fixture but a resource that will occasionally die — a GPU out-of-memory on an over-ambitious mesh,
 * a driver reset, a tab the OS decided to reclaim. A run that loses eight hours of work to one of
 * those is not an overnight run.
 *
 * So the host owns the browser rather than the caller: `call()` relaunches on a dead page and
 * retries once, and a failure that survives the relaunch is returned as a failed evaluation instead
 * of an exception that unwinds the study. The orchestrator decides what a failed design means; the
 * host's only job is to still be there afterwards.
 */

import { serve, CHROME_ARGS, CHROME_ARGS_SOFTWARE } from "./run.js";

export class PageHost {
  constructor({ page = "headless.html", allowSoftware = false, forceSoftware = false, onLog = null, root = null } = {}) {
    Object.assign(this, { pageName: page, allowSoftware, forceSoftware, onLog, root });
    this.browser = null; this.page = null; this.server = null; this.port = 0;
    this.caps = null; this.launches = 0;
  }

  log(s) { this.onLog ? this.onLog(s) : process.stderr.write(s + "\n"); }

  async start() {
    if (this.page) return this.caps;
    const { chromium } = await import("playwright");
    if (!this.server) {
      const s = await serve(this.root || undefined);
      this.server = s.server; this.port = s.port;
    }
    this.browser = await chromium.launch({ args: this.forceSoftware ? CHROME_ARGS_SOFTWARE : CHROME_ARGS });
    this.page = await this.browser.newPage();
    this.page.on("pageerror", e => this.log(`[page error] ${e.message}`));
    this.page.on("crash", () => { this.log("[page crashed]"); this.page = null; });
    await this.page.goto(`http://127.0.0.1:${this.port}/${this.pageName}`, { waitUntil: "load" });
    await this.page.waitForFunction("window.AFS && window.AFS.ready", null, { timeout: 60000 });
    this.caps = await this.page.evaluate(() => window.AFS.capabilities().catch(e => ({ error: e.message })));
    if (this.caps.error) throw new Error("WebGPU did not start in headless Chrome: " + this.caps.error);
    if (this.caps.software && !this.allowSoftware)
      throw new Error(`This run landed on a software WebGPU adapter (${this.caps.adapter}). An overnight study on ` +
        `SwiftShader would be correct and about a thousand times too slow. Pass --allow-software to proceed anyway.`);
    this.launches++;
    this.log(`adapter: ${this.caps.adapter}${this.caps.software ? "  [SOFTWARE]" : ""}${this.launches > 1 ? `  (launch ${this.launches})` : ""}`);
    return this.caps;
  }

  async restart() {
    this.log("relaunching the browser");
    try { await this.browser?.close(); } catch { /* it is already gone, which is why we are here */ }
    this.browser = null; this.page = null;
    await this.start();
  }

  /* Run `fn(window, arg)` in the page. Returns `{ ok, value }` or `{ ok: false, error }` — never
   * throws for a solve that failed, because one impossible design in a sweep of two thousand is
   * data, not an outage. */
  async call(fn, arg, { retries = 1 } = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.start();
        return { ok: true, value: await this.page.evaluate(fn, arg) };
      } catch (e) {
        const msg = e?.message || String(e);
        const dead = /crash|Target closed|Session closed|browser has been closed|detached/i.test(msg);
        if (attempt < retries && dead) { await this.restart(); continue; }
        if (attempt < retries && /out of memory|device.*lost|Failed to create/i.test(msg)) { await this.restart(); continue; }
        return { ok: false, error: msg };
      }
    }
  }

  async close() {
    try { await this.browser?.close(); } catch { /* nothing left to close */ }
    this.server?.close();
    this.browser = null; this.page = null; this.server = null;
  }
}
