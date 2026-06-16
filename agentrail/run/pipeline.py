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
from agentrail.run.check_runner import ac_coverage_for, load_verify_checks, run_objective_checks
from agentrail.run.objective_gate import CheckResult, GateResult, evaluate
from agentrail.run.activity_push import push_agent_activity
from agentrail.run.context_pack_push import push_context_pack
from agentrail.run.cost_push import build_cost_record, push_cost_event
from agentrail.run.failure_push import push_failure_event
from agentrail.run.pricing import cost_usd
from agentrail.run.proc import run_with_timeout
from agentrail.run.usage_capture import capture_usage
from agentrail.shared.json import read_json, write_json

_log = logging.getLogger(__name__)


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

    # 8. Build phase prompt
    phase_prompt = prompts.issue_run_phase_prompt(
        phase, rc.issue,
        issue_context=rc.resolution_text,
        base_prompt=rc.base_prompt,
        context_summary=phase_context_summary,
        plan_output=plan_output,
        verifier_findings_text=verifier_findings_text,
        execution_attempt=execution_attempt,
        max_execution_attempts=rc.max_execution_attempts,
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

    # 17c. Context pack telemetry — non-fatal
    try:
        push_context_pack(rc.target_dir, rc.run_id, rc.context_retrieval)
    except Exception as _exc:
        _log.debug("context pack push skipped: %s", _exc)

    # 17d. Index snapshot telemetry — non-fatal. Keeps the dashboard repos
    # health view fresh on every run instead of only after a manual
    # `agentrail context index`. build_index already ran incrementally during
    # context-pack retrieval, so this is a cache-hit read plus one POST.
    # Plan-phase only: once per run is enough.
    if phase == "plan":
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
    Returns the final exit status."""

    # 1. Resolve target_dir
    target_dir = Path(target_dir).resolve()

    # 2. Issue resolution text
    resolution_text = ctx.issue_resolution_text(target_dir, issue)

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

    # 4. Build base prompt
    run_context_pack_file = ctx.build_issue_context_pack(target_dir, issue, "plan")
    context_summary = ctx.context_pack_summary(target_dir, run_context_pack_file)
    context_snippets = ctx.context_selected_snippets(target_dir, resolution_text)
    header = prompts.common_header(agent, state_mod.render_state_summary(target_dir))
    skill_block = prompts.format_skill_resolution(resolution, mode="prompt", engine=agent)
    base_prompt = prompts.issue_base_prompt(
        agent, issue,
        header=header,
        skill_block=skill_block,
        context_summary=context_summary,
        context_snippets=context_snippets,
    )

    # 5. Context retrieval metadata
    run_context_retrieval = ctx.context_retrieval_metadata(target_dir, f"issue #{issue}")

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

    # 7. Run dir setup
    started_at = _utc_now_iso()
    log_dir = log_dir or (target_dir / ".agentrail" / "runs")
    run_id = run_id or (
        f"{_dt.datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}"
        f"-issue-{issue}-{agent}-{os.getpid()}"
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

    # 11. Determine plan skip

    # Review-fix check
    is_review_fix = False
    try:
        gh_result = subprocess.run(
            ["gh", "issue", "view", str(issue),
             "--json", "labels",
             "--jq", "[.labels[].name] | join(\",\")"],
            cwd=target_dir,
            capture_output=True,
            text=True,
        )
        if gh_result.returncode == 0 and "review-fix" in gh_result.stdout:
            is_review_fix = True
    except Exception:
        pass

    # Resume check
    prior_plan_output: Optional[str] = None
    if os.environ.get("AGENTRAIL_RESUME") == "1":
        for prior_dir in sorted(Path(log_dir).glob(f"*-issue-{issue}-*"), reverse=True):
            if prior_dir == run_dir:
                continue
            plan_status_file = prior_dir / "plan" / "status.json"
            plan_output_file = prior_dir / "plan" / "output.md"
            if plan_status_file.exists() and plan_output_file.exists():
                try:
                    plan_status = json.loads(plan_status_file.read_text())
                    if plan_status.get("status") == "completed":
                        prior_plan_output = plan_output_file.read_text()
                        break
                except Exception:
                    continue

    # 12. Phase execution
    plan_output = ""
    status = 0
    last_phase = "execute"

    if is_review_fix:
        print(
            "skipped plan phase (review-fix issue — fix is described in issue body)",
            file=sys.stderr,
        )
        status = 0
    elif prior_plan_output is not None:
        plan_output = prior_plan_output
        status = 0
        print("skipped plan phase (resumed from prior run)", file=sys.stderr)
    else:
        status, plan_output = run_issue_phase(rc, "plan", 1)
        last_phase = "plan"

    if status == 0 and rc.budget_usd > 0 and rc.cumulative_cost_usd >= rc.budget_usd:
        msg = (f"run stopped: ${rc.cumulative_cost_usd:.2f} spent of "
               f"${rc.budget_usd:.2f} budget")
        print(f"budget exceeded after {last_phase} phase: {msg}", file=sys.stderr)
        try:
            push_failure_event(rc.target_dir, rc.run_id, "budget_exceeded", last_phase, msg)
        except Exception as _exc:
            _log.debug("budget failure push skipped: %s", _exc)
        status = 1

    if status == 0:
        status, _ = run_issue_phase(rc, "execute", 1, verifier_findings_file="", plan_output=plan_output)
        last_phase = "execute"

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

    gate_result = evaluate(checks=gate_checks, ac_coverage=ac_coverage_for(declared))
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
