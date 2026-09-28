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

import { appendFileSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

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
