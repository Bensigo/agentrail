from __future__ import annotations
import json
import os
import re
import tempfile
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
