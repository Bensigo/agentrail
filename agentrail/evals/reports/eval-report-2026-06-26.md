# AgentRail eval report

Generated: 2026-06-26

Headline cost metric is **dollars-per-solved-task** (never cost per task). Reports include failures, ties, and spread — not only wins. All dollar figures route through the single-source pricing module.

## Per-arm summary

| Arm | Reps | Solved | Failed | Solve-rate | Spread | False-green rate | Wall-time per task | Total tokens | Total cost | Dollars-per-solved-task |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| full | 4 | 1 | 3 | 25.0% | 0.4330 | 66.7% | 928.6s | 29375973 | $16.7899 | $16.7899 |

## New-flow vs full

_Not available: this run set does not contain BOTH the `full` and `new-flow` arms (run `--arm full --arm new-flow` to populate this)._

## Per-layer ablation deltas

Each layer's worth is `full` solve-rate minus `full-minus-<layer>` solve-rate on the SAME scorer and run set. A positive delta means the layer **earns its place**; a zero or negative delta flags it as a **candidate to fix or remove**. `n/a` means the `full` arm or that layer's ablation arm was absent from this run set (delta undefined).

| Layer | full solve-rate | full-minus-layer solve-rate | Delta | Verdict |
| --- | ---: | ---: | ---: | --- |
| context | 25.0% | n/a | n/a | n/a (delta undefined — arm absent) |
| routing | 25.0% | n/a | n/a | n/a (delta undefined — arm absent) |
| verify_gate | 25.0% | n/a | n/a | n/a (delta undefined — arm absent) |
| retry | 25.0% | n/a | n/a | n/a (delta undefined — arm absent) |
| guardrails | 25.0% | n/a | n/a | n/a (delta undefined — arm absent) |

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
| full | easy | 1 | 0 | 1 | 0.0% | $2.0692 | n/a |
| full | medium | 2 | 1 | 1 | 50.0% | $9.6594 | $9.6594 |
| full | hard | 1 | 0 | 1 | 0.0% | $5.0614 | n/a |

## Failures, ties, and spread

### Arm: full

- Failed repetitions: 3 of 4
- Tie tasks: none
- Spread (population stddev of per-task solve-rate): 0.4330
- Objective Gate false-green rate: 66.7% (2 of 3 gate-passed runs failed the hidden tests)
- Dollars-per-solved-task: $16.7899
- Per-task solve-rate:
  - context-rerank: 0.0%
  - objective-gate-unified: 0.0%
  - output-format-enforcer: 0.0%
  - runner-escalation: 100.0%
- Failed-run detail:
  - **context-rerank** — gate: no reason captured
  - Diff (first 50 lines):

    ```diff
    diff --git a/agentrail/context/compiler.py b/agentrail/context/compiler.py
    index cefe420..ef126c8 100644
    --- a/agentrail/context/compiler.py
    +++ b/agentrail/context/compiler.py
    @@ -468,6 +468,58 @@ def token_pack_metadata(
         }
     
     
    +def _build_rerank_metadata(
    +    rerank_result: Optional[Dict[str, Any]],
    +    selected_candidate_ids: List[str],
    +    excluded_candidate_ids: List[str],
    +    candidates: List[Dict[str, Any]],
    +) -> Dict[str, Any]:
    +    """Build rerank metadata for the compiler contract.
    +
    +    When rerank_result is provided (from the RERANK stage), use its data.
    +    Otherwise, use the default score_sorted metadata.
    +    """
    +    if rerank_result:
    +        # Extract rejected candidates from the rerank result.
    +        # The rejected list from rerank_candidates contains the full candidate dicts.
    +        rejected_items = []
    +        for rejected in rerank_result.get("rejected", []):
    +            rejected_items.append({
    +                "id": (
    +                    rejected.get("chunkId")
    +                    or rejected.get("sourceId")
    +                    or rejected.get("path")
    +                    or str(id(rejected))
    +                ),
    +                "kind": "excluded_context",
    +                "path": rejected.get("path"),
    +                "citation": rejected.get("citation"),
    +                "rerank": rejected.get("rerank", {}),
    +            })
    +
    +        return {
    +            "status": "reranked",
    +            "method": rerank_result.get("method", "code_aware_symbol_graph_freshness"),
    +            "model": None,
    +            "rankedCandidateIds": selected_candidate_ids,
    +            "rejected": rejected_items,
    +            "signals": {
    +                "symbolOverlap": True,
    +                "graphDistance": True,
    +                "freshness": True,
    +            },
    +        }
    +    else:
    … 803 more lines
    ```
  - **objective-gate-unified** — gate: no reason captured
  - Diff (first 50 lines):

    ```diff
    diff --git a/agentrail/afk/objective_gate.py b/agentrail/afk/objective_gate.py
    index 056779d..6d1cfa5 100644
    --- a/agentrail/afk/objective_gate.py
    +++ b/agentrail/afk/objective_gate.py
    @@ -1,14 +1,22 @@
     """Deterministic objective gate (ADR 0007): CI checks + security checks.
     
    -This module is pure — it takes already-fetched CI-check data and diff data and
    -returns a verdict. The runner performs the IO (gh.pr_checks, git diff) and the
    -CI polling. No LLM opinion participates; merge is gated only by these signals.
    +This module is a delegation shim — it exposes the afk-harness interface while
    +delegating to the unified policy in agentrail/guardrails/policies/objective.py.
    +The runner performs the IO (gh.pr_checks, git diff) and the CI polling. No LLM
    +opinion participates; merge is gated only by these signals.
     """
     from __future__ import annotations
     
    -import re
     from dataclasses import dataclass
    -from typing import Dict, List, Optional
    +from typing import Dict, List
    +
    +# Re-export the unified helper functions (same objects, not copies)
    +from agentrail.guardrails.policies.objective import (
    +    deleted_files_in_use,
    +    evaluate_objective,
    +    fix_prompt,
    +    scan_secrets,
    +)
     
     
     @dataclass(frozen=True)
    @@ -21,86 +29,20 @@ class ObjectiveGateResult:
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
    -def evaluate_ci(checks: List[dict]) -> Optional[ObjectiveGateResult]:
    -    """Evaluate CI checks. Returns a fail/pending result, or None when all pass.
    -
    -    Zero checks is a FAIL — merging with no objective signal violates ADR 0007.
    … 1002 more lines
    ```
  - **output-format-enforcer** — gate: tests didn't pass / gate red
  - Diff (first 50 lines):

    ```diff
    diff --git a/agentrail/run/output_enforcer.py b/agentrail/run/output_enforcer.py
    new file mode 100644
    index 0000000..c94702e
    --- /dev/null
    +++ b/agentrail/run/output_enforcer.py
    @@ -0,0 +1,159 @@
    +"""Output format enforcer for the execute phase.
    +
    +When the agent edits an existing file it must return a unified diff, not a
    +full-file rewrite. enforce checks for the presence of unified-diff hunk headers
    +('@@ ... @@') and rejects content without them unless is_new_or_rename=True.
    +"""
    +from __future__ import annotations
    +
    +import json
    +import time
    +import urllib.request
    +from dataclasses import dataclass
    +from datetime import datetime, timezone
    +from pathlib import Path
    +
    +from agentrail.context.snapshot_push import load_link
    +
    +
    +@dataclass(frozen=True)
    +class Accepted:
    +    """Content is accepted (valid unified diff or new/rename)."""
    +    pass
    +
    +
    +@dataclass(frozen=True)
    +class Rejected:
    +    """Content is rejected (missing unified-diff hunk headers).
    +
    +    Carries a non-empty reason string explaining the rejection.
    +    """
    +    reason: str
    +
    +
    +def enforce(content: str, is_new_or_rename: bool = False) -> Accepted | Rejected:
    +    """Enforce output format: unified diff required for existing files.
    +
    +    Returns Accepted when:
    +    - Content contains unified-diff hunk header (@@ ... @@), OR
    +    - is_new_or_rename=True (new files accept any content)
    +
    +    Returns Rejected with reason when:
    +    - is_new_or_rename=False AND content lacks @@ hunk headers
    +    """
    +    if is_new_or_rename:
    … 438 more lines
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
  - full: $0.0000 (1 solved run(s))

## Retry lift

Solve-rate lift attributable to retries = with-retry solve-rate minus first-attempt-only solve-rate. Wasted-retry cost = dollars spent on runs that retried but never solved.

- With-retry solve-rate: 25.0%
- First-attempt-only solve-rate: 25.0%
- Retry lift: 0.0%
- Wasted-retry cost: $0.0000

## Guardrail injection-corpus catch-rate

Fraction of crafted VIOLATION cases (secret-in-diff, deleted-test) the REAL guardrails flagged. A clean case is included as a falsifier: a guardrail that flagged everything would surface it as a false positive.

- Catch-rate: 100.0% (2 of 2 violations caught)
- Cases:
  - secret_in_diff via push_guardrail: CAUGHT
  - deleted_test via objective_gate: CAUGHT
  - clean via push_guardrail: clean (not flagged)
