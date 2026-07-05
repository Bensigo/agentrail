# Closing the eval loop: `agentrail evals apply`

This walkthrough executes the **#981 HITL default-flip** from a real canary
report — the loop's first fully closed cycle: a dated eval report (produced by
the #1041 canary) is read by the consumer CLI, which proposes concrete
`.agentrail/` changes, each justified by the exact report line that drove it. A
human reviews the proposal and, only then, runs `--apply`.

The command is **proposal-by-default**. The bare invocation prints the proposal
and writes nothing; only an explicit `--apply` performs the writes, and it
writes byte-for-byte what the proposal printed. `--apply` is **fail-closed**: a
target with no configured server link is rejected before any write happens.

> Scope note. Everything this command writes lives under `.agentrail/`, which is
> gitignored — the apply step mutates local working-tree files only, never the
> repo. Eval reports under `agentrail/evals/reports/` are run artifacts and stay
> untracked; the paths below are absolute because the reports are not committed
> and are absent from fresh checkouts.

## The command

```
agentrail evals apply (--report PATH | --date YYYY-MM-DD)
                      [--reports-dir DIR] [--target DIR] [--apply]
```

- `--report PATH` — the report to read, or `--date YYYY-MM-DD` to resolve
  `<reports-dir>/eval-report-<date>.md` (exactly one of the two).
- `--target DIR` — the checkout to propose/apply against (default: cwd). The
  `.agentrail/` files are read from and written under this directory.
- `--apply` — perform the printed writes. Without it the command is read-only.

It reads two facts out of the report and turns each into a proposed change:

| Report section | Fact | Proposed change |
| --- | --- | --- |
| `## New-flow vs full` | the four paired deltas from the #1040 gate | pin `critic` / `bestofn` / `warmcache` in `.agentrail/layer-overrides.json` |
| `## Routing cost-regret` | total cost-regret + net $-delta | step each over-priced phase down a model tier in `.agentrail/config.json` |

### The layer decision is the #981 four-gate rule

The new-flow layers flip **on** only when the head-to-head deltas
(`new-flow − full`) clear all four gates at once:

- solve-rate delta `>= 0` (no worse at solving),
- dollars-per-solved delta `< 0` (strictly cheaper per win),
- wall-time-per-task delta `< 0` (strictly faster),
- false-green delta `<= 0` (no more gate-passing failures).

Three outcomes, no middle ground:

- **all four pass** → pin `critic`, `bestofn`, `warmcache` = `true`;
- **any defined gate fails** → pin all three = `false`;
- **only unknowns** (a delta is `n/a`, none failing) → propose no layer change.

The routing side proposes a change only on **measured** overspend: total
cost-regret `> 0`, or a positive net $-delta vs baseline. `$0.0000` regret and an
`n/a` net delta are not overspend, so routing is left alone.

## Step 1 — Read the real 2026-06-29 canary report (proposal only)

```
agentrail evals apply \
  --report /Users/macbook/work/bensigo-ai-workflow/agentrail/evals/reports/eval-report-2026-06-29.md \
  --target .
```

That report has only the `full` arm. Its New-flow section is the sentinel:

```
## New-flow vs full

_Not available: this run set does not contain BOTH the `full` and `new-flow`
arms (run `--arm full --arm new-flow` to populate this)._
```

and its routing lines show no overspend:

```
- Total routing cost-regret: $0.0000
...
- Net $-delta vs baseline: n/a (no per-run baseline token usage exists to price
  a counterfactual — we never invent one)
```

So the honest proposal is **nothing** — there is no new-flow arm to justify a
flip, and no measured routing overspend. The CLI says exactly that, and cites
the lines that made each non-decision (verbatim CLI output):

```
Proposal from eval-report-2026-06-29.md
Mode: proposal only — nothing is written without --apply.

Layer overrides (.agentrail/layer-overrides.json):
  No change proposed.
  Evidence: "_Not available: this run set does not contain BOTH the `full` and `new-flow` arms (run `--arm full --arm new-flow` to populate this)._"

Routing (.agentrail/config.json):
  No change proposed: the report shows no measured routing overspend.
  Evidence: "- Total routing cost-regret: $0.0000"
  Evidence: "- Net $-delta vs baseline: n/a (no per-run baseline token usage exists to price a counterfactual — we never invent one)"

No changes proposed. Nothing to apply.
```

This is the correct first closed cycle on a real report: the loop **refuses to
invent a decision** from a run set that cannot support one, and shows its work.
Running the same command with `--apply` changes nothing — the proposal is empty,
so there is nothing to write.

## Step 2 — The flip, on a canary that carries both arms

To actually execute the #981 flip, the canary must run **both** arms
(`--arm full --arm new-flow`) so the New-flow section is populated. On such a
report the section renders the four paired deltas, e.g.:

```
## New-flow vs full
...
| Metric | full | new-flow | Delta (new-flow - full) |
| --- | ---: | ---: | ---: |
| Solve-rate | 75.0% | 100.0% | +25.0% |
| Dollars-per-solved-task | $0.6667 | $0.3750 | -$0.2917 |
| Wall-time per task | 120.0s | 90.0s | -30.0s |
| False-green rate | 33.3% | 0.0% | -33.3% |
```

Solve-rate is up (`+25.0% >= 0`), dollars-per-solved down (`-$0.2917 < 0`),
wall-time down (`-30.0s < 0`), false-green down (`-33.3% <= 0`) — all four gates
pass. The proposal pins the three layers ON and shows the exact file it will
write (verbatim CLI output):

```
Layer overrides (.agentrail/layer-overrides.json):
  All four #981 gates pass (solve-rate delta >= 0, dollars-per-solved delta < 0, wall-time delta < 0, false-green delta <= 0). Pin the new-flow layers ON — the recorded default-flip decision.
  Set critic = true
  Set bestofn = true
  Set warmcache = true
  Evidence: "| Solve-rate | 75.0% | 100.0% | +25.0% |"
  Evidence: "| Dollars-per-solved-task | $0.6667 | $0.3750 | -$0.2917 |"
  Evidence: "| Wall-time per task | 120.0s | 90.0s | -30.0s |"
  Evidence: "| False-green rate | 33.3% | 0.0% | -33.3% |"
  --apply writes this file content:
  {
    "layers": {
      "critic": true,
      "bestofn": true,
      "warmcache": true
    },
    "source": "eval-report-2026-07-15.md"
  }
```

## Step 3 — Apply (fail-closed on unconfigured auth)

`--apply` writes only when the target has a configured server link — a
`.agentrail/server.json`, or all three of `AGENTRAIL_SERVER_BASE_URL`,
`AGENTRAIL_SERVER_API_KEY`, `AGENTRAIL_SERVER_REPOSITORY_ID`. With no link,
the apply is **rejected before any write**:

```
$ agentrail evals apply --report <two-arm report> --target <unlinked> --apply
error: apply refused: no server link is configured for this target (no
.agentrail/server.json and AGENTRAIL_SERVER_BASE_URL / AGENTRAIL_SERVER_API_KEY
/ AGENTRAIL_SERVER_REPOSITORY_ID are not all set). The apply path is
fail-closed: unconfigured auth rejects the request, it never skips the check.
# exit code 2; no .agentrail/layer-overrides.json written
```

This is the deliberate opposite of the GitHub webhook's signature check
(`apps/console/app/api/v1/connectors/github/webhook/route.ts`), whose
`verifySignature` returns `true` when the secret is unset — a fail-**open** skip.
The consumer path must never copy that: an unconfigured secret is a hard reject,
not a bypass. (See "Why the boundary is `load_link`" below for why this is the
right boundary given the consumer touches no console route.)

With a link configured, the same `--apply` writes the file — its content
byte-identical to the "`--apply` writes this file content:" block above — and
prints a receipt:

```
{
  "layers": {
    "critic": true,
    "bestofn": true,
    "warmcache": true
  },
  "source": "eval-report-2026-07-15.md"
}

Applied: <target>/.agentrail/layer-overrides.json (critic=true, bestofn=true, warmcache=true)
```

## What the flip changes

`.agentrail/layer-overrides.json` is a live lever. The pipeline's layer-flag
helpers (`layer_enabled`, `bestofn_testfirst_enabled`,
`diff_only_enforce_enabled` in `agentrail/run/pipeline.py`) resolve each flag in
precedence order — most specific first:

1. `AGENTRAIL_EVAL_LAYER_<NAME>` env (the eval harness's ablation seam),
2. this file's `layers.<name>` boolean (the recorded human decision),
3. default ON.

So once the flip is applied, the next run in that checkout picks up
`critic` / `bestofn` / `warmcache` from the file — the #981 default-flip is now
in effect, backed by a report a human reviewed. The env rung still wins, so
ablation runs and CI overrides are unaffected.

## Why the boundary is `load_link` (the AC3 judgment call)

The consumer works entirely against the **existing** #942 ingest route — it adds
no console endpoint, so there is no new HTTP handler to make fail-closed. The
only boundary the apply path itself owns is the local one: does this target have
a configured server link? That check is `load_link(target)` (from
`agentrail/context/snapshot_push.py`), which returns the `{base_url, api_key,
repository_id}` triple or `None`. `apply_proposal` calls it **first**, before any
file is touched, and raises `ApplyAuthError` (→ CLI exit 2) when it is `None`.

That is the fail-closed contract AC3 asks for, sited on the boundary the
consumer actually relies on, and it is the deliberate opposite of the webhook's
fail-open skip. The read-only proposal mode is intentionally ungated: it makes
no mutating call and writes nothing, so there is no secret to gate.
