"""Hermetic e2e test for agentrail.run.pipeline.run_issue.

Exercises the full MVP spine pipeline (test-author → execute → verify →
Objective Gate; NO plan phase) using:
  - A temporary directory with .agentrail/state.json (no git required)
  - A stub agent script driven by the phase prompt on stdin
  - Patches on context/skills helpers that would otherwise hit the DB or network

The verification spine (ADR 0008) is ON BY DEFAULT in the MVP, so the
full-pipeline success test must present a GENUINE red→green trail: the declared
``verify`` check is RED at the baseline (before execute) and GREEN after the
execute phase creates a sentinel. A tautological always-pass check would be
(correctly) RED at the gate — that anti-false-green default is its own test.

No network, no gh, no live agent, no DB.

Acceptance criteria coverage:
  AC1: hermetic — no network/gh; temp dir, stub scripts, all DB/index calls patched.
  AC2: asserts test-author + execute artifacts written (NO plan phase), run.json
       and resolved-skills.json produced, state.json finalized to completed,
       and the Objective Gate is GREEN on a genuine red→green trail, exit 0.
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
    """Set up a minimal target directory and return (target_dir, stub_agent_path).

    The Objective Gate (#769) drives "done" and the verification spine (ADR 0008)
    is ON BY DEFAULT (MVP): a run reaches GREEN only on a genuine red→green trail.
    We declare a sentinel-file ``verify`` check that is RED at the baseline and is
    turned GREEN by the execute stub creating the sentinel — a real fail→pass
    trail. (An always-pass ``"verify": "true"`` would be a tautological,
    never-red check and the gate would correctly refuse done.)
    """
    agentrail_dir = tmp_path / ".agentrail"
    agentrail_dir.mkdir(parents=True)
    (agentrail_dir / "state.json").write_text(json.dumps({"workflow": {}}))
    sentinel = tmp_path / "impl_done"
    (agentrail_dir / "config.json").write_text(
        json.dumps({"verify": f"test -f {sentinel}"})
    )

    # Stub agent: runs natively for every phase via `bash -lc <agent_command>`
    # with the phase prompt on stdin. It creates the sentinel ONLY on the execute
    # phase (detected from the prompt) so the acceptance check is red before and
    # green after — proving the Red-Green trail. The test-author phase must NOT
    # turn it green (a separate role authors the failing test).
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
# E2E test
# ---------------------------------------------------------------------------

def test_run_issue_full_pipeline(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Full MVP spine pipeline (test-author → execute) with a stub agent.

    Verifies the real pipeline runs the spine by DEFAULT with NO plan phase,
    writes all expected artifacts, reaches a GREEN Objective Gate on a genuine
    red→green trail, and finalizes state.json to 'completed' (exit 0).
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

    # AC1 (MVP): there is NO plan phase any more.
    assert not (run_dir / "plan").exists(), "the plan phase must be gone"

    # AC2: test-author phase artifacts (the new first phase)
    test_author_dir = run_dir / "test-author"
    assert test_author_dir.is_dir(), "test-author/ subdirectory must exist"
    assert (test_author_dir / "prompt.md").is_file(), "test-author/prompt.md must exist"
    assert (test_author_dir / "output.md").is_file(), "test-author/output.md must exist"
    test_author_status = json.loads((test_author_dir / "status.json").read_text())
    assert test_author_status["status"] == "completed", (
        f"test-author status must be 'completed', got {test_author_status['status']!r}"
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

    # AC2: the Objective Gate is GREEN on a genuine red→green trail (spine on).
    assert run_meta["objectiveGate"]["verdict"] == "green", (
        f"gate must be green, got {run_meta['objectiveGate']}"
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


def test_default_spine_keeps_tautological_test_red(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """AC2 (MVP, e2e): with NO special config the spine is ON, so a tautological
    always-pass ``verify`` (never observed red) keeps the Objective Gate RED and
    the run not-done — even though every agent phase exits 0."""
    monkeypatch.setenv("AGENTRAIL_AGENT_TIMEOUT", "30")
    agentrail_dir = tmp_path / ".agentrail"
    agentrail_dir.mkdir(parents=True)
    (agentrail_dir / "state.json").write_text(json.dumps({"workflow": {}}))
    # ``true`` passes at the baseline AND after execute → never red → tautological.
    (agentrail_dir / "config.json").write_text(json.dumps({"verify": "true"}))
    stub_agent = tmp_path / "stub-agent"
    stub_agent.write_text("#!/bin/sh\ncat >/dev/null\nexit 0\n")
    stub_agent.chmod(stub_agent.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)

    skills_result = {**_STUB_SKILLS, "targetDir": str(tmp_path)}
    with (
        patch("agentrail.run.context.issue_resolution_text", return_value="Issue #1"),
        patch("agentrail.run.context.build_issue_context_pack", return_value=None),
        patch("agentrail.run.context.context_selected_snippets", return_value=""),
        patch("agentrail.run.context.context_retrieval_metadata", return_value={}),
        patch("agentrail.run.skills.resolve_skills", return_value=skills_result),
    ):
        exit_code = run_issue(
            tmp_path, 1, agent="stub", command=str(stub_agent), repo_dir=tmp_path
        )

    assert exit_code != 0, "a never-red tautological test must keep the run not-done"
    run_dir = next((tmp_path / ".agentrail" / "runs").glob("*-issue-1-stub-*"))
    run_meta = json.loads((run_dir / "run.json").read_text())
    assert run_meta["objectiveGate"]["verdict"] == "red"
    assert any(
        "red-green" in r.lower() for r in run_meta["objectiveGate"]["failedReasons"]
    )


def test_explicit_opt_out_restores_minimal_flow(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """AC3 (MVP, e2e): ``redGreenProof: false`` restores the minimal flow — no
    test-author phase, no red-green requirement — so an always-pass declared
    ``verify`` reaches a GREEN gate and done (exit 0)."""
    monkeypatch.setenv("AGENTRAIL_AGENT_TIMEOUT", "30")
    agentrail_dir = tmp_path / ".agentrail"
    agentrail_dir.mkdir(parents=True)
    (agentrail_dir / "state.json").write_text(json.dumps({"workflow": {}}))
    (agentrail_dir / "config.json").write_text(
        json.dumps({"verify": "true", "redGreenProof": False})
    )
    stub_agent = tmp_path / "stub-agent"
    stub_agent.write_text("#!/bin/sh\ncat >/dev/null\nexit 0\n")
    stub_agent.chmod(stub_agent.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)

    skills_result = {**_STUB_SKILLS, "targetDir": str(tmp_path)}
    with (
        patch("agentrail.run.context.issue_resolution_text", return_value="Issue #1"),
        patch("agentrail.run.context.build_issue_context_pack", return_value=None),
        patch("agentrail.run.context.context_selected_snippets", return_value=""),
        patch("agentrail.run.context.context_retrieval_metadata", return_value={}),
        patch("agentrail.run.skills.resolve_skills", return_value=skills_result),
    ):
        exit_code = run_issue(
            tmp_path, 1, agent="stub", command=str(stub_agent), repo_dir=tmp_path
        )

    assert exit_code == 0, "explicit opt-out + passing verify must reach done"
    run_dir = next((tmp_path / ".agentrail" / "runs").glob("*-issue-1-stub-*"))
    run_meta = json.loads((run_dir / "run.json").read_text())
    assert run_meta["objectiveGate"]["verdict"] == "green"
    # The minimal flow has no test-author phase.
    assert not (run_dir / "test-author").exists(), "opt-out must skip test-author"


# ---------------------------------------------------------------------------
# Independent Verifier e2e (issue #782, ADR 0008)
# ---------------------------------------------------------------------------

def _make_redgreen_target(tmp_path: Path, verifier_verdict: str) -> tuple[Path, Path, Path]:
    """Set up a target whose Red-Green Proof is on, with a real fail→pass trail
    and a stub verifier that emits ``verifier_verdict``.

    Returns (target, plan/execute stub agent, verifier stub agent). The execute
    stub creates an ``impl_done`` sentinel so the declared ``verify`` check is RED
    at the baseline and GREEN after execute — a genuine trail. The verifier stub
    writes the given verdict to stdout (captured into the verify phase output).
    """
    agentrail_dir = tmp_path / ".agentrail"
    agentrail_dir.mkdir(parents=True)
    (agentrail_dir / "state.json").write_text(json.dumps({"workflow": {}}))
    sentinel = tmp_path / "impl_done"
    (agentrail_dir / "config.json").write_text(json.dumps({
        "verify": f"test -f {sentinel}",
        "redGreenProof": True,
    }))

    # Implementer stub: on the execute phase it creates the sentinel (turns the
    # acceptance check green). Plan/test-author/verify produce nothing harmful.
    # We distinguish execute by reading the phase prompt on stdin.
    impl_agent = tmp_path / "impl-agent"
    impl_agent.write_text(
        "#!/bin/sh\n"
        "in=$(cat)\n"
        "case \"$in\" in\n"
        f"  *'phase 2 of 2: execute'*) : > '{sentinel}' ;;\n"
        "esac\n"
        "exit 0\n"
    )
    impl_agent.chmod(impl_agent.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)

    # Verifier stub: emits the configured structured verdict on stdout.
    verifier_agent = tmp_path / "verifier-agent"
    verifier_agent.write_text("#!/bin/sh\ncat >/dev/null\n" + f"echo '{verifier_verdict}'\n")
    verifier_agent.chmod(
        verifier_agent.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH
    )

    return tmp_path, impl_agent, verifier_agent


def _run_redgreen(target: Path, impl_agent: Path, verifier_agent: Path):
    skills_result = {**_STUB_SKILLS, "targetDir": str(target)}
    with (
        patch("agentrail.run.context.issue_resolution_text", return_value="Issue #1\nAdd feature"),
        patch("agentrail.run.context.build_issue_context_pack", return_value=None),
        patch("agentrail.run.context.context_selected_snippets", return_value=""),
        patch("agentrail.run.context.context_retrieval_metadata", return_value={}),
        patch("agentrail.run.skills.resolve_skills", return_value=skills_result),
    ):
        exit_code = run_issue(
            target, 1,
            agent="stub",
            command=str(impl_agent),
            repo_dir=target,
            # Verifier runs on a DIFFERENT command (a different model in practice).
            phase_commands={"verify": str(verifier_agent)},
        )
    runs_dir = target / ".agentrail" / "runs"
    run_dir = next(runs_dir.glob("*-issue-1-stub-*"))
    return exit_code, json.loads((run_dir / "run.json").read_text())


def test_verifier_rejection_blocks_done_e2e(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """AC2+AC3 (hermetic e2e): a genuine red→green trail with a verifier that
    REJECTS the test → the Objective Gate is RED and run_issue returns non-zero.
    A rejected Independent Verification blocks done."""
    monkeypatch.setenv("AGENTRAIL_AGENT_TIMEOUT", "30")
    target, impl_agent, verifier_agent = _make_redgreen_target(
        tmp_path, '{"verdict": "reject", "reason": "tautological test"}'
    )
    exit_code, run_meta = _run_redgreen(target, impl_agent, verifier_agent)

    assert exit_code != 0, "a verifier rejection must block done (non-zero exit)"
    assert run_meta["objectiveGate"]["verdict"] == "red"
    assert any(
        "verification" in r.lower()
        for r in run_meta["objectiveGate"]["failedReasons"]
    )


def test_verifier_acceptance_reaches_done_e2e(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A genuine red→green trail + a verifier ACCEPT verdict reaches done (green,
    exit 0) — the verifier confirms the AC are satisfied."""
    monkeypatch.setenv("AGENTRAIL_AGENT_TIMEOUT", "30")
    target, impl_agent, verifier_agent = _make_redgreen_target(
        tmp_path, '{"verdict": "accept", "reason": "tests pin the AC"}'
    )
    exit_code, run_meta = _run_redgreen(target, impl_agent, verifier_agent)

    assert exit_code == 0
    assert run_meta["objectiveGate"]["verdict"] == "green"
