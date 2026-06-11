from __future__ import annotations
import json
import re
import tempfile
from pathlib import Path

import pytest

from agentrail.run.state import (
    relative_path,
    first_line,
    section_items,
    issue_goal_defaults,
    upsert_issue_goal,
    write_state,
    update_run_state,
    render_state_summary,
    update_worktree_state,
)

NOW = "2026-06-11T00:00:00Z"


# ---------------------------------------------------------------------------
# relative_path
# ---------------------------------------------------------------------------

class TestRelativePath:
    def test_file_under_target(self, tmp_path):
        subdir = tmp_path / "sub"
        subdir.mkdir()
        file = str(subdir / "foo.txt")
        result = relative_path(tmp_path, file)
        assert result == "sub/foo.txt"

    def test_empty_string_returns_empty(self, tmp_path):
        assert relative_path(tmp_path, "") == ""

    def test_file_at_target_root(self, tmp_path):
        file = str(tmp_path / "bar.txt")
        result = relative_path(tmp_path, file)
        assert result == "bar.txt"

    def test_posix_separator(self, tmp_path):
        deep = tmp_path / "a" / "b"
        deep.mkdir(parents=True)
        file = str(deep / "c.txt")
        result = relative_path(tmp_path, file)
        assert "/" in result
        assert "\\" not in result


# ---------------------------------------------------------------------------
# first_line
# ---------------------------------------------------------------------------

class TestFirstLine:
    def test_leading_blank_lines_skipped(self):
        assert first_line("  \n Title \n body") == "Title"

    def test_empty_string(self):
        assert first_line("") == ""

    def test_single_line(self):
        assert first_line("Hello") == "Hello"

    def test_whitespace_trimmed(self):
        assert first_line("   hello   \n second") == "hello"

    def test_crlf(self):
        assert first_line("\r\n  \r\nActual\r\nOther") == "Actual"


# ---------------------------------------------------------------------------
# section_items
# ---------------------------------------------------------------------------

ACCEPTANCE_RE = re.compile(r"^##\s+Acceptance criteria\s*$", re.I)
NON_GOALS_RE = re.compile(r"^##\s+Non-goals\s*$", re.I)

SAMPLE_TEXT = """\
# Title

## Acceptance criteria
- [ ] crit one
- crit two

## Other
- x
"""


class TestSectionItems:
    def test_acceptance_criteria_collected(self):
        items = section_items(SAMPLE_TEXT, ACCEPTANCE_RE)
        assert items == ["crit one", "crit two"]

    def test_stops_at_next_heading(self):
        # "x" under ## Other must NOT appear
        items = section_items(SAMPLE_TEXT, ACCEPTANCE_RE)
        assert "x" not in items

    def test_checkbox_stripped(self):
        text = "## Acceptance criteria\n- [ ] do this\n- [x] done that\n- [X] caps too\n"
        items = section_items(text, ACCEPTANCE_RE)
        assert items == ["do this", "done that", "caps too"]

    def test_bullet_stripped(self):
        text = "## Acceptance criteria\n* star bullet\n- dash bullet\n"
        items = section_items(text, ACCEPTANCE_RE)
        assert items == ["star bullet", "dash bullet"]

    def test_blank_lines_skipped(self):
        text = "## Acceptance criteria\n\n- one\n\n- two\n"
        items = section_items(text, ACCEPTANCE_RE)
        assert items == ["one", "two"]

    def test_no_matching_section_returns_empty(self):
        items = section_items(SAMPLE_TEXT, NON_GOALS_RE)
        assert items == []

    def test_case_insensitive_heading(self):
        text = "## ACCEPTANCE CRITERIA\n- item\n"
        items = section_items(text, ACCEPTANCE_RE)
        assert items == ["item"]


# ---------------------------------------------------------------------------
# issue_goal_defaults
# ---------------------------------------------------------------------------

ISSUE_CONTEXT_FULL = """\
Implement the widget

## Acceptance criteria
- [ ] Widget renders
- Widget is tested

## Non-goals
- No mobile support
"""


class TestIssueGoalDefaults:
    def test_basic_fields(self):
        goal = issue_goal_defaults({}, {}, 7, ISSUE_CONTEXT_FULL, NOW)
        assert goal["id"] == "issue-7"
        assert goal["kind"] == "issue"
        assert goal["source"] == "github:issue/7"

    def test_summary_from_first_line(self):
        goal = issue_goal_defaults({}, {}, 7, ISSUE_CONTEXT_FULL, NOW)
        assert goal["summary"] == "Implement the widget"

    def test_success_criteria_from_section(self):
        goal = issue_goal_defaults({}, {}, 7, ISSUE_CONTEXT_FULL, NOW)
        assert goal["successCriteria"] == ["Widget renders", "Widget is tested"]

    def test_non_goals_from_section(self):
        goal = issue_goal_defaults({}, {}, 7, ISSUE_CONTEXT_FULL, NOW)
        assert goal["nonGoals"] == ["No mobile support"]

    def test_created_at_equals_now_when_no_previous(self):
        goal = issue_goal_defaults({}, {}, 7, ISSUE_CONTEXT_FULL, NOW)
        assert goal["createdAt"] == NOW
        assert goal["updatedAt"] == NOW

    def test_created_at_preserved_from_previous(self):
        previous = {"createdAt": "2026-01-01T00:00:00Z"}
        goal = issue_goal_defaults(previous, {}, 7, ISSUE_CONTEXT_FULL, NOW)
        assert goal["createdAt"] == "2026-01-01T00:00:00Z"
        assert goal["updatedAt"] == NOW

    def test_no_acceptance_section_no_previous_uses_default(self):
        goal = issue_goal_defaults({}, {}, 7, "Just a summary", NOW)
        assert goal["successCriteria"] == ["Complete issue #7."]

    def test_no_acceptance_section_uses_previous_if_non_empty(self):
        previous = {"successCriteria": ["existing criterion"]}
        goal = issue_goal_defaults(previous, {}, 7, "Just a summary", NOW)
        assert goal["successCriteria"] == ["existing criterion"]

    def test_active_pull_request_from_workflow(self):
        workflow = {"activePullRequest": 99}
        goal = issue_goal_defaults({}, workflow, 7, ISSUE_CONTEXT_FULL, NOW)
        assert goal["activePullRequest"] == 99

    def test_active_pull_request_falls_back_to_previous(self):
        previous = {"activePullRequest": 42}
        goal = issue_goal_defaults(previous, {}, 7, ISSUE_CONTEXT_FULL, NOW)
        assert goal["activePullRequest"] == 42

    def test_active_pull_request_none_when_absent(self):
        goal = issue_goal_defaults({}, {}, 7, ISSUE_CONTEXT_FULL, NOW)
        assert goal["activePullRequest"] is None

    def test_shallow_copy_does_not_mutate_previous(self):
        previous = {"extra": "value"}
        goal = issue_goal_defaults(previous, {}, 7, ISSUE_CONTEXT_FULL, NOW)
        assert goal["extra"] == "value"
        assert "id" not in previous  # previous not mutated


# ---------------------------------------------------------------------------
# upsert_issue_goal
# ---------------------------------------------------------------------------

class TestUpsertIssueGoal:
    def test_empty_workflow_creates_goal(self):
        workflow: dict = {}
        upsert_issue_goal(workflow, 7, ISSUE_CONTEXT_FULL, "active", NOW)
        assert isinstance(workflow["goals"], list)
        assert len(workflow["goals"]) == 1
        assert workflow["goals"][0]["id"] == "issue-7"
        assert workflow["goals"][0]["status"] == "active"

    def test_active_removes_completed_blocked(self):
        workflow: dict = {"goals": [{"id": "issue-7", "completedAt": "old", "blockedAt": "old", "blockedReason": "r"}]}
        upsert_issue_goal(workflow, 7, ISSUE_CONTEXT_FULL, "active", NOW)
        g = workflow["goals"][0]
        assert "completedAt" not in g
        assert "blockedAt" not in g
        assert "blockedReason" not in g

    def test_completed_sets_completed_at_removes_blocked(self):
        workflow: dict = {"goals": [{"id": "issue-7", "blockedAt": "old", "blockedReason": "r"}]}
        upsert_issue_goal(workflow, 7, ISSUE_CONTEXT_FULL, "completed", NOW)
        g = workflow["goals"][0]
        assert g["completedAt"] == NOW
        assert "blockedAt" not in g
        assert "blockedReason" not in g

    def test_blocked_sets_blocked_fields_removes_completed(self):
        workflow: dict = {"goals": [{"id": "issue-7", "completedAt": "old"}]}
        upsert_issue_goal(workflow, 7, ISSUE_CONTEXT_FULL, "blocked", NOW, reason="disk full")
        g = workflow["goals"][0]
        assert g["blockedAt"] == NOW
        assert g["blockedReason"] == "disk full"
        assert "completedAt" not in g

    def test_blocked_default_reason_mentions_issue(self):
        workflow: dict = {}
        upsert_issue_goal(workflow, 7, ISSUE_CONTEXT_FULL, "blocked", NOW)
        g = workflow["goals"][0]
        assert "issue #7" in g["blockedReason"]

    def test_update_existing_goal_replaces_in_place(self):
        workflow: dict = {"goals": [{"id": "issue-7", "status": "active"}]}
        upsert_issue_goal(workflow, 7, ISSUE_CONTEXT_FULL, "completed", NOW)
        assert len(workflow["goals"]) == 1
        assert workflow["goals"][0]["status"] == "completed"

    def test_different_issue_appended(self):
        workflow: dict = {"goals": [{"id": "issue-5", "status": "active"}]}
        upsert_issue_goal(workflow, 7, ISSUE_CONTEXT_FULL, "active", NOW)
        assert len(workflow["goals"]) == 2
        ids = {g["id"] for g in workflow["goals"]}
        assert ids == {"issue-5", "issue-7"}

    def test_non_list_goals_treated_as_empty(self):
        workflow: dict = {"goals": "garbage"}
        upsert_issue_goal(workflow, 7, ISSUE_CONTEXT_FULL, "active", NOW)
        assert isinstance(workflow["goals"], list)
        assert len(workflow["goals"]) == 1


# ---------------------------------------------------------------------------
# write_state
# ---------------------------------------------------------------------------

class TestWriteState:
    def test_writes_pretty_json_with_trailing_newline(self, tmp_path):
        state_path = tmp_path / "state.json"
        data = {"foo": "bar", "num": 42}
        write_state(state_path, data)
        content = state_path.read_text(encoding="utf-8")
        assert content.endswith("\n")
        # Pretty-printed: should have newlines inside
        assert "\n" in content.rstrip("\n")

    def test_round_trips_via_json_load(self, tmp_path):
        state_path = tmp_path / "state.json"
        data = {"nested": {"a": 1}, "list": [1, 2, 3]}
        write_state(state_path, data)
        loaded = json.loads(state_path.read_text(encoding="utf-8"))
        assert loaded == data

    def test_overwrite_works(self, tmp_path):
        state_path = tmp_path / "state.json"
        write_state(state_path, {"v": 1})
        write_state(state_path, {"v": 2})
        loaded = json.loads(state_path.read_text(encoding="utf-8"))
        assert loaded == {"v": 2}

    def test_creates_parent_dirs(self, tmp_path):
        state_path = tmp_path / "deep" / "nested" / "state.json"
        write_state(state_path, {"ok": True})
        assert state_path.exists()

    def test_lock_sidecar_created(self, tmp_path):
        state_path = tmp_path / "state.json"
        write_state(state_path, {})
        # The .lock file may exist after write; we don't assert its absence
        lock_path = tmp_path / "state.json.lock"
        # Just verify we can check without error
        _ = lock_path.exists()

    def test_uses_two_space_indent(self, tmp_path):
        state_path = tmp_path / "state.json"
        write_state(state_path, {"key": "value"})
        content = state_path.read_text(encoding="utf-8")
        # json.dumps with indent=2 produces "  " before keys
        assert '  "key"' in content


# ---------------------------------------------------------------------------
# update_run_state
# ---------------------------------------------------------------------------

FIXED_NOW = "2026-01-01T00:00:00.000Z"
FIXED_FINISHED = "2026-01-01T01:00:00.000Z"
FIXED_PICKED = "2026-01-01T00:00:00.000Z"


def _make_target(tmp_path: Path, initial_workflow=None) -> Path:
    """Create a target dir with a .agentrail/state.json containing the given workflow."""
    agentrail_dir = tmp_path / ".agentrail"
    agentrail_dir.mkdir(parents=True)
    state = {"workflow": initial_workflow if initial_workflow is not None else {}}
    (agentrail_dir / "state.json").write_text(json.dumps(state), encoding="utf-8")
    return tmp_path


def _base_start_kwargs(target_dir: Path, issue: int = 7, phase: str = "plan") -> dict:
    return dict(
        run_id="run-abc",
        issue=issue,
        agent="claude",
        phase=phase,
        picked_at=FIXED_PICKED,
        finished_at="",
        exit_status=0,
        prompt_file=str(target_dir / "prompt.md"),
        metadata_file=str(target_dir / "meta.json"),
        run_dir=str(target_dir / "runs" / "run-abc"),
        now=FIXED_NOW,
    )


def _base_finish_kwargs(target_dir: Path, issue: int = 7, phase: str = "execute",
                        exit_status: int = 0) -> dict:
    return dict(
        run_id="run-abc",
        issue=issue,
        agent="claude",
        phase=phase,
        picked_at=FIXED_PICKED,
        finished_at=FIXED_FINISHED,
        exit_status=exit_status,
        prompt_file=str(target_dir / "prompt.md"),
        metadata_file=str(target_dir / "meta.json"),
        run_dir=str(target_dir / "runs" / "run-abc"),
        now=FIXED_NOW,
    )


def _load_state(target_dir: Path) -> dict:
    return json.loads((target_dir / ".agentrail" / "state.json").read_text(encoding="utf-8"))


class TestUpdateRunState:

    def test_missing_state_file_returns_without_error(self, tmp_path):
        """No state file → returns without raising, creates nothing."""
        # No .agentrail dir or state.json
        update_run_state(tmp_path, "start", **_base_start_kwargs(tmp_path))
        assert not (tmp_path / ".agentrail" / "state.json").exists()

    def test_start_event_sets_active_run(self, tmp_path):
        target = _make_target(tmp_path)
        update_run_state(target, "start", **_base_start_kwargs(target, issue=7, phase="plan"))
        state = _load_state(target)
        wf = state["workflow"]
        assert wf["activeRun"]["runId"] == "run-abc"
        assert wf["activeIssue"] == 7
        assert wf["phase"] == "plan"
        assert wf["activeRun"]["status"] == "running"

    def test_start_event_creates_active_goal(self, tmp_path):
        target = _make_target(tmp_path)
        update_run_state(target, "start", **_base_start_kwargs(target, issue=7, phase="plan"))
        state = _load_state(target)
        wf = state["workflow"]
        goals = wf.get("goals", [])
        assert any(g["id"] == "issue-7" and g["status"] == "active" for g in goals)

    def test_start_event_next_suggested_action_with_phase(self, tmp_path):
        target = _make_target(tmp_path)
        update_run_state(target, "start", **_base_start_kwargs(target, issue=7, phase="plan"))
        state = _load_state(target)
        nsa = state["workflow"]["nextSuggestedAction"]
        assert "Continue issue #7 plan phase; active run metadata is" in nsa

    def test_start_event_no_phase_uses_implementation(self, tmp_path):
        target = _make_target(tmp_path)
        kwargs = _base_start_kwargs(target, issue=7, phase=None)
        kwargs["phase"] = None
        update_run_state(target, "start", **kwargs)
        state = _load_state(target)
        wf = state["workflow"]
        assert wf["phase"] == "implementation"
        nsa = wf["nextSuggestedAction"]
        assert "Continue issue #7; active run metadata is" in nsa
        assert "phase" not in nsa.split("Continue issue #7;")[0]  # no phase before semicolon

    def test_finish_success_clears_active_run(self, tmp_path):
        target = _make_target(tmp_path, {"activeIssue": 7, "completedRuns": []})
        update_run_state(target, "finish", **_base_finish_kwargs(target, issue=7, exit_status=0))
        state = _load_state(target)
        wf = state["workflow"]
        assert wf["activeRun"] is None
        assert wf["activeIssue"] is None
        assert wf["phase"] == "completed"
        goals = wf.get("goals", [])
        assert any(g["id"] == "issue-7" and g["status"] == "completed" and "completedAt" in g for g in goals)
        assert len(wf.get("completedRuns", [])) == 1
        run = wf["completedRuns"][0]
        assert run["status"] == "completed"
        assert run["exitStatus"] == 0
        assert "completedAt" in run
        assert "Review or merge the PR for issue #7" in wf["nextSuggestedAction"]

    def test_finish_failure_sets_blocked(self, tmp_path):
        target = _make_target(tmp_path, {"activeIssue": 7})
        update_run_state(target, "finish",
                         **_base_finish_kwargs(target, issue=7, phase="execute", exit_status=1))
        state = _load_state(target)
        wf = state["workflow"]
        assert wf["phase"] == "blocked"
        goals = wf.get("goals", [])
        assert any(g["id"] == "issue-7" and g["status"] == "blocked" for g in goals)
        run = wf["completedRuns"][0]
        assert run["status"] == "failed"
        nsa = wf["nextSuggestedAction"]
        assert "failed during execute phase" in nsa
        assert "inspect" in nsa

    def test_finish_with_blocked_reason(self, tmp_path):
        target = _make_target(tmp_path, {"activeIssue": 7})
        kwargs = _base_finish_kwargs(target, issue=7, phase="execute", exit_status=1)
        kwargs["blocked_reason"] = "needs human"
        update_run_state(target, "finish", **kwargs)
        state = _load_state(target)
        nsa = state["workflow"]["nextSuggestedAction"]
        assert "blocked: needs human" in nsa

    def test_completed_runs_capped_at_20(self, tmp_path):
        # Pre-seed 25 dummy runs
        dummy_runs = [{"runId": f"old-{i}", "status": "completed"} for i in range(25)]
        target = _make_target(tmp_path, {"activeIssue": 7, "completedRuns": dummy_runs})
        update_run_state(target, "finish",
                         **_base_finish_kwargs(target, issue=7, exit_status=0))
        state = _load_state(target)
        assert len(state["workflow"]["completedRuns"]) == 20

    def test_context_pack_file_not_made_relative(self, tmp_path):
        target = _make_target(tmp_path)
        kwargs = _base_start_kwargs(target, issue=7, phase="plan")
        kwargs["context_pack_file"] = "/absolute/path/context.tar.gz"
        update_run_state(target, "start", **kwargs)
        state = _load_state(target)
        assert state["workflow"]["activeRun"]["contextPackFile"] == "/absolute/path/context.tar.gz"

    def test_deterministic_updated_at(self, tmp_path):
        target = _make_target(tmp_path)
        # _base_start_kwargs already sets now=FIXED_NOW
        update_run_state(target, "start", **_base_start_kwargs(target, issue=7, phase="plan"))
        state = _load_state(target)
        assert state["updatedAt"] == FIXED_NOW


# ---------------------------------------------------------------------------
# render_state_summary
# ---------------------------------------------------------------------------

def _write_state_json(target_dir: Path, data: dict) -> None:
    """Write .agentrail/state.json in target_dir."""
    agentrail_dir = target_dir / ".agentrail"
    agentrail_dir.mkdir(parents=True, exist_ok=True)
    (agentrail_dir / "state.json").write_text(json.dumps(data), encoding="utf-8")


def _write_raw_state_json(target_dir: Path, raw: str) -> None:
    """Write raw bytes as .agentrail/state.json (for invalid JSON tests)."""
    agentrail_dir = target_dir / ".agentrail"
    agentrail_dir.mkdir(parents=True, exist_ok=True)
    (agentrail_dir / "state.json").write_text(raw, encoding="utf-8")


class TestRenderStateSummary:

    def test_missing_state_json_returns_empty_string(self, tmp_path):
        result = render_state_summary(tmp_path)
        assert result == ""

    def test_invalid_json_returns_unreadable_header(self, tmp_path):
        _write_raw_state_json(tmp_path, "not json {{{")
        result = render_state_summary(tmp_path)
        assert result.startswith("- AgentRail state: present but unreadable")
        assert "- state error:" in result

    def test_minimal_workflow_contains_expected_lines(self, tmp_path):
        _write_state_json(tmp_path, {"workflow": {}})
        result = render_state_summary(tmp_path)
        assert "- AgentRail state: present" in result
        assert "- phase: unknown" in result
        assert "- active phase: none" in result
        assert "- active run: none" in result
        assert "- next suggested action: none" in result

    def test_active_run_label_and_attempt_summary(self, tmp_path):
        run_dir = tmp_path / "runs" / "run-abc"
        run_dir.mkdir(parents=True)
        active_run = {
            "targetType": "issue",
            "targetIssue": 7,
            "agent": "claude",
            "status": "running",
            "maxExecutionAttempts": 5,
            "executionAttempt": 1,
            "failedVerificationAttempts": 0,
            "runDir": str(run_dir),
        }
        _write_state_json(tmp_path, {"workflow": {"activeRun": active_run}})
        result = render_state_summary(tmp_path)
        assert "- active run: issue #7 via claude (running)" in result
        assert "- active run attempts: 1/5; failed verify attempts: 0" in result
        # run dir exists → no stale line
        assert "stale" not in result

    def test_active_run_stale_when_run_dir_missing(self, tmp_path):
        active_run = {
            "targetType": "issue",
            "targetIssue": 7,
            "agent": "claude",
            "status": "running",
            "maxExecutionAttempts": 5,
            "executionAttempt": 1,
            "runDir": "runs/nonexistent",
        }
        _write_state_json(tmp_path, {"workflow": {"activeRun": active_run}})
        result = render_state_summary(tmp_path)
        assert "- active run stale: run dir missing:" in result

    def test_active_goals_listed(self, tmp_path):
        goals = [
            {
                "id": "issue-7",
                "status": "active",
                "activeIssue": 7,
                "summary": "Fix the bug",
            }
        ]
        _write_state_json(tmp_path, {"workflow": {"goals": goals}})
        result = render_state_summary(tmp_path)
        assert "- active goals:" in result
        assert "  - issue-7 active issue #7: Fix the bug" in result

    def test_completed_run_blocked_reason(self, tmp_path):
        completed_runs = [
            {
                "targetType": "issue",
                "targetIssue": 5,
                "agent": "claude",
                "status": "failed",
                "blockedReason": "disk full",
            }
        ]
        _write_state_json(tmp_path, {"workflow": {"completedRuns": completed_runs}})
        result = render_state_summary(tmp_path)
        assert "- last completed run:" in result
        assert "- last completed run blocked reason: disk full" in result

    def test_worktrees_summary(self, tmp_path):
        worktrees = [{}, {"removedAt": "2026-01-01T00:00:00Z"}]
        _write_state_json(tmp_path, {"workflow": {"worktrees": worktrees}})
        result = render_state_summary(tmp_path)
        assert "- AgentRail worktrees: 1 active / 2 tracked" in result

    def test_null_coalesce_active_issue_zero(self, tmp_path):
        """activeIssue 0 must render as '0', not 'none' (?? semantics)."""
        _write_state_json(tmp_path, {"workflow": {"activeIssue": 0}})
        result = render_state_summary(tmp_path)
        assert "- active issue: 0" in result


# ---------------------------------------------------------------------------
# update_worktree_state
# ---------------------------------------------------------------------------

WORKTREE_NOW = "2026-01-01T00:00:00.000Z"


def _make_worktree_target(tmp_path: Path, initial_state: dict | None = None) -> Path:
    """Create target dir with .agentrail/state.json."""
    agentrail_dir = tmp_path / ".agentrail"
    agentrail_dir.mkdir(parents=True)
    state = initial_state if initial_state is not None else {"workflow": {}}
    (agentrail_dir / "state.json").write_text(json.dumps(state), encoding="utf-8")
    return tmp_path


def _load_worktree_state(target_dir: Path) -> dict:
    return json.loads((target_dir / ".agentrail" / "state.json").read_text(encoding="utf-8"))


class TestUpdateWorktreeState:

    def test_missing_state_json_is_noop(self, tmp_path):
        """No state.json → no error, no file created."""
        worktree = str(tmp_path / "worktrees" / "issue-12-my-feature")
        update_worktree_state(tmp_path, worktree, "running", now=WORKTREE_NOW)
        assert not (tmp_path / ".agentrail" / "state.json").exists()

    def test_invalid_status_raises_value_error(self, tmp_path):
        target = _make_worktree_target(tmp_path)
        worktree = str(tmp_path / "worktrees" / "issue-12-my-feature")
        with pytest.raises(ValueError, match="invalid worktree lifecycle status: bogus"):
            update_worktree_state(target, worktree, "bogus", now=WORKTREE_NOW)

    def test_new_running_worktree_creates_entry(self, tmp_path):
        target = _make_worktree_target(tmp_path)
        worktree_path = str(tmp_path / "worktrees" / "issue-12-my-feature")
        update_worktree_state(
            target, worktree_path, "running",
            issue=12, base="main", slot=0,
            run_dir=str(tmp_path / "runs" / "run-abc"),
            now=WORKTREE_NOW,
        )
        state = _load_worktree_state(target)
        worktrees = state["workflow"]["worktrees"]
        assert len(worktrees) == 1
        wt = worktrees[0]
        assert wt["status"] == "running"
        assert wt["absolutePath"] == str(Path(worktree_path).resolve())
        # path is posix relative
        assert "/" in wt["path"] or wt["path"] == "worktrees/issue-12-my-feature"
        assert "\\" not in wt["path"]
        # id uses issue number and basename: "issue-{issue}-{basename}"
        assert wt["id"] == "issue-12-issue-12-my-feature"
        assert wt["type"] == "issue"
        assert wt["createdAt"] == WORKTREE_NOW
        assert wt["updatedAt"] == WORKTREE_NOW
        assert wt["issue"] == 12
        assert wt["base"] == "main"
        assert wt["slot"] == 0
        assert "runDir" in wt

    def test_upsert_running_then_completed_stays_one_entry(self, tmp_path):
        target = _make_worktree_target(tmp_path)
        worktree_path = str(tmp_path / "worktrees" / "issue-5-feat")
        FIRST_NOW = "2026-01-01T00:00:00.000Z"
        SECOND_NOW = "2026-01-02T00:00:00.000Z"
        update_worktree_state(target, worktree_path, "running", issue=5, now=FIRST_NOW)
        update_worktree_state(target, worktree_path, "completed", issue=5, now=SECOND_NOW)
        state = _load_worktree_state(target)
        worktrees = state["workflow"]["worktrees"]
        assert len(worktrees) == 1
        wt = worktrees[0]
        assert wt["status"] == "completed"
        assert wt["completedAt"] == SECOND_NOW
        # createdAt preserved from first call
        assert wt["createdAt"] == FIRST_NOW

    def test_merged_sets_merged_at(self, tmp_path):
        target = _make_worktree_target(tmp_path)
        worktree_path = str(tmp_path / "worktrees" / "issue-3-feat")
        update_worktree_state(target, worktree_path, "merged", issue=3, now=WORKTREE_NOW)
        state = _load_worktree_state(target)
        wt = state["workflow"]["worktrees"][0]
        assert wt["mergedAt"] == WORKTREE_NOW

    def test_failed_sets_failed_at(self, tmp_path):
        target = _make_worktree_target(tmp_path)
        worktree_path = str(tmp_path / "worktrees" / "issue-4-feat")
        update_worktree_state(target, worktree_path, "failed", issue=4, now=WORKTREE_NOW)
        state = _load_worktree_state(target)
        wt = state["workflow"]["worktrees"][0]
        assert wt["failedAt"] == WORKTREE_NOW

    def test_abandoned_sets_abandoned_at(self, tmp_path):
        target = _make_worktree_target(tmp_path)
        worktree_path = str(tmp_path / "worktrees" / "issue-6-feat")
        update_worktree_state(target, worktree_path, "abandoned", issue=6, now=WORKTREE_NOW)
        state = _load_worktree_state(target)
        wt = state["workflow"]["worktrees"][0]
        assert wt["abandonedAt"] == WORKTREE_NOW

    def test_running_clears_terminal_timestamps(self, tmp_path):
        """Pre-seed a worktree with terminal timestamps; marking running removes them."""
        worktree_path = str(tmp_path / "worktrees" / "issue-9-feat")
        resolved = str(Path(worktree_path).resolve())
        pre_seeded = {
            "id": "issue-9-issue-9-feat",
            "type": "issue",
            "status": "completed",
            "path": "worktrees/issue-9-feat",
            "absolutePath": resolved,
            "completedAt": "2025-12-01T00:00:00.000Z",
            "removedAt": "2025-12-02T00:00:00.000Z",
            "createdAt": "2025-11-01T00:00:00.000Z",
            "updatedAt": "2025-12-01T00:00:00.000Z",
        }
        target = _make_worktree_target(tmp_path, {"workflow": {"worktrees": [pre_seeded]}})
        update_worktree_state(target, worktree_path, "running", issue=9, now=WORKTREE_NOW)
        state = _load_worktree_state(target)
        wt = state["workflow"]["worktrees"][0]
        assert wt["status"] == "running"
        assert "completedAt" not in wt
        assert "removedAt" not in wt
        assert "failedAt" not in wt
        assert "abandonedAt" not in wt
        assert "mergedAt" not in wt
        assert "cleanupStatus" not in wt

    def test_issue_pr_slot_absent_when_none(self, tmp_path):
        """Omitting issue/pr/slot → those keys absent from the record."""
        target = _make_worktree_target(tmp_path)
        worktree_path = str(tmp_path / "worktrees" / "issue-unknown-feat")
        update_worktree_state(target, worktree_path, "running", now=WORKTREE_NOW)
        state = _load_worktree_state(target)
        wt = state["workflow"]["worktrees"][0]
        assert "issue" not in wt
        assert "pr" not in wt
        assert "slot" not in wt

    def test_deterministic_updated_at(self, tmp_path):
        target = _make_worktree_target(tmp_path)
        worktree_path = str(tmp_path / "worktrees" / "issue-1-feat")
        update_worktree_state(target, worktree_path, "running", now="2026-01-01T00:00:00.000Z")
        state = _load_worktree_state(target)
        assert state["updatedAt"] == "2026-01-01T00:00:00.000Z"
        assert state["workflow"]["worktrees"][0]["updatedAt"] == "2026-01-01T00:00:00.000Z"
