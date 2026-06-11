"""Hermetic e2e test for agentrail.run.pipeline.run_issue.

Exercises the full plan→execute→artifact→state pipeline using:
  - A temporary directory with .agentrail/state.json (no git required)
  - A stub scripts/ralph-loop that exits 0 immediately
  - A stub agent script that exits 0 immediately
  - Patches on context/skills helpers that would otherwise hit the DB or network

No network, no gh, no live agent, no DB.

Acceptance criteria coverage:
  AC1: hermetic — no network/gh; temp dir, stub scripts, all DB/index calls patched.
  AC2: asserts plan + execute artifacts written, run.json and resolved-skills.json
       produced, state.json finalized to completed, exit 0.
  AC3: deterministic — tmp_path is isolated per-run; no shared mutable state.
"""
from __future__ import annotations

import json
import stat
from pathlib import Path
from unittest.mock import patch

import pytest

from agentrail.run.pipeline import run_issue


# ---------------------------------------------------------------------------
# Helpers
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
    """Set up a minimal target directory and return (target_dir, stub_agent_path)."""
    agentrail_dir = tmp_path / ".agentrail"
    agentrail_dir.mkdir(parents=True)
    (agentrail_dir / "state.json").write_text(json.dumps({"workflow": {}}))

    # Stub ralph-loop: 3rd candidate in ralph_executor_path lookup order
    #   target_dir / "scripts" / "ralph-loop"
    scripts_dir = tmp_path / "scripts"
    scripts_dir.mkdir()
    ralph_stub = scripts_dir / "ralph-loop"
    ralph_stub.write_text("#!/bin/sh\nexit 0\n")
    ralph_stub.chmod(ralph_stub.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)

    # Stub agent: used as the agent_command for the plan phase
    stub_agent = tmp_path / "stub-agent"
    stub_agent.write_text("#!/bin/sh\nexit 0\n")
    stub_agent.chmod(stub_agent.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)

    return tmp_path, stub_agent


# ---------------------------------------------------------------------------
# E2E test
# ---------------------------------------------------------------------------

def test_run_issue_full_pipeline(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Full plan→execute pipeline with stub agent and stub ralph-loop.

    Verifies that the real pipeline writes all expected artifacts and finalizes
    state.json to 'completed' when both phases exit 0.
    """
    target, stub_agent = _make_target(tmp_path)
    skills_result = {**_STUB_SKILLS, "targetDir": str(target)}

    # Keep CI fast and non-hanging
    monkeypatch.setenv("AGENTRAIL_AGENT_TIMEOUT", "30")

    with (
        patch("agentrail.run.context.issue_resolution_text", return_value="Issue #1\nAdd CI e2e test"),
        patch("agentrail.run.context.build_issue_context_pack", return_value=None),
        patch("agentrail.run.context.context_selected_snippets", return_value=""),
        patch("agentrail.run.context.context_retrieval_metadata", return_value={}),
        patch("agentrail.run.skills.resolve_skills", return_value=skills_result),
    ):
        exit_code = run_issue(
            target, 1,
            agent="stub",
            command=str(stub_agent),
            repo_dir=target,
        )

    # AC2: exit 0
    assert exit_code == 0, "run_issue must return 0 on success"

    # AC2: run directory created under .agentrail/runs
    runs_dir = target / ".agentrail" / "runs"
    run_dirs = list(runs_dir.glob("*-issue-1-stub-*"))
    assert run_dirs, "run directory must be created under .agentrail/runs"
    run_dir = run_dirs[0]

    # AC2: run.json and resolved-skills.json
    assert (run_dir / "run.json").is_file(), "run.json must exist"
    assert (run_dir / "resolved-skills.json").is_file(), "resolved-skills.json must exist"

    run_meta = json.loads((run_dir / "run.json").read_text())
    assert run_meta["targetIssue"] == 1
    assert run_meta["agent"] == "stub"

    resolved = json.loads((run_dir / "resolved-skills.json").read_text())
    assert isinstance(resolved, dict)

    # AC2: plan phase artifacts
    plan_dir = run_dir / "plan"
    assert plan_dir.is_dir(), "plan/ subdirectory must exist"
    assert (plan_dir / "prompt.md").is_file(), "plan/prompt.md must exist"
    assert (plan_dir / "output.md").is_file(), "plan/output.md must exist"
    plan_status = json.loads((plan_dir / "status.json").read_text())
    assert plan_status["status"] == "completed", (
        f"plan status must be 'completed', got {plan_status['status']!r}"
    )

    # AC2: execute phase artifacts
    execute_dir = run_dir / "execute"
    assert execute_dir.is_dir(), "execute/ subdirectory must exist"
    assert (execute_dir / "prompt.md").is_file(), "execute/prompt.md must exist"
    assert (execute_dir / "output.md").is_file(), "execute/output.md must exist"
    execute_status = json.loads((execute_dir / "status.json").read_text())
    assert execute_status["status"] == "completed", (
        f"execute status must be 'completed', got {execute_status['status']!r}"
    )

    # AC2: state.json finalized to 'completed'
    state = json.loads((target / ".agentrail" / "state.json").read_text())
    workflow = state["workflow"]
    assert workflow.get("phase") == "completed", (
        f"workflow.phase must be 'completed', got {workflow.get('phase')!r}"
    )
    completed_runs = workflow.get("completedRuns", [])
    assert completed_runs, "completedRuns must have at least one entry"
    last_run = completed_runs[-1]
    assert last_run.get("status") == "completed", (
        f"last completed run status must be 'completed', got {last_run.get('status')!r}"
    )
