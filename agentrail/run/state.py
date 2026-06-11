from __future__ import annotations
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


def relative_path(target_dir: Path, file: str) -> str:
    """POSIX relative path of `file` from target_dir (legacy relative():6053-6055).
    If file is empty, return ''."""
    if not file:
        return ""
    return Path(os.path.relpath(file, target_dir)).as_posix()


def first_line(text: str) -> str:
    """First non-empty trimmed line, or '' (legacy firstLine:6057-6059)."""
    for line in re.split(r"\r?\n", str(text or "")):
        stripped = line.strip()
        if stripped:
            return stripped
    return ""


def section_items(text: str, heading_regex: "re.Pattern") -> List[str]:
    """Collect list items under a '## <heading>' section until the next '## ' heading.
    Mirror legacy sectionItems (6061-6077): split lines; a line matching ^##\\s+ toggles
    inSection = heading_regex matches that line; within section, skip blank lines, strip a
    leading checkbox/bullet (`- [ ] `, `- [x] `, `* `, `- `) then the remaining bullet, and
    collect non-empty items."""
    lines = re.split(r"\r?\n", str(text or ""))
    items: List[str] = []
    in_section = False
    for line in lines:
        if re.match(r"^##\s+", line):
            in_section = bool(heading_regex.search(line))
            continue
        if not in_section:
            continue
        trimmed = line.strip()
        if not trimmed:
            continue
        # Strip leading checkbox/bullet then remaining bullet prefix
        item = re.sub(r"^[-*]\s+\[[ xX]\]\s+", "", trimmed)
        item = re.sub(r"^[-*]\s+", "", item).strip()
        if item:
            items.append(item)
    return items


def issue_goal_defaults(previous: Dict[str, Any], workflow: Dict[str, Any], issue: int,
                        issue_context: str, now: str) -> Dict[str, Any]:
    """Port legacy issueGoalDefaults (6079-6097). `previous` is the prior goal dict (or {}).
    Returns a NEW goal dict merging previous with computed fields:
      - id = f"issue-{issue}", kind="issue", source=f"github:issue/{issue}"
      - summary = first_line(issue_context) or f"Issue #{issue}"
      - successCriteria = section_items(issue_context, /^##\\s+Acceptance criteria\\s*$/i)
          if non-empty else (previous.successCriteria if a non-empty list else [f"Complete issue #{issue}."])
      - nonGoals = section_items(issue_context, /^##\\s+Non-goals\\s*$/i)
          if non-empty else (previous.nonGoals if list else [])
      - activeIssue = issue
      - activePullRequest = workflow.activePullRequest ?? previous.activePullRequest ?? None
      - activeMilestone = workflow.activeMilestone ?? previous.activeMilestone ?? None
      - createdAt = previous.createdAt or now
      - updatedAt = now
    Start from a shallow copy of `previous` then overwrite these keys (legacy `...previous`)."""
    success_criteria = section_items(issue_context, re.compile(r"^##\s+Acceptance criteria\s*$", re.I))
    non_goals = section_items(issue_context, re.compile(r"^##\s+Non-goals\s*$", re.I))
    summary = first_line(issue_context) or f"Issue #{issue}"

    prev_success = previous.get("successCriteria")
    if success_criteria:
        resolved_success = success_criteria
    elif isinstance(prev_success, list) and prev_success:
        resolved_success = prev_success
    else:
        resolved_success = [f"Complete issue #{issue}."]

    prev_non_goals = previous.get("nonGoals")
    if non_goals:
        resolved_non_goals = non_goals
    elif isinstance(prev_non_goals, list):
        resolved_non_goals = prev_non_goals
    else:
        resolved_non_goals = []

    goal = dict(previous)
    goal.update({
        "id": f"issue-{issue}",
        "kind": "issue",
        "source": f"github:issue/{issue}",
        "summary": summary,
        "successCriteria": resolved_success,
        "nonGoals": resolved_non_goals,
        "activeIssue": issue,
        "activePullRequest": workflow.get("activePullRequest") if workflow.get("activePullRequest") is not None
                             else previous.get("activePullRequest"),
        "activeMilestone": workflow.get("activeMilestone") if workflow.get("activeMilestone") is not None
                           else previous.get("activeMilestone"),
        "createdAt": previous.get("createdAt") or now,
        "updatedAt": now,
    })
    return goal


def upsert_issue_goal(workflow: Dict[str, Any], issue: int, issue_context: str,
                      status: str, now: str, reason: str = "") -> None:
    """Port legacy upsertIssueGoal (6099-6121). Mutates workflow['goals'] in place.
    - goals = workflow.goals if list else []
    - find index where goal.id == f"issue-{issue}"; previous = that goal or {}
    - goal = issue_goal_defaults(previous, workflow, issue, issue_context, now); goal['status']=status
    - if status=='active': remove completedAt/blockedAt/blockedReason keys
      if status=='completed': set completedAt=now; remove blockedAt/blockedReason
      if status=='blocked': set blockedAt=now; blockedReason = reason or
          f"Agent run for issue #{issue} failed during {activePhase or 'execution'} phase."
    NOTE on blocked default: legacy references `activePhase` from outer scope. To keep this
    helper decoupled from the outer run state, the BLOCKED fallback here uses the literal
    string 'execution' when no explicit reason is supplied. The Task-2 caller is expected
    to pass a fully-formed `reason` string (computed with the real activePhase), so this
    default is only a safety fallback."""
    goals: List[Dict[str, Any]] = workflow.get("goals") if isinstance(workflow.get("goals"), list) else []
    index = next((i for i, g in enumerate(goals) if g and g.get("id") == f"issue-{issue}"), -1)
    previous = goals[index] if index >= 0 else {}
    goal = issue_goal_defaults(previous, workflow, issue, issue_context, now)
    goal["status"] = status

    if status == "active":
        goal.pop("completedAt", None)
        goal.pop("blockedAt", None)
        goal.pop("blockedReason", None)
    elif status == "completed":
        goal["completedAt"] = now
        goal.pop("blockedAt", None)
        goal.pop("blockedReason", None)
    elif status == "blocked":
        goal["blockedAt"] = now
        goal["blockedReason"] = reason or f"Agent run for issue #{issue} failed during execution phase."
        goal.pop("completedAt", None)

    if index >= 0:
        goals[index] = goal
    else:
        goals.append(goal)
    workflow["goals"] = goals


def _utc_now_iso() -> str:
    """Return current UTC time as ISO-8601 with millisecond precision and trailing Z,
    matching JavaScript's new Date().toISOString() format, e.g. '2024-01-01T00:00:00.000Z'."""
    dt = datetime.now(tz=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def write_state(state_path: Path, state: Dict[str, Any]) -> None:
    """Atomically write `state` as pretty JSON (2-space indent) + trailing newline to
    state_path, under an advisory flock on a sidecar lock file `<state_path>.lock`, using
    tempfile + os.replace for atomicity. Mirrors legacy fs.writeFileSync(`${JSON.stringify(state,null,2)}\\n`)
    but adds locking + atomic replace (the legacy file is a shared singleton). On platforms
    without fcntl, fall back to a plain atomic write (no lock)."""
    state_path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(state, indent=2) + "\n"
    lock_path = state_path.with_name(state_path.name + ".lock")
    try:
        import fcntl
    except ImportError:
        fcntl = None
    lock_file = open(lock_path, "w")
    try:
        if fcntl is not None:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        fd, tmp = tempfile.mkstemp(dir=str(state_path.parent), prefix=".state-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(text)
            os.replace(tmp, state_path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
    finally:
        if fcntl is not None:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
        lock_file.close()


def _null_coalesce(value: Any, default: str) -> str:
    """Return str(value) if value is not None, else default.
    Mirrors JavaScript ?? operator (only None triggers the default, not 0 or "")."""
    return str(value) if value is not None else default


def _run_label(run: Any) -> str:
    """Port of legacy runLabel (scripts/agentrail-legacy:4152-4156)."""
    if not isinstance(run, dict):
        return "none"
    if run.get("targetType") == "issue":
        target = f"issue #{run['targetIssue']}"
    else:
        target = run.get("targetType") or "target"
    return f"{target} via {run.get('agent') or 'unknown'} ({run.get('status') or 'unknown'})"


def _attempt_summary(run: Any) -> Optional[str]:
    """Port of legacy attemptSummary (scripts/agentrail-legacy:4157-4160)."""
    if not isinstance(run, dict) or not run.get("maxExecutionAttempts"):
        return None
    exec_attempt = int(run.get("executionAttempt") or 0)
    max_attempts = run["maxExecutionAttempts"]
    failed_verify = int(run.get("failedVerificationAttempts") or 0)
    return f"attempts: {exec_attempt}/{max_attempts}; failed verify attempts: {failed_verify}"


def _stale_summary(target_dir: Path, run: Any) -> Optional[str]:
    """Port of legacy staleSummary (scripts/agentrail-legacy:4161-4165)."""
    if not isinstance(run, dict) or not run.get("runDir"):
        return None
    run_dir_str = run["runDir"]
    run_dir = Path(run_dir_str)
    if not run_dir.is_absolute():
        run_dir = target_dir / run_dir_str
    if run_dir.exists():
        return None
    return f"run dir missing: {run_dir_str}"


def _goal_label(goal: Any) -> str:
    """Port of legacy goalLabel (scripts/agentrail-legacy:4166-4170)."""
    if not isinstance(goal, dict):
        return "goal unknown: goal"
    issue_part = f" issue #{goal['activeIssue']}" if goal.get("activeIssue") else ""
    summary = goal.get("summary") or goal.get("source") or goal.get("id") or "goal"
    return f"{goal.get('id') or 'goal'} {goal.get('status') or 'unknown'}{issue_part}: {summary}"


def state_recommendation(target_dir: Path) -> str:
    """Port of legacy state_recommendation (~2867). The no-state guidance text."""
    return (
        "AgentRail state was not found at .agentrail/state.json.\n\n"
        "Recommendation:\n"
        f"- If this repo has not been initialized, run: agentrail init --target {target_dir}\n"
        f"- If this repo already has AgentRail files but no state, run: agentrail install --target {target_dir}\n"
        f"- Then rerun: agentrail status --target {target_dir}"
    )


def _active_context_pack(target_dir: Path, run: Any) -> Optional[str]:
    """Port of legacy activeContextPack (scripts/agentrail-legacy:3264-3276).
    Return run.contextPackFile if set; else if run.metadataFile, read
    <target>/<metadataFile> (or absolute) JSON and return its contextPackFile; else None."""
    if not isinstance(run, dict):
        return None
    if run.get("contextPackFile"):
        return run["contextPackFile"]
    if not run.get("metadataFile"):
        return None
    meta_file = run["metadataFile"]
    meta_path = Path(meta_file) if Path(meta_file).is_absolute() else target_dir / meta_file
    if not meta_path.exists():
        return None
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        return meta.get("contextPackFile") or None
    except Exception:
        return None


def render_resume(target_dir: Path) -> str:
    """Render the resume/handoff markdown from <target>/.agentrail/state.json
    (port of legacy resume_body ~3211-3338). Returns the markdown string."""
    state_path = target_dir / ".agentrail" / "state.json"

    if not state_path.exists():
        lines: List[str] = [
            "# AgentRail Resume",
            "",
            "Codex Desktop instruction: do not rely on previous chat context. Recover from durable state and source files only.",
            "",
            state_recommendation(target_dir),
            "",
            "Relevant docs to inspect after initialization:",
            "- CONTEXT.md",
            "- TASTE.md when present",
            "- docs/agents/",
            "- docs/memory/",
            "- docs/prd/",
            "- docs/milestones/",
            "",
            "Verification commands:",
            f"- agentrail doctor --target {target_dir}",
            "- npm test",
        ]
        return "\n".join(lines)

    state: Dict[str, Any] = json.loads(state_path.read_text(encoding="utf-8"))
    workflow: Dict[str, Any] = state.get("workflow") or {}
    active_run = workflow.get("activeRun")
    completed_runs: List[Any] = workflow.get("completedRuns") if isinstance(workflow.get("completedRuns"), list) else []
    goals: List[Any] = workflow.get("goals") if isinstance(workflow.get("goals"), list) else []

    t = target_dir
    lines = [
        "# AgentRail Resume",
        "",
        "Codex Desktop instruction: do not rely on previous chat context. Recover from durable state and source files only.",
        "",
        "Current task:",
        f"- workflow phase: {workflow.get('phase') or 'unknown'}",
        f"- active phase: {_null_coalesce(workflow.get('activePhase'), 'none')}",
        f"- active issue: {_null_coalesce(workflow.get('activeIssue'), 'none')}",
        f"- active pull request: {_null_coalesce(workflow.get('activePullRequest'), 'none')}",
        f"- active PRD: {_null_coalesce(workflow.get('activePrd'), 'none')}",
        f"- active milestone: {_null_coalesce(workflow.get('activeMilestone'), 'none')}",
        f"- active run: {_run_label(active_run) if isinstance(active_run, dict) else 'none'}",
    ]

    context_pack = _active_context_pack(target_dir, active_run)
    if context_pack:
        lines.append(f"- active context pack: {context_pack}")

    active_goals = [g for g in goals if isinstance(g, dict) and g.get("status") == "active"]
    for goal in active_goals[:5]:
        success_count = len(goal.get("successCriteria") or []) if isinstance(goal.get("successCriteria"), list) else 0
        lines.append(f"- active goal: {_goal_label(goal)}")
        lines.append(f"- active goal success criteria: {success_count}")

    active_attempts = _attempt_summary(active_run)
    if active_attempts:
        lines.append(f"- active run {active_attempts}")

    active_stale = _stale_summary(target_dir, active_run)
    if active_stale:
        lines.append(f"- active run stale: {active_stale}")

    if completed_runs:
        for run in completed_runs[-5:]:
            lines.append(f"- completed run: {_run_label(run)}")
            attempts = _attempt_summary(run)
            if attempts:
                lines.append(f"- completed run {attempts}")
            if isinstance(run, dict) and run.get("blockedReason"):
                lines.append(f"- completed run blocked reason: {run['blockedReason']}")

    lines.append(f"- last completed step: {_null_coalesce(workflow.get('lastCompletedStep'), 'none')}")
    lines.append(f"- next action: {workflow.get('nextSuggestedAction') or 'none'}")
    lines.append("")
    lines.append("Relevant docs:")
    lines.append("- CONTEXT.md")
    lines.append("- TASTE.md when present")
    lines.append("- docs/agents/agentrail-state.md")
    lines.append("- docs/agents/issue-tracker.md")
    lines.append("- docs/agents/ralph-loop.md")
    lines.append("- docs/agents/pr-review.md")
    lines.append("- docs/memory/")
    lines.append("- docs/prd/")
    lines.append("- docs/milestones/")
    lines.append("")
    lines.append("Verification commands:")
    lines.append(f"- agentrail status --target {t}")
    lines.append(f"- agentrail doctor --target {t}")
    lines.append("- npm test")
    lines.append("")
    lines.append("Resume rules:")
    lines.append("- Read source files and GitHub issue or PR state before acting.")
    lines.append("- Treat this handoff as a pointer to durable state, not as hidden truth.")
    lines.append("- Continue only the active issue or PR unless the durable state says otherwise.")

    return "\n".join(lines)


def render_state_summary(target_dir: Path) -> str:
    """Render the AgentRail state summary block from <target_dir>/.agentrail/state.json
    (port of legacy print_state_summary, scripts/agentrail-legacy:4132-4209).
    - If state.json does not exist → return "" (legacy returns 0 / prints nothing; the
      caller prompt_common_header prints a '- AgentRail state: not found…' line itself,
      so here return "").
    - If state.json is present but unreadable/invalid JSON → return
      "- AgentRail state: present but unreadable\n- state error: <message>".
    - Else emit the multi-line block below. Lines joined by '\\n', NO trailing newline."""
    state_path = target_dir / ".agentrail" / "state.json"
    if not state_path.exists():
        return ""

    lines: List[str] = []
    try:
        state: Dict[str, Any] = json.loads(state_path.read_text(encoding="utf-8"))
        workflow: Dict[str, Any] = state.get("workflow") or {}
        active_run = workflow.get("activeRun")
        completed_runs: List[Any] = workflow.get("completedRuns") if isinstance(workflow.get("completedRuns"), list) else []
        worktrees: List[Any] = workflow.get("worktrees") if isinstance(workflow.get("worktrees"), list) else []
        goals: List[Any] = workflow.get("goals") if isinstance(workflow.get("goals"), list) else []

        lines.append("- AgentRail state: present")
        lines.append(f"- version: {state.get('agentrailVersion') or 'unknown'}")
        lines.append(f"- phase: {workflow.get('phase') or 'unknown'}")
        lines.append(f"- active phase: {_null_coalesce(workflow.get('activePhase'), 'none')}")
        lines.append(f"- active issue: {_null_coalesce(workflow.get('activeIssue'), 'none')}")
        lines.append(f"- active pull request: {_null_coalesce(workflow.get('activePullRequest'), 'none')}")
        lines.append(f"- active PRD: {_null_coalesce(workflow.get('activePrd'), 'none')}")
        lines.append(f"- active milestone: {_null_coalesce(workflow.get('activeMilestone'), 'none')}")
        lines.append(f"- active run: {_run_label(active_run) if isinstance(active_run, dict) else 'none'}")

        active_goals = [g for g in goals if isinstance(g, dict) and g.get("status") == "active"]
        if active_goals:
            lines.append("- active goals:")
            for goal in active_goals[:5]:
                lines.append(f"  - {_goal_label(goal)}")

        active_attempts = _attempt_summary(active_run)
        if active_attempts:
            lines.append(f"- active run {active_attempts}")

        active_stale = _stale_summary(target_dir, active_run)
        if active_stale:
            lines.append(f"- active run stale: {active_stale}")

        if completed_runs:
            last_run = completed_runs[-1]
            lines.append(f"- last completed run: {_run_label(last_run)}")
            last_attempts = _attempt_summary(last_run)
            if last_attempts:
                lines.append(f"- last completed run {last_attempts}")
            if isinstance(last_run, dict) and last_run.get("blockedReason"):
                lines.append(f"- last completed run blocked reason: {last_run['blockedReason']}")

        if worktrees:
            active_worktrees = [w for w in worktrees if isinstance(w, dict) and not w.get("removedAt")]
            lines.append(f"- AgentRail worktrees: {len(active_worktrees)} active / {len(worktrees)} tracked")

        lines.append(f"- last completed step: {_null_coalesce(workflow.get('lastCompletedStep'), 'none')}")
        lines.append(f"- next suggested action: {workflow.get('nextSuggestedAction') or 'none'}")

    except Exception as e:
        return f"- AgentRail state: present but unreadable\n- state error: {e}"

    return "\n".join(lines)


_WORKTREE_VALID_STATUSES = {"running", "completed", "merged", "abandoned", "failed"}
_WORKTREE_TERMINAL_KEYS = ("completedAt", "mergedAt", "failedAt", "abandonedAt", "removedAt", "cleanupStatus")


def update_worktree_state(target_dir: Path, worktree_path: str, status: str, *,
                          issue: Optional[int] = None, pr: Optional[int] = None,
                          run_dir: str = "", base: str = "", slot: Optional[int] = None,
                          now: Optional[str] = None) -> None:
    """Port of legacy update_worktree_state. Upserts a worktree lifecycle record into
    <target_dir>/.agentrail/state.json workflow.worktrees[]. No-op if state.json absent.
    Raises ValueError on an invalid status."""
    state_path = target_dir / ".agentrail" / "state.json"
    if not state_path.exists():
        return

    if status not in _WORKTREE_VALID_STATUSES:
        raise ValueError(f"invalid worktree lifecycle status: {status}")

    if now is None:
        now = _utc_now_iso()

    absolute_path = str(Path(worktree_path).resolve())

    state: Dict[str, Any] = json.loads(state_path.read_text(encoding="utf-8"))
    workflow: Dict[str, Any] = state["workflow"] if isinstance(state.get("workflow"), dict) else {}
    worktrees: List[Dict[str, Any]] = workflow["worktrees"] if isinstance(workflow.get("worktrees"), list) else []

    # Find existing worktree by resolving stored path and comparing to absolutePath
    index = -1
    for i, wt in enumerate(worktrees):
        stored = wt.get("path") or wt.get("worktreePath") or ""
        if not stored:
            continue
        stored_p = Path(stored)
        if stored_p.is_absolute():
            resolved = str(stored_p)
        else:
            resolved = str((target_dir / stored).resolve())
        if resolved == absolute_path:
            index = i
            break

    previous: Dict[str, Any] = worktrees[index] if index >= 0 else {}

    basename = Path(absolute_path).name
    issue_part = str(issue) if issue is not None else "unknown"
    record: Dict[str, Any] = {
        **previous,
        "id": previous.get("id") or f"issue-{issue_part}-{basename}",
        "type": previous.get("type") or "issue",
        "status": status,
        "path": relative_path(target_dir, absolute_path),
        "absolutePath": absolute_path,
        "updatedAt": now,
    }

    if not previous.get("createdAt"):
        record["createdAt"] = now

    if issue is not None:
        record["issue"] = issue
    elif "issue" in record and "issue" not in previous:
        del record["issue"]

    if pr is not None:
        record["pr"] = pr

    if run_dir:
        if os.path.isabs(run_dir):
            record["runDir"] = relative_path(target_dir, run_dir)
        else:
            record["runDir"] = run_dir

    if base:
        record["base"] = base

    if slot is not None:
        record["slot"] = slot

    if status == "running":
        for key in _WORKTREE_TERMINAL_KEYS:
            record.pop(key, None)
    elif status == "completed":
        if not record.get("completedAt"):
            record["completedAt"] = now
    elif status == "merged":
        record["mergedAt"] = now
    elif status == "failed":
        record["failedAt"] = now
    elif status == "abandoned":
        record["abandonedAt"] = now

    if index >= 0:
        worktrees[index] = record
    else:
        worktrees.append(record)

    workflow["worktrees"] = worktrees
    state["workflow"] = workflow
    state["updatedAt"] = now
    write_state(state_path, state)


def update_run_state(target_dir: Path, event: str, *, run_id: str, issue: int,
                     agent: str, phase: Optional[str], picked_at: str,
                     finished_at: str, exit_status: int, prompt_file: str,
                     metadata_file: str, run_dir: str,
                     execution_attempt: int = 1, max_execution_attempts: int = 5,
                     failed_verification_attempts: int = 0,
                     verifier_findings_file: str = "", blocked_reason: str = "",
                     issue_context: str = "", context_pack_file: str = "",
                     now: Optional[str] = None) -> None:
    """Port of legacy update_run_state (scripts/agentrail-legacy:5991-6186).
    Reads <target_dir>/.agentrail/state.json, mutates workflow for a run 'start' or
    'finish' (any non-'start') event, writes it back atomically. If the state file
    does not exist, returns without doing anything (legacy:6013)."""
    state_path = target_dir / ".agentrail" / "state.json"
    if not state_path.exists():
        return

    # legacy: const now = new Date().toISOString(); — accept param for determinism
    if now is None:
        now = _utc_now_iso()

    state: Dict[str, Any] = json.loads(state_path.read_text(encoding="utf-8"))
    workflow: Dict[str, Any] = state["workflow"] if isinstance(state.get("workflow"), dict) else {}
    completed_runs: List[Dict[str, Any]] = workflow["completedRuns"] if isinstance(workflow.get("completedRuns"), list) else []

    active_phase: Optional[str] = phase or None

    # Build run dict (legacy 6127-6149)
    run: Dict[str, Any] = {
        "runId": run_id,
        "targetType": "issue",
        "targetIssue": issue,
        "agent": agent,
        "status": "running" if event == "start" else ("completed" if exit_status == 0 else "failed"),
        "activePhase": active_phase,
        "executionAttempt": execution_attempt,
        "maxExecutionAttempts": max_execution_attempts,
        "failedVerificationAttempts": failed_verification_attempts,
        "pickedAt": picked_at,
        "promptFile": relative_path(target_dir, prompt_file),
        "metadataFile": relative_path(target_dir, metadata_file),
        "runDir": relative_path(target_dir, run_dir),
    }
    if verifier_findings_file:
        run["verifierFindingsFile"] = relative_path(target_dir, verifier_findings_file)
    if blocked_reason:
        run["blockedReason"] = blocked_reason
    if context_pack_file:
        run["contextPackFile"] = context_pack_file  # NOT made relative (legacy 6144)
    if event != "start":
        run["completedAt"] = finished_at
        run["exitStatus"] = exit_status

    if event == "start":
        # legacy 6151-6162
        workflow["phase"] = active_phase or "implementation"
        workflow["activePhase"] = active_phase
        workflow["activeIssue"] = issue
        upsert_issue_goal(workflow, issue, issue_context, "active", now, "")
        previous_run = (
            workflow["activeRun"]
            if (isinstance(workflow.get("activeRun"), dict) and workflow["activeRun"].get("runId") == run["runId"])
            else {}
        )
        workflow["activeRun"] = {
            **previous_run,
            **run,
            "phases": previous_run["phases"] if isinstance(previous_run.get("phases"), list) else [],
        }
        workflow["nextSuggestedAction"] = (
            f"Continue issue #{issue}"
            + (f" {active_phase} phase;" if active_phase else ";")
            + f" active run metadata is {run['metadataFile']}."
        )
    else:
        # legacy 6163-6178
        workflow["activeRun"] = None
        workflow["activePhase"] = None
        if workflow.get("activeIssue") == issue:
            workflow["activeIssue"] = None
        workflow["phase"] = "completed" if exit_status == 0 else "blocked"
        lifecycle_reason = blocked_reason or (
            "" if exit_status == 0
            else (
                f"Agent run for issue #{issue}"
                + (f" failed during {active_phase} phase" if active_phase else " failed")
                + "."
            )
        )
        upsert_issue_goal(
            workflow, issue, issue_context,
            "completed" if exit_status == 0 else "blocked",
            finished_at or now,
            lifecycle_reason,
        )
        workflow["lastCompletedStep"] = (
            f"issue-{issue}-{active_phase}-{run['status']}"
            if active_phase
            else f"issue-{issue}-{run['status']}"
        )
        if exit_status == 0:
            workflow["nextSuggestedAction"] = (
                f"Review or merge the PR for issue #{issue}, then pick the next ready issue."
            )
        elif blocked_reason:
            workflow["nextSuggestedAction"] = (
                f"Agent run for issue #{issue} blocked: {blocked_reason}; inspect {run['metadataFile']}"
                + (f" and {run['verifierFindingsFile']}" if run.get("verifierFindingsFile") else "")
                + "."
            )
        else:
            workflow["nextSuggestedAction"] = (
                f"Agent run for issue #{issue}"
                + (f" failed during {active_phase} phase" if active_phase else " failed")
                + f"; inspect {run['metadataFile']} and rerun or mark blocked."
            )
        completed_runs.append(run)
        workflow["completedRuns"] = completed_runs[-20:]

    # legacy 6180-6185
    state["workflow"] = {
        **workflow,
        "completedRuns": completed_runs[-20:] if event == "start" else workflow["completedRuns"],
    }
    state["updatedAt"] = now
    write_state(state_path, state)
