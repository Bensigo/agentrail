from __future__ import annotations
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

from agentrail.run import artifacts, context as ctx, prompts, skills, state as state_mod
from agentrail.guardrails.policies.input_contract import screen_injection
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
from agentrail.run.pricing import cost_usd
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
    cumulative_cost_usd: float = 0.0
    # #1049: deterministic context manifest captured ONCE from the gather
    # phase's output artifact and injected VERBATIM into every later phase's
    # shared task context (one set of bytes = one shared cache key). "" = no
    # manifest → phase prompts stay byte-identical to pre-#1049 output.
    gather_manifest: str = ""


def finalize_objective_gate(
    metadata_file: Path,
    *,
    gate_result: GateResult,
    review_advisory: Optional[Dict[str, Any]] = None,
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
    try:
        usage = capture_usage(rc.agent, rc.target_dir, phase_start_ts)
        if usage:
            cost = cost_usd(usage)
            # Cost accounting FIRST — the budget guardrail depends on this, so it
            # must never be skipped by a later ledger/push failure.
            rc.cumulative_cost_usd += cost
            push_cost_event(rc.target_dir, rc.run_id, phase, usage, cost)
            # Local append-only ledger for `agentrail context savings` — isolated
            # in its own try/except so a write failure cannot disable the cost
            # accounting above (which would silently defeat the budget guardrail).
            try:
                record = build_cost_record(rc.run_id, phase, usage, cost)
                ledger = rc.target_dir / ".agentrail" / "run" / "cost-events.jsonl"
                ledger.parent.mkdir(parents=True, exist_ok=True)
                with ledger.open("a", encoding="utf-8") as _f:
                    _f.write(json.dumps(record) + "\n")
            except Exception as _exc:
                _log.debug("cost ledger write skipped: %s", _exc)
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
    if status != 0:
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
              budget_usd: float = 0.0) -> int:
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
        run_id_stem=f"issue-{issue}",
        context_query=f"issue #{issue}",
    )


def run_prompt(target_dir: Path, prompt: str, *, label: str, agent: str,
               command: str, repo_dir: Path, log_dir: Optional[Path] = None,
               run_id: str = "",
               phase_commands: Optional[Dict[str, str]] = None,
               budget_usd: float = 0.0) -> int:
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
        run_id_stem=f"prompt-{safe_label}",
        context_query=f"prompt {label}",
    )


def _run_pipeline(target_dir: Path, *, resolution_text: str, label,
                  agent: str, command: str, repo_dir: Path,
                  log_dir: Optional[Path] = None, run_id: str = "",
                  phase_commands: Optional[Dict[str, str]] = None,
                  budget_usd: float = 0.0,
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
    )

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

    if status == 0 and rc.budget_usd > 0 and rc.cumulative_cost_usd >= rc.budget_usd:
        msg = (f"run stopped: ${rc.cumulative_cost_usd:.2f} spent of "
               f"${rc.budget_usd:.2f} budget")
        print(f"budget exceeded after {last_phase} phase: {msg}", file=sys.stderr)
        try:
            push_failure_event(rc.target_dir, rc.run_id, "budget_exceeded", last_phase, msg)
        except Exception as _exc:
            _log.debug("budget failure push skipped: %s", _exc)
        status = 1

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
    outcome = finalize_objective_gate(metadata_file, gate_result=gate_result, review_advisory=None)

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
    artifacts.update_run_metadata_attempts(
        metadata_file,
        execution_attempt=1,
        max_execution_attempts=max_execution_attempts,
        failed_verification_attempts=0,
        verifier_findings_file="",
        blocked_reason="",
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
        blocked_reason="",
        issue_context=resolution_text,
        context_pack_file=run_context_pack_file or "",
    )
    return status
