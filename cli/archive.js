/* The run archive: what an overnight study leaves behind, and where.
 *
 * Deliberately **outside the repository**. A study writes hundreds of megabytes of designs and
 * frames; a git history is the wrong place for it and a static site is the wrong place to serve it
 * from. The scripts that produce and read it live in the repo, so anyone can run their own studies
 * and view their own results, and the results themselves live wherever they said. The default is
 * `../axialflow-runs/` — a sibling of the checkout, so it is next to the work without being in it.
 *
 * The format is three append-only files and a directory, chosen so that:
 *
 *   - **nothing is lost to a crash.** `ledger.jsonl` and `best.jsonl` are appended a line at a time
 *     and flushed. A run killed at 04:12 has everything up to 04:12, readable with `tail`.
 *   - **it resumes without checkpointing an optimizer.** The ledger is the evaluation cache, keyed by
 *     spec hash. Every searcher here is deterministic given its seed, so a resumed run replays the
 *     same sequence of points, finds them already scored, and carries on. The algorithm plus the
 *     seed is the checkpoint.
 *   - **it is reviewable without any of this code.** JSON Lines opens in anything. `best.jsonl` is a
 *     storyboard: one line per improvement, in order, which is exactly the frame list a movie wants.
 *   - **the big things are addressed, not embedded.** `designs/<hash>.json` holds the spec and the
 *     full results for each distinct design, so the ledger stays small enough to load whole in a
 *     browser while the detail is one fetch away.
 *
 *   <runs-root>/<runId>/
 *     run.json        manifest: study, baseline, git commit, adapter, stages, status, totals
 *     ledger.jsonl    one line per evaluation, append-only, in evaluation order
 *     best.jsonl      one line per improvement of the best score — the storyboard
 *     designs/<hash>.json   spec + full record, one file per distinct design
 *     frames/         rendered PNGs, if cli/frames.js has been run
 *     log.txt         the run's own stderr
 */

import { appendFileSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";

export const ARCHIVE_VERSION = 1;
export const DEFAULT_RUNS_ROOT = resolve(process.env.AXIALFLOW_RUNS || "../axialflow-runs");

export const runId = (name, date = new Date()) => {
  const p = n => String(n).padStart(2, "0");
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `${stamp}-${String(name || "study").replace(/[^A-Za-z0-9._-]+/g, "-")}`;
};

function gitCommit(cwd) {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim(); }
  catch { return null; }
}

export class RunArchive {
  constructor(dir) {
    this.dir = resolve(dir);
    this.designs = join(this.dir, "designs");
    this.ledgerPath = join(this.dir, "ledger.jsonl");
    this.bestPath = join(this.dir, "best.jsonl");
    this.manifestPath = join(this.dir, "run.json");
    this.logPath = join(this.dir, "log.txt");
    this.lockPath = join(this.dir, "lock.json");
    this.seq = 0;
    this.byHash = new Map();
    /* Best per *tier*. A screening-mesh score and a confirm-mesh score are two different numbers
     * about the same design, and tracking one "best" across both would let a coarse mesh's optimism
     * beat a fine mesh's honesty — which is exactly the mistake the rankcheck stage exists to make
     * measurable. `primaryTier` is the search's own tier and is what `best` means. */
    this.bestByTier = new Map();
    this.primaryTier = "score";
  }

  get best() { return this.bestByTier.get(this.primaryTier) || null; }
  bestOn(tier) { return this.bestByTier.get(tier) || null; }

  static open({ root = DEFAULT_RUNS_ROOT, id, study, resume = null } = {}) {
    const dir = resume ? resolve(resume) : join(root, id || runId(study));
    const a = new RunArchive(dir);
    mkdirSync(a.designs, { recursive: true });
    if (resume) a.replay();
    return a;
  }

  /* Read a previous run back in. This is the whole of resume: the ledger becomes the evaluation
   * cache and the sequence counter picks up where it stopped. A truncated final line — the run was
   * killed mid-write — is dropped rather than repaired, because the design it describes will simply
   * be re-evaluated. */
  replay() {
    if (!existsSync(this.ledgerPath)) return { entries: 0 };
    const lines = readFileSync(this.ledgerPath, "utf8").split("\n").filter(Boolean);
    let dropped = 0;
    for (const line of lines) {
      let e;
      try { e = JSON.parse(line); } catch { dropped++; continue; }
      this.byHash.set(RunArchive.key(e), e);
      this.seq = Math.max(this.seq, e.seq + 1);
      this.noteBest(e, false);
    }
    return { entries: lines.length - dropped, dropped };
  }

  /* One writer per run directory.
   *
   * Two studies appending to one ledger do not corrupt a line — the format is append-only for
   * exactly that reason — but they do collide on sequence numbers, and because every searcher here
   * is deterministic given its seed they evaluate the *same* points, so the second process buys
   * nothing and doubles the history. That happened once, by hand, which is why this exists.
   *
   * A stale lock is taken over rather than being a wall: the usual way a lock is left behind is a
   * machine that went to sleep, and a run you cannot resume in the morning is worse than a run with
   * a lock file in it. Liveness is checked by signal 0 on the same host, and by heartbeat age
   * otherwise. */
  lock({ force = false, staleAfter_ms = 10 * 60e3 } = {}) {
    if (existsSync(this.lockPath) && !force) {
      let prior = null;
      try { prior = JSON.parse(readFileSync(this.lockPath, "utf8")); } catch { /* unreadable counts as stale */ }
      // Our own lock is not a competitor. A process that already holds the run may re-lock freely.
      if (prior && !(prior.pid === process.pid && prior.host === hostname())) {
        const sameHost = prior.host === hostname();
        let alive;
        /* Signal 0 asks "does this process exist and may I signal it". EPERM is the interesting
         * answer: the process is there, it just is not ours to signal — which is still alive, and
         * treating it as dead would defeat the whole check. */
        if (sameHost) { try { process.kill(prior.pid, 0); alive = true; } catch (e) { alive = e.code === "EPERM"; } }
        else alive = Date.now() - (prior.heartbeat || 0) < staleAfter_ms;
        if (alive) throw new Error(
          `This run is already being written by pid ${prior.pid} on ${prior.host}, started ${prior.started}. ` +
          `Two studies appending to one ledger evaluate the same points and double the history rather than ` +
          `covering more ground. Stop that process, or pass --force if you are certain it is gone.`);
      }
      this.staleLock = prior;
    }
    this.locked = true;
    this.heartbeat();
    /* Best effort. A kill -9 leaves the lock behind, which is what the staleness check is for. */
    for (const sig of ["exit", "SIGINT", "SIGTERM"]) process.once(sig, () => this.unlock());
    return this.staleLock || null;
  }

  /* Only a holder refreshes the lock. Writing one as a side effect of writing the manifest would
   * mean that merely *reading* a run left a lock behind it. */
  heartbeat() {
    if (!this.locked) return;
    try { writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, host: hostname(), started: this.started ||= new Date().toISOString(), heartbeat: Date.now() }) + "\n"); }
    catch { /* a run that cannot write its lock can still write its results */ }
  }

  unlock() {
    this.locked = false;
    try {
      const l = JSON.parse(readFileSync(this.lockPath, "utf8"));
      if (l.pid === process.pid) unlinkSync(this.lockPath);
    } catch { /* already gone, or never ours */ }
  }

  manifest(m) {
    const prev = existsSync(this.manifestPath) ? JSON.parse(readFileSync(this.manifestPath, "utf8")) : {};
    const out = {
      archiveVersion: ARCHIVE_VERSION,
      runId: this.dir.split(/[\\/]/).pop(),
      ...prev, ...m,
      commit: prev.commit || gitCommit(process.cwd()),
      updated: new Date().toISOString()
    };
    writeFileSync(this.manifestPath, JSON.stringify(out, null, 2) + "\n");
    this.heartbeat();
    return out;
  }

  log(s) { appendFileSync(this.logPath, s.endsWith("\n") ? s : s + "\n"); }

  /* The cache key is the design's spec hash, optionally suffixed. The suffix exists for the one
   * thing the spec hash does not cover: a scoring option that changes the answer without changing
   * the spec, such as an explicitly declared copper-loss budget. Two studies with different budgets
   * pointed at one directory would otherwise collide on a hash and read each other's scores. */
  static key(e) { return e.key || e.hash; }
  cached(key) { return this.byHash.get(key) || null; }

  /* One evaluation, recorded. The ledger line is a summary — small enough that ten thousand of them
   * still load in a browser in one fetch — and the full spec and results go beside it under their
   * own hash, written once however many times the design is visited. */
  record(entry, { spec = null, record = null } = {}) {
    const e = { seq: this.seq++, ts: Date.now(), ...entry };
    appendFileSync(this.ledgerPath, JSON.stringify(e) + "\n");
    this.byHash.set(RunArchive.key(e), e);
    if (spec || record) {
      const p = join(this.designs, `${e.hash}.json`);
      if (!existsSync(p)) writeFileSync(p, JSON.stringify({ hash: e.hash, seq: e.seq, spec, record }) + "\n");
    }
    /* The heartbeat rides along with the evaluation rather than only with the manifest. A refine
     * stage can run for two hours without a stage boundary, and this archive root may well be a
     * synced folder, where another machine's staleness check has nothing but the heartbeat to go on.
     * It is a 120-byte write next to a solve. */
    this.heartbeat();
    this.noteBest(e, true);
    return e;
  }

  /* An improvement on any tier is a line in the storyboard, tagged with the tier it improved on, so
   * a viewer or a frame sequence can follow one tier or show them side by side. */
  noteBest(e, write) {
    if (e.score === null || e.score === undefined || !Number.isFinite(e.score)) return false;
    const tier = e.tier || "score";
    const cur = this.bestByTier.get(tier);
    if (cur && cur.score >= e.score) return false;
    this.bestByTier.set(tier, e);
    if (write) appendFileSync(this.bestPath, JSON.stringify(e) + "\n");
    return true;
  }

  design(hash) {
    const p = join(this.designs, `${hash}.json`);
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
  }

  ledger() {
    if (!existsSync(this.ledgerPath)) return [];
    return readFileSync(this.ledgerPath, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }

  storyboard() {
    if (!existsSync(this.bestPath)) return [];
    return readFileSync(this.bestPath, "utf8").split("\n").filter(Boolean).map(JSON.parse);
  }
}

/* Collapse a ledger that has been written by more than one process.
 *
 * Append-only is what makes the format crash-proof, so nothing rewrites history as a side effect of
 * anything: this is a command somebody runs, it keeps the original as `ledger.jsonl.bak`, and it
 * refuses outright if two lines claim the same design with different scores — because then the
 * duplication is not the accident it looks like and deleting either line would be destroying a
 * measurement rather than tidying one.
 */
export function repairLedger(dir) {
  const a = new RunArchive(dir);
  const lines = existsSync(a.ledgerPath) ? readFileSync(a.ledgerPath, "utf8").split("\n").filter(Boolean) : [];
  const seen = new Map(), out = [];
  let dropped = 0, conflicts = [];
  for (const line of lines) {
    let e; try { e = JSON.parse(line); } catch { dropped++; continue; }
    const k = RunArchive.key(e);
    const prior = seen.get(k);
    if (prior) {
      if (prior.score !== e.score) conflicts.push({ key: k, scores: [prior.score, e.score] });
      dropped++;
      continue;
    }
    seen.set(k, e);
    out.push(e);
  }
  if (conflicts.length) throw new Error(
    `${conflicts.length} design(s) appear twice with different scores, for example ${conflicts[0].key} ` +
    `at ${conflicts[0].scores.join(" and ")}. That is not duplicated work, so nothing here is safe to drop. ` +
    `The archive is left untouched.`);

  // Renumber in the order the work was actually done, and rebuild the storyboard from it.
  out.sort((p, q) => (p.ts || 0) - (q.ts || 0) || p.seq - q.seq);
  out.forEach((e, i) => { e.seq = i; });
  renameSync(a.ledgerPath, a.ledgerPath + ".bak");
  writeFileSync(a.ledgerPath, out.map(e => JSON.stringify(e)).join("\n") + "\n");
  const bests = new Map(), story = [];
  for (const e of out) {
    if (e.score === null || e.score === undefined || !Number.isFinite(e.score)) continue;
    const t = e.tier || "score";
    if (bests.has(t) && bests.get(t) >= e.score) continue;
    bests.set(t, e.score); story.push(e);
  }
  if (existsSync(a.bestPath)) renameSync(a.bestPath, a.bestPath + ".bak");
  writeFileSync(a.bestPath, story.map(e => JSON.stringify(e)).join("\n") + "\n");
  return { kept: out.length, dropped, improvements: story.length, backup: a.ledgerPath + ".bak" };
}

/* Every run under a root, newest first, with just enough of each manifest to list them. */
export function listRuns(root = DEFAULT_RUNS_ROOT) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const name of readdirSync(root)) {
    const p = join(root, name, "run.json");
    if (!existsSync(p)) continue;
    try {
      const m = JSON.parse(readFileSync(p, "utf8"));
      out.push({ runId: name, study: m.study, status: m.status, started: m.started, updated: m.updated,
                 evaluations: m.evaluations, best: m.bestScore, objective: m.objective });
    } catch { /* a half-written manifest is not a run yet */ }
  }
  return out.sort((a, b) => String(b.runId).localeCompare(String(a.runId)));
}
