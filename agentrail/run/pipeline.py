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
from agentrail.run.check_runner import (
    ac_coverage_for,
    load_verify_checks,
    red_green_proof_required,
    run_objective_checks,
)
from agentrail.run.objective_gate import CheckResult, GateResult, evaluate
from agentrail.run.red_green import Observation, gate_evidence, verify_trail
from agentrail.run.activity_push import push_agent_activity
from agentrail.run.context_pack_push import push_context_pack
from agentrail.run.cost_push import build_cost_record, push_cost_event
from agentrail.run.failure_push import push_failure_event
from agentrail.run.output_enforcer import (
    Rejected,
    all_changes_new_or_rename,
    enforce,
    push_format_rejection_event,
)
from agentrail.run.pricing import cost_usd
from agentrail.run.proc import run_with_timeout
from agentrail.run import verifier as verifier_mod
from agentrail.run.usage_capture import capture_usage
from agentrail.shared.json import read_json, write_json

_log = logging.getLogger(__name__)


def layer_enabled(name: str) -> bool:
    """Is the named AgentRail layer ON for this run?

    The eval harness (``agentrail.evals``) sets ``AGENTRAIL_EVAL_LAYER_<NAME>``
    to ``"0"`` or ``"1"`` to toggle a layer for leave-one-out ablation arms
    (CONTEXT, ROUTING, VERIFY_GATE, RETRY, GUARDRAILS). The real autonomous loop
    (``run issue <N>``) sets NONE of these vars, so the flag is ABSENT and the
    default is ON — behavior is byte-identical to before this seam existed.

    Contract: ABSENT or ``"1"`` → ``True`` (layer ON, today's behavior). Only an
    explicit ``"0"`` turns a layer OFF. Any other value is treated as ON (a
    typo'd flag must never silently disable a layer in the real loop).
    """
    return os.environ.get(f"AGENTRAIL_EVAL_LAYER_{name.upper()}") != "0"


def _utc_now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


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
        if phase == "plan" and rc.run_context_pack_file:
            phase_context_pack_file = rc.run_context_pack_file
        elif (phase != "plan" and rc.run_context_pack_file
              and (rc.target_dir / rc.run_context_pack_file).is_file()):
            phase_context_pack_file = rc.run_context_pack_file
        else:
            phase_context_pack_file = ctx.build_issue_context_pack(rc.target_dir, rc.issue, phase)

        # 6. Context summary
        phase_context_summary = ctx.context_pack_summary(rc.target_dir, phase_context_pack_file)

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

    # 17d. Context pack telemetry — non-fatal
    try:
        push_context_pack(rc.target_dir, rc.run_id, rc.context_retrieval)
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
            push_failure_event(rc.target_dir, rc.run_id, failure_type, phase,
                               f"{phase} phase exited with status {status}")
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

    if status == 0:
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
    verification_evidence: Optional[Dict[str, Any]] = None
    if (status == 0 and require_red_green and "verify" in rc.phase_commands
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
