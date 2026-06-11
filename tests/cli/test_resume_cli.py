from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

from agentrail.cli.commands.resume import run_resume


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_state(tmp_path: Path) -> None:
    """Write a minimal valid state.json so render_resume takes the state path."""
    run_dir = tmp_path / ".agentrail" / "runs" / "r1"
    run_dir.mkdir(parents=True, exist_ok=True)
    state = {
        "agentrailVersion": "0.0.1",
        "workflow": {
            "phase": "implementation",
            "activePhase": "execution",
            "activeIssue": 42,
            "activePullRequest": None,
            "activePrd": None,
            "activeMilestone": None,
            "lastCompletedStep": None,
            "nextSuggestedAction": "Continue issue #42",
            "activeRun": {
                "runId": "r1",
                "targetType": "issue",
                "targetIssue": 42,
                "agent": "codex",
                "status": "running",
                "maxExecutionAttempts": 3,
                "executionAttempt": 1,
                "failedVerificationAttempts": 0,
                "runDir": ".agentrail/runs/r1",
            },
            "completedRuns": [],
            "goals": [],
        },
    }
    state_path = tmp_path / ".agentrail" / "state.json"
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# run_resume — no-state dir, basic invocation
# ---------------------------------------------------------------------------

class TestRunResumeNoState:
    def test_returns_zero(self, tmp_path, capsys):
        rc = run_resume(["--target", str(tmp_path)], now="20260101-000000")
        assert rc == 0

    def test_writes_handoff_file(self, tmp_path, capsys):
        rc = run_resume(["--target", str(tmp_path)], now="20260101-000000")
        expected = tmp_path / ".agentrail" / "handoffs" / "20260101-000000-resume.md"
        assert expected.exists(), "handoff file should be written"

    def test_handoff_file_content_contains_header(self, tmp_path, capsys):
        run_resume(["--target", str(tmp_path)], now="20260101-000000")
        f = tmp_path / ".agentrail" / "handoffs" / "20260101-000000-resume.md"
        assert "# AgentRail Resume" in f.read_text(encoding="utf-8")

    def test_stdout_contains_handoff_line(self, tmp_path, capsys):
        run_resume(["--target", str(tmp_path)], now="20260101-000000")
        out = capsys.readouterr().out
        assert "handoff:" in out

    def test_stdout_contains_body(self, tmp_path, capsys):
        run_resume(["--target", str(tmp_path)], now="20260101-000000")
        out = capsys.readouterr().out
        assert "# AgentRail Resume" in out


# ---------------------------------------------------------------------------
# run_resume — with state
# ---------------------------------------------------------------------------

class TestRunResumeWithState:
    def test_returns_zero_with_state(self, tmp_path, capsys):
        _make_state(tmp_path)
        rc = run_resume(["--target", str(tmp_path)], now="20260601-120000")
        assert rc == 0

    def test_handoff_file_contains_active_issue(self, tmp_path, capsys):
        _make_state(tmp_path)
        run_resume(["--target", str(tmp_path)], now="20260601-120000")
        f = tmp_path / ".agentrail" / "handoffs" / "20260601-120000-resume.md"
        assert "active issue: 42" in f.read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# run_resume — --output flag
# ---------------------------------------------------------------------------

class TestRunResumeCustomOutput:
    def test_custom_output_path(self, tmp_path, capsys):
        custom = tmp_path / "out" / "my-resume.md"
        rc = run_resume(
            ["--target", str(tmp_path), "--output", str(custom)],
            now="20260101-000000",
        )
        assert rc == 0
        assert custom.exists(), "custom output file should be written"

    def test_custom_output_has_body(self, tmp_path, capsys):
        custom = tmp_path / "out" / "my-resume.md"
        run_resume(["--target", str(tmp_path), "--output", str(custom)], now="20260101-000000")
        assert "# AgentRail Resume" in custom.read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# parse_resume_args — error paths
# ---------------------------------------------------------------------------

class TestParseResumeArgs:
    def test_unknown_option_returns_rc2(self, tmp_path, capsys):
        rc = run_resume(["--target", str(tmp_path), "--unknown-flag"], now="20260101-000000")
        assert rc == 2

    def test_help_flag_returns_rc0(self, tmp_path, capsys):
        rc = run_resume(["-h"], now="20260101-000000")
        assert rc == 0

    def test_help_long_flag_returns_rc0(self, tmp_path, capsys):
        rc = run_resume(["--help"], now="20260101-000000")
        assert rc == 0


# ---------------------------------------------------------------------------
# run_resume — full state fixture (port of bash test-resume-handoff)
# ---------------------------------------------------------------------------

_FULL_STATE = {
    "agentrailVersion": "0.1.0",
    "installedAt": "2026-05-26T10:00:00Z",
    "updatedAt": "2026-05-26T11:00:00Z",
    "legacyAdopted": False,
    "workflow": {
        "phase": "implementation",
        "activePhase": "execute",
        "activeIssue": 13,
        "activePullRequest": 23,
        "activePrd": "docs/prd/agentrail.md",
        "activeMilestone": "docs/milestones/001-agentrail.md",
        "activeRun": {
            "runId": "20260526-110000-issue-13-codex-100",
            "targetType": "issue",
            "targetIssue": 13,
            "agent": "codex",
            "status": "running",
            "pickedAt": "2026-05-26T11:00:00Z",
            "runDir": ".agentrail/runs/20260526-110000-issue-13-codex-100",
            "contextPackFile": ".agentrail/context/packs/issue-13-execute-20260526T110000000Z.json",
        },
        "completedRuns": [
            {
                "runId": "20260526-100000-issue-8-codex-99",
                "targetType": "issue",
                "targetIssue": 8,
                "agent": "codex",
                "status": "completed",
                "executionAttempt": 2,
                "maxExecutionAttempts": 5,
                "failedVerificationAttempts": 1,
            },
            {
                "runId": "20260526-103000-issue-9-codex-98",
                "targetType": "issue",
                "targetIssue": 9,
                "agent": "codex",
                "status": "failed",
                "executionAttempt": 5,
                "maxExecutionAttempts": 5,
                "failedVerificationAttempts": 5,
                "blockedReason": "maximum verifier retry attempts reached after 5 execution attempts",
            },
        ],
        "goals": [
            {
                "id": "issue-13",
                "kind": "issue",
                "status": "active",
                "summary": "Implement resume and handoff support",
                "successCriteria": [
                    "agentrail status prints active run state",
                    "agentrail resume writes a handoff",
                ],
                "activeIssue": 13,
                "activePullRequest": 23,
            },
        ],
        "lastCompletedStep": "runner-adapter-merged",
        "nextSuggestedAction": "Implement resume and handoff support.",
    },
}


class TestRunResumeFullState:
    """Port of bash test-resume-handoff: full state fixture assertions."""

    def _write_full_state(self, tmp_path: Path) -> None:
        state_dir = tmp_path / ".agentrail"
        state_dir.mkdir(parents=True, exist_ok=True)
        (state_dir / "state.json").write_text(
            json.dumps(_FULL_STATE, indent=2) + "\n", encoding="utf-8"
        )

    def _run_resume(self, tmp_path: Path, extra_args=None):
        import io
        args = ["--target", str(tmp_path)] + (extra_args or [])
        buf = io.StringIO()
        with patch("sys.stdout", buf):
            rc = run_resume(args, now="20260526-110001")
        return rc, buf.getvalue()

    def test_codex_desktop_instruction_in_stdout(self, tmp_path):
        self._write_full_state(tmp_path)
        rc, out = self._run_resume(tmp_path)
        assert "do not rely on previous chat context" in out

    def test_active_phase_in_resume(self, tmp_path):
        self._write_full_state(tmp_path)
        rc, out = self._run_resume(tmp_path)
        assert "active phase: execute" in out

    def test_active_issue_in_resume(self, tmp_path):
        self._write_full_state(tmp_path)
        rc, out = self._run_resume(tmp_path)
        assert "active issue: 13" in out

    def test_active_pull_request_in_resume(self, tmp_path):
        self._write_full_state(tmp_path)
        rc, out = self._run_resume(tmp_path)
        assert "active pull request: 23" in out

    def test_active_run_in_resume(self, tmp_path):
        self._write_full_state(tmp_path)
        rc, out = self._run_resume(tmp_path)
        assert "active run: issue #13 via codex (running)" in out

    def test_active_context_pack_in_resume(self, tmp_path):
        self._write_full_state(tmp_path)
        rc, out = self._run_resume(tmp_path)
        assert "active context pack: .agentrail/context/packs/issue-13-execute-20260526T110000000Z.json" in out

    def test_active_goal_label_in_resume(self, tmp_path):
        self._write_full_state(tmp_path)
        rc, out = self._run_resume(tmp_path)
        assert "active goal: issue-13 active issue #13: Implement resume and handoff support" in out

    def test_success_criteria_count_in_resume(self, tmp_path):
        self._write_full_state(tmp_path)
        rc, out = self._run_resume(tmp_path)
        assert "success criteria: 2" in out

    def test_stale_active_run_in_resume(self, tmp_path):
        self._write_full_state(tmp_path)
        rc, out = self._run_resume(tmp_path)
        # runDir does not exist on disk → stale
        assert "active run stale: run dir missing: .agentrail/runs/20260526-110000-issue-13-codex-100" in out

    def test_completed_run_issue8_in_resume(self, tmp_path):
        self._write_full_state(tmp_path)
        rc, out = self._run_resume(tmp_path)
        assert "completed run: issue #8 via codex (completed)" in out

    def test_completed_run_attempts_in_resume(self, tmp_path):
        self._write_full_state(tmp_path)
        rc, out = self._run_resume(tmp_path)
        assert "completed run attempts: 2/5; failed verify attempts: 1" in out

    def test_completed_run_issue9_failed_in_resume(self, tmp_path):
        self._write_full_state(tmp_path)
        rc, out = self._run_resume(tmp_path)
        assert "completed run: issue #9 via codex (failed)" in out

    def test_completed_run_blocked_reason_in_resume(self, tmp_path):
        self._write_full_state(tmp_path)
        rc, out = self._run_resume(tmp_path)
        assert "completed run blocked reason: maximum verifier retry attempts reached after 5 execution attempts" in out

    def test_last_completed_step_in_resume(self, tmp_path):
        self._write_full_state(tmp_path)
        rc, out = self._run_resume(tmp_path)
        assert "last completed step: runner-adapter-merged" in out

    def test_next_action_in_resume(self, tmp_path):
        self._write_full_state(tmp_path)
        rc, out = self._run_resume(tmp_path)
        assert "next action: Implement resume and handoff support." in out

    def test_verification_commands_in_resume(self, tmp_path):
        self._write_full_state(tmp_path)
        rc, out = self._run_resume(tmp_path)
        assert "Verification commands:" in out

    def test_docs_agentrail_state_in_resume(self, tmp_path):
        self._write_full_state(tmp_path)
        rc, out = self._run_resume(tmp_path)
        assert "docs/agents/agentrail-state.md" in out

    def test_handoff_path_in_stdout(self, tmp_path):
        self._write_full_state(tmp_path)
        rc, out = self._run_resume(tmp_path)
        assert "handoff:" in out

    def test_handoff_file_written_with_active_issue(self, tmp_path):
        self._write_full_state(tmp_path)
        self._run_resume(tmp_path)
        handoff = tmp_path / ".agentrail" / "handoffs" / "20260526-110001-resume.md"
        assert handoff.exists()
        assert "active issue: 13" in handoff.read_text(encoding="utf-8")


class TestRunResumeMissingStateAssertions:
    """Port of bash test-resume-handoff: missing state assertions."""

    def test_missing_state_contains_not_found_message(self, tmp_path, capsys):
        run_resume(["--target", str(tmp_path)], now="20260101-000000")
        out = capsys.readouterr().out
        assert "AgentRail state was not found" in out

    def test_missing_state_contains_codex_desktop_instruction(self, tmp_path, capsys):
        run_resume(["--target", str(tmp_path)], now="20260101-000000")
        out = capsys.readouterr().out
        assert "do not rely on previous chat context" in out

    def test_missing_state_recommends_install(self, tmp_path, capsys):
        run_resume(["--target", str(tmp_path)], now="20260101-000000")
        out = capsys.readouterr().out
        assert f"agentrail install --target {tmp_path}" in out


# ---------------------------------------------------------------------------
# main.py routes "resume" to run_resume
# ---------------------------------------------------------------------------

class TestMainRouting:
    def test_resume_routed_via_main(self, tmp_path, capsys):
        from agentrail.cli import main as main_mod
        # Patch run_resume so we just check routing
        with patch("agentrail.cli.main.run_resume", return_value=0) as mock_resume:
            rc = main_mod.main(["resume", "--target", str(tmp_path)])
        assert rc == 0
        mock_resume.assert_called_once_with(["--target", str(tmp_path)])
