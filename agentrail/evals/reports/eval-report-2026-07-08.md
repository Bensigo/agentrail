# AgentRail eval report

Generated: 2026-07-08

Headline cost metric is **dollars-per-solved-task** (never cost per task). Reports include failures, ties, and spread — not only wins. All dollar figures route through the single-source pricing module.

## Per-arm summary

| Arm | Reps | Solved | Failed | Solve-rate | Spread | False-green rate | Wall-time per task | Total tokens | Total cost | Dollars-per-solved-task |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 1 | 0 | 1 | 0.0% | 0.0000 | n/a | 0.0s | 0 | $0.0000 | n/a |
| full | 1 | 0 | 1 | 0.0% | 0.0000 | n/a | 0.0s | 0 | $0.0000 | n/a |

## Cost breakdown

Per-arm split of **Total cost** into its four priced components (input, output, cache-read, cache-write). All figures route through the single-source pricing module, and the four components sum to the arm's total cost. The `%` columns are each component's share of that arm's total cost (`n/a` when the arm spent nothing).

| Arm | Input $ | Input % | Output $ | Output % | Cache-read $ | Cache-read % | Cache-write $ | Cache-write % | Total $ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | $0.0000 | n/a | $0.0000 | n/a | $0.0000 | n/a | $0.0000 | n/a | $0.0000 |
| full | $0.0000 | n/a | $0.0000 | n/a | $0.0000 | n/a | $0.0000 | n/a | $0.0000 |

## New-flow vs full

_Not available: this run set does not contain BOTH the `full` and `new-flow` arms (run `--arm full --arm new-flow` to populate this)._

## Rerank arm (full vs full-minus-rerank)

_Not available: this run set does not contain BOTH the `full` and `full-minus-rerank` arms (run `--arm full --arm full-minus-rerank` to populate this)._

## Per-layer ablation deltas

Each layer's worth is `full` solve-rate minus `full-minus-<layer>` solve-rate on the SAME scorer and run set. A positive delta means the layer **earns its place**; a zero or negative delta flags it as a **candidate to fix or remove**. `n/a` means the `full` arm or that layer's ablation arm was absent from this run set (delta undefined).

| Layer | full solve-rate | full-minus-layer solve-rate | Delta | Verdict |
| --- | ---: | ---: | ---: | --- |
| context | 0.0% | n/a | n/a | n/a (delta undefined — arm absent) |
| routing | 0.0% | n/a | n/a | n/a (delta undefined — arm absent) |
| verify_gate | 0.0% | n/a | n/a | n/a (delta undefined — arm absent) |
| retry | 0.0% | n/a | n/a | n/a (delta undefined — arm absent) |
| guardrails | 0.0% | n/a | n/a | n/a (delta undefined — arm absent) |
| rerank | 0.0% | n/a | n/a | n/a (delta undefined — arm absent) |
| expansion | 0.0% | n/a | n/a | n/a (delta undefined — arm absent) |

_No layer has a zero or negative delta in this run set._

## New-flow per-layer ablation deltas

Each new layer's worth is `new-flow` solve-rate minus `new-flow-minus-<layer>` solve-rate on the SAME scorer and run set (critic #977 / bestofn #979 / warmcache #978). These layers are NOT in `full` (critic and best-of-N are opt-in; warm-cache is default-on), so they are ablated relative to the NEW flow, never minused from `full`. A positive delta means the layer **earns its place**; a zero or negative delta flags it as a **candidate to fix or remove**. `n/a` means the `new-flow` arm or that layer's ablation arm was absent (delta undefined).

| Layer | new-flow solve-rate | new-flow-minus-layer solve-rate | Delta | Verdict |
| --- | ---: | ---: | ---: | --- |
| critic | n/a | n/a | n/a | n/a (delta undefined — arm absent) |
| bestofn | n/a | n/a | n/a | n/a (delta undefined — arm absent) |
| warmcache | n/a | n/a | n/a | n/a (delta undefined — arm absent) |

_No new-flow layer has a zero or negative delta in this run set._

## Difficulty-stratified breakdown

Solve-rate, cost, and dollars-per-solved-task broken out per difficulty stratum (easy / medium / hard, proxied by required-context scatter), IN ADDITION TO the aggregate above. A single aggregate hides the harness's real edge, which is large on hard scattered-context tasks and small on easy single-file ones.

| Arm | Difficulty | Reps | Solved | Failed | Solve-rate | Total cost | Dollars-per-solved-task |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | easy | 1 | 0 | 1 | 0.0% | $0.0000 | n/a |
| full | easy | 1 | 0 | 1 | 0.0% | $0.0000 | n/a |

## Failures, ties, and spread

### Arm: baseline

- Failed repetitions: 1 of 1
- Tie tasks: none
- Spread (population stddev of per-task solve-rate): 0.0000
- Objective Gate false-green rate: n/a (undefined — no run's gate passed, so the denominator is empty; NOT a 0% rate)
- Dollars-per-solved-task: n/a (undefined — no repetition solved; total cost $0.0000 was spent on failures)
- Per-task solve-rate:
  - afk-objective-gate: 0.0%
- Failed-run detail:
  - **afk-objective-gate** — gate: no reason captured
  - Diff: _(empty — agent produced no change)_

### Arm: full

- Failed repetitions: 1 of 1
- Tie tasks: none
- Spread (population stddev of per-task solve-rate): 0.0000
- Objective Gate false-green rate: n/a (undefined — no run's gate passed, so the denominator is empty; NOT a 0% rate)
- Dollars-per-solved-task: n/a (undefined — no repetition solved; total cost $0.0000 was spent on failures)
- Per-task solve-rate:
  - afk-objective-gate: 0.0%
- Failed-run detail:
  - **afk-objective-gate** — gate: no reason captured
  - Diff: _(empty — agent produced no change)_

## Context quality

Context-pack retrieval quality per arm (issue #994). ``n/a`` means the metric was not captured for this arm — the live sandbox executor does not yet plumb context-pack metadata out of the run — and is DISTINCT from a measured ``0.000``.

| Arm | Mean precision@budget | Mean citation-coverage |
| --- | ---: | ---: |
| baseline | n/a | n/a |
| full | n/a | n/a |

# AgentRail intrinsic probes

Measurements hidden tests cannot see (PRD §Intrinsic probes). All dollar figures route through the single-source pricing module; the guardrail catch-rate runs the REAL guardrails against a crafted injection corpus.

## Routing cost-regret

Dollar regret = a solved run's cost minus the cheapest model that STILL SOLVED the same task across the run set. Unsolved runs and tasks no run solved contribute no regret.

- Total routing cost-regret: $0.0000
- Per arm:
  - baseline: $0.0000 (0 solved run(s))
  - full: $0.0000 (0 solved run(s))

## Retry lift

Solve-rate lift attributable to retries = with-retry solve-rate minus first-attempt-only solve-rate. Wasted-retry cost = dollars spent on runs that retried but never solved.

- With-retry solve-rate: 0.0%
- First-attempt-only solve-rate: 0.0%
- Retry lift: 0.0%
- Wasted-retry cost: $0.0000

## Guardrail injection-corpus catch-rate

Fraction of crafted VIOLATION cases (secret-in-diff, deleted-test) the REAL guardrails flagged. A clean case is included as a falsifier: a guardrail that flagged everything would surface it as a false positive.

- Catch-rate: 100.0% (2 of 2 violations caught)
- Cases:
  - secret_in_diff via push_guardrail: CAUGHT
  - deleted_test via objective_gate: CAUGHT
  - clean via push_guardrail: clean (not flagged)

# Routing/retry value audit

Measurement-only attribution (Finding 4): did the routing layer ever change the model from the arm's baseline/default, and did retries flip failures into wins or just burn cost? No live-loop behaviour is changed. All dollars route through the single-source pricing module.

## Routing attribution (vs baseline model)

A run "diverged" when the resolved model differs from the run's recorded baseline/default model (the arm's pinned model it would have used had routing not acted).

- Routing NEVER diverged from baseline across 2 run(s) with a recorded baseline: it had **no chance to act**, so it neither added nor destroyed value here. A flat result is NOT a measured zero-value verdict.

## Retry attribution (wins vs burned cost)

A retry **win** is a run that retried and ended solved while its first attempt's gate did not pass (the retry flipped failure into success). A **burn** is a run that retried and ended unsolved (cost spent, no win).

- Runs that retried: 0
- Retries that flipped failure into success (wins): 0
- Retries that burned cost with no win (unsolved): 0
- Cost burned by retries with no win: $0.0000
