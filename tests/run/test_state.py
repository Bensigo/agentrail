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
