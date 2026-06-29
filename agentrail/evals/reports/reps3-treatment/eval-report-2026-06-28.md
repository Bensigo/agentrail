# AgentRail eval report

Generated: 2026-06-28

Headline cost metric is **dollars-per-solved-task** (never cost per task). Reports include failures, ties, and spread — not only wins. All dollar figures route through the single-source pricing module.

## Per-arm summary

| Arm | Reps | Solved | Failed | Solve-rate | Spread | False-green rate | Wall-time per task | Total tokens | Total cost | Dollars-per-solved-task |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| full | 30 | 9 | 21 | 30.0% | 0.4069 | 0.0% | 396.0s | 80967835 | $40.3072 | $4.4786 |

## Cost breakdown

Per-arm split of **Total cost** into its four priced components (input, output, cache-read, cache-write). All figures route through the single-source pricing module, and the four components sum to the arm's total cost. The `%` columns are each component's share of that arm's total cost (`n/a` when the arm spent nothing).

| Arm | Input $ | Input % | Output $ | Output % | Cache-read $ | Cache-read % | Cache-write $ | Cache-write % | Total $ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| full | $0.0912 | 0.2% | $4.4218 | 11.0% | $19.4182 | 48.2% | $16.3759 | 40.6% | $40.3072 |

## New-flow vs full

_Not available: this run set does not contain BOTH the `full` and `new-flow` arms (run `--arm full --arm new-flow` to populate this)._

## Per-layer ablation deltas

Each layer's worth is `full` solve-rate minus `full-minus-<layer>` solve-rate on the SAME scorer and run set. A positive delta means the layer **earns its place**; a zero or negative delta flags it as a **candidate to fix or remove**. `n/a` means the `full` arm or that layer's ablation arm was absent from this run set (delta undefined).

| Layer | full solve-rate | full-minus-layer solve-rate | Delta | Verdict |
| --- | ---: | ---: | ---: | --- |
| context | 30.0% | n/a | n/a | n/a (delta undefined — arm absent) |
| routing | 30.0% | n/a | n/a | n/a (delta undefined — arm absent) |
| verify_gate | 30.0% | n/a | n/a | n/a (delta undefined — arm absent) |
| retry | 30.0% | n/a | n/a | n/a (delta undefined — arm absent) |
| guardrails | 30.0% | n/a | n/a | n/a (delta undefined — arm absent) |

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
| full | easy | 12 | 6 | 6 | 50.0% | $12.5250 | $2.0875 |
| full | medium | 15 | 3 | 12 | 20.0% | $27.7821 | $9.2607 |
| full | hard | 3 | 0 | 3 | 0.0% | $0.0000 | n/a |

## Failures, ties, and spread

### Arm: full

- Failed repetitions: 21 of 30
- Tie tasks (solved on some reps, failed on others): cache-token-pricing, context-rerank
- Spread (population stddev of per-task solve-rate): 0.4069
- Objective Gate false-green rate: 0.0% (0 of 1 gate-passed runs failed the hidden tests)
- Dollars-per-solved-task: $4.4786
- Per-task solve-rate:
  - afk-objective-gate: 100.0%
  - cache-token-pricing: 66.7%
  - context-rerank: 33.3%
  - false-scorer-bug-report: 100.0%
  - guardrails-signals-adapters: 0.0%
  - issue-queue-state-machine: 0.0%
  - objective-gate-unified: 0.0%
  - output-format-enforcer: 0.0%
  - red-green-proof: 0.0%
  - runner-escalation: 0.0%
- Failed-run detail:
  - **cache-token-pricing** — gate: tests didn't pass / gate red
  - Diff (first 50 lines):

    ```diff
    diff --git a/agentrail/run/pricing.py b/agentrail/run/pricing.py
    index f86d930..61ec595 100644
    --- a/agentrail/run/pricing.py
    +++ b/agentrail/run/pricing.py
    @@ -53,9 +53,11 @@ def cost_usd(usage: object) -> float:
         input_tokens: int = usage.input_tokens    # type: ignore[attr-defined]
         output_tokens: int = usage.output_tokens  # type: ignore[attr-defined]
         cache_tokens: int = usage.cache_tokens    # type: ignore[attr-defined]
    +    cache_creation_tokens: int = getattr(usage, "cache_creation_tokens", 0)
     
         return (
             input_tokens * rates.input
    +        + cache_creation_tokens * rates.input
             + output_tokens * rates.output
             + cache_tokens * rates.cache
         ) / 1_000_000
    @@ -83,6 +85,7 @@ def cache_savings(usage: object) -> Dict[str, Any]:
         input_tokens: int = usage.input_tokens  # type: ignore[attr-defined]
         output_tokens: int = usage.output_tokens  # type: ignore[attr-defined]
         cache_tokens: int = usage.cache_tokens  # type: ignore[attr-defined]
    +    cache_creation_tokens: int = getattr(usage, "cache_creation_tokens", 0)
     
         total_prompt_tokens = input_tokens + cache_tokens
         cache_hit_rate = cache_tokens / total_prompt_tokens if total_prompt_tokens > 0 else 0.0
    @@ -97,7 +100,7 @@ def cache_savings(usage: object) -> Dict[str, Any]:
     
         cached_usd_saved = cache_tokens * (rates.input - rates.cache) / 1_000_000
         baseline_uncached_usd = (
    -        total_prompt_tokens * rates.input + output_tokens * rates.output
    +        (total_prompt_tokens + cache_creation_tokens) * rates.input + output_tokens * rates.output
         ) / 1_000_000
     
         return {
    diff --git a/tests/run/test_cache_creation_tokens.py b/tests/run/test_cache_creation_tokens.py
    new file mode 100644
    index 0000000..d381c06
    --- /dev/null
    +++ b/tests/run/test_cache_creation_tokens.py
    @@ -0,0 +1,224 @@
    +"""Acceptance test for issue #cache-token-pricing.
    +
    +Tests that cache_creation_tokens are captured and priced correctly through
    +the single-source pricing module (agentrail/run/pricing.py).
    +
    +Acceptance Criteria:
    +- AC1: cost_usd() accounts for cache_creation_tokens, charging them at the
    +       input rate (cache creation = writing to cache = same cost as input)
    +- AC2: cache_savings() computes baseline_uncached_usd including
    +       cache_creation_tokens at the input rate
    +
    … 213 more lines
    ```
  - **context-rerank** — gate: tests didn't pass / gate red
  - Diff (first 50 lines):

    ```diff
    diff --git a/agentrail/context/compiler.py b/agentrail/context/compiler.py
    index cefe420..674b42e 100644
    --- a/agentrail/context/compiler.py
    +++ b/agentrail/context/compiler.py
    @@ -483,6 +483,7 @@ def compiler_contract(
         graph_expansion: Optional[Dict[str, Any]] = None,
         compatibility: Optional[Dict[str, Any]] = None,
         token_pack_strategy: str = "compat_max_items_until_token_estimator_exists",
    +    rerank_metadata: Optional[Dict[str, Any]] = None,
     ) -> Dict[str, Any]:
         budget = token_budget or {"maxItems": None, "maxTokens": None}
         policy = compiler_policy(root)
    @@ -520,7 +521,7 @@ def compiler_contract(
                 "rejected": [],
             },
             "policy": policy,
    -        "rerank": {
    +        "rerank": rerank_metadata if rerank_metadata is not None else {
                 "status": "score_sorted",
                 "method": "hybrid_lexical_rrf_authority_freshness",
                 "model": None,
    diff --git a/agentrail/context/packs.py b/agentrail/context/packs.py
    index d695926..86a17bd 100644
    --- a/agentrail/context/packs.py
    +++ b/agentrail/context/packs.py
    @@ -649,6 +649,8 @@ def build_context_pack(
         else:
             prior_items = []
         pack["retrieval_dedup"] = compute_retrieval_dedup(prior_items, pack["included"], _dedup_model)
    +    # Extract rerank metadata from query result if available
    +    query_rerank_metadata = query.get("compiler", {}).get("rerank")
         pack["compiler"] = compiler_contract(
             target_kind,
             query_text,
    @@ -667,6 +669,7 @@ def build_context_pack(
                 "skillsMapTo": "compiler.candidates[kind=procedural_guidance]",
             },
             token_pack_strategy="greedy_budget_fill",
    +        rerank_metadata=query_rerank_metadata,
         )
         write_json(json_path, pack)
         md_path.write_text(render_context_pack_markdown(pack), encoding="utf-8")
    diff --git a/agentrail/context/rerank.py b/agentrail/context/rerank.py
    new file mode 100644
    index 0000000..e7c99cf
    --- /dev/null
    +++ b/agentrail/context/rerank.py
    @@ -0,0 +1,295 @@
    +"""Deterministic code-aware reranking for the Context Compiler.
    +
    … 1629 more lines
    ```
  - **context-rerank** — gate: tests didn't pass / gate red
  - Diff (first 50 lines):

    ```diff
    diff --git a/agentrail/context/compiler.py b/agentrail/context/compiler.py
    index cefe420..33a0847 100644
    --- a/agentrail/context/compiler.py
    +++ b/agentrail/context/compiler.py
    @@ -483,6 +483,7 @@ def compiler_contract(
         graph_expansion: Optional[Dict[str, Any]] = None,
         compatibility: Optional[Dict[str, Any]] = None,
         token_pack_strategy: str = "compat_max_items_until_token_estimator_exists",
    +    rerank: Optional[Dict[str, Any]] = None,
     ) -> Dict[str, Any]:
         budget = token_budget or {"maxItems": None, "maxTokens": None}
         policy = compiler_policy(root)
    @@ -520,7 +521,7 @@ def compiler_contract(
                 "rejected": [],
             },
             "policy": policy,
    -        "rerank": {
    +        "rerank": rerank or {
                 "status": "score_sorted",
                 "method": "hybrid_lexical_rrf_authority_freshness",
                 "model": None,
    diff --git a/agentrail/context/packs.py b/agentrail/context/packs.py
    index d695926..0cf7c46 100644
    --- a/agentrail/context/packs.py
    +++ b/agentrail/context/packs.py
    @@ -649,6 +649,8 @@ def build_context_pack(
         else:
             prior_items = []
         pack["retrieval_dedup"] = compute_retrieval_dedup(prior_items, pack["included"], _dedup_model)
    +    # Extract rerank metadata from query if present (rerank stage ran during retrieval)
    +    query_rerank = query.get("compiler", {}).get("rerank")
         pack["compiler"] = compiler_contract(
             target_kind,
             query_text,
    @@ -667,6 +669,7 @@ def build_context_pack(
                 "skillsMapTo": "compiler.candidates[kind=procedural_guidance]",
             },
             token_pack_strategy="greedy_budget_fill",
    +        rerank=query_rerank,
         )
         write_json(json_path, pack)
         md_path.write_text(render_context_pack_markdown(pack), encoding="utf-8")
    diff --git a/agentrail/context/rerank.py b/agentrail/context/rerank.py
    new file mode 100644
    index 0000000..1d758d7
    --- /dev/null
    +++ b/agentrail/context/rerank.py
    @@ -0,0 +1,238 @@
    +"""Deterministic code-aware reranking for context compiler candidates.
    +
    … 597 more lines
    ```
  - **guardrails-signals-adapters** — gate: tests didn't pass / gate red
  - Diff (first 50 lines):

    ```diff
    diff --git a/agentrail/guardrails/adapters.py b/agentrail/guardrails/adapters.py
    new file mode 100644
    index 0000000..5a0108c
    --- /dev/null
    +++ b/agentrail/guardrails/adapters.py
    @@ -0,0 +1,44 @@
    +"""Adapters translating framework-specific data into framework-neutral Signals.
    +
    +Adapters decouple guardrail policies from run/afk internal data structures.
    +Policies depend on Signals; adapters handle the translation.
    +
    +Design intent (issue #guardrails-signals-adapters)
    +---------------------------------------------------
    +* Adapters are the only code that knows about run/afk internals.
    +* Guardrail policies operate purely on Signals.
    +* This makes policies testable without importing orchestration modules.
    +"""
    +from __future__ import annotations
    +
    +from typing import Any
    +
    +from agentrail.guardrails.signals import CiCheck, Signals, TestResult
    +
    +
    +def verify_gate_adapter(run_data: dict[str, Any]) -> Signals:
    +    """Translate verify_gate internal data structures to framework-neutral Signals.
    +
    +    Parameters
    +    ----------
    +    run_data:
    +        Run data containing:
    +        - "ci_checks": list of {"name": str, "state": str}
    +        - "test_observations": list of {"test": str, "passed": bool}
    +
    +    Returns
    +    -------
    +    Signals
    +        Framework-neutral signal container.
    +    """
    +    ci_checks = [
    +        CiCheck(name=check["name"], status=check["state"])
    +        for check in run_data.get("ci_checks", [])
    +    ]
    +
    +    test_results = [
    +        TestResult(name=obs["test"], passed=obs["passed"])
    +        for obs in run_data.get("test_observations", [])
    +    ]
    +
    +    return Signals(ci_checks=ci_checks, test_results=test_results)
    … 323 more lines
    ```
  - **guardrails-signals-adapters** — gate: tests didn't pass / gate red
  - Diff (first 50 lines):

    ```diff
    diff --git a/agentrail/guardrails/policies/__init__.py b/agentrail/guardrails/policies/__init__.py
    index 35c15c6..9aa4c85 100644
    --- a/agentrail/guardrails/policies/__init__.py
    +++ b/agentrail/guardrails/policies/__init__.py
    @@ -8,5 +8,6 @@ approval_gate, sandbox, check_runner) so a single import populates the registry.
     from __future__ import annotations
     
     from agentrail.guardrails.policies import output_enforcer  # noqa: F401  (registers on import)
    +from agentrail.guardrails.policies import proof_required  # noqa: F401  (registers on import)
     
    -__all__ = ["output_enforcer"]
    +__all__ = ["output_enforcer", "proof_required"]
    diff --git a/agentrail/guardrails/policies/proof_required.py b/agentrail/guardrails/policies/proof_required.py
    new file mode 100644
    index 0000000..3f219af
    --- /dev/null
    +++ b/agentrail/guardrails/policies/proof_required.py
    @@ -0,0 +1,127 @@
    +"""Red-green proof guardrail — PURE policy (no file/network I/O).
    +
    +Validates that acceptance tests show valid red-green proof: test failed before
    +implementation, then passed after. Prevents tautological tests (never-red) and
    +ensures the implementer made the test pass, not that the test was authored green.
    +
    +What lives here (pure)
    +----------------------
    +* :func:`check_proof` — pure predicate: test_results → proof status.
    +* :class:`ProofRequiredGuardrail` — the seam adapter: wraps :func:`check_proof`
    +  behind the :class:`~agentrail.guardrails.base.Guardrail` protocol, mapping
    +  valid proof → PASS, invalid proof → FAIL (blocking).
    +
    +What deliberately does NOT live here
    +------------------------------------
    +No I/O imports. This policy is pure and framework-neutral.
    +"""
    +from __future__ import annotations
    +
    +from dataclasses import dataclass
    +
    +from agentrail.guardrails.base import Verdict
    +from agentrail.guardrails.registry import register
    +
    +
    +def check_proof(test_results: list[object]) -> tuple[bool, list[str]]:
    +    """Check if test_results contain valid red-green proof.
    +
    +    Parameters
    +    ----------
    +    test_results:
    +        List of TestResult signals.
    … 512 more lines
    ```
  - **guardrails-signals-adapters** — gate: tests didn't pass / gate red
  - Diff (first 50 lines):

    ```diff
    diff --git a/agentrail/guardrails/adapters.py b/agentrail/guardrails/adapters.py
    new file mode 100644
    index 0000000..893c47e
    --- /dev/null
    +++ b/agentrail/guardrails/adapters.py
    @@ -0,0 +1,97 @@
    +"""Adapters converting run/afk internals to framework-neutral Signals.
    +
    +This module is the boundary: it imports both Signals types (output) and run/afk
    +types (input) and provides thin conversion functions. Guardrail policies import
    +only Signals, never run/afk directly.
    +
    +Design
    +------
    +* **from_check_result** — converts run.CheckResult to signals.CiCheck.
    +* **from_ci_check_dict** — converts afk CI check dict to signals.CiCheck.
    +* **from_changed_files** — converts file change list to signals.TestResult.
    +
    +All adapters are pure functions with no I/O.
    +"""
    +from __future__ import annotations
    +
    +from typing import Any
    +
    +from agentrail.guardrails.signals import CiCheck, TestResult
    +from agentrail.run.objective_gate import CheckResult
    +
    +
    +def from_check_result(check: CheckResult) -> CiCheck:
    +    """Convert run.CheckResult to signals.CiCheck.
    +
    +    Parameters
    +    ----------
    +    check:
    +        A CheckResult from the objective gate.
    +
    +    Returns
    +    -------
    +    CiCheck
    +        Framework-neutral CI check signal.
    +    """
    +    return CiCheck(name=check.name, passed=check.passed, detail=check.detail)
    +
    +
    +def from_ci_check_dict(check_dict: dict[str, Any]) -> CiCheck:
    +    """Convert afk CI check dict to signals.CiCheck.
    +
    +    Parameters
    +    ----------
    +    check_dict:
    … 563 more lines
    ```
  - **issue-queue-state-machine** — gate: tests didn't pass / gate red
  - Diff (first 50 lines):

    ```diff
    diff --git a/tests/afk/test_queue_state.py b/tests/afk/test_queue_state.py
    new file mode 100644
    index 0000000..26145c6
    --- /dev/null
    +++ b/tests/afk/test_queue_state.py
    @@ -0,0 +1,251 @@
    +"""Acceptance test for the Issue Queue state machine (agentrail/afk/queue_state.py).
    +
    +This test encodes the full contract for the queue state machine through its public API:
    +- admit(entry, open_blockers) decides whether an issue is QUEUED or PARKED
    +- transition(entry, event) drives state changes through gate outcomes
    +- Terminal states (GREEN, ESCALATED_TO_HUMAN, BLOCKED) are idempotent
    +- Budget and tier escalation rules are enforced
    +"""
    +import pytest
    +
    +from agentrail.afk.queue_state import (
    +    Event,
    +    QueueEntry,
    +    QueueState,
    +    Terminal,
    +    Tier,
    +    admit,
    +    transition,
    +)
    +
    +
    +class TestQueueStateMachine:
    +    """Acceptance test for the Issue Queue state machine public API."""
    +
    +    def test_queue_state_machine_contract(self):
    +        """Complete state machine contract: admission, transitions, budget, escalation, terminals."""
    +
    +        # ─────────────────────────────────────────────────────────────────
    +        # 1. ADMISSION: unblocked issue queues, blocked issue parks
    +        # ─────────────────────────────────────────────────────────────────
    +
    +        # An issue with no blockers queues even when unrelated blockers are open
    +        entry_no_blockers = QueueEntry(
    +            number=1,
    +            tier=Tier.CHEAP,
    +            remaining_budget=3,
    +            blocked_by=frozenset(),
    +        )
    +        admitted_unblocked = admit(entry_no_blockers, open_blockers=frozenset([99, 100]))
    +        assert admitted_unblocked.state == QueueState.QUEUED
    +
    +        # An issue whose blockers intersect with open_blockers parks
    +        entry_with_blockers = QueueEntry(
    +            number=2,
    … 207 more lines
    ```
  - **issue-queue-state-machine** — gate: no diff (agent produced no change)
  - Diff: _(empty — agent produced no change)_
  - **issue-queue-state-machine** — gate: no diff (agent produced no change)
  - Diff: _(empty — agent produced no change)_
  - **objective-gate-unified** — gate: no diff (agent produced no change)
  - Diff: _(empty — agent produced no change)_
  - **objective-gate-unified** — gate: no diff (agent produced no change)
  - Diff: _(empty — agent produced no change)_
  - **objective-gate-unified** — gate: no diff (agent produced no change)
  - Diff: _(empty — agent produced no change)_
  - **output-format-enforcer** — gate: no diff (agent produced no change)
  - Diff: _(empty — agent produced no change)_
  - **output-format-enforcer** — gate: no diff (agent produced no change)
  - Diff: _(empty — agent produced no change)_
  - **output-format-enforcer** — gate: no diff (agent produced no change)
  - Diff: _(empty — agent produced no change)_
  - **red-green-proof** — gate: no diff (agent produced no change)
  - Diff: _(empty — agent produced no change)_
  - **red-green-proof** — gate: no diff (agent produced no change)
  - Diff: _(empty — agent produced no change)_
  - **red-green-proof** — gate: no diff (agent produced no change)
  - Diff: _(empty — agent produced no change)_
  - **runner-escalation** — gate: no diff (agent produced no change)
  - Diff: _(empty — agent produced no change)_
  - **runner-escalation** — gate: no diff (agent produced no change)
  - Diff: _(empty — agent produced no change)_
  - **runner-escalation** — gate: no diff (agent produced no change)
  - Diff: _(empty — agent produced no change)_

## Context quality

Context-pack retrieval quality per arm (issue #994). ``n/a`` means the metric was not captured for this arm — the live sandbox executor does not yet plumb context-pack metadata out of the run — and is DISTINCT from a measured ``0.000``.

| Arm | Mean precision@budget | Mean citation-coverage |
| --- | ---: | ---: |
| full | n/a | n/a |

# AgentRail intrinsic probes

Measurements hidden tests cannot see (PRD §Intrinsic probes). All dollar figures route through the single-source pricing module; the guardrail catch-rate runs the REAL guardrails against a crafted injection corpus.

## Routing cost-regret

Dollar regret = a solved run's cost minus the cheapest model that STILL SOLVED the same task across the run set. Unsolved runs and tasks no run solved contribute no regret.

- Total routing cost-regret: $1.1609
- Per arm:
  - full: $1.1609 (9 solved run(s))

## Retry lift

Solve-rate lift attributable to retries = with-retry solve-rate minus first-attempt-only solve-rate. Wasted-retry cost = dollars spent on runs that retried but never solved.

- With-retry solve-rate: 30.0%
- First-attempt-only solve-rate: 30.0%
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

- Runs where routing changed the model: 30 of 30 (baseline recorded)
- Runs that stayed on baseline (routing did nothing): 0
- Dollars spent on diverged runs: $40.3072
- Net $-delta vs baseline: n/a (no per-run baseline token usage exists to price a counterfactual — we never invent one)

## Retry attribution (wins vs burned cost)

A retry **win** is a run that retried and ended solved while its first attempt's gate did not pass (the retry flipped failure into success). A **burn** is a run that retried and ended unsolved (cost spent, no win).

- Runs that retried: 0
- Retries that flipped failure into success (wins): 0
- Retries that burned cost with no win (unsolved): 0
- Cost burned by retries with no win: $0.0000
