# AgentRail eval report

Generated: 2026-06-28

Headline cost metric is **dollars-per-solved-task** (never cost per task). Reports include failures, ties, and spread — not only wins. All dollar figures route through the single-source pricing module.

## Per-arm summary

| Arm | Reps | Solved | Failed | Solve-rate | Spread | False-green rate | Wall-time per task | Total tokens | Total cost | Dollars-per-solved-task |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| full | 5 | 4 | 1 | 80.0% | 0.4000 | 0.0% | 801.1s | 28461127 | $17.1632 | $4.2908 |

## New-flow vs full

_Not available: this run set does not contain BOTH the `full` and `new-flow` arms (run `--arm full --arm new-flow` to populate this)._

## Per-layer ablation deltas

Each layer's worth is `full` solve-rate minus `full-minus-<layer>` solve-rate on the SAME scorer and run set. A positive delta means the layer **earns its place**; a zero or negative delta flags it as a **candidate to fix or remove**. `n/a` means the `full` arm or that layer's ablation arm was absent from this run set (delta undefined).

| Layer | full solve-rate | full-minus-layer solve-rate | Delta | Verdict |
| --- | ---: | ---: | ---: | --- |
| context | 80.0% | n/a | n/a | n/a (delta undefined — arm absent) |
| routing | 80.0% | n/a | n/a | n/a (delta undefined — arm absent) |
| verify_gate | 80.0% | n/a | n/a | n/a (delta undefined — arm absent) |
| retry | 80.0% | n/a | n/a | n/a (delta undefined — arm absent) |
| guardrails | 80.0% | n/a | n/a | n/a (delta undefined — arm absent) |

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
| full | easy | 2 | 1 | 1 | 50.0% | $4.0108 | $4.0108 |
| full | medium | 2 | 2 | 0 | 100.0% | $8.3918 | $4.1959 |
| full | hard | 1 | 1 | 0 | 100.0% | $4.7605 | $4.7605 |

## Failures, ties, and spread

### Arm: full

- Failed repetitions: 1 of 5
- Tie tasks: none
- Spread (population stddev of per-task solve-rate): 0.4000
- Objective Gate false-green rate: 0.0% (0 of 3 gate-passed runs failed the hidden tests)
- Dollars-per-solved-task: $4.2908
- Per-task solve-rate:
  - context-rerank: 100.0%
  - issue-queue-state-machine: 0.0%
  - objective-gate-unified: 100.0%
  - output-format-enforcer: 100.0%
  - runner-escalation: 100.0%
- Failed-run detail:
  - **issue-queue-state-machine** — gate: tests didn't pass / gate red
  - Diff (first 50 lines):

    ```diff
    diff --git a/agentrail/afk/queue_state.py b/agentrail/afk/queue_state.py
    new file mode 100644
    index 0000000..6548ee3
    --- /dev/null
    +++ b/agentrail/afk/queue_state.py
    @@ -0,0 +1,130 @@
    +"""
    +Issue Queue state machine.
    +
    +Single-entry state transitions for the AFK issue queue. Each entry carries its
    +tier, remaining budget, state (live or terminal), and blocker dependencies.
    +"""
    +from __future__ import annotations
    +
    +from dataclasses import dataclass, replace
    +from enum import Enum
    +from typing import FrozenSet, Union
    +
    +
    +class QueueState(str, Enum):
    +    """Live states for queue entries."""
    +    QUEUED = "queued"
    +    RUNNING = "running"
    +    PARKED = "parked"
    +
    +
    +class Terminal(str, Enum):
    +    """Terminal states — once reached, no further transitions."""
    +    GREEN = "green"
    +    ESCALATED_TO_HUMAN = "escalated_to_human"
    +    BLOCKED = "blocked"
    +
    +
    +class Tier(str, Enum):
    +    """Model tier for execution."""
    +    CHEAP = "cheap"
    +    STRONG = "strong"
    +
    +
    +class Event(str, Enum):
    +    """Input alphabet that drives state transitions."""
    +    START = "start"
    +    GATE_GREEN = "gate_green"
    +    GATE_RED = "gate_red"
    +    SECURITY_BLOCK = "security_block"
    +
    +
    +@dataclass(frozen=True)
    +class QueueEntry:
    +    """A queue entry with state, tier, budget, and blocker dependencies.
    … 323 more lines
    ```

## Context quality

Context-pack retrieval quality per arm (issue #994). ``n/a`` means the metric was not captured for this arm — the live sandbox executor does not yet plumb context-pack metadata out of the run — and is DISTINCT from a measured ``0.000``.

| Arm | Mean precision@budget | Mean citation-coverage |
| --- | ---: | ---: |
| full | n/a | n/a |

# AgentRail intrinsic probes

Measurements hidden tests cannot see (PRD §Intrinsic probes). All dollar figures route through the single-source pricing module; the guardrail catch-rate runs the REAL guardrails against a crafted injection corpus.

## Routing cost-regret

Dollar regret = a solved run's cost minus the cheapest model that STILL SOLVED the same task across the run set. Unsolved runs and tasks no run solved contribute no regret.

- Total routing cost-regret: $0.0000
- Per arm:
  - full: $0.0000 (4 solved run(s))

## Retry lift

Solve-rate lift attributable to retries = with-retry solve-rate minus first-attempt-only solve-rate. Wasted-retry cost = dollars spent on runs that retried but never solved.

- With-retry solve-rate: 80.0%
- First-attempt-only solve-rate: 80.0%
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

- Runs where routing changed the model: 5 of 5 (baseline recorded)
- Runs that stayed on baseline (routing did nothing): 0
- Dollars spent on diverged runs: $17.1632
- Net $-delta vs baseline: n/a (no per-run baseline token usage exists to price a counterfactual — we never invent one)

## Retry attribution (wins vs burned cost)

A retry **win** is a run that retried and ended solved while its first attempt's gate did not pass (the retry flipped failure into success). A **burn** is a run that retried and ended unsolved (cost spent, no win).

- Runs that retried: 0
- Retries that flipped failure into success (wins): 0
- Retries that burned cost with no win (unsolved): 0
- Cost burned by retries with no win: $0.0000
