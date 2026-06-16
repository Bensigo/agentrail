"""Tests for the --run-id override feature.

Covers:
  1. parse_run_options parses --run-id correctly.
  2. run_issue uses the override run_id (not a generated one) when provided.
"""
from __future__ import annotations

import json
import stat
from pathlib import Path
from unittest.mock import patch

import pytest

from agentrail.cli.commands.run import parse_run_options, UsageError
from agentrail.run.pipeline import run_issue


# ---------------------------------------------------------------------------
# 1. CLI parsing
# ---------------------------------------------------------------------------

class TestParseRunIdOption:
    def test_run_id_parsed(self) -> None:
        opts = parse_run_options(["--run-id", "abc-123"])
        assert opts.run_id == "abc-123"

    def test_run_id_with_other_flags(self) -> None:
        opts = parse_run_options([
            "--agent", "claude",
            "--target", "/tmp/x",
            "--run-id", "my-canonical-id",
        ])
        assert opts.run_id == "my-canonical-id"
        assert opts.agent == "claude"

    def test_run_id_default_empty(self) -> None:
        opts = parse_run_options([])
        assert opts.run_id == ""

    def test_run_id_missing_value_raises(self) -> None:
        with pytest.raises(UsageError):
            parse_run_options(["--run-id"])


# ---------------------------------------------------------------------------
# Helpers shared by pipeline tests
# ---------------------------------------------------------------------------

_STUB_SKILLS: dict = {
    "resolved": [],
    "autoSkills": True,
    "maxAutoSkills": 4,
    "unavailable": [],
    "registryPath": "",
    "targetDir": "",
}


def _make_target(tmp_path: Path) -> tuple[Path, Path]:
    agentrail_dir = tmp_path / ".agentrail"
    agentrail_dir.mkdir(parents=True)
    (agentrail_dir / "state.json").write_text(json.dumps({"workflow": {}}))
    # The verification spine is ON BY DEFAULT (MVP): a run reaches GREEN only on a
    # genuine red→green trail. The declared sentinel-file verify is RED at the
    # baseline and turned GREEN by the execute phase (the stub creates the
    # sentinel on the execute phase, detected from the prompt on stdin).
    sentinel = tmp_path / "impl_done"
    (agentrail_dir / "config.json").write_text(
        json.dumps({"verify": f"test -f {sentinel}"})
    )
    stub_agent = tmp_path / "stub-agent"
    stub_agent.write_text(
        "#!/bin/sh\n"
        "in=$(cat)\n"
        "case \"$in\" in\n"
        f"  *'phase 2 of 2: execute'*) : > '{sentinel}' ;;\n"
        "esac\n"
        "exit 0\n"
    )
    stub_agent.chmod(stub_agent.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    return tmp_path, stub_agent


# ---------------------------------------------------------------------------
# 2. Pipeline-level: run_id override is used, not overwritten
# ---------------------------------------------------------------------------

def test_run_id_override_used_as_run_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """run_issue(..., run_id='fixed-id') must create <log_dir>/fixed-id as the run dir."""
    target, stub_agent = _make_target(tmp_path)
    log_dir = tmp_path / "custom-logs"
    log_dir.mkdir()
    skills_result = {**_STUB_SKILLS, "targetDir": str(target)}

    monkeypatch.setenv("AGENTRAIL_AGENT_TIMEOUT", "30")

    with (
        patch("agentrail.run.context.issue_resolution_text", return_value="Issue #5"),
        patch("agentrail.run.context.build_issue_context_pack", return_value=None),
        patch("agentrail.run.context.context_selected_snippets", return_value=""),
        patch("agentrail.run.context.context_retrieval_metadata", return_value={}),
        patch("agentrail.run.skills.resolve_skills", return_value=skills_result),
    ):
        exit_code = run_issue(
            target, 5,
            agent="stub",
            command=str(stub_agent),
            repo_dir=target,
            log_dir=log_dir,
            run_id="fixed-id",
        )

    assert exit_code == 0
    run_dir = log_dir / "fixed-id"
    assert run_dir.is_dir(), f"Expected run dir at {run_dir}"
    assert (run_dir / "run.json").is_file(), "run.json must exist inside fixed-id dir"


def test_run_id_override_not_generated_when_given(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No auto-generated run dir (containing 'issue-5-stub') must exist when run_id is set."""
    target, stub_agent = _make_target(tmp_path)
    log_dir = tmp_path / "custom-logs2"
    log_dir.mkdir()
    skills_result = {**_STUB_SKILLS, "targetDir": str(target)}

    monkeypatch.setenv("AGENTRAIL_AGENT_TIMEOUT", "30")

    with (
        patch("agentrail.run.context.issue_resolution_text", return_value="Issue #5"),
        patch("agentrail.run.context.build_issue_context_pack", return_value=None),
        patch("agentrail.run.context.context_selected_snippets", return_value=""),
        patch("agentrail.run.context.context_retrieval_metadata", return_value={}),
        patch("agentrail.run.skills.resolve_skills", return_value=skills_result),
    ):
        run_issue(
            target, 5,
            agent="stub",
            command=str(stub_agent),
            repo_dir=target,
            log_dir=log_dir,
            run_id="canonical-run-uuid",
        )

    all_dirs = [d.name for d in log_dir.iterdir() if d.is_dir()]
    assert all_dirs == ["canonical-run-uuid"], (
        f"Expected only 'canonical-run-uuid' dir, got: {all_dirs}"
    )


def test_run_id_generated_when_not_provided(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Without run_id override, the auto-generated name contains 'issue-5-stub'."""
    target, stub_agent = _make_target(tmp_path)
    log_dir = tmp_path / "custom-logs3"
    log_dir.mkdir()
    skills_result = {**_STUB_SKILLS, "targetDir": str(target)}

    monkeypatch.setenv("AGENTRAIL_AGENT_TIMEOUT", "30")

    with (
        patch("agentrail.run.context.issue_resolution_text", return_value="Issue #5"),
        patch("agentrail.run.context.build_issue_context_pack", return_value=None),
        patch("agentrail.run.context.context_selected_snippets", return_value=""),
        patch("agentrail.run.context.context_retrieval_metadata", return_value={}),
        patch("agentrail.run.skills.resolve_skills", return_value=skills_result),
    ):
        run_issue(
            target, 5,
            agent="stub",
            command=str(stub_agent),
            repo_dir=target,
            log_dir=log_dir,
        )

    run_dirs = [d.name for d in log_dir.iterdir() if d.is_dir()]
    assert len(run_dirs) == 1
    assert "issue-5-stub" in run_dirs[0], (
        f"Auto-generated run dir should contain 'issue-5-stub', got: {run_dirs[0]!r}"
    )
