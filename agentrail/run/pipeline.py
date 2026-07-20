from __future__ import annotations
import dataclasses
import datetime as _dt
import json
import logging
import os
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import timezone
from pathlib import Path
from typing import Any, Dict, Optional

from agentrail.run import artifacts, budget_leash, context as ctx, prompts, skills, state as state_mod
from agentrail.guardrails.policies.input_contract import screen_injection
from agentrail.observability.tracer import RunTracer
from agentrail.run.check_runner import (
    ac_coverage_for,
    load_verify_checks,
    red_green_proof_required,
    run_objective_checks,
)
from agentrail.run.objective_gate import CheckResult, GateResult, evaluate
from agentrail.run.red_green import Observation, gate_evidence, verify_trail
from agentrail.run.activity_push import push_agent_activity
from agentrail.run.context_pack_push import (
    push_context_pack,
    push_live_context_metrics,
    read_pack_included,
)
from agentrail.run.context_inject import (
    emit_forced_context,
    forced_context_enabled,
    remove_forced_context,
)
from agentrail.run.cost_push import build_cost_record, push_cost_event
from agentrail.run.failure_push import push_failure_event
from agentrail.run.output_enforcer import (
    Rejected,
    all_changes_new_or_rename,
    enforce,
    plan_enforcement_step,
    push_format_rejection_event,
)
from agentrail.run.layer_overrides import layer_override
from agentrail.run.pricing import cost_breakdown, cost_usd, resolve_price_source
from agentrail.run.proc import run_with_timeout
from agentrail.run import best_of_n as bestofn
from agentrail.run import critic as critic_mod
from agentrail.run import verifier as verifier_mod
from agentrail.run.usage_capture import (
    capture_reads,
    capture_usage,
    record_reads_into_run_json,
)
from agentrail.shared.json import read_json, write_json

_log = logging.getLogger(__name__)


def layer_enabled(name: str) -> bool:
    """Is the named AgentRail layer ON for this run?

    Resolution order, most specific first:

    1. ``AGENTRAIL_EVAL_LAYER_<NAME>`` env var — the eval harness
       (``agentrail.evals``) sets it to ``"0"`` or ``"1"`` per leave-one-out
       ablation arm. When SET it wins outright, so eval arms are never
       contaminated by a checkout's overrides file.
    2. ``.agentrail/layer-overrides.json`` in the working directory — written
       by ``agentrail evals apply --apply`` (issue #1048), the recorded,
       evidence-backed human decision. Only an explicit JSON boolean counts.
    3. Default ON — the real autonomous loop (``run issue <N>``) with neither
       env var nor file behaves byte-identically to before this seam existed.

    Env contract: ABSENT falls through; ``"1"`` → ``True``; only an explicit
    ``"0"`` turns a layer OFF. Any other set value is treated as ON (a typo'd
    flag must never silently disable a layer in the real loop). The overrides
    file inherits the same defensiveness (see
    :mod:`agentrail.run.layer_overrides`).
    """
    env_value = os.environ.get(f"AGENTRAIL_EVAL_LAYER_{name.upper()}")
    if env_value is not None:
        return env_value != "0"
    override = layer_override(name)
    if override is not None:
        return override
    return True


def _utc_now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# Best-of-N (issue #979): the default candidate ceiling N. Kept SMALL — a tractable
# best-of-N is a critic-gated attempt loop with early stopping, not N parallel full
# pipelines (CONTEXT.md: per-task fan-out is 3-10x tokens for no reliable gain).
BESTOFN_DEFAULT_N = 3


def resolve_bestofn_n() -> int:
    """Resolve the best-of-N candidate ceiling N (issue #979).

    Reads ``AGENTRAIL_BESTOFN_N`` (the eval harness / runner may override it),
    falling back to :data:`BESTOFN_DEFAULT_N`. Pure and defensive: a missing,
    blank, non-integer, or non-positive value yields the default, so a typo'd
    config can never make N <= 0 (which would skip execute entirely).
    """
    raw = (os.environ.get("AGENTRAIL_BESTOFN_N") or "").strip()
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return BESTOFN_DEFAULT_N
    return n if n >= 1 else BESTOFN_DEFAULT_N


def bestofn_testfirst_enabled() -> bool:
    """Is the TEST-PRIMARY best-of-N selector ON for this run? DEFAULT ON (Finding 3).

    Finding 3 (the SAFE best-of-N): keep the executable hidden test as the PRIMARY
    candidate selector with early-stop on first pass, and demote the cheap critic
    (#977) to a SECONDARY tie-breaker ONLY. The merged #979 loop instead selects by
    the critic ALONE — the research-forbidden mode that gets worse as N grows. This
    flag swaps in the corrected selector.

    Eval data confirms this improvement is ready. Now DEFAULT ON — set
    ``AGENTRAIL_EVAL_LAYER_BESTOFN_TESTFIRST="0"`` (or pin
    ``bestofn_testfirst: false`` in ``.agentrail/layer-overrides.json``) to
    disable. Any other value (including ABSENT) uses the corrected selector.
    Resolution order (env > overrides file > default ON) is
    :func:`layer_enabled`'s.
    """
    return layer_enabled(bestofn.TESTFIRST_LAYER)


def diff_only_enforce_enabled() -> bool:
    """Is diff-only REJECT+LOOP enforcement ON for this run? DEFAULT ON.

    Eval data confirms this cost lever is ready. Now DEFAULT ON — set
    ``AGENTRAIL_EVAL_LAYER_DIFF_ONLY_ENFORCE="0"`` (or pin
    ``diff_only_enforce: false`` in ``.agentrail/layer-overrides.json``) to
    disable and revert to observe-only behavior. ABSENT or any other value
    keeps enforcement active. Resolution order (env > overrides file >
    default ON) is :func:`layer_enabled`'s.
    """
    return layer_enabled("DIFF_ONLY_ENFORCE")


def jit_gather_enabled() -> bool:
    """Is the JIT context-gatherer phase ON for this run? DEFAULT OFF (#1049).

    The gather phase (a cheap-model, read-only context gatherer that runs
    BEFORE test-author) is experimental and ships flag-gated OFF. It turns on
    ONLY when ``AGENTRAIL_JIT_GATHER`` is explicitly ``"1"`` — absent, blank,
    ``"0"``, or any other value keeps today's phase sequence byte-identical.

    Deliberately NOT routed through :func:`layer_enabled`: that helper defaults
    ON (ablation layers are opt-out), while this is a rollout flag that must
    default OFF until the gather flow is proven.
    """
    return (os.environ.get("AGENTRAIL_JIT_GATHER") or "").strip() == "1"


# Set by the hosted fleet runner (#1267) to mark this run as executing on
# AgentRail's managed infrastructure, rather than a developer's own machine.
# Hosted runs may NEVER proceed without the Independent Verifier seat (spec
# Sec 4.4: the per-task model override applies to the coding model only — the
# reviewer seat is never user-collapsible on the hosted path); see the
# startup assert in `_run_pipeline` (#1270 AC1). Same opt-in-only convention
# as `jit_gather_enabled`: default OFF, only an explicit "1" turns it on, so a
# developer's local/dev checkout is never accidentally treated as hosted.
AGENTRAIL_HOSTED_ENV = "AGENTRAIL_HOSTED"


def is_hosted_run() -> bool:
    """Is this run executing on the hosted fleet (#1267)? DEFAULT False."""
    return (os.environ.get(AGENTRAIL_HOSTED_ENV) or "").strip() == "1"


DIFF_ONLY_DEFAULT_MAX_ATTEMPTS = 2  # 1 initial + 1 redo-as-diff; kept small (cost lever)


def resolve_diff_only_max_attempts() -> int:
    """Resolve the diff-enforcement attempt ceiling. Defensive: missing/blank/
    non-int/<1 -> default, so a typo can never make it skip execute entirely."""
    raw = (os.environ.get("AGENTRAIL_DIFF_ONLY_MAX_ATTEMPTS") or "").strip()
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return DIFF_ONLY_DEFAULT_MAX_ATTEMPTS
    return n if n >= 1 else DIFF_ONLY_DEFAULT_MAX_ATTEMPTS


@dataclass
class RunContext:
    target_dir: Path
    repo_dir: Path
    issue: int
    agent: str
    agent_command: str
    run_id: str
    run_dir: Path
    started_at: str            # run-level started_at (for update_run_state)
    metadata_file: Path        # the run.json path
    base_prompt: str
    resolution_text: str       # issue context text
    run_context_pack_file: Optional[str]
    max_execution_attempts: int
    agent_timeout: int = 1800
    failed_verification_attempts: int = 0
    context_retrieval: Dict[str, Any] = field(default_factory=dict)
    phase_commands: Dict[str, str] = field(default_factory=dict)
    budget_usd: float = 0.0
    # Budget-source visibility (#1269 follow-up / #1274 / #1275, 2026-07-18):
    # which tier actually set budget_usd above — "flag" (explicit
    # --budget-usd), "config" (budgets.per_issue_usd), "default" (neither said
    # anything, so the flat DEFAULT_PER_ISSUE_BUDGET_USD estimate-absent
    # backstop applied — see budget_leash.py), or "brief" (the self-hosted
    # runner relayed a claimed WorkItem's estimated_budget_usd — an alignment
    # brief the user already confirmed priced this issue). Computed by
    # `agentrail.cli.commands.run.effective_budget_source` and threaded
    # through unchanged. Consulted ONLY where the budget-stop message is
    # built below, to decide how this run's stop reads: a deliberate ceiling
    # (flag/config: unembellished phrasing, unchanged), the resumable
    # estimate-absent check-in (default: resume guidance appended), or the
    # confirmed-estimate ceiling (brief: names the brief, not a bare number).
    # Defaults to "default" — the honest, conservative assumption for any
    # direct `RunContext(...)` construction (tests) that never sets this.
    budget_source: str = "default"
    # Independent Review visibility (#1270): the status token computed by
    # `agentrail.cli.commands.run.independent_review_status` and threaded
    # through unchanged, so `finalize_objective_gate` can record WHY the
    # verify/critic seat did or didn't run. "active" (the default) keeps
    # direct `RunContext(...)` construction in existing tests byte-identical.
    independent_review_status: str = "active"
    cumulative_cost_usd: float = 0.0
    # #1269: sticky, run-scoped signal set (once) by the per-phase Budget
    # Leash check inside run_issue_phase's cost-capture block, the moment
    # cumulative_cost_usd crosses budget_usd. Every phase-gating "if status ==
    # 0" check in _run_pipeline below already stops on its own once this
    # trips, because the tripping call's OWN returned status is forced
    # non-zero (see run_issue_phase) — these two fields exist for the ONE
    # call site that treats a non-zero phase status as advisory-only (the
    # gather phase, #1049) and needs to tell "budget stop" apart from
    # "gather itself just failed", and for surfacing the reason in run
    # metadata at finalize.
    #
    # budget_exceeded means "the breach IS the stop cause": set ONLY when the
    # phase itself succeeded on its own (status == 0 at the moment the Budget
    # Leash tripped) — this is what 17c's generic failure-push guard and the
    # phase-level budgetExceeded marker (write_phase_budget_marker) key off.
    # budget_ceiling_crossed is the broader, review-finding fact (double-
    # classification fix): the ceiling was ALSO crossed even when the phase
    # already failed for its own reason (e.g. a timeout) — that phase's own
    # failure remains the reported cause (the generic push fires with its own
    # evidence, unsuppressed), but the ceiling-crossed fact still gets
    # recorded in run.json's metadata at finalize, and it still counts as
    # "handled" for the sticky once-only guard below.
    budget_exceeded: bool = False
    budget_ceiling_crossed: bool = False
    budget_stop_reason: str = ""
    # #1049: deterministic context manifest captured ONCE from the gather
    # phase's output artifact and injected VERBATIM into every later phase's
    # shared task context (one set of bytes = one shared cache key). "" = no
    # manifest → phase prompts stay byte-identical to pre-#1049 output.
    gather_manifest: str = ""
    # Langfuse per-run tracer (Task 3, langfuse-tracing-shadow-judge PRD).
    # Defaults to an INERT RunTracer (client=None) rather than None, so every
    # call site can invoke rc.tracer.* unconditionally with no `if` — inert
    # methods are no-ops by construction (see RunTracer._safe_emit). This also
    # keeps direct RunContext(...) construction in existing tests (which never
    # pass tracer=) safe: rc.tracer is never None, so run_issue_phase's cost
    # block never hits an AttributeError even without _run_pipeline's real
    # RunTracer.start() wiring.
    tracer: RunTracer = field(default_factory=lambda: RunTracer(None, "", "", {}))


# Independent Review visibility (#1270): reason tokens produced by
# `agentrail.cli.commands.run.independent_review_status`, each mapped to a
# human-readable reason + the exact config that restores the seat. Kept as
# plain string literals (not a shared import) — pipeline.py must not import
# the cli layer (cli/commands/run.py imports FROM pipeline.py at module scope,
# so the reverse import would be circular); the token spellings are pinned by
# tests on both sides instead.
_INDEPENDENT_REVIEW_REASONS: Dict[str, "tuple[str, str]"] = {
    "skipped_explicit_command": (
        "an explicit --command was passed, so no phase commands (verify "
        "included) were built",
        "drop --command, or configure runners.<agent>.models.verify and let "
        "AgentRail build the agent command",
    ),
    "skipped_layer_off": (
        "the VERIFY_GATE layer is turned off for this run",
        "unset AGENTRAIL_EVAL_LAYER_VERIFY_GATE (or clear layers.verify_gate "
        "in .agentrail/layer-overrides.json)",
    ),
    "skipped_no_distinct_model": (
        "no model configured differs from the Implementer's",
        "set runners.<agent>.models.verify in .agentrail/config.json to a "
        "model different from the Implementer's",
    ),
}


def _independent_review_reason(agent: str, status: str) -> "tuple[str, str]":
    reason, fix = _INDEPENDENT_REVIEW_REASONS.get(
        status,
        ("the Independent Verifier is not configured",
         "set runners.<agent>.models.verify in .agentrail/config.json"),
    )
    return reason, fix.replace("<agent>", agent)


def independent_review_metadata_value(status: str) -> str:
    """Map an ``independent_review_status`` token to its run.json value.

    ``"active"`` passes through unchanged; any ``skipped_<reason>`` token
    becomes ``"skipped:<reason>"`` (#1270 AC1/AC2 evidence format) — the same
    field records a real verdict for hosted runs (always "active"; a hosted
    run can only reach finalization when the seat is active, see the startup
    assert in ``_run_pipeline``) and the skip reason for local runs.
    """
    if status == "active":
        return status
    prefix = "skipped_"
    if status.startswith(prefix):
        return "skipped:" + status[len(prefix):]
    return status


def _independent_review_fatal_message(agent: str, status: str) -> str:
    reason, fix = _independent_review_reason(agent, status)
    bar = "=" * 78
    return (
        f"\n{bar}\n"
        "FATAL: hosted run refused — no Independent Reviewer configured\n"
        f"  reason: {reason}\n"
        f"  fix:    {fix}\n"
        "  a hosted run may never proceed without the independent review "
        "seat (#1270).\n"
        f"{bar}\n"
    )


def _independent_review_warning(agent: str, status: str) -> str:
    reason, fix = _independent_review_reason(agent, status)
    bar = "!" * 78
    return (
        f"\n{bar}\n"
        "WARNING: independent review is OFF for this run\n"
        f"  reason: {reason}\n"
        f"  fix:    {fix}\n"
        "  the executor's own test results are the ONLY signal on this run "
        "(#1270).\n"
        f"{bar}\n"
    )


def finalize_objective_gate(
    metadata_file: Path,
    *,
    gate_result: GateResult,
    review_advisory: Optional[Dict[str, Any]] = None,
    independent_review_status: str = "active",
) -> Dict[str, Any]:
    """Mark a run done from the Objective Gate and record review as advisory.

    Thin orchestration around the deep, pure ``objective_gate.evaluate`` (ADR
    0007): a run is "done" if and only if the gate is GREEN. The LLM reviewer's
    output is stored as **advisory** (``role: "advisory"``) and never changes
    done-ness — a clean review cannot turn a red gate green, and a blocking
    review cannot turn a green gate red. The gate verdict + full evidence trail
    are persisted to the run metadata so the run surface can show *why* (AC3
    data side; the console UI is a separate follow-up).

    Returns a small outcome dict (``done`` + the persisted gate verdict) for the
    caller; the source of truth is what is written to ``metadata_file``.
    """
    data = read_json(metadata_file) if metadata_file.exists() else {}

    gate_payload = gate_result.to_dict()
    data["objectiveGate"] = gate_payload

    # Review is advisory only — recorded for the run surface, never gating.
    if review_advisory is not None:
        data["review"] = {"role": "advisory", "findings": review_advisory}

    # Independent Review visibility (#1270 AC1/AC2): every run's record shows
    # whether the verify/critic seat ran, and why not when it didn't.
    data["independentReview"] = independent_review_metadata_value(independent_review_status)

    write_json(metadata_file, data)

    return {"done": gate_result.is_green, "objectiveGate": gate_payload}


def _record_live_context_metrics(
    *,
    metadata_file: Path,
    target_dir: Path,
    run_id: str,
    agent: str,
    run_context_pack_file: Optional[str],
) -> None:
    """Compute + persist + push read-grounded live context metrics (#1037).

    Wires the pure :func:`compute_live_context_metrics` into the run at
    finalization:

      1. ``included`` — the ACTUAL selected pack items (precision denominator is
         these items' tokens, not a fixed budget).
      2. ``reads_coverage`` — the per-phase read harvest (#1028) already written
         to ``run.json`` under ``readsCoverage``; ``status="n/a"`` for engines
         with no transcript vehicle (cursor/hermes) → precision/waste/miss n/a,
         NEVER a measured zero (AC3).
      3. classified diff — pre-existing modified files (recall denominator) vs
         created files (excluded); a no-diff run yields a coverage count and NO
         recall value, never recall=0 (AC2).

    The result is written to ``run.json`` under ``liveContextMetrics`` (AC1) and
    re-pushed on the #1027 pack channel with the engine tag + waste/miss items
    (AC4). Callers wrap this in a non-fatal guard; it also degrades internally so
    a partial failure still records what it can.
    """
    from agentrail.context.live_metrics import compute_live_context_metrics
    from agentrail.guardrails.adapters.git import collect_classified_changes

    included = read_pack_included(target_dir, run_context_pack_file)

    reads_coverage = None
    if metadata_file.exists():
        existing = read_json(metadata_file)
        if isinstance(existing, dict):
            candidate = existing.get("readsCoverage")
            if isinstance(candidate, dict):
                reads_coverage = candidate

    try:
        modified_preexisting, created_files = collect_classified_changes(target_dir)
    except Exception:  # noqa: BLE001 — recall degrades to a coverage count
        modified_preexisting, created_files = [], []

    metrics = compute_live_context_metrics(
        included=included,
        reads_coverage=reads_coverage,
        modified_preexisting=modified_preexisting,
        created_files=created_files,
        engine_fallback=agent,
    )

    # Persist to run.json (AC1) — read-modify-write, mirroring
    # record_reads_into_run_json; never clobbers other keys.
    if metadata_file.exists():
        data = read_json(metadata_file)
        if not isinstance(data, dict):
            data = {}
    else:
        data = {}
    data["liveContextMetrics"] = metrics
    write_json(metadata_file, data)

    # Re-push on the #1027 channel so the dashboard shows the engine tag +
    # read-grounded precision/recall + drillable waste/miss (AC4). Non-fatal.
    push_live_context_metrics(
        target_dir, run_id, metrics, pack_file=run_context_pack_file
    )


# Budget-source visibility (#1269 follow-up / #1274 / #1275, 2026-07-18):
# appended to the budget-stop message ONLY when rc.budget_source == "default"
# — i.e. neither an explicit --budget-usd/--budget-per-issue flag NOR a
# configured budgets.per_issue_usd set the ceiling, so DEFAULT_PER_ISSUE_
# BUDGET_USD (budget_leash.py) is an estimate-absent BACKSTOP, not a
# deliberate limit. A flag/config ceiling is a real choice someone made —
# those stop messages keep their original, unembellished phrasing. This one
# is a resumable check-in, never a hard kill: say so, and say how to resume.
_BUDGET_DEFAULT_SOURCE_GUIDANCE = (
    "this run hit the estimate-absent backstop, not a hard limit — it can "
    "resume with a real budget: re-run with --budget-usd <n>, set "
    "budgets.per_issue_usd, or let the alignment brief estimate it "
    "(#1274/#1275)"
)

# Budget-source visibility, "brief" case (#1274/#1275): appended ONLY when
# rc.budget_source == "brief" — the self-hosted runner relayed a claimed
# WorkItem's estimated_budget_usd, i.e. an alignment brief the user already
# confirmed priced this issue (owner rule: "confirming the brief = sanctioning
# the ceiling"). Unlike the "default" backstop above, this ceiling was NOT a
# gap nobody filled — it is exactly the number the user signed off on, so the
# honest resume story is different: raising it means re-confirming a REVISED
# brief, not just picking a bigger number off the top of your head.
_BUDGET_BRIEF_SOURCE_GUIDANCE = (
    "this ceiling is the estimate you confirmed in the alignment brief, not "
    "an arbitrary limit — resuming with more budget means re-confirming a "
    "revised brief (#1274/#1275), not just a bigger --budget-usd"
)


def run_issue_phase(rc: RunContext, phase: str, execution_attempt: int,
                    verifier_findings_file: str = "", plan_output: str = "") -> tuple[int, str]:
    """Execute one phase (plan|execute). Returns (exit_status, plan_output).
    plan_output is the captured plan agent output when phase=='plan' and it
    succeeded (else the passed-in plan_output unchanged). Port of legacy
    run_issue_phase (scripts/agentrail-legacy:6445-6515)."""

    # 1. Determine phase directory name
    phase_dir_name = phase
    if phase != "plan" and execution_attempt > 1:
        phase_dir_name = f"{phase}-{execution_attempt}"

    # 2. Create phase directory
    phase_dir = rc.run_dir / phase_dir_name
    phase_dir.mkdir(parents=True, exist_ok=True)

    # 3. Paths
    phase_prompt_file = phase_dir / "prompt.md"
    phase_output_file = phase_dir / "output.md"
    phase_status_file = phase_dir / "status.json"
    phase_metadata_file = phase_dir / "metadata.json"

    # 4. Phase started timestamp
    phase_started_at = _utc_now_iso()

    # 5. Context pack selection
    # CONTEXT layer (eval ablation): when OFF, do NOT build/inject a context pack
    # — the agent gets the bare prompt (empty summary, no pack). ABSENT/"1" = ON =
    # today's behavior (the real loop never sets the flag, so this is unchanged).
    if not layer_enabled("CONTEXT"):
        phase_context_pack_file = None
        phase_context_summary = ""
    else:
        if phase == "gather":
            # JIT gather (#1049): the gather phase always builds a FRESH,
            # run-pinned pack — never reuses the run-level pack. Passing
            # ``run_id`` pins the pack_id/artifact path to this run (#1084),
            # which is what makes the gather handoff deterministic. This
            # branch must stay ABOVE the generic non-plan reuse branch below,
            # which would otherwise swallow gather and drop the run pin.
            phase_context_pack_file = ctx.build_issue_context_pack(
                rc.target_dir, rc.issue, phase, run_id=rc.run_id
            )
        elif phase == "plan" and rc.run_context_pack_file:
            phase_context_pack_file = rc.run_context_pack_file
        elif (phase != "plan" and rc.run_context_pack_file
              and (rc.target_dir / rc.run_context_pack_file).is_file()):
            phase_context_pack_file = rc.run_context_pack_file
        else:
            phase_context_pack_file = ctx.build_issue_context_pack(rc.target_dir, rc.issue, phase)

        # 6. Context summary
        phase_context_summary = ctx.context_pack_summary(rc.target_dir, phase_context_pack_file)

    # 6b. Forced-context injection (Finding 2, flag-gated DEFAULT OFF). Emit a
    # per-engine artifact (claude UserPromptSubmit hook / codex AGENTS.md /
    # cursor .mdc rule) that re-asserts the SAME retrieved context every turn,
    # reusing phase_context_summary verbatim (no recompute). The stdin prompt
    # injection below is unchanged and remains the universal fallback; this is
    # strictly additive and only fires when runners.forcedContext is enabled.
    if forced_context_enabled(rc.target_dir):
        emit_forced_context(rc.agent, rc.target_dir, phase_context_summary)
    else:
        # Flag flipped OFF after a prior emit: actively remove the per-engine
        # artifacts, otherwise the claude hook keeps force-injecting a stale
        # context every turn (emit alone is a no-op when disabled).
        remove_forced_context(rc.target_dir)

    # 7. Verifier findings text
    if verifier_findings_file and Path(verifier_findings_file).is_file():
        verifier_findings_text = prompts.bounded_phase_text(
            Path(verifier_findings_file).read_text(), "verifier findings"
        )
    else:
        verifier_findings_text = ""

    # 8. Build phase prompt. When the run opts into the Red-Green Proof (ADR
    # 0008), the role split is active: the test-author phase authors the failing
    # acceptance test and the execute prompt carries the Implementer boundary so
    # the implementer never authors its own acceptance test (AC3).
    # WARMCACHE layer (#978): when ON, hoist the shared per-task context (issue
    # context + context pack + base instructions) to a stable, cacheable LEADING
    # prefix so later phases (execute, verify) hit the agent's prompt-prefix
    # cache instead of re-sending the same context cold (AC1/AC2). Roles stay
    # separate — only the shared context prefix moves (AC3). ABSENT/"1" = ON =
    # today's behavior; "0" = OFF = byte-identical cold per-phase prompt (AC4).
    phase_prompt = prompts.issue_run_phase_prompt(
        phase, rc.issue,
        issue_context=rc.resolution_text,
        base_prompt=rc.base_prompt,
        context_summary=phase_context_summary,
        plan_output=plan_output,
        verifier_findings_text=verifier_findings_text,
        execution_attempt=execution_attempt,
        max_execution_attempts=rc.max_execution_attempts,
        red_green=red_green_proof_required(rc.target_dir),
        warm_cache=layer_enabled("WARMCACHE"),
        # #1049: same captured manifest bytes for every phase of this run
        # ("" until the gather phase succeeds → no prompt change).
        gather_manifest=rc.gather_manifest,
    )

    # 9. Write prompt file
    phase_prompt_file.write_text(phase_prompt)

    # 10. Phase command string (metadata only) — the EFFECTIVE command for
    # this phase (incl. model override), not the base agent_command, so
    # artifacts record what actually ran.
    phase_command = rc.phase_commands.get(phase, rc.agent_command)

    # 11. Write initial phase status
    artifacts.write_phase_status(
        phase_status_file,
        phase=phase,
        status="running",
        started_at=phase_started_at,
        finished_at=None,
        exit_status=0,
        metadata_file=str(phase_metadata_file),
        output_file=str(phase_output_file),
        execution_attempt=execution_attempt,
        max_execution_attempts=rc.max_execution_attempts,
        verifier_findings_file=verifier_findings_file,
    )

    # 12. Write initial phase metadata
    artifacts.write_phase_metadata(
        phase_metadata_file,
        phase=phase,
        started_at=phase_started_at,
        finished_at=None,
        status="running",
        exit_status=0,
        issue=rc.issue,
        agent=rc.agent,
        command=phase_command,
        prompt_file=str(phase_prompt_file),
        context_pack_file=phase_context_pack_file,
        output_file=str(phase_output_file),
        status_file=str(phase_status_file),
        run_id=rc.run_id,
        run_dir=str(rc.run_dir),
        execution_attempt=execution_attempt,
        max_execution_attempts=rc.max_execution_attempts,
        verifier_findings_file=verifier_findings_file,
    )

    # 13. Update run state
    state_mod.update_run_state(
        rc.target_dir, "start",
        run_id=rc.run_id,
        issue=rc.issue,
        agent=rc.agent,
        phase=phase,
        picked_at=rc.started_at,
        finished_at="",
        exit_status=0,
        prompt_file=str(phase_prompt_file),
        metadata_file=str(rc.metadata_file),
        run_dir=str(rc.run_dir),
        execution_attempt=execution_attempt,
        max_execution_attempts=rc.max_execution_attempts,
        failed_verification_attempts=rc.failed_verification_attempts,
        verifier_findings_file=verifier_findings_file,
        blocked_reason="",
        issue_context=rc.resolution_text,
        context_pack_file=phase_context_pack_file or "",
    )

    # 14. Print phase info
    print(f"phase: {phase}")
    if phase != "plan":
        print(f"execution attempt: {execution_attempt}/{rc.max_execution_attempts}")
    print(f"phase prompt: {phase_prompt_file}")
    print(f"phase output: {phase_output_file}")
    print(f"phase metadata: {phase_metadata_file}")

    # 15. Agent timeout
    # The execute phase preserves the RALPH_AGENT_TIMEOUT precedence:
    # RALPH_AGENT_TIMEOUT wins over AGENTRAIL_AGENT_TIMEOUT so anyone who set
    # the user-facing alias is not silently changed.
    if phase == "execute":
        timeout_value = (
            os.environ.get("RALPH_AGENT_TIMEOUT")
            or os.environ.get("AGENTRAIL_AGENT_TIMEOUT")
            or str(rc.agent_timeout)
        )
    else:
        timeout_value = (
            os.environ.get("AGENTRAIL_AGENT_TIMEOUT") or str(rc.agent_timeout)
        )
    agent_timeout = int(timeout_value or rc.agent_timeout)

    # 16. Execute
    # Both plan and execute run natively: a single bounded agent invocation
    # (bash -lc <agent_command>) with the phase prompt on stdin.
    # Per-phase command override (e.g. model-specific command) wins when set.
    effective_command = rc.phase_commands.get(phase, rc.agent_command)
    phase_start_ts = time.time()
    status = run_with_timeout(
        ["bash", "-lc", effective_command],
        cwd=rc.target_dir,
        timeout=agent_timeout,
        output_file=phase_output_file,
        stdin_text=phase_prompt,
    )

    if status == 124:
        print(f"agent timed out after {agent_timeout}s in {phase} phase", file=sys.stderr)

    # 17. Phase finished timestamp
    phase_finished_at = _utc_now_iso()

    # 17a. Cost capture — non-fatal
    # #1269 review: True only when THIS call trips a clean-phase budget stop
    # (below) — set BEFORE step 18 rewrites status.json wholesale (not a
    # merge), so the write_phase_budget_marker call after step 18 knows
    # whether to fire without re-deriving it from rc's now-possibly-stale
    # sticky flags.
    budget_marker_pending = False
    try:
        usage = capture_usage(rc.agent, rc.target_dir, phase_start_ts)
        if usage:
            cost = cost_usd(usage)
            # Cost accounting FIRST — the budget guardrail depends on this, so it
            # must never be skipped by a later ledger/push failure.
            rc.cumulative_cost_usd += cost

            # Budget Leash (#1269): the hard per-issue spend backstop, evaluated
            # right after EVERY phase's cost is known — not just once after
            # test-author (the old single checkpoint this replaces) — so a
            # breach mid-run stops the run at THIS phase; no later phase
            # (verify, critic, another best-of-n candidate, ...) ever starts.
            # attempts/attempt_limit are inert placeholders: this call site has
            # no escalation-attempt counter to feed the leash (that concept
            # belongs to the heartbeat dispatcher's own tiered escalation, a
            # separate consumer), so attempts is fixed at 0 against the
            # smallest valid attempt_limit (1) — that combination can never
            # itself satisfy `attempts >= attempt_limit`, so only ceiling vs.
            # spent can trip STOP_TO_HUMAN here.
            if (not rc.budget_exceeded and not rc.budget_ceiling_crossed
                    and budget_leash.check(
                        spent=rc.cumulative_cost_usd,
                        attempts=0,
                        ceiling=rc.budget_usd,
                        attempt_limit=1,
                        gate_red=False,
                    ) is budget_leash.Decision.STOP_TO_HUMAN):
                budget_msg = (f"${rc.cumulative_cost_usd:.2f} spent of "
                              f"${rc.budget_usd:.2f} budget")
                # Double-classification review fix: the ceiling is crossed
                # either way, so that FACT is always recorded (below, and in
                # run.json's metadata at finalize). But it is only THE stop
                # cause — budget_exceeded, the phase-level budgetExceeded
                # marker, and the dedicated budget_exceeded failure push —
                # when the phase succeeded on its own (status == 0 right now,
                # before any forcing). When the phase already failed for its
                # own reason (e.g. a timeout, status == 124), that failure is
                # the evidence-bearing signal: leave it to the generic 17c
                # failure push (which reads the phase's real output as
                # evidence) instead of masking it behind this generic
                # dollar-figure message.
                rc.budget_ceiling_crossed = True
                if status == 0:
                    rc.budget_exceeded = True
                    rc.budget_stop_reason = (
                        f"budget exceeded after {phase} phase: {budget_msg}"
                    )
                    # Budget-source visibility: the estimate-absent backstop
                    # and the confirmed-brief ceiling each get their OWN
                    # resume guidance appended — a flag or config ceiling was
                    # a deliberate choice made some other way, so those keep
                    # the plain message above unchanged.
                    if rc.budget_source == "default":
                        rc.budget_stop_reason += (
                            f"; {_BUDGET_DEFAULT_SOURCE_GUIDANCE}"
                        )
                    elif rc.budget_source == "brief":
                        rc.budget_stop_reason += (
                            f"; {_BUDGET_BRIEF_SOURCE_GUIDANCE}"
                        )
                    print(rc.budget_stop_reason, file=sys.stderr)
                    budget_marker_pending = True
                    try:
                        # Push the SAME source-aware string run.json's
                        # blockedReason gets (rc.budget_stop_reason, above) —
                        # not the plain dollar-figure budget_msg — so a
                        # server-side reader (or AFK's own _fail, which reads
                        # this run's run.json) sees the check-in framing and
                        # resume guidance too, not just "budget_exceeded".
                        # failure_type stays "budget_exceeded" unconditionally
                        # — only the message changes.
                        push_failure_event(
                            rc.target_dir, rc.run_id, "budget_exceeded", phase,
                            rc.budget_stop_reason,
                        )
                    except Exception as _exc:
                        _log.debug("budget failure push skipped: %s", _exc)
                    status = 1
                else:
                    _log.debug(
                        "budget ceiling crossed after %s phase but phase status "
                        "was already %s on its own: %s", phase, status, budget_msg,
                    )

            # Which price tier resolved this cost (#1337 PR ②) — computed HERE,
            # after the budget guardrail block above, precisely so it can never
            # perturb the cost accounting / budget leash the run depends on. It
            # is a ledger concern only (threaded into the durable cost-events
            # record below so AC1 auditability holds), and resolve_price_source
            # is non-fatal (returns None rather than raising), matching the
            # non-fatal design of this whole telemetry block.
            price_source = resolve_price_source(usage.model)
            push_cost_event(rc.target_dir, rc.run_id, phase, usage, cost, price_source)
            # Local append-only ledger for `agentrail context savings` — isolated
            # in its own try/except so a write failure cannot disable the cost
            # accounting above (which would silently defeat the budget guardrail).
            try:
                record = build_cost_record(rc.run_id, phase, usage, cost, price_source)
                ledger = rc.target_dir / ".agentrail" / "run" / "cost-events.jsonl"
                ledger.parent.mkdir(parents=True, exist_ok=True)
                with ledger.open("a", encoding="utf-8") as _f:
                    _f.write(json.dumps(record) + "\n")
            except Exception as _exc:
                _log.debug("cost ledger write skipped: %s", _exc)
            # Langfuse generation-per-phase-cost-capture (Task 3) — isolated in
            # its own try/except, same as the ledger write above, so a tracing
            # failure can never disable (or reorder) the cost accounting above
            # it, which the budget guardrail depends on. usage is a Usage
            # dataclass (model, input_tokens, output_tokens, cache_tokens,
            # cache_creation_tokens); dataclasses.asdict maps those field names
            # 1:1 into usageDetails, matching RunTracer.phase_generation's
            # `usage: dict` contract. cost_breakdown(usage) gives the flat
            # category→USD dict RunTracer folds into costDetails. usage.model
            # (the model actually observed in the transcript this phase) is
            # passed as the generation's model — NOT rc.model, which does not
            # exist on RunContext.
            try:
                rc.tracer.phase_generation(
                    phase,
                    dataclasses.asdict(usage),
                    cost,
                    cost_breakdown(usage),
                    phase_start_ts,
                    usage.model or None,
                )
            except Exception as _exc:
                _log.debug("langfuse phase trace skipped: %s", _exc)
    except Exception as _exc:
        _log.debug("cost capture skipped: %s", _exc)

    # 17a-reads. Read harvest (transcript-scrape, no runner instrumentation) — non-fatal.
    # Harvest the executor's mid-run file reads from the on-disk transcript into
    # run.json BEFORE the workdir is torn down. capture_reads never raises and
    # reports n/a (never a silent zero) for engines with no transcript vehicle.
    try:
        coverage = capture_reads(rc.agent, rc.target_dir, phase_start_ts)
        record_reads_into_run_json(rc.metadata_file, coverage)
    except Exception as _exc:
        _log.debug("read harvest skipped: %s", _exc)

    # 17b. Agent activity telemetry — non-fatal
    try:
        push_agent_activity(rc.target_dir, rc.run_id, phase, rc.agent, phase_start_ts)
    except Exception as _exc:
        _log.debug("agent activity push skipped: %s", _exc)

    # 17c. Output format enforcement — non-fatal, observational.
    # Inspect the execute-phase output file for diff/patch evidence.  A full-file
    # rewrite of an existing file is flagged as a run event so the dashboard can
    # surface format violations without blocking the pipeline exit status.
    # GUARDRAILS layer (eval ablation): the output-format enforcer is the live
    # guardrail that runs DURING the run. When the layer is OFF, skip enforcement
    # entirely (no inspection, no rejection event). ABSENT/"1" = ON = today's
    # behavior (the real loop never sets the flag, so this is unchanged).
    if phase == "execute" and phase_output_file.exists() and layer_enabled("GUARDRAILS"):
        try:
            phase_output_text = phase_output_file.read_text(encoding="utf-8", errors="replace")
            # Drive is_new_or_rename from the real worktree state: a phase that only
            # adds new files (no existing-file edit) must not be a false-positive
            # rejection (AC3). Falls back to enforcing when git status is unavailable.
            try:
                porcelain = subprocess.run(
                    ["git", "status", "--porcelain"],
                    cwd=rc.target_dir, capture_output=True, text=True, timeout=10,
                ).stdout
            except Exception:
                porcelain = ""
            # enforce() also consults its own DEFAULT-OFF strict flag
            # (AGENTRAIL_EVAL_LAYER_DIFF_ONLY_STRICT): when on, a full-file
            # rewrite disguised as a diff (token hunk + full body) is also
            # Rejected and surfaced below. Off → today's loose behavior.
            enforce_result = enforce(
                phase_output_text,
                is_new_or_rename=all_changes_new_or_rename(porcelain),
            )
            if isinstance(enforce_result, Rejected):
                push_format_rejection_event(
                    rc.target_dir,
                    rc.run_id,
                    phase,
                    enforce_result.reason,
                    output_file=str(phase_output_file),
                )
        except Exception as _exc:
            _log.debug("output format enforcement skipped: %s", _exc)

    # 17d. Context pack telemetry — non-fatal. The persisted pack JSON is the
    # source of truth for tokens + all quality proxies; context_retrieval
    # (search runMetadata) is only a fallback when no pack was persisted.
    # Passing the pack path also lets unlinked (eval/canary) runs emit a
    # run-identifying pack-metadata record locally.
    try:
        push_context_pack(
            rc.target_dir,
            rc.run_id,
            rc.context_retrieval,
            pack_file=rc.run_context_pack_file,
        )
    except Exception as _exc:
        _log.debug("context pack push skipped: %s", _exc)

    # 17d. Index snapshot telemetry — non-fatal. Keeps the dashboard repos
    # health view fresh on every run instead of only after a manual
    # `agentrail context index`. build_index already ran incrementally during
    # context-pack retrieval, so this is a cache-hit read plus one POST.
    # First-phase only: once per run is enough. With the plan phase removed
    # (MVP), the run's first phase is now ``test-author`` (or ``execute`` when
    # the spine is explicitly disabled).
    if phase in ("test-author", "plan"):
        try:
            from agentrail.context.index import build_index
            from agentrail.context.snapshot_push import push_index_snapshot

            push_index_snapshot(rc.target_dir, build_index(rc.target_dir))
        except Exception as _exc:
            _log.debug("index snapshot push skipped: %s", _exc)

    # 17c. Failure telemetry — non-fatal
    # #1269: skip this GENERIC failure push when the Budget Leash (just above)
    # already forced `status` non-zero — it already pushed its OWN specific
    # "budget_exceeded" event for this phase, and this phase's own agent
    # invocation may well have succeeded (the budget, not the agent, is why
    # the run is stopping). Without this guard every budget-triggered stop
    # would ALSO get a second, misleading "phase_failure" event for the same
    # phase.
    if status != 0 and not rc.budget_exceeded:
        try:
            failure_type = "timeout" if status == 124 else "phase_failure"
            # Attach the phase's captured output as evidence. push_failure_event
            # tails, secret-scrubs and byte-caps it before send, so passing the
            # whole file is safe.
            evidence = ""
            try:
                if phase_output_file.exists():
                    evidence = phase_output_file.read_text(encoding="utf-8", errors="replace")
            except Exception:  # noqa: BLE001 — evidence is best-effort
                evidence = ""
            push_failure_event(rc.target_dir, rc.run_id, failure_type, phase,
                               f"{phase} phase exited with status {status}",
                               evidence=evidence)
        except Exception as _exc:
            _log.debug("failure push skipped: %s", _exc)

    # 18. Update artifacts based on success/failure
    if status == 0:
        artifacts.write_phase_status(
            phase_status_file,
            phase=phase,
            status="completed",
            started_at=phase_started_at,
            finished_at=phase_finished_at,
            exit_status=status,
            metadata_file=str(phase_metadata_file),
            output_file=str(phase_output_file),
            execution_attempt=execution_attempt,
            max_execution_attempts=rc.max_execution_attempts,
            verifier_findings_file=verifier_findings_file,
        )
        artifacts.write_phase_metadata(
            phase_metadata_file,
            phase=phase,
            started_at=phase_started_at,
            finished_at=phase_finished_at,
            status="completed",
            exit_status=status,
            issue=rc.issue,
            agent=rc.agent,
            command=phase_command,
            prompt_file=str(phase_prompt_file),
            context_pack_file=phase_context_pack_file,
            output_file=str(phase_output_file),
            status_file=str(phase_status_file),
            run_id=rc.run_id,
            run_dir=str(rc.run_dir),
            execution_attempt=execution_attempt,
            max_execution_attempts=rc.max_execution_attempts,
            verifier_findings_file=verifier_findings_file,
        )
        if phase == "plan":
            plan_output = phase_output_file.read_text()
    else:
        artifacts.write_phase_status(
            phase_status_file,
            phase=phase,
            status="failed",
            started_at=phase_started_at,
            finished_at=phase_finished_at,
            exit_status=status,
            metadata_file=str(phase_metadata_file),
            output_file=str(phase_output_file),
            execution_attempt=execution_attempt,
            max_execution_attempts=rc.max_execution_attempts,
            verifier_findings_file=verifier_findings_file,
        )
        artifacts.write_phase_metadata(
            phase_metadata_file,
            phase=phase,
            started_at=phase_started_at,
            finished_at=phase_finished_at,
            status="failed",
            exit_status=status,
            issue=rc.issue,
            agent=rc.agent,
            command=phase_command,
            prompt_file=str(phase_prompt_file),
            context_pack_file=phase_context_pack_file,
            output_file=str(phase_output_file),
            status_file=str(phase_status_file),
            run_id=rc.run_id,
            run_dir=str(rc.run_dir),
            execution_attempt=execution_attempt,
            max_execution_attempts=rc.max_execution_attempts,
            verifier_findings_file=verifier_findings_file,
        )

    # 18b. Budget-stop marker (#1269 review, Fix 1): merged in AFTER step 18
    # above, which OVERWRITES (not merges) status.json — writing it any
    # earlier would just be clobbered. Reuses the write_phase_verdict (#1181)
    # merge pattern so run_record.py (and any other consumer) can tell "the
    # Budget Leash stopped this phase" apart from a genuine agent failure —
    # both otherwise land on status="failed" with no other signal.
    if budget_marker_pending:
        artifacts.write_phase_budget_marker(
            rc.run_dir, phase_dir_name,
            spent=rc.cumulative_cost_usd, ceiling=rc.budget_usd,
        )

    # 19. Return
    return (status, plan_output)


def _run_execute_with_diff_enforcement(rc: "RunContext", plan_output: str) -> int:
    """Run execute, re-running it as a diff when the output is a full-file rewrite.

    DEFAULT-OFF seam (gated by :func:`diff_only_enforce_enabled` at the call site).
    On a Rejected diff-format check it writes the reason to a findings file and
    re-runs execute (bounded by :func:`resolve_diff_only_max_attempts`), feeding the
    reason back via the existing ``verifier_findings_file`` channel so the agent
    redoes the change as a unified diff. After the cap, it FALLS BACK to today's
    behavior: it returns the last execute status and lets the Objective Gate decide
    done-ness (never hard-fails a run that would pass today). Telemetry (section
    17c inside run_issue_phase) still fires per attempt, unchanged.
    """
    max_attempts = resolve_diff_only_max_attempts()
    findings_file = ""
    status = 0
    for attempt in range(1, max_attempts + 1):
        status, _ = run_issue_phase(
            rc, "execute", attempt,
            verifier_findings_file=findings_file, plan_output=plan_output,
        )
        if status != 0:
            return status  # execute itself failed; let the normal path handle it
        if _candidate_test_passed(rc):
            return status
        phase_dir = rc.run_dir / ("execute" if attempt == 1 else f"execute-{attempt}")
        phase_output_file = phase_dir / "output.md"
        if not phase_output_file.exists():
            return status
        try:
            content = phase_output_file.read_text(encoding="utf-8", errors="replace")
            try:
                porcelain = subprocess.run(
                    ["git", "status", "--porcelain"],
                    cwd=rc.target_dir, capture_output=True, text=True, timeout=10,
                ).stdout
            except Exception:
                porcelain = ""
            result = enforce(content, is_new_or_rename=all_changes_new_or_rename(porcelain))
        except Exception as _exc:  # never let enforcement break a run
            _log.debug("diff-only enforcement skipped: %s", _exc)
            return status
        step = plan_enforcement_step(result, attempt=attempt, max_attempts=max_attempts)
        if not step.retry:
            return status
        findings_path = phase_dir / "diff_enforcement.md"
        try:
            findings_path.write_text(
                "# Output format rejected — redo as a unified diff\n\n"
                "Your previous output rewrote a whole existing file. Emit ONLY the "
                "changed hunks as a unified diff/patch (@@ ... @@), not the full file.\n\n"
                f"Reason: {step.findings}\n",
                encoding="utf-8",
            )
            findings_file = str(findings_path)
        except Exception as _exc:
            _log.debug("diff-only findings write failed: %s", _exc)
            return status
    return status


def _capture_candidate_diff(rc: RunContext, attempt: int) -> None:
    """Persist the working-tree diff of one best-of-N candidate (issue #979).

    Best-effort and non-fatal: the Critic phase scores the live working tree
    itself, so this snapshot is for the run record / dashboard only — a capture
    failure must never break the loop. The diff is written under the per-attempt
    execute phase dir so each candidate's change is recoverable.
    """
    try:
        from agentrail.guardrails.adapters.git import collect_diff

        diff = collect_diff(rc.target_dir)
        phase_dir_name = "execute" if attempt <= 1 else f"execute-{attempt}"
        diff_file = rc.run_dir / phase_dir_name / "candidate.diff"
        diff_file.parent.mkdir(parents=True, exist_ok=True)
        diff_file.write_text(diff, encoding="utf-8")
    except Exception as _exc:  # pragma: no cover - defensive
        _log.debug("best-of-n candidate diff capture skipped: %s", _exc)


def _run_execute_best_of_n(
    rc: RunContext, plan_output: str
) -> tuple[int, Optional[Dict[str, Any]]]:
    """Best-of-N execute with critic ranking and early stop (issue #979).

    Runs the execute phase to produce a candidate, scores that candidate with the
    independent Critic (#977), and:

    - ACCEPT → STOP EARLY: carry this candidate forward (fewer than N generated).
    - REJECT → try again, up to N total candidates, tracking the BEST-scoring one
      and feeding its reject reason back to the next attempt as verifier findings.

    The selected candidate's critic verdict is returned as the gate evidence
    (``critic.gate_evidence``), so the Objective Gate's accept/reject contract is
    byte-identical to the standalone critic path. Candidate generation is BOUNDED
    by N (never exceeds it, AC3) and the Critic is a SEPARATE phase from the
    executor every iteration (the maker never grades its own homework).

    Returns ``(status, verification_evidence)``. ``status`` is non-zero if an
    execute/critic phase itself failed; the gate (not this loop) decides done-ness
    from the returned evidence.
    """
    n = resolve_bestofn_n()
    best_verdict: Optional[critic_mod.CriticVerdict] = None
    best_evidence: Optional[Dict[str, Any]] = None
    findings_file = ""
    status = 0

    for attempt in range(1, n + 1):
        # 1. Produce a candidate. Reject reasons from prior candidates are fed
        # back as verifier findings so each attempt can improve on the last.
        status, _ = run_issue_phase(
            rc, "execute", attempt,
            verifier_findings_file=findings_file, plan_output=plan_output,
        )
        if status != 0:
            return status, best_evidence
        _capture_candidate_diff(rc, attempt)

        # 2. Score THIS candidate with the independent Critic (a separate phase).
        status, _ = run_issue_phase(rc, "critic", attempt, plan_output=plan_output)
        if status != 0:
            return status, best_evidence
        critic_dir = "critic" if attempt <= 1 else f"critic-{attempt}"
        critic_output_file = rc.run_dir / critic_dir / "output.md"
        critic_output = (
            critic_output_file.read_text(encoding="utf-8", errors="replace")
            if critic_output_file.exists()
            else ""
        )
        verdict = critic_mod.score_candidate(critic_output)

        # 3. Track the best-scoring candidate so far (AC2: highest score wins).
        if best_verdict is None or verdict.score > best_verdict.score:
            best_verdict = verdict
            best_evidence = critic_mod.gate_evidence(verdict)

        # 4. Early stop: a candidate that clears the confidence bar is carried
        # forward immediately — no further candidates are generated (AC2).
        if verdict.accepted:
            break

        # 5. Rejected: carry the critic's reason into the next candidate.
        findings_file = str(critic_output_file)

    return status, best_evidence


def _candidate_test_passed(rc: RunContext) -> bool:
    """Run the executable hidden test for the CURRENT candidate (Finding 3 PRIMARY).

    The PRIMARY best-of-N signal: did EVERY declared objective check pass for the
    candidate now in the working tree? This is the same gate
    (:func:`run_objective_checks`) the Objective Gate runs — best-of-N just runs it
    per candidate so the executable test, not the critic, decides which candidate
    wins and when to stop. Defensive: any failure to run the checks is treated as a
    NON-pass (fail-closed), so a flaky check harness can never falsely early-stop on
    an unverified candidate.
    """
    try:
        results = run_objective_checks(rc.target_dir)
    except Exception as _exc:  # pragma: no cover - defensive
        _log.debug("best-of-n per-candidate checks failed to run: %s", _exc)
        return False
    return bool(results) and all(c.passed for c in results)


def _run_execute_best_of_n_testfirst(
    rc: RunContext, plan_output: str
) -> tuple[int, Optional[Dict[str, Any]]]:
    """Best-of-N execute with TEST-PRIMARY selection + critic tiebreak (Finding 3).

    The SAFE best-of-N. Unlike :func:`_run_execute_best_of_n` (which selects by the
    critic ALONE — the research-forbidden mode that degrades as N grows), this
    variant makes the executable hidden test the PRIMARY selector:

    - PRIMARY: each candidate is executed, then the declared objective checks (the
      hidden test) are run. The FIRST candidate whose checks all pass STOPS the loop
      early — the critic's opinion is irrelevant to *whether to stop*.
    - SECONDARY: the cheap critic (#977) scores each candidate only as a tie-break.
      It can pick among several test-passing candidates, or pick the least-bad one
      when the budget forces a stop before any candidate passed — but a candidate the
      critic prefers and the TEST rejects is NEVER selected over a test-passing one.
    - BUDGET: before spawning each additional candidate, the per-issue budget cap is
      checked; the loop stops rather than blow the cap to chase one more candidate.

    The ranking/selection itself lives in the pure :mod:`agentrail.run.best_of_n`
    module (test-PRIMARY, critic-SECONDARY total order), keeping this function thin
    I/O orchestration. The selected candidate's critic verdict is returned as the
    gate evidence so the Objective Gate's accept/reject contract is unchanged; the
    gate (not this loop) still decides done-ness from the executable checks.
    """
    n = resolve_bestofn_n()
    candidates: list[bestofn.Candidate] = []
    selected_evidence: Optional[Dict[str, Any]] = None
    findings_file = ""
    status = 0
    attempts_run = 0
    budget_hit = False

    for attempt in range(1, n + 1):
        # Budget guard: never spawn an additional candidate that would push the
        # per-issue spend at/over the cap (the first attempt always runs).
        if attempt > 1 and bestofn.would_exceed_budget(
            rc.cumulative_cost_usd, rc.budget_usd
        ):
            budget_hit = True
            break

        # 1. Produce a candidate (reject reasons feed forward as verifier findings).
        status, _ = run_issue_phase(
            rc, "execute", attempt,
            verifier_findings_file=findings_file, plan_output=plan_output,
        )
        if status != 0:
            return status, selected_evidence
        _capture_candidate_diff(rc, attempt)
        attempts_run = attempt

        # 2. PRIMARY signal: run the executable hidden test for THIS candidate.
        test_passed = _candidate_test_passed(rc)

        # 3. SECONDARY signal: the independent cheap critic (a SEPARATE phase).
        status, _ = run_issue_phase(rc, "critic", attempt, plan_output=plan_output)
        if status != 0:
            return status, selected_evidence
        critic_dir = "critic" if attempt <= 1 else f"critic-{attempt}"
        critic_output_file = rc.run_dir / critic_dir / "output.md"
        critic_output = (
            critic_output_file.read_text(encoding="utf-8", errors="replace")
            if critic_output_file.exists()
            else ""
        )
        verdict = critic_mod.score_candidate(critic_output)
        candidates.append(
            bestofn.Candidate(attempt=attempt, test_passed=test_passed, critic=verdict)
        )

        # 4. Early stop on the PRIMARY signal: the FIRST test-passing candidate ends
        # the loop — never the critic's accept (that would be critic-only selection).
        if test_passed:
            break

        # 5. Test still failing: carry the critic's reason into the next candidate.
        findings_file = str(critic_output_file)

    # 6. SELECT: test-PRIMARY, critic-SECONDARY tiebreak (pure policy). A
    # test-failing candidate is NEVER selected over a test-passing one.
    selected = bestofn.select_best(candidates)

    # 7. Gate evidence — the critic is a SELECTION tiebreak, NOT a veto. When the
    # selected candidate PASSED the executable hidden test, the test (not the
    # critic) is the authority: emit non-blocking evidence so a critic that merely
    # disliked passing code can NOT red the gate (the research-forbidden critic-as-
    # selector failure mode). Only when NO candidate passed do we surface the
    # critic's verdict (its reject reason) as the gate evidence, as #979 does.
    if selected is not None and selected.test_passed:
        selected_evidence = critic_mod.gate_evidence(
            critic_mod.CriticVerdict(
                accepted=True,
                score=selected.critic_score,
                reason="best-of-n: executable test passed",
            )
        )
    elif selected is not None and selected.critic is not None:
        selected_evidence = critic_mod.gate_evidence(selected.critic)
    _log.info(
        "%s", bestofn.stop_reason(selected, attempts_run, n, budget_hit=budget_hit)
    )

    return status, selected_evidence


def run_issue(target_dir: Path, issue: int, *, agent: str, command: str,
              repo_dir: Path, log_dir: Optional[Path] = None,
              run_id: str = "",
              phase_commands: Optional[Dict[str, str]] = None,
              budget_usd: float = 0.0,
              budget_source: str = "default",
              independent_review_status: str = "active") -> int:
    """Native port of legacy run_issue (scripts/agentrail-legacy:6376-6566).
    Assumes guards (source-run, active-run conflict, command availability) were
    already done by the caller (agentrail/cli/commands/run.py:_dispatch).
    Returns the final exit status.

    Issue mode is the GitHub-issue fetch path: the ONLY thing it adds over the
    shared pipeline (:func:`_run_pipeline`) is resolving the issue text via
    ``ctx.issue_resolution_text``. Everything downstream — skills, base prompt,
    context pack, the test-author→execute→verify phase loop, and the Objective
    Gate / Red-Green / Independent Verification — is the SAME code path the
    prompt mode (:func:`run_prompt`) runs, so the real autonomous loop's
    behavior is unchanged."""

    # 1. Resolve target_dir
    target_dir = Path(target_dir).resolve()

    # 2. Issue resolution text (the issue-mode-specific GitHub fetch).
    resolution_text = ctx.issue_resolution_text(target_dir, issue)

    # 3. Run the shared pipeline off the fetched issue text. ``label`` is the
    # numeric issue id, used for paths/prompts/run-id exactly as before so issue
    # mode is byte-identical.
    return _run_pipeline(
        target_dir,
        resolution_text=resolution_text,
        label=issue,
        agent=agent,
        command=command,
        repo_dir=repo_dir,
        log_dir=log_dir,
        run_id=run_id,
        phase_commands=phase_commands,
        budget_usd=budget_usd,
        budget_source=budget_source,
        independent_review_status=independent_review_status,
        run_id_stem=f"issue-{issue}",
        context_query=f"issue #{issue}",
    )


def run_prompt(target_dir: Path, prompt: str, *, label: str, agent: str,
               command: str, repo_dir: Path, log_dir: Optional[Path] = None,
               run_id: str = "",
               phase_commands: Optional[Dict[str, str]] = None,
               budget_usd: float = 0.0,
               budget_source: str = "default",
               independent_review_status: str = "active") -> int:
    """Prompt-driven run mode (#968) — run the pipeline off a raw prompt.

    Mirrors :func:`run_issue` but injects the supplied ``prompt`` as the
    resolution text instead of fetching a GitHub issue, and uses ``label`` (a
    non-numeric string such as a corpus task name) wherever issue mode used the
    issue number as an id (run-id, prompt/path labels, metadata, state).

    It calls the SAME :func:`_run_pipeline` body, so EVERY phase
    (test-author → execute → verify) and the Objective Gate / Red-Green Proof /
    Independent Verification run EXACTLY as for an issue — no phase is skipped
    and no gate is weakened in prompt mode (the eval's whole value is measuring
    the real gate). Returns the final exit status."""
    target_dir = Path(target_dir).resolve()
    # A non-empty prompt is the contract; an empty prompt has no work to define.
    if not (prompt or "").strip():
        print("error: run prompt requires a non-empty prompt", file=sys.stderr)
        return 2
    # Sanitize the label into a filesystem-safe run-id stem (paths use it).
    safe_label = "".join(c if (c.isalnum() or c in "-_.") else "-" for c in str(label)) or "prompt"
    return _run_pipeline(
        target_dir,
        resolution_text=prompt,
        label=label,
        agent=agent,
        command=command,
        repo_dir=repo_dir,
        log_dir=log_dir,
        run_id=run_id,
        phase_commands=phase_commands,
        budget_usd=budget_usd,
        budget_source=budget_source,
        independent_review_status=independent_review_status,
        run_id_stem=f"prompt-{safe_label}",
        context_query=f"prompt {label}",
    )


def _run_pipeline(target_dir: Path, *, resolution_text: str, label,
                  agent: str, command: str, repo_dir: Path,
                  log_dir: Optional[Path] = None, run_id: str = "",
                  phase_commands: Optional[Dict[str, str]] = None,
                  budget_usd: float = 0.0,
                  budget_source: str = "default",
                  independent_review_status: str = "active",
                  run_id_stem: str = "",
                  context_query: str = "") -> int:
    """Shared run body for issue mode and prompt mode (#968).

    This is the single source of truth for the phase loop and the Objective
    Gate; ``run_issue`` and ``run_prompt`` differ ONLY in how they produce
    ``resolution_text`` and ``label`` (issue fetch vs. raw prompt). ``label`` is
    used wherever the legacy ``issue`` id appeared (run-id, prompt ``#{label}``
    framing, artifacts/state, context-pack target) and may be an ``int`` (issue
    mode, byte-identical) or a ``str`` (prompt mode).

    Assumes guards (source-run, active-run conflict, command availability) were
    already done by the caller. Returns the final exit status."""
    # 1. Resolve target_dir (idempotent — callers already resolved it).
    target_dir = Path(target_dir).resolve()
    issue = label  # kept as the local name the body below already used.

    # 3. Resolve skills (degrade gracefully on failure)
    _default_resolution = {
        "resolved": [],
        "autoSkills": True,
        "maxAutoSkills": 4,
        "unavailable": [],
        "registryPath": "",
        "targetDir": str(target_dir),
    }
    try:
        resolution = skills.resolve_skills(
            target_dir, repo_dir, resolution_text, auto_skills=True, explicit_skills=[]
        )
    except Exception as e:
        print(
            f"warning: skill resolution failed ({type(e).__name__}: {e}); "
            "proceeding without skills",
            file=sys.stderr,
        )
        resolution = _default_resolution

    # 4. Build base prompt.
    # CONTEXT layer (eval ablation): when OFF, do NOT build/inject the context
    # pack — the agent gets the bare prompt (empty summary + empty snippets, no
    # pack). ABSENT/"1" = ON = today's behavior (the real loop never sets the
    # flag, so this is byte-identical).
    if layer_enabled("CONTEXT"):
        run_context_pack_file = ctx.build_issue_context_pack(target_dir, issue, "plan")
        context_summary = ctx.context_pack_summary(target_dir, run_context_pack_file)
        context_snippets = ctx.context_selected_snippets(target_dir, resolution_text)
    else:
        run_context_pack_file = None
        context_summary = ""
        context_snippets = ""
    header = prompts.common_header(agent, state_mod.render_state_summary(target_dir))
    skill_block = prompts.format_skill_resolution(resolution, mode="prompt", engine=agent)
    base_prompt = prompts.issue_base_prompt(
        agent, issue,
        header=header,
        skill_block=skill_block,
        context_summary=context_summary,
        context_snippets=context_snippets,
    )

    # 5. Context retrieval metadata. The query label is ``issue #{issue}`` in
    # issue mode (byte-identical) and a prompt label in prompt mode.
    run_context_retrieval = ctx.context_retrieval_metadata(
        target_dir, context_query or f"issue #{issue}"
    )

    # 6. Max execution attempts
    max_execution_attempts = int(
        os.environ.get("AGENTRAIL_MAX_EXECUTION_ATTEMPTS", "5") or "5"
    )
    if max_execution_attempts < 1:
        print(
            f"error: AGENTRAIL_MAX_EXECUTION_ATTEMPTS must be a positive integer, "
            f"got {max_execution_attempts}",
            file=sys.stderr,
        )
        return 2
    # RETRY layer (eval ablation): when OFF, force a SINGLE execution attempt — no
    # retry budget. ABSENT/"1" = ON = today's behavior (the real loop never sets
    # the flag, so max attempts is the configured value, unchanged).
    if not layer_enabled("RETRY"):
        max_execution_attempts = 1

    # 7. Run dir setup
    started_at = _utc_now_iso()
    log_dir = log_dir or (target_dir / ".agentrail" / "runs")
    # The run-id stem encodes the target: ``issue-{issue}`` in issue mode
    # (byte-identical) or ``prompt-{label}`` in prompt mode.
    _stem = run_id_stem or f"issue-{issue}"
    run_id = run_id or (
        f"{_dt.datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}"
        f"-{_stem}-{agent}-{os.getpid()}"
    )
    run_dir = Path(log_dir) / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    # 8. Write artifacts
    prompt_file = run_dir / "prompt.md"
    prompt_file.write_text(base_prompt)

    resolved_skills_file = run_dir / "resolved-skills.json"
    resolved_skills_file.write_text(json.dumps(resolution, indent=2))

    metadata_file = run_dir / "run.json"
    artifacts.write_run_metadata(
        metadata_file,
        started_at=started_at,
        issue=issue,
        agent=agent,
        command=command,
        prompt_file=str(prompt_file),
        resolved_skills_file=str(resolved_skills_file),
        resolved_skills=resolution.get("resolved", []),
        max_execution_attempts=max_execution_attempts,
        context_pack_file=run_context_pack_file,
        context_retrieval=run_context_retrieval,
    )

    # 9. Print run info
    print(f"issue: {issue}")
    print(f"agent: {agent}")
    print(f"prompt: {prompt_file}")
    print(f"metadata: {metadata_file}")

    # 9a. Independent Review visibility (#1270): the verify/critic seat is the
    # crux of "not vibe coding" and must never silently vanish. A hosted run
    # (AGENTRAIL_HOSTED=1, set by the fleet runner, #1267) may NEVER proceed
    # without it — refuse right here, before any phase runs (RunContext isn't
    # even built yet). A local/dev run instead gets a loud, non-fatal warning
    # printed into this same run header so it cannot be missed in the
    # transcript. The reason is recorded into run.json either way: a hosted
    # refusal records it immediately below (it never reaches finalization —
    # see write_run_refusal_marker, #1267 PR③); a local warning's reason is
    # recorded at finalization (finalize_objective_gate, below) so every run's
    # record shows why the seat did or didn't run. When status is "active"
    # neither branch fires — byte-identical to before this seam existed.
    if is_hosted_run() and independent_review_status != "active":
        fatal_message = _independent_review_fatal_message(agent, independent_review_status)
        # Persist the refusal itself (#1267 PR③): a hosted refusal previously
        # left a run.json that existed but was permanently unfinalized, with no
        # field saying why — the runner's native_runner.py then folded it into
        # a bare "agentrail run exited 1", indistinguishable from a real
        # objective-gate failure, and the queue retried it up to the full
        # budget (pointless: no stronger model fixes a static config gap).
        # Recording the SAME message object used for the stderr print below
        # keeps this a single source of truth — no risk of the two drifting.
        artifacts.write_run_refusal_marker(
            metadata_file,
            kind="independent_review",
            status=independent_review_status,
            message=fatal_message,
            independent_review_value=independent_review_metadata_value(
                independent_review_status
            ),
        )
        # Failure telemetry — non-fatal, same push_failure_event seam and env
        # link every other call site in this module uses (see step 17c below).
        try:
            push_failure_event(
                target_dir, run_id, "hosted_refusal", "startup", fatal_message,
            )
        except Exception as _exc:  # noqa: BLE001 — non-fatal by design
            _log.debug("hosted refusal failure push skipped: %s", _exc)
        print(fatal_message, file=sys.stderr)
        return 1
    if not is_hosted_run() and independent_review_status != "active":
        print(_independent_review_warning(agent, independent_review_status))

    # 10. Build RunContext
    rc = RunContext(
        target_dir=target_dir,
        repo_dir=repo_dir,
        issue=issue,
        agent=agent,
        agent_command=command,
        run_id=run_id,
        run_dir=run_dir,
        started_at=started_at,
        metadata_file=metadata_file,
        base_prompt=base_prompt,
        resolution_text=resolution_text,
        run_context_pack_file=run_context_pack_file,
        max_execution_attempts=max_execution_attempts,
        context_retrieval=run_context_retrieval,
        phase_commands=phase_commands or {},
        budget_usd=budget_usd,
        budget_source=budget_source,
        independent_review_status=independent_review_status,
    )

    # 10a. Langfuse tracer (Task 3, langfuse-tracing-shadow-judge PRD): one
    # trace per run, attached to rc so every downstream phase can reach it.
    # RunTracer.start() is itself non-fatal by construction (inert when the
    # AGENTRAIL_LANGFUSE_ENABLED flag is off or keys are missing, and never
    # raises even when enabled — see agentrail/observability/tracer.py), but
    # this call site still wraps it in its own try/except to match the
    # non-fatal pattern used for every other observability/telemetry block in
    # this file (cost push, ledger write, activity push, format enforcement).
    # rc.tracer defaults to an inert RunTracer (see RunContext.tracer above),
    # so a failure here leaves rc.tracer inert rather than None — additive
    # only, never a risk to the run or the budget guardrail below.
    try:
        rc.tracer = RunTracer.start(
            run_id,
            session_id=os.environ.get("AGENTRAIL_LANGFUSE_SESSION_ID") or None,
            metadata={"agent": agent, "label": str(label)},
            # Readable trace name (`issue #42` / `prompt <task>`) instead of the
            # opaque run-id, and the run's actual ask as trace-level input so the
            # Langfuse trace list/detail I/O columns are populated.
            name=context_query or None,
            input_text=resolution_text,
        )
    except Exception as _exc:
        _log.debug("langfuse tracer start skipped: %s", _exc)

    # 10b. Read-side injection re-screen (issue #1035).
    #
    # Defense-in-depth against prompt injection: the queue-entrance gate (#1026)
    # sanitizes on WRITE, but it cannot cover rows admitted before the gate
    # existed, bodies written straight through a webhook, or — most importantly —
    # a body edited AFTER admission (clean at enqueue, malicious at run time).
    # So at the READ boundary, right before the untrusted issue body is assembled
    # into the runner's prompt and executed, we re-run the SAME injection screen
    # (agentrail/guardrails/policies/input_contract.screen_injection) against the
    # body as read from the queue at run time.
    #
    # A read-side hit PARKS this run for human inspection using the same parking
    # shape as the write-side gate: we record blocked_reason in the run metadata
    # and state (phase="blocked", not a terminal success), print the reason, and
    # RETURN before any phase runs — the agent never sees the tainted prompt. This
    # is a park, not a silent drop: the run dir + run.json survive with the reason
    # for a human to inspect, and the blocked (non-retryable) state means the loop
    # does not spin re-running it (AC3). The complementary framing in
    # prompts.frame_untrusted_issue_context is the second layer for bodies that
    # slip past the deny-list.
    injection_reason = screen_injection(resolution_text)
    if injection_reason:
        park_reason = (
            f"read-side prompt-injection screen tripped ({injection_reason}) — "
            "parked for human review instead of run"
        )
        print(
            f"blocked: issue #{issue} {park_reason}; inspect {metadata_file}",
            file=sys.stderr,
        )
        finished_at = _utc_now_iso()
        artifacts.update_run_metadata_attempts(
            metadata_file,
            execution_attempt=1,
            max_execution_attempts=max_execution_attempts,
            failed_verification_attempts=0,
            verifier_findings_file="",
            blocked_reason=park_reason,
        )
        state_mod.update_run_state(
            target_dir, "finish",
            run_id=run_id,
            issue=issue,
            agent=agent,
            phase="blocked",
            picked_at=started_at,
            finished_at=finished_at,
            exit_status=2,
            prompt_file=str(prompt_file),
            metadata_file=str(metadata_file),
            run_dir=str(run_dir),
            execution_attempt=1,
            max_execution_attempts=max_execution_attempts,
            failed_verification_attempts=0,
            verifier_findings_file="",
            blocked_reason=park_reason,
            issue_context=resolution_text,
            context_pack_file=run_context_pack_file or "",
        )
        try:
            rc.tracer.finish(2, output={"exitStatus": 2, "blocked": park_reason})
        except Exception as _exc:
            _log.debug("langfuse tracer finish skipped: %s", _exc)
        return 2

    # 11. Phase execution
    #
    # MVP flow (no plan phase): test-author → execute → verify → Objective Gate.
    # The legacy plan phase has been removed from the DEFAULT run sequence; the
    # plan prompt/handler in ``run_issue_phase`` is left dormant for any explicit
    # caller, but ``run_issue`` no longer plans. ``plan_output`` is therefore
    # always empty here and is passed through only to keep the phase prompt
    # signature stable (the execute prompt tolerates an empty plan).
    plan_output = ""
    status = 0
    last_phase = "execute"

    # The verification spine (ADR 0008) is ON BY DEFAULT in the MVP. A caller
    # restores the minimal single-execute flow with ``"redGreenProof": false``.
    require_red_green = red_green_proof_required(target_dir)

    # Test-Author phase (ADR 0008, #775): a DISTINCT Test-Author role authors the
    # failing acceptance test from the AC BEFORE any implementation (AC1, AC3).
    # This runs ahead of the RED baseline below so the baseline observes the
    # *authored* acceptance test failing — that red observation is what proves the
    # test is real, and the Implementer (execute phase) is a separate role that
    # turns it green (AC2). It is the FIRST phase now that plan is gone.
    # JIT context gatherer (#1049, flag-gated DEFAULT OFF): a cheap-model,
    # read-only gather phase that runs BEFORE test-author. It runs ONLY when a
    # distinct gather command was enumerated into ``phase_commands`` (the same
    # presence pattern the critic uses) AND ``AGENTRAIL_JIT_GATHER=1``. With
    # the flag off or no command enumerated, the phase is skipped entirely —
    # gather NEVER falls back to the implementer's ``rc.agent_command``.
    # Advisory phase: a gather failure is logged but does not fail the run —
    # later phases proceed exactly as if gather had not run.
    if status == 0 and "gather" in rc.phase_commands and jit_gather_enabled():
        gather_status, _ = run_issue_phase(rc, "gather", 1, plan_output=plan_output)
        if gather_status != 0:
            if rc.budget_exceeded or rc.budget_ceiling_crossed:
                # #1269: a budget breach during gather is a hard stop, unlike a
                # genuine gather failure (advisory-only, below) — propagate so
                # test-author (and every later phase) never starts having
                # already blown the per-issue cap. Checks BOTH flags (review
                # fix): rc.budget_ceiling_crossed covers the case where gather
                # ALSO failed on its own terms (rc.budget_exceeded then stays
                # False by design, so the generic push isn't suppressed) —
                # the ceiling was still crossed, so this is still a hard stop,
                # not gather's usual advisory-only failure path.
                status = gather_status
            else:
                print("gather phase failed; continuing without gathered context",
                      file=sys.stderr)
        else:
            # Manifest handoff (#1049): capture the gather output artifact ONCE
            # and pin it on the RunContext, so test-author/execute/verify all
            # inject the SAME manifest bytes into their shared task context
            # (byte-identical prefix = one warm-cache key, AC1).
            # bounded_phase_text caps oversized manifests deterministically
            # (env-stable within a run; the truncation note points back at this
            # artifact). Missing/empty output → rc.gather_manifest stays "" and
            # later prompts are byte-identical to a run without gather.
            gather_output_file = rc.run_dir / "gather" / "output.md"
            gather_output = (
                gather_output_file.read_text(encoding="utf-8", errors="replace")
                if gather_output_file.exists()
                else ""
            )
            if gather_output.strip():
                rc.gather_manifest = prompts.bounded_phase_text(
                    gather_output.strip(), "gather context manifest"
                )

    if status == 0 and require_red_green:
        status, _ = run_issue_phase(rc, "test-author", 1, plan_output=plan_output)
        last_phase = "test-author"

    # Budget Leash enforcement itself now lives INSIDE run_issue_phase (#1269),
    # evaluated per-phase right after each phase's own cost is known — this
    # single post-test-author checkpoint (the ONLY one that existed before)
    # is fully subsumed by that mechanism: run_issue_phase already forces a
    # non-zero status the moment cumulative_cost_usd crosses budget_usd, which
    # the `status == 0` gates throughout this function (including the ones
    # below) already respect.

    # Red-Green Proof baseline (ADR 0008, #772): observe the declared acceptance
    # checks BEFORE implementation. With the Test-Author phase above, this
    # reflects the just-authored acceptance test — expected RED here. That red
    # observation is what proves the test is real (not tautological) once the
    # implementation turns it green. With the spine on by default this is the
    # default path; an explicit ``redGreenProof: false`` opt-out skips it.
    red_green_observations: list[Observation] = []
    if status == 0 and require_red_green:
        try:
            baseline = run_objective_checks(target_dir)
            red_green_observations.extend(
                Observation(test=c.name, passed=c.passed) for c in baseline
            )
        except Exception as _exc:  # pragma: no cover - defensive
            _log.debug("red-green baseline skipped: %s", _exc)

    # Best-of-N execute with critic ranking and early stop (issue #979).
    # BESTOFN layer: when ON *and* a distinct critic command is configured, the
    # execute phase produces up to a small configurable N candidate fixes; the
    # independent Critic (#977) scores each candidate, the highest-scoring one is
    # carried to the Objective Gate, and generation STOPS EARLY the moment a
    # candidate clears the critic's confidence bar (AC1/AC2/AC3). This replaces
    # the blind single execute with a critic-gated attempt loop — it never spins
    # up N parallel full pipelines (per-task fan-out is 3-10x tokens for no gain,
    # CONTEXT.md). When the layer is OFF, or no critic is configured, the execute
    # phase runs EXACTLY once and the existing critic/verify gate below runs
    # unchanged (AC4 — byte-identical to today). The Critic is INDEPENDENT of the
    # executor: it is a SEPARATE phase, never the maker grading its own homework.
    bestofn_evidence: Optional[Dict[str, Any]] = None
    bestofn_active = (
        require_red_green
        and "critic" in rc.phase_commands
        and layer_enabled("CRITIC")
        and layer_enabled("BESTOFN")
    )
    if status == 0 and bestofn_active:
        # Finding 3 seam (DEFAULT OFF): the TESTFIRST flag swaps the merged #979
        # critic-ONLY selector for the SAFE test-PRIMARY / critic-tiebreak selector.
        # ABSENT/anything-but-"1" keeps today's behavior, so the live loop is unchanged.
        _bestofn_execute = (
            _run_execute_best_of_n_testfirst
            if bestofn_testfirst_enabled()
            else _run_execute_best_of_n
        )
        status, bestofn_evidence = _bestofn_execute(rc, plan_output)
        last_phase = "execute"
    elif status == 0:
        # Diff-only REJECT+LOOP enforcement (DEFAULT OFF) applies to the PLAIN
        # execute path ONLY — never the best-of-N branch above — so the two attempt
        # loops are not compounded into a token blowup. Both paths stay default-OFF.
        if diff_only_enforce_enabled():
            status = _run_execute_with_diff_enforcement(rc, plan_output)
        else:
            status, _ = run_issue_phase(rc, "execute", 1, verifier_findings_file="", plan_output=plan_output)
        last_phase = "execute"

    # 12a. Independent Verification (ADR 0008, #782): a blocking, narrow check by
    # a DIFFERENT model than the Implementer. It runs after execute, ONLY when the
    # Red-Green Proof is on AND a distinct verifier command is configured for the
    # ``verify`` phase (``phase_commands["verify"]`` — built from a model that
    # differs from the Implementer's, AC1). The verifier confirms the solution AND
    # tests genuinely satisfy the AC and stayed in scope; its structured verdict
    # (accept/reject) is parsed from the phase output and fed to the Objective
    # Gate below so a REJECT blocks done (AC3). When no distinct verifier model is
    # available, no verify phase runs and behavior is unchanged.
    # VERIFY_GATE layer (eval ablation): when OFF, do NOT run the Independent
    # Verifier phase (no distinct-model verify pass, no verification evidence fed
    # to the gate). ABSENT/"1" = ON = today's behavior (the real loop never sets
    # the flag). NOTE: this disables the agent's IN-RUN verifier phase only — the
    # eval's separate hidden-test scorer is untouched.
    # CRITIC layer (#977): the cheap-model Critic REPLACES the expensive verify
    # model as the independent reviewer that feeds the gate. It runs as a SEPARATE
    # phase from the executor (the executor never scores its own work, AC3) and a
    # critic REJECT blocks done exactly as a verify reject does (AC2/AC3). It runs
    # ONLY when a distinct ``critic`` command is configured AND the CRITIC layer is
    # not explicitly off; the real loop builds no critic command, so the verify
    # path below is unchanged (AC4). When the critic runs, the verify phase does
    # NOT — there is exactly one independent reviewer feeding the gate. The Critic
    # produces the SAME ``verification_evidence`` shape the verifier does, so the
    # Objective Gate's accept/reject contract and false-green handling are
    # byte-identical (AC2).
    # When best-of-N ran (#979), it already produced the SELECTED candidate's
    # critic verdict as the gate evidence; the standalone critic/verify pass below
    # must not run again (the critic already scored every candidate in the loop).
    verification_evidence: Optional[Dict[str, Any]] = bestofn_evidence
    use_critic = (
        not bestofn_active
        and require_red_green and "critic" in rc.phase_commands
        and layer_enabled("CRITIC")
    )
    if status == 0 and use_critic:
        status, _ = run_issue_phase(rc, "critic", 1, plan_output=plan_output)
        last_phase = "critic"
        if status == 0:
            critic_output_file = rc.run_dir / "critic" / "output.md"
            critic_output = (
                critic_output_file.read_text(encoding="utf-8", errors="replace")
                if critic_output_file.exists()
                else ""
            )
            critic_verdict = critic_mod.score_candidate(critic_output)
            verification_evidence = critic_mod.gate_evidence(critic_verdict)
    elif (status == 0 and not bestofn_active
            and require_red_green and "verify" in rc.phase_commands
            and layer_enabled("VERIFY_GATE")):
        status, _ = run_issue_phase(rc, "verify", 1, plan_output=plan_output)
        last_phase = "verify"
        if status == 0:
            verify_output_file = rc.run_dir / "verify" / "output.md"
            verify_output = (
                verify_output_file.read_text(encoding="utf-8", errors="replace")
                if verify_output_file.exists()
                else ""
            )
            verdict = verifier_mod.parse_verdict(verify_output)
            verification_evidence = verifier_mod.gate_evidence(verdict)
            artifacts.write_phase_verdict(
                rc.run_dir, "verify",
                {"accepted": verdict.accepted, "reason": verdict.reason},
            )

    # 12b. Objective Gate — the falsifiable definition of "done" (ADR 0007).
    # AFTER the execute phase we run the OBJECTIVE checks ourselves (the agent's
    # own "it works" is never trusted), evaluate the gate, and finalize. The
    # run's done-ness is the gate verdict — NOT the raw agent exit status.
    declared = load_verify_checks(target_dir)
    if status == 0:
        # Agent phases succeeded: actually run the declared checks.
        gate_checks = run_objective_checks(target_dir)
    else:
        # Agent phase failed: there is nothing trustworthy to verify and the
        # checks were NOT run. Record each declared check as a failure so the
        # gate is red ("agent phase failed; verification not run"); if nothing
        # was declared, the empty-coverage path makes it red anyway.
        gate_checks = [
            CheckResult(name=c.name, passed=False, detail="agent phase failed; not run")
            for c in declared
        ]

    # Red-Green Proof (ADR 0008, #772): when required, the post-implementation
    # check results are the GREEN half of the trail. Combined with the
    # pre-implementation RED baseline above, the recorder decides whether a valid
    # fail→pass trail exists. The Objective Gate consults this evidence — a
    # never-failed (tautological) acceptance test cannot produce a valid trail
    # and so cannot reach done (AC3). When the proof is not required, no evidence
    # is passed and the gate's behavior is unchanged.
    red_green_evidence: Optional[Dict[str, Any]] = None
    if require_red_green:
        # Issue #907: a change that legitimately needs no new test — docs/config
        # only, no Python source touched — has no fail→pass trail to produce, so
        # requiring one would false-red it. Waive the trail for such changes,
        # driven by the SAME changed-file classification the verify check uses
        # (single source of truth, AC3). Anti-false-green is preserved (AC2): any
        # change that touches Python source still requires the trail, and the
        # verify check independently reds a source-without-test change.
        from agentrail.run.verify_gate import (
            collect_changed_files,
            is_test_free_change,
        )

        changed_files = collect_changed_files(target_dir)
        if not is_test_free_change(changed_files):
            # Source changed (or the change set is empty/unknown) → require the
            # trail. Only a NON-EMPTY docs/config-only change waives it.
            red_green_observations.extend(
                Observation(test=c.name, passed=c.passed) for c in gate_checks
            )
            red_green_evidence = gate_evidence(verify_trail(red_green_observations))

    gate_result = evaluate(
        checks=gate_checks,
        ac_coverage=ac_coverage_for(declared),
        red_green_evidence=red_green_evidence,
        verification_evidence=verification_evidence,
    )
    outcome = finalize_objective_gate(
        metadata_file, gate_result=gate_result, review_advisory=None,
        independent_review_status=rc.independent_review_status,
    )

    # Done is gate-driven: green → exit 0; red → non-zero. Preserve a genuine
    # agent failure code when the agent itself failed, otherwise surface 1 for a
    # red gate on an otherwise-clean run.
    if outcome["done"]:
        status = 0
    elif status == 0:
        status = 1

    # Read-grounded live context metrics (#1037). Computed HERE, at run
    # finalization, because recall needs the FINAL accepted diff — which the
    # per-phase pack push (block 17d) fires too early to see. Never fatal: a
    # failure here must not change the run's exit status, which the Objective
    # Gate above already decided.
    try:
        _record_live_context_metrics(
            metadata_file=metadata_file,
            target_dir=target_dir,
            run_id=run_id,
            agent=agent,
            run_context_pack_file=run_context_pack_file,
        )
    except Exception as e:  # noqa: BLE001 — non-fatal by design
        print(
            f"warning: live context metrics skipped "
            f"({type(e).__name__}: {e})",
            file=sys.stderr,
        )

    # 13. Finalize
    finished_at = _utc_now_iso()
    # #1269 AC1 "reason recorded": when the Budget Leash stopped this run,
    # rc.budget_stop_reason carries the phase, spend, and ceiling — the same
    # blocked_reason vehicle the read-side injection park (above) uses, so run
    # metadata and .agentrail/state.json both surface WHY, not just THAT.
    # "" (the default, unless the leash tripped) writes no blockedReason at
    # all — both callees only set the field when it is truthy.
    #
    # budget_ceiling_crossed (review fix, double-classification): recorded
    # separately from blocked_reason. It is True whenever the per-issue
    # ceiling was crossed at all — including when the triggering phase had
    # ALREADY failed for its own reason (rc.budget_exceeded stays False in
    # that case so the generic failure push keeps its evidence, and
    # blocked_reason stays "" too) — so run.json still names the ceiling fact
    # even though it was not what stopped the run.
    artifacts.update_run_metadata_attempts(
        metadata_file,
        execution_attempt=1,
        max_execution_attempts=max_execution_attempts,
        failed_verification_attempts=0,
        verifier_findings_file="",
        blocked_reason=rc.budget_stop_reason,
        budget_ceiling_crossed=rc.budget_ceiling_crossed,
    )
    state_mod.update_run_state(
        target_dir, "finish",
        run_id=run_id,
        issue=issue,
        agent=agent,
        phase=last_phase,
        picked_at=started_at,
        finished_at=finished_at,
        exit_status=status,
        prompt_file=str(prompt_file),
        metadata_file=str(metadata_file),
        run_dir=str(run_dir),
        execution_attempt=1,
        max_execution_attempts=max_execution_attempts,
        failed_verification_attempts=0,
        verifier_findings_file="",
        blocked_reason=rc.budget_stop_reason,
        issue_context=resolution_text,
        context_pack_file=run_context_pack_file or "",
    )
    try:
        gate = outcome.get("objectiveGate", {}) if isinstance(outcome, dict) else {}
        rc.tracer.finish(status, output={
            "exitStatus": status,
            "done": outcome.get("done") if isinstance(outcome, dict) else None,
            "verdict": gate.get("verdict"),
            "failedReasons": gate.get("failedReasons", []),
            "lastPhase": last_phase,
        })
    except Exception as _exc:
        _log.debug("langfuse tracer finish skipped: %s", _exc)
    return status
