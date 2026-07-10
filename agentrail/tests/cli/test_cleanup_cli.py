"""
Tests for ``agentrail cleanup`` — native Python port.

All git subprocess calls are patched at ``agentrail.cli.commands.cleanup.subprocess.run``.
Real temp dirs are created for worktree paths so that ``Path.is_dir()`` checks work.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any, Dict, List
from unittest.mock import MagicMock, call, patch

import pytest

from agentrail.cli.commands.cleanup import run_cleanup


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_FIXED_NOW = "2026-01-01T00:00:00.000Z"


def _make_state(target: Path, worktrees: List[Dict[str, Any]]) -> None:
    """Write a minimal state.json with the given worktrees list."""
    state = {
        "agentrailVersion": "0.0.1",
        "workflow": {
            "phase": "implementation",
            "worktrees": worktrees,
        },
    }
    state_dir = target / ".agentrail"
    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / "state.json").write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")


def _read_state(target: Path) -> Dict[str, Any]:
    return json.loads((target / ".agentrail" / "state.json").read_text(encoding="utf-8"))


def _make_git_mock(prune_ok=True, status_outputs: Dict[str, str] | None = None,
                   remove_ok=True):
    """Return a side_effect callable that simulates git subprocess calls."""
    if status_outputs is None:
        status_outputs = {}

    def _side_effect(cmd, **kwargs):
        result = MagicMock()
        result.returncode = 0
        result.stdout = ""
        result.stderr = ""
        # cmd is a list like ["git", "-C", target, "worktree", "prune"]
        if "worktree" in cmd and "prune" in cmd:
            result.returncode = 0 if prune_ok else 1
        elif "status" in cmd and "--porcelain" in cmd:
            # cmd = ["git", "-C", <path>, "status", "--porcelain"]
            path = cmd[2]
            result.stdout = status_outputs.get(str(path), "")
            result.returncode = 0
        elif "worktree" in cmd and "remove" in cmd:
            result.returncode = 0 if remove_ok else 1
        return result

    return _side_effect


# ---------------------------------------------------------------------------
# No state.json → rc1, state_recommendation to stderr
# ---------------------------------------------------------------------------

class TestNoStateJson:
    def test_returns_rc1_when_no_state(self, tmp_path, capsys):
        rc = run_cleanup(["--target", str(tmp_path)], now=_FIXED_NOW)
        assert rc == 1

    def test_state_recommendation_on_stderr(self, tmp_path, capsys):
        run_cleanup(["--target", str(tmp_path)], now=_FIXED_NOW)
        err = capsys.readouterr().err
        assert "AgentRail state was not found" in err

    def test_state_recommendation_mentions_init(self, tmp_path, capsys):
        run_cleanup(["--target", str(tmp_path)], now=_FIXED_NOW)
        err = capsys.readouterr().err
        assert "agentrail init" in err


# ---------------------------------------------------------------------------
# Neither --merged nor --dry-run → rc2
# ---------------------------------------------------------------------------

class TestRequiresMergedOrDryRun:
    def test_rc2_without_merged_or_dry_run(self, tmp_path, capsys):
        _make_state(tmp_path, [])
        with patch("agentrail.cli.commands.cleanup.subprocess.run",
                   side_effect=_make_git_mock()):
            rc = run_cleanup(["--target", str(tmp_path)], now=_FIXED_NOW)
        assert rc == 2

    def test_error_message_on_stderr(self, tmp_path, capsys):
        _make_state(tmp_path, [])
        with patch("agentrail.cli.commands.cleanup.subprocess.run",
                   side_effect=_make_git_mock()):
            run_cleanup(["--target", str(tmp_path)], now=_FIXED_NOW)
        err = capsys.readouterr().err
        assert "cleanup requires --dry-run or --merged" in err


# ---------------------------------------------------------------------------
# Unknown option → rc2; -h → rc0
# ---------------------------------------------------------------------------

class TestArgParsing:
    def test_unknown_option_rc2(self, tmp_path, capsys):
        rc = run_cleanup(["--unknown-flag"], now=_FIXED_NOW)
        assert rc == 2

    def test_unknown_option_stderr(self, tmp_path, capsys):
        run_cleanup(["--unknown-flag"], now=_FIXED_NOW)
        err = capsys.readouterr().err
        assert "Unknown option" in err

    def test_help_short_rc0(self, capsys):
        rc = run_cleanup(["-h"], now=_FIXED_NOW)
        assert rc == 0

    def test_help_long_rc0(self, capsys):
        rc = run_cleanup(["--help"], now=_FIXED_NOW)
        assert rc == 0


# ---------------------------------------------------------------------------
# No candidates → prints message, rc0
# ---------------------------------------------------------------------------

class TestNoCandidates:
    def test_no_candidates_rc0(self, tmp_path, capsys):
        _make_state(tmp_path, [])
        with patch("agentrail.cli.commands.cleanup.subprocess.run",
                   side_effect=_make_git_mock()):
            rc = run_cleanup(["--target", str(tmp_path), "--merged"], now=_FIXED_NOW)
        assert rc == 0

    def test_no_candidates_message(self, tmp_path, capsys):
        _make_state(tmp_path, [])
        with patch("agentrail.cli.commands.cleanup.subprocess.run",
                   side_effect=_make_git_mock()):
            run_cleanup(["--target", str(tmp_path), "--merged"], now=_FIXED_NOW)
        out = capsys.readouterr().out
        assert "No matching AgentRail-owned worktrees found." in out

    def test_prints_cleanup_header(self, tmp_path, capsys):
        _make_state(tmp_path, [])
        with patch("agentrail.cli.commands.cleanup.subprocess.run",
                   side_effect=_make_git_mock()):
            run_cleanup(["--target", str(tmp_path), "--merged"], now=_FIXED_NOW)
        out = capsys.readouterr().out
        assert f"AgentRail cleanup: {tmp_path}" in out

    def test_all_removed_at_skipped(self, tmp_path, capsys):
        """Worktrees that already have removedAt should not appear."""
        _make_state(tmp_path, [
            {"id": "w1", "status": "merged", "path": "worktrees/w1", "removedAt": "2025-01-01T00:00:00.000Z"},
        ])
        with patch("agentrail.cli.commands.cleanup.subprocess.run",
                   side_effect=_make_git_mock()):
            rc = run_cleanup(["--target", str(tmp_path), "--merged"], now=_FIXED_NOW)
        assert rc == 0
        out = capsys.readouterr().out
        assert "No matching AgentRail-owned worktrees found." in out


# ---------------------------------------------------------------------------
# dry-run: merged worktree, dir present + clean → label printed, no removal
# ---------------------------------------------------------------------------

class TestDryRunCleanDir:
    def test_prints_label(self, tmp_path, capsys):
        wt_path = tmp_path / "worktrees" / "issue-10"
        wt_path.mkdir(parents=True)
        _make_state(tmp_path, [
            {"id": "w1", "issue": 10, "pr": 55, "status": "merged", "path": str(wt_path)},
        ])
        with patch("agentrail.cli.commands.cleanup.subprocess.run",
                   side_effect=_make_git_mock(status_outputs={str(wt_path): ""})):
            run_cleanup(["--target", str(tmp_path), "--dry-run"], now=_FIXED_NOW)
        out = capsys.readouterr().out
        assert "worktree issue #10 PR #55:" in out
        assert str(wt_path) in out
        assert "(merged)" in out

    def test_no_git_remove_called(self, tmp_path, capsys):
        wt_path = tmp_path / "worktrees" / "issue-10"
        wt_path.mkdir(parents=True)
        _make_state(tmp_path, [
            {"id": "w1", "issue": 10, "status": "merged", "path": str(wt_path)},
        ])
        with patch("agentrail.cli.commands.cleanup.subprocess.run") as mock_git:
            mock_git.side_effect = _make_git_mock(status_outputs={str(wt_path): ""})
            run_cleanup(["--target", str(tmp_path), "--dry-run"], now=_FIXED_NOW)
        remove_calls = [c for c in mock_git.call_args_list
                        if "worktree" in c.args[0] and "remove" in c.args[0]]
        assert remove_calls == []

    def test_returns_rc0(self, tmp_path, capsys):
        wt_path = tmp_path / "worktrees" / "issue-10"
        wt_path.mkdir(parents=True)
        _make_state(tmp_path, [
            {"id": "w1", "issue": 10, "status": "merged", "path": str(wt_path)},
        ])
        with patch("agentrail.cli.commands.cleanup.subprocess.run",
                   side_effect=_make_git_mock(status_outputs={str(wt_path): ""})):
            rc = run_cleanup(["--target", str(tmp_path), "--dry-run"], now=_FIXED_NOW)
        assert rc == 0

    def test_no_dirty_line_when_clean(self, tmp_path, capsys):
        wt_path = tmp_path / "worktrees" / "issue-10"
        wt_path.mkdir(parents=True)
        _make_state(tmp_path, [
            {"id": "w1", "issue": 10, "status": "merged", "path": str(wt_path)},
        ])
        with patch("agentrail.cli.commands.cleanup.subprocess.run",
                   side_effect=_make_git_mock(status_outputs={str(wt_path): ""})):
            run_cleanup(["--target", str(tmp_path), "--dry-run"], now=_FIXED_NOW)
        out = capsys.readouterr().out
        assert "  dirty: would skip without --force" not in out


# ---------------------------------------------------------------------------
# dry-run: dir missing → "  missing: stale state entry"
# ---------------------------------------------------------------------------

class TestDryRunMissingDir:
    def test_missing_dir_message(self, tmp_path, capsys):
        # Use a path that doesn't exist
        wt_path = tmp_path / "worktrees" / "nonexistent"
        _make_state(tmp_path, [
            {"id": "w1", "issue": 20, "status": "merged", "path": str(wt_path)},
        ])
        with patch("agentrail.cli.commands.cleanup.subprocess.run",
                   side_effect=_make_git_mock()):
            run_cleanup(["--target", str(tmp_path), "--dry-run"], now=_FIXED_NOW)
        out = capsys.readouterr().out
        assert "  missing: stale state entry" in out

    def test_returns_rc0_missing_dir(self, tmp_path, capsys):
        wt_path = tmp_path / "worktrees" / "nonexistent"
        _make_state(tmp_path, [
            {"id": "w1", "issue": 20, "status": "merged", "path": str(wt_path)},
        ])
        with patch("agentrail.cli.commands.cleanup.subprocess.run",
                   side_effect=_make_git_mock()):
            rc = run_cleanup(["--target", str(tmp_path), "--dry-run"], now=_FIXED_NOW)
        assert rc == 0


# ---------------------------------------------------------------------------
# dry-run: dir dirty → "  dirty: would skip without --force"
# ---------------------------------------------------------------------------

class TestDryRunDirtyDir:
    def test_dirty_message(self, tmp_path, capsys):
        wt_path = tmp_path / "worktrees" / "dirty-one"
        wt_path.mkdir(parents=True)
        _make_state(tmp_path, [
            {"id": "w1", "issue": 30, "status": "merged", "path": str(wt_path)},
        ])
        with patch("agentrail.cli.commands.cleanup.subprocess.run",
                   side_effect=_make_git_mock(status_outputs={str(wt_path): "M  somefile.py"})):
            run_cleanup(["--target", str(tmp_path), "--dry-run"], now=_FIXED_NOW)
        out = capsys.readouterr().out
        assert "  dirty: would skip without --force" in out

    def test_returns_rc0_dirty(self, tmp_path, capsys):
        wt_path = tmp_path / "worktrees" / "dirty-one"
        wt_path.mkdir(parents=True)
        _make_state(tmp_path, [
            {"id": "w1", "issue": 30, "status": "merged", "path": str(wt_path)},
        ])
        with patch("agentrail.cli.commands.cleanup.subprocess.run",
                   side_effect=_make_git_mock(status_outputs={str(wt_path): "M  somefile.py"})):
            rc = run_cleanup(["--target", str(tmp_path), "--dry-run"], now=_FIXED_NOW)
        assert rc == 0


# ---------------------------------------------------------------------------
# --merged: removes merged clean, skips non-merged
# ---------------------------------------------------------------------------

class TestMergedRemoval:
    def test_merged_clean_removed(self, tmp_path, capsys):
        wt_merged = tmp_path / "worktrees" / "merged-one"
        wt_merged.mkdir(parents=True)
        wt_running = tmp_path / "worktrees" / "running-one"
        wt_running.mkdir(parents=True)
        _make_state(tmp_path, [
            {"id": "w1", "issue": 40, "status": "merged", "path": str(wt_merged)},
            {"id": "w2", "issue": 41, "status": "running", "path": str(wt_running)},
        ])
        with patch("agentrail.cli.commands.cleanup.subprocess.run") as mock_git:
            mock_git.side_effect = _make_git_mock(status_outputs={str(wt_merged): ""})
            rc = run_cleanup(["--target", str(tmp_path), "--merged"], now=_FIXED_NOW)
        out = capsys.readouterr().out
        assert "  removed" in out
        assert rc == 0

    def test_non_merged_skipped(self, tmp_path, capsys):
        wt_merged = tmp_path / "worktrees" / "merged-one"
        wt_merged.mkdir(parents=True)
        wt_running = tmp_path / "worktrees" / "running-one"
        wt_running.mkdir(parents=True)
        _make_state(tmp_path, [
            {"id": "w1", "issue": 40, "status": "merged", "path": str(wt_merged)},
            {"id": "w2", "issue": 41, "status": "running", "path": str(wt_running)},
        ])
        with patch("agentrail.cli.commands.cleanup.subprocess.run",
                   side_effect=_make_git_mock(status_outputs={str(wt_merged): ""})):
            run_cleanup(["--target", str(tmp_path), "--merged"], now=_FIXED_NOW)
        out = capsys.readouterr().out
        # running worktree does NOT appear at all (--merged filters it from candidates)
        assert "running-one" not in out

    def test_git_worktree_remove_called_without_force(self, tmp_path, capsys):
        wt_merged = tmp_path / "worktrees" / "merged-one"
        wt_merged.mkdir(parents=True)
        _make_state(tmp_path, [
            {"id": "w1", "issue": 40, "status": "merged", "path": str(wt_merged)},
        ])
        with patch("agentrail.cli.commands.cleanup.subprocess.run") as mock_git:
            mock_git.side_effect = _make_git_mock(status_outputs={str(wt_merged): ""})
            run_cleanup(["--target", str(tmp_path), "--merged"], now=_FIXED_NOW)
        remove_calls = [c for c in mock_git.call_args_list
                        if "worktree" in c.args[0] and "remove" in c.args[0]]
        assert len(remove_calls) == 1
        # --force should NOT be present
        assert "--force" not in remove_calls[0].args[0]

    def test_state_updated_with_removed_at(self, tmp_path, capsys):
        wt_merged = tmp_path / "worktrees" / "merged-one"
        wt_merged.mkdir(parents=True)
        _make_state(tmp_path, [
            {"id": "w1", "issue": 40, "status": "merged", "path": str(wt_merged)},
        ])
        with patch("agentrail.cli.commands.cleanup.subprocess.run",
                   side_effect=_make_git_mock(status_outputs={str(wt_merged): ""})):
            run_cleanup(["--target", str(tmp_path), "--merged"], now=_FIXED_NOW)
        state = _read_state(tmp_path)
        wt = state["workflow"]["worktrees"][0]
        assert wt.get("removedAt") == _FIXED_NOW
        assert wt.get("cleanupStatus") == "removed"

    def test_state_updated_at_set(self, tmp_path, capsys):
        wt_merged = tmp_path / "worktrees" / "merged-one"
        wt_merged.mkdir(parents=True)
        _make_state(tmp_path, [
            {"id": "w1", "issue": 40, "status": "merged", "path": str(wt_merged)},
        ])
        with patch("agentrail.cli.commands.cleanup.subprocess.run",
                   side_effect=_make_git_mock(status_outputs={str(wt_merged): ""})):
            run_cleanup(["--target", str(tmp_path), "--merged"], now=_FIXED_NOW)
        state = _read_state(tmp_path)
        assert state.get("updatedAt") == _FIXED_NOW

    def test_non_merged_state_not_updated(self, tmp_path, capsys):
        """Running worktree that was skipped should not get removedAt."""
        wt_merged = tmp_path / "worktrees" / "merged-one"
        wt_merged.mkdir(parents=True)
        wt_running = tmp_path / "worktrees" / "running-one"
        wt_running.mkdir(parents=True)
        _make_state(tmp_path, [
            {"id": "w1", "issue": 40, "status": "merged", "path": str(wt_merged)},
            {"id": "w2", "issue": 41, "status": "running", "path": str(wt_running)},
        ])
        with patch("agentrail.cli.commands.cleanup.subprocess.run",
                   side_effect=_make_git_mock(status_outputs={str(wt_merged): ""})):
            run_cleanup(["--target", str(tmp_path), "--merged"], now=_FIXED_NOW)
        state = _read_state(tmp_path)
        running_wt = next(w for w in state["workflow"]["worktrees"] if w["id"] == "w2")
        assert "removedAt" not in running_wt


# ---------------------------------------------------------------------------
# --merged, dirty, no --force → skip
# ---------------------------------------------------------------------------

class TestMergedDirtyNoForce:
    def test_skip_message(self, tmp_path, capsys):
        wt_path = tmp_path / "worktrees" / "dirty-merged"
        wt_path.mkdir(parents=True)
        _make_state(tmp_path, [
            {"id": "w1", "issue": 50, "status": "merged", "path": str(wt_path)},
        ])
        with patch("agentrail.cli.commands.cleanup.subprocess.run",
                   side_effect=_make_git_mock(status_outputs={str(wt_path): "M  file.py"})):
            run_cleanup(["--target", str(tmp_path), "--merged"], now=_FIXED_NOW)
        out = capsys.readouterr().out
        assert "  skip: uncommitted changes; rerun with --force to remove" in out

    def test_not_removed(self, tmp_path, capsys):
        wt_path = tmp_path / "worktrees" / "dirty-merged"
        wt_path.mkdir(parents=True)
        _make_state(tmp_path, [
            {"id": "w1", "issue": 50, "status": "merged", "path": str(wt_path)},
        ])
        with patch("agentrail.cli.commands.cleanup.subprocess.run") as mock_git:
            mock_git.side_effect = _make_git_mock(status_outputs={str(wt_path): "M  file.py"})
            run_cleanup(["--target", str(tmp_path), "--merged"], now=_FIXED_NOW)
        remove_calls = [c for c in mock_git.call_args_list
                        if "worktree" in c.args[0] and "remove" in c.args[0]]
        assert remove_calls == []

    def test_state_not_updated(self, tmp_path, capsys):
        wt_path = tmp_path / "worktrees" / "dirty-merged"
        wt_path.mkdir(parents=True)
        _make_state(tmp_path, [
            {"id": "w1", "issue": 50, "status": "merged", "path": str(wt_path)},
        ])
        with patch("agentrail.cli.commands.cleanup.subprocess.run",
                   side_effect=_make_git_mock(status_outputs={str(wt_path): "M  file.py"})):
            run_cleanup(["--target", str(tmp_path), "--merged"], now=_FIXED_NOW)
        state = _read_state(tmp_path)
        wt = state["workflow"]["worktrees"][0]
        assert "removedAt" not in wt


# ---------------------------------------------------------------------------
# --merged --force, dirty → git worktree remove --force called
# ---------------------------------------------------------------------------

class TestMergedForce:
    def test_force_removes_dirty(self, tmp_path, capsys):
        wt_path = tmp_path / "worktrees" / "dirty-merged"
        wt_path.mkdir(parents=True)
        _make_state(tmp_path, [
            {"id": "w1", "issue": 60, "status": "merged", "path": str(wt_path)},
        ])
        with patch("agentrail.cli.commands.cleanup.subprocess.run") as mock_git:
            mock_git.side_effect = _make_git_mock(status_outputs={str(wt_path): "M  file.py"})
            rc = run_cleanup(["--target", str(tmp_path), "--merged", "--force"], now=_FIXED_NOW)
        out = capsys.readouterr().out
        assert "  removed" in out
        assert rc == 0

    def test_git_worktree_remove_force_flag(self, tmp_path, capsys):
        wt_path = tmp_path / "worktrees" / "dirty-merged"
        wt_path.mkdir(parents=True)
        _make_state(tmp_path, [
            {"id": "w1", "issue": 60, "status": "merged", "path": str(wt_path)},
        ])
        with patch("agentrail.cli.commands.cleanup.subprocess.run") as mock_git:
            mock_git.side_effect = _make_git_mock(status_outputs={str(wt_path): "M  file.py"})
            run_cleanup(["--target", str(tmp_path), "--merged", "--force"], now=_FIXED_NOW)
        remove_calls = [c for c in mock_git.call_args_list
                        if "worktree" in c.args[0] and "remove" in c.args[0]]
        assert len(remove_calls) == 1
        assert "--force" in remove_calls[0].args[0]

    def test_state_updated_after_force_remove(self, tmp_path, capsys):
        wt_path = tmp_path / "worktrees" / "dirty-merged"
        wt_path.mkdir(parents=True)
        _make_state(tmp_path, [
            {"id": "w1", "issue": 60, "status": "merged", "path": str(wt_path)},
        ])
        with patch("agentrail.cli.commands.cleanup.subprocess.run",
                   side_effect=_make_git_mock(status_outputs={str(wt_path): "M  file.py"})):
            run_cleanup(["--target", str(tmp_path), "--merged", "--force"], now=_FIXED_NOW)
        state = _read_state(tmp_path)
        wt = state["workflow"]["worktrees"][0]
        assert wt.get("removedAt") == _FIXED_NOW
        assert wt.get("cleanupStatus") == "removed"


# ---------------------------------------------------------------------------
# --merged: dir already missing → "  already missing"
# ---------------------------------------------------------------------------

class TestMergedAlreadyMissing:
    def test_already_missing_message(self, tmp_path, capsys):
        wt_path = tmp_path / "worktrees" / "gone"
        # Do NOT create the dir
        _make_state(tmp_path, [
            {"id": "w1", "issue": 70, "status": "merged", "path": str(wt_path)},
        ])
        with patch("agentrail.cli.commands.cleanup.subprocess.run",
                   side_effect=_make_git_mock()):
            run_cleanup(["--target", str(tmp_path), "--merged"], now=_FIXED_NOW)
        out = capsys.readouterr().out
        assert "  already missing" in out

    def test_state_updated_for_already_missing(self, tmp_path, capsys):
        """Even a missing dir should be recorded as removed in state."""
        wt_path = tmp_path / "worktrees" / "gone"
        _make_state(tmp_path, [
            {"id": "w1", "issue": 70, "status": "merged", "path": str(wt_path)},
        ])
        with patch("agentrail.cli.commands.cleanup.subprocess.run",
                   side_effect=_make_git_mock()):
            run_cleanup(["--target", str(tmp_path), "--merged"], now=_FIXED_NOW)
        state = _read_state(tmp_path)
        wt = state["workflow"]["worktrees"][0]
        assert wt.get("removedAt") == _FIXED_NOW
        assert wt.get("cleanupStatus") == "removed"


# ---------------------------------------------------------------------------
# Worktree path resolution: relative path in state
# ---------------------------------------------------------------------------

class TestRelativePath:
    def test_relative_path_resolved_against_target(self, tmp_path, capsys):
        wt_rel = "worktrees/rel-issue"
        wt_abs = tmp_path / "worktrees" / "rel-issue"
        wt_abs.mkdir(parents=True)
        _make_state(tmp_path, [
            {"id": "w1", "issue": 80, "status": "merged", "path": wt_rel},
        ])
        with patch("agentrail.cli.commands.cleanup.subprocess.run",
                   side_effect=_make_git_mock(status_outputs={str(wt_abs): ""})):
            rc = run_cleanup(["--target", str(tmp_path), "--merged"], now=_FIXED_NOW)
        out = capsys.readouterr().out
        assert "  removed" in out
        assert rc == 0

    def test_worktree_path_key_also_supported(self, tmp_path, capsys):
        """State entries using 'worktreePath' instead of 'path' should work."""
        wt_path = tmp_path / "worktrees" / "wt-path-key"
        wt_path.mkdir(parents=True)
        _make_state(tmp_path, [
            {"id": "w1", "issue": 81, "status": "merged", "worktreePath": str(wt_path)},
        ])
        with patch("agentrail.cli.commands.cleanup.subprocess.run",
                   side_effect=_make_git_mock(status_outputs={str(wt_path): ""})):
            rc = run_cleanup(["--target", str(tmp_path), "--merged"], now=_FIXED_NOW)
        out = capsys.readouterr().out
        assert "  removed" in out


# ---------------------------------------------------------------------------
# Label format: issue and PR in label
# ---------------------------------------------------------------------------

class TestLabelFormat:
    def test_label_with_issue_and_pr(self, tmp_path, capsys):
        wt_path = tmp_path / "worktrees" / "w1"
        wt_path.mkdir(parents=True)
        _make_state(tmp_path, [
            {"id": "w1", "issue": 100, "pr": 200, "status": "merged", "path": str(wt_path)},
        ])
        with patch("agentrail.cli.commands.cleanup.subprocess.run",
                   side_effect=_make_git_mock(status_outputs={str(wt_path): ""})):
            run_cleanup(["--target", str(tmp_path), "--dry-run"], now=_FIXED_NOW)
        out = capsys.readouterr().out
        assert "worktree issue #100 PR #200:" in out

    def test_label_with_issue_only(self, tmp_path, capsys):
        wt_path = tmp_path / "worktrees" / "w1"
        wt_path.mkdir(parents=True)
        _make_state(tmp_path, [
            {"id": "w1", "issue": 100, "status": "merged", "path": str(wt_path)},
        ])
        with patch("agentrail.cli.commands.cleanup.subprocess.run",
                   side_effect=_make_git_mock(status_outputs={str(wt_path): ""})):
            run_cleanup(["--target", str(tmp_path), "--dry-run"], now=_FIXED_NOW)
        out = capsys.readouterr().out
        assert "worktree issue #100:" in out
        assert "PR" not in out

    def test_label_without_issue_or_pr(self, tmp_path, capsys):
        wt_path = tmp_path / "worktrees" / "w1"
        wt_path.mkdir(parents=True)
        _make_state(tmp_path, [
            {"id": "w1", "status": "merged", "path": str(wt_path)},
        ])
        with patch("agentrail.cli.commands.cleanup.subprocess.run",
                   side_effect=_make_git_mock(status_outputs={str(wt_path): ""})):
            run_cleanup(["--target", str(tmp_path), "--dry-run"], now=_FIXED_NOW)
        out = capsys.readouterr().out
        assert "worktree:" in out

    def test_label_with_targetissue_fallback(self, tmp_path, capsys):
        """Legacy state may store issue as targetIssue."""
        wt_path = tmp_path / "worktrees" / "w1"
        wt_path.mkdir(parents=True)
        _make_state(tmp_path, [
            {"id": "w1", "targetIssue": 99, "status": "merged", "path": str(wt_path)},
        ])
        with patch("agentrail.cli.commands.cleanup.subprocess.run",
                   side_effect=_make_git_mock(status_outputs={str(wt_path): ""})):
            run_cleanup(["--target", str(tmp_path), "--dry-run"], now=_FIXED_NOW)
        out = capsys.readouterr().out
        assert "issue #99" in out

    def test_label_with_pull_request_fallback(self, tmp_path, capsys):
        """Legacy state may store PR as pullRequest."""
        wt_path = tmp_path / "worktrees" / "w1"
        wt_path.mkdir(parents=True)
        _make_state(tmp_path, [
            {"id": "w1", "issue": 10, "pullRequest": 77, "status": "merged", "path": str(wt_path)},
        ])
        with patch("agentrail.cli.commands.cleanup.subprocess.run",
                   side_effect=_make_git_mock(status_outputs={str(wt_path): ""})):
            run_cleanup(["--target", str(tmp_path), "--dry-run"], now=_FIXED_NOW)
        out = capsys.readouterr().out
        assert "PR #77" in out


# ---------------------------------------------------------------------------
# main.py routes "cleanup" to run_cleanup
# ---------------------------------------------------------------------------

class TestMainRouting:
    def test_cleanup_routed_via_main(self, tmp_path, capsys):
        from agentrail.cli import main as main_mod
        with patch("agentrail.cli.main.run_cleanup", return_value=0) as mock_cleanup:
            rc = main_mod.main(["cleanup", "--target", str(tmp_path)])
        assert rc == 0
        mock_cleanup.assert_called_once_with(["--target", str(tmp_path)])
