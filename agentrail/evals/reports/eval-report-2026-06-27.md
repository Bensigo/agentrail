# AgentRail eval report

Generated: 2026-06-27

Headline cost metric is **dollars-per-solved-task** (never cost per task). Reports include failures, ties, and spread — not only wins. All dollar figures route through the single-source pricing module.

## Per-arm summary

| Arm | Reps | Solved | Failed | Solve-rate | Spread | False-green rate | Wall-time per task | Total tokens | Total cost | Dollars-per-solved-task |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| full | 5 | 2 | 3 | 40.0% | 0.4899 | 50.0% | 771.9s | 27982075 | $16.2248 | $8.1124 |

## New-flow vs full

_Not available: this run set does not contain BOTH the `full` and `new-flow` arms (run `--arm full --arm new-flow` to populate this)._

## Per-layer ablation deltas

Each layer's worth is `full` solve-rate minus `full-minus-<layer>` solve-rate on the SAME scorer and run set. A positive delta means the layer **earns its place**; a zero or negative delta flags it as a **candidate to fix or remove**. `n/a` means the `full` arm or that layer's ablation arm was absent from this run set (delta undefined).

| Layer | full solve-rate | full-minus-layer solve-rate | Delta | Verdict |
| --- | ---: | ---: | ---: | --- |
| context | 40.0% | n/a | n/a | n/a (delta undefined — arm absent) |
| routing | 40.0% | n/a | n/a | n/a (delta undefined — arm absent) |
| verify_gate | 40.0% | n/a | n/a | n/a (delta undefined — arm absent) |
| retry | 40.0% | n/a | n/a | n/a (delta undefined — arm absent) |
| guardrails | 40.0% | n/a | n/a | n/a (delta undefined — arm absent) |

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
| full | easy | 2 | 1 | 1 | 50.0% | $4.0394 | $4.0394 |
| full | medium | 2 | 1 | 1 | 50.0% | $7.5340 | $7.5340 |
| full | hard | 1 | 0 | 1 | 0.0% | $4.6513 | n/a |

## Failures, ties, and spread

### Arm: full

- Failed repetitions: 3 of 5
- Tie tasks: none
- Spread (population stddev of per-task solve-rate): 0.4899
- Objective Gate false-green rate: 50.0% (1 of 2 gate-passed runs failed the hidden tests)
- Dollars-per-solved-task: $8.1124
- Per-task solve-rate:
  - context-rerank: 0.0%
  - issue-queue-state-machine: 100.0%
  - objective-gate-unified: 0.0%
  - output-format-enforcer: 0.0%
  - runner-escalation: 100.0%
- Failed-run detail:
  - **context-rerank** — gate: tests didn't pass / gate red
  - Diff (first 50 lines):

    ```diff
    diff --git a/agentrail/context/compiler.py b/agentrail/context/compiler.py
    index cefe420..ef7ed9a 100644
    --- a/agentrail/context/compiler.py
    +++ b/agentrail/context/compiler.py
    @@ -411,6 +411,9 @@ def candidate_from_item(item: Dict[str, Any], *, kind: Optional[str] = None, bas
                 "freshnessPolicy": _freshness_policy(item, candidate_kind, freshness),
             },
         }
    +    # Preserve rerank metadata if present
    +    if "rerank" in item:
    +        value["rerank"] = item["rerank"]
         return {key: current for key, current in value.items() if current is not None}
     
     
    @@ -468,6 +471,49 @@ def token_pack_metadata(
         }
     
     
    +def _build_rerank_section(
    +    rerank_data: Optional[Dict[str, Any]],
    +    selected_candidate_ids: List[str],
    +    excluded_candidate_ids: List[str],
    +    candidates: List[Dict[str, Any]],
    +) -> Dict[str, Any]:
    +    """Build the rerank section of the compiler contract.
    +
    +    Uses rerank_data if provided (when AGENTRAIL_CONTEXT_RERANK=1), otherwise
    +    returns the pre-rerank state (score_sorted).
    +    """
    +    if rerank_data is None:
    +        # Pre-rerank state: no rerank stage ran
    +        return {
    +            "status": "score_sorted",
    +            "method": "hybrid_lexical_rrf_authority_freshness",
    +            "model": None,
    +            "rankedCandidateIds": selected_candidate_ids,
    +            "rejectedCandidateIds": excluded_candidate_ids,
    +        }
    +
    +    # Build rejected list from candidates that have rerank.reason
    +    rejected_items = []
    +    for cand in candidates:
    +        if "rerank" in cand and "reason" in cand["rerank"]:
    +            rejected_items.append({
    +                "id": cand.get("id"),
    +                "path": cand.get("path"),
    +                "citation": cand.get("citation"),
    +                "reason": cand["rerank"]["reason"],
    +            })
    +
    … 582 more lines
    ```
  - **objective-gate-unified** — gate: no reason captured
  - Diff (first 50 lines):

    ```diff
    diff --git a/agentrail/afk/objective_gate.py b/agentrail/afk/objective_gate.py
    index 056779d..3f9e05a 100644
    --- a/agentrail/afk/objective_gate.py
    +++ b/agentrail/afk/objective_gate.py
    @@ -1,15 +1,23 @@
     """Deterministic objective gate (ADR 0007): CI checks + security checks.
     
    -This module is pure — it takes already-fetched CI-check data and diff data and
    -returns a verdict. The runner performs the IO (gh.pr_checks, git diff) and the
    -CI polling. No LLM opinion participates; merge is gated only by these signals.
    +This module now delegates to the unified policy at
    +agentrail.guardrails.policies.objective and maintains the afk harness
    +interface for backward compatibility.
     """
     from __future__ import annotations
     
    -import re
     from dataclasses import dataclass
     from typing import Dict, List, Optional
     
    +# Re-export helpers from the unified policy
    +from agentrail.guardrails.policies.objective import (
    +    deleted_files_in_use,
    +    evaluate_ci_checks as _evaluate_ci_checks,
    +    evaluate_objective,
    +    fix_prompt,
    +    scan_secrets,
    +)
    +
     
     @dataclass(frozen=True)
     class ObjectiveGateResult:
    @@ -21,57 +29,15 @@ class ObjectiveGateResult:
             return self.state == "pass"
     
     
    -# High-confidence secret patterns. Conservative on purpose — a false positive
    -# blocks a merge, so we only match shapes that are almost never legitimate in a
    -# diff's added lines.
    -_SECRET_PATTERNS = [
    -    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    -    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),                       # AWS access key id
    -    re.compile(r"(?i)\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*['\"][^'\"]{12,}['\"]"),
    -]
    -
    -
     def evaluate_ci(checks: List[dict]) -> Optional[ObjectiveGateResult]:
         """Evaluate CI checks. Returns a fail/pending result, or None when all pass.
     
         Zero checks is a FAIL — merging with no objective signal violates ADR 0007.
    … 930 more lines
    ```
  - **output-format-enforcer** — gate: tests didn't pass / gate red
  - Diff (first 50 lines):

    ```diff
    diff --git a/agentrail/run/output_enforcer.py b/agentrail/run/output_enforcer.py
    new file mode 100644
    index 0000000..3f970c2
    --- /dev/null
    +++ b/agentrail/run/output_enforcer.py
    @@ -0,0 +1,150 @@
    +"""Output format enforcer for the execute phase.
    +
    +Validates that agent output follows the required unified diff format for existing
    +file edits, and emits rejection events when violations are detected.
    +"""
    +from __future__ import annotations
    +
    +import json
    +import urllib.request
    +from dataclasses import dataclass
    +from datetime import datetime, timezone
    +from pathlib import Path
    +from typing import Union
    +
    +
    +@dataclass
    +class Accepted:
    +    """Result indicating content passed format validation."""
    +    pass
    +
    +
    +@dataclass
    +class Rejected:
    +    """Result indicating content failed format validation."""
    +    reason: str
    +
    +
    +def enforce(content: str, is_new_or_rename: bool = False) -> Union[Accepted, Rejected]:
    +    """Enforce unified diff format for existing file edits.
    +
    +    When editing an existing file (is_new_or_rename=False), content must contain
    +    a unified diff hunk header '@@ ... @@'. For new files or renames, any content
    +    is accepted.
    +
    +    Args:
    +        content: The output content to validate
    +        is_new_or_rename: True if this is a new file or rename operation
    +
    +    Returns:
    +        Accepted if content passes validation, Rejected with reason otherwise
    +    """
    +    if is_new_or_rename:
    +        return Accepted()
    +
    … 392 more lines
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
  - full: $0.0000 (2 solved run(s))

## Retry lift

Solve-rate lift attributable to retries = with-retry solve-rate minus first-attempt-only solve-rate. Wasted-retry cost = dollars spent on runs that retried but never solved.

- With-retry solve-rate: 40.0%
- First-attempt-only solve-rate: 40.0%
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
- Dollars spent on diverged runs: $16.2248
- Net $-delta vs baseline: n/a (no per-run baseline token usage exists to price a counterfactual — we never invent one)

## Retry attribution (wins vs burned cost)

A retry **win** is a run that retried and ended solved while its first attempt's gate did not pass (the retry flipped failure into success). A **burn** is a run that retried and ended unsolved (cost spent, no win).

- Runs that retried: 0
- Retries that flipped failure into success (wins): 0
- Retries that burned cost with no win (unsolved): 0
- Cost burned by retries with no win: $0.0000
