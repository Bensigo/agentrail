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
