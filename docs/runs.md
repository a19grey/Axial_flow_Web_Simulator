# Runs: storing, resuming and reviewing a night of search

A study is not a command you watch. It is a script you start and a directory you read afterwards.
This describes that directory — what it holds, why it holds it that way, and how to look at it.

Everything here is open format and open code. The scripts that produce and read a run live in this
repository so that anyone can run their own studies and review their own results; the results
themselves do not.

---

## Where runs live, and why not here

**A run archive is deliberately outside the repository and outside the site.** The default root is
`../axialflow-runs/` — a sibling of the checkout, so it sits beside the work without being in it —
and `$AXIALFLOW_RUNS` or `--runs-root` moves it anywhere.

Three reasons, in order of how much they matter:

1. **A run is not source.** It is a measurement made by this code on one machine on one night.
   Committing it would put megabytes of derived data into a history that exists to record decisions,
   and it would grow without bound. Whether a given result reproduces is answered by re-running the
   study, not by having a copy of the old answer under version control.
2. **A static site has no business serving it.** The site is `index.html` and a few hundred kilobytes
   of modules. A few hundred megabytes of designs and PNG frames alongside it would make the tool
   slower to fetch for everybody, to the benefit of nobody.
3. **The interesting thing is portable anyway.** Every design in the archive carries its full spec.
   The winner is a file you can open in the tool, and *that* is worth committing — as a case in
   `src/cases/` — once it has earned it.

So the repository carries the machinery and the study specs, and `npm start` *mounts* whatever
directory holds the results at `/runs/`. Nothing is copied; the viewer reads it over `fetch` from
where it already is.

---

## The layout

```
<runs-root>/<runId>/
  run.json          the manifest: study spec, baseline, commit, adapter, stages, status, totals
  report.json       the stage-by-stage findings, rewritten at every stage boundary
  ledger.jsonl      one line per evaluation, append-only, in evaluation order
  best.jsonl        one line each time a tier's best score improved — the storyboard
  designs/<hash>.json   spec + full results for each distinct design, written once
  frames/           PNG sequence and frames.json, if cli/frames.js has been run
  log.txt           the run's own stderr, verbatim
```

`runId` is `YYYYMMDD-HHMMSS-<study-name>`, so the directory sorts chronologically and says what it is.

### Four properties the format is chosen for

**Nothing is lost to a crash.** `ledger.jsonl` and `best.jsonl` are appended one line at a time and
flushed. A run killed at 04:12 holds everything up to 04:12, and `tail -f ledger.jsonl` works while
it is still running.

**It resumes without checkpointing an optimizer.** The ledger *is* the evaluation cache, keyed by the
spec hash. Every sampler and searcher in `src/study/` is deterministic given its seed, so
`--resume <dir>` replays the same sequence of points, finds the ones already scored, and carries on.
The algorithm plus the seed is the checkpoint — there is no separate state file to get out of step
with the results. It also means two overlapping studies of the same machine share work if pointed at
the same directory.

**It is reviewable without any of this code.** JSON Lines opens in anything:

```sh
# the best score so far, live, while the run is going
tail -n1 best.jsonl | jq '{score, hash, stage, vars}'

# every feasible design, as a score-versus-sequence table
jq -r 'select(.score != null) | [.seq, .stage, .tier, .score] | @tsv' ledger.jsonl

# why designs were being rejected
jq -r 'select(.score == null) | .gates[] | select(.pass == false) | .detail' ledger.jsonl | sort | uniq -c
```

**The big things are addressed, not embedded.** A ledger line is a compact summary — hash, stage,
tier, score, the design vector, a dozen metrics, the cost. Ten thousand of them still load in a
browser in one fetch. The full spec and the full results JSON live in `designs/<hash>.json`, one
fetch away, written once however many times a design is visited.

### A ledger line

```json
{
  "seq": 412, "ts": 1759012345678, "hash": "409a3d44",
  "stage": "refine", "tier": "score", "tag": { "stage": "cmaes", "generation": 7, "member": 3 },
  "vars": { "riOverRo": 0.516, "gapOverRo": 0.026, "pole.trail0": -0.418, "…": 0 },
  "x": [0.516, 0.026, "…"],
  "score": 0.021832631825896186, "feasible": true, "objective": "shear_kPa",
  "gates": [{ "name": "manufacturability", "pass": true, "detail": null }, "…"],
  "metrics": { "shear_kPa": 0.0218, "torque_mNm": 5.546, "ripple_pct": 12.4, "gamma_deg": 50.05,
               "amps_A": 8.383, "copperLoss_W": 519.2, "confirmError_pct": 1.3e-4,
               "peakB_mT": 112.1, "surfaceSpread_pct": 3.86, "mass_kg": 0.2336,
               "cells": 211680, "gapCells": 5.39, "iterations": 768 },
  "cost": { "solves": 4, "elapsed_ms": 302 }
}
```

`score` is `null` for a design that was not scored, and the failed gate says why. There are three
ways that happens, distinguished by `rejectedBefore`: `"mesh"` is a self-crossing or colliding
footprint, `"solve"` is a spec-only gate such as a trace narrower than the fab allows, and no
`rejectedBefore` with an `error` field is a solve that failed. A rejection costs no solve time, which
is why the cheap gates run first.

**Scores are comparable within a tier and not across tiers.** A screening mesh and a confirm mesh are
two different numbers about the same design, so the archive tracks a best *per tier* and
`primaryTier` in the manifest says which one the run's headline best refers to. The `rankcheck` stage
is what earns the right to search on the cheap one: it re-scores a sample of designs on the fine mesh
and reports the Spearman correlation of the two rankings.

---

## Reviewing a run

```sh
npm start                      # then open http://localhost:8080/runs.html
npm start -- --runs ~/archives # if the runs live somewhere else
node cli/study.js list         # what is on disk, newest first
node cli/study.js report <run-dir>
```

`runs.html` flips through a run. Arrow keys step, space plays, and the selector chooses what the
sequence is:

- **improvements only** — one design per time the score got better, in order. This is the storyboard,
  and the only ordering that tells a story rather than showing a search.
- **every scored design** — all of them, in the order they were evaluated.
- **everything** — rejections included, which is how you find out that a whole region of the space
  was being thrown away for one reason.

**Nothing in the viewer solves anything.** Each outline is drawn from that design's own spec through
the same `src/core/curves.js` the rasterizer used, so a frame costs about a millisecond and eight
hours of search scrubs at video rate. A viewer that had to re-solve to show you a design would be a
viewer nobody scrubs. To see the fields, *open in the tool* hands the spec to `index.html`, which
does solve it.

The plan view draws the footprint at the gap face solid and at the yoke dashed, so a flare, a waist
or a twist reads as the offset between the two. The side view is the pole's radial extent against
height, which is the part no plan view can show.

## Making a movie

```sh
node cli/frames.js <run-dir>                       # improvements, 1600x900
node cli/frames.js <run-dir> --mode feasible --hold 2 --fps 12
node cli/frames.js <run-dir> --size 1080 --video   # square, and run ffmpeg too
```

It drives `runs.html` with `?frames=1` — the same page, with the chrome stripped — and screenshots it
once per design. Driving the real viewer rather than a bespoke renderer means there is one drawing
path to get wrong, and that anything you can see by hand you can also render.

Frames land in `<run-dir>/frames/`, beside the designs they came from, with a `frames.json` mapping
every frame back to the design hash and score it shows. That map is the difference between a nice
video and evidence: a still lifted out of the movie can be traced to a spec, re-solved, and checked.

`--hold` repeats each frame, which is what makes a slow late-stage section readable at a frame rate
that does not make the early scan crawl.

---

## Running one

```sh
node cli/study.js run studies/printed-rotor-shape.json --hours 8
node cli/study.js run studies/printed-rotor-shape.json --dry-run   # compile it, solve nothing
node cli/study.js run studies/printed-rotor-shape.json --resume ../axialflow-runs/20260927-...
```

`--dry-run` is worth the habit: it compiles the study, prints the variables, their bounds, the
starting vector, the discrete combinations and the gates on the baseline, and solves nothing. A study
spec with a typo in an objective expression fails there rather than eight hours later — and
`checkExpressions` checks every objective and constraint against the names a record actually carries
before the first solve.

A study spec declares the baseline, the objective and its gates, the design variables, and the
stages. `studies/printed-rotor-shape.json` is the worked example and is commented; the stages are
described at the top of `cli/study.js`, and what a score *is* — the closed-form current phase, the
mean over the ripple period, the fixed copper-loss budget — is derived at the top of
`src/study/operatingPoint.js`.
