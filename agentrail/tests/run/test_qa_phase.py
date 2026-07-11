"""Tests for agentrail.run.qa_phase — the opt-in, runner-side QA phase (#1148).

Two layers:

* **Gating / classification** (pure): ``qa_enabled`` (default OFF), ``qa_timeout``
  (override + sanitisation), ``is_ui_runtime_change`` (the UI/runtime filter).
* **Orchestration** (``run_qa_phase``): the skip / pass / red / timeout branches.
  Every non-timeout branch fakes :func:`run_with_timeout` with a FAITHFUL stand-in
  that writes the output file and returns an int — exactly the contract the real
  helper honours — so the mapping from exit code → verdict is exercised without a
  real subprocess. AC4 (fail-safe on a hung harness) uses a REAL ``bash`` sleep
  under a 1s ceiling and asserts it neither hangs nor raises.
"""
from __future__ import annotations

import time
from pathlib import Path

from agentrail.run import qa_phase
from agentrail.run.qa_phase import (
    QaResult,
    is_ui_runtime_change,
    qa_enabled,
    qa_timeout,
    run_qa_phase,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _faithful_run_with_timeout(rc: int, *, log: str = "", artifact: str | None = None):
    """A stand-in for ``run_with_timeout`` that honours its real contract: it
    writes ``output_file`` (so the log-tail read succeeds) and returns an int.
    Optionally drops a file into the sibling ``artifacts/`` dir so the
    basename-only artifact listing can be asserted."""

    def _fake(argv, *, cwd, timeout, output_file, stdin_text=None, env=None):
        of = Path(output_file)
        of.parent.mkdir(parents=True, exist_ok=True)
        of.write_text(log)
        if artifact:
            adir = of.parent / "artifacts"
            adir.mkdir(parents=True, exist_ok=True)
            (adir / artifact).write_text("screenshot-bytes")
        return rc

    return _fake


def _with_qa_script(target: Path) -> Path:
    script = target / ".agentrail" / "qa.sh"
    script.parent.mkdir(parents=True, exist_ok=True)
    script.write_text("#!/usr/bin/env bash\nexit 0\n")
    script.chmod(0o755)
    return script


# ---------------------------------------------------------------------------
# qa_enabled — default OFF, only "1" turns it on
# ---------------------------------------------------------------------------


def test_qa_enabled_default_off(monkeypatch) -> None:
    monkeypatch.delenv("AGENTRAIL_QA", raising=False)
    assert qa_enabled() is False


def test_qa_enabled_true_only_for_one(monkeypatch) -> None:
    monkeypatch.setenv("AGENTRAIL_QA", "1")
    assert qa_enabled() is True


def test_qa_enabled_false_for_other_truthy_looking_values(monkeypatch) -> None:
    for val in ("0", "true", "yes", "on", "", "  "):
        monkeypatch.setenv("AGENTRAIL_QA", val)
        assert qa_enabled() is False, val


# ---------------------------------------------------------------------------
# qa_timeout — default 180, positive override wins, junk ignored
# ---------------------------------------------------------------------------


def test_qa_timeout_default(monkeypatch) -> None:
    monkeypatch.delenv("AGENTRAIL_QA_TIMEOUT", raising=False)
    assert qa_timeout() == 180


def test_qa_timeout_positive_override(monkeypatch) -> None:
    monkeypatch.setenv("AGENTRAIL_QA_TIMEOUT", "45")
    assert qa_timeout() == 45


def test_qa_timeout_ignores_nonpositive_and_nonnumeric(monkeypatch) -> None:
    for junk in ("0", "-30", "abc", "12.5", ""):
        monkeypatch.setenv("AGENTRAIL_QA_TIMEOUT", junk)
        assert qa_timeout() == 180, junk


# ---------------------------------------------------------------------------
# is_ui_runtime_change — the UI/runtime filter
# ---------------------------------------------------------------------------


def test_is_ui_runtime_change_matches_frontend_extensions() -> None:
    assert is_ui_runtime_change(["apps/console/app/dashboard/Foo.tsx"]) is True
    assert is_ui_runtime_change(["src/Widget.jsx"]) is True
    assert is_ui_runtime_change(["styles/theme.css"]) is True
    assert is_ui_runtime_change(["public/index.html"]) is True


def test_is_ui_runtime_change_matches_console_and_app_paths() -> None:
    assert is_ui_runtime_change(["apps/console/lib/db.ts"]) is True
    assert is_ui_runtime_change(["apps/web/app/page.ts"]) is True
    assert is_ui_runtime_change(["apps/web/components/Button.ts"]) is True


def test_is_ui_runtime_change_false_for_backend_and_docs() -> None:
    assert is_ui_runtime_change(["agentrail/run/pipeline.py"]) is False
    assert is_ui_runtime_change(["docs/readme.md"]) is False
    assert is_ui_runtime_change(["packages/db-postgres/src/schema/auth.ts"]) is False


def test_is_ui_runtime_change_empty_and_blank() -> None:
    assert is_ui_runtime_change([]) is False
    assert is_ui_runtime_change([""]) is False


# ---------------------------------------------------------------------------
# run_qa_phase — skip branches (no execution, never a gate)
# ---------------------------------------------------------------------------


def test_run_qa_phase_skips_without_script(tmp_path, monkeypatch) -> None:
    # No .agentrail/qa.sh → nothing to run; must NOT invoke run_with_timeout.
    def _boom(*a, **k):
        raise AssertionError("run_with_timeout must not be called on a skip")

    monkeypatch.setattr(qa_phase, "run_with_timeout", _boom)
    res = run_qa_phase(tmp_path, tmp_path / "run", changed_files=["Foo.tsx"])
    assert res.is_skip and res.verdict == "skipped"
    assert "no .agentrail/qa.sh" in res.reason


def test_run_qa_phase_skips_non_ui_change(tmp_path, monkeypatch) -> None:
    _with_qa_script(tmp_path)

    def _boom(*a, **k):
        raise AssertionError("run_with_timeout must not be called on a skip")

    monkeypatch.setattr(qa_phase, "run_with_timeout", _boom)
    res = run_qa_phase(
        tmp_path, tmp_path / "run", changed_files=["agentrail/run/pipeline.py"]
    )
    assert res.is_skip
    assert "no UI/runtime surface" in res.reason


# ---------------------------------------------------------------------------
# run_qa_phase — pass / red (exit-code → verdict mapping)
# ---------------------------------------------------------------------------


def test_run_qa_phase_pass(tmp_path, monkeypatch) -> None:
    _with_qa_script(tmp_path)
    monkeypatch.setattr(
        qa_phase,
        "run_with_timeout",
        _faithful_run_with_timeout(0, log="QA PASSED\n", artifact="dashboard.html"),
    )
    res = run_qa_phase(tmp_path, tmp_path / "run", changed_files=["Foo.tsx"])
    assert res.is_pass and res.verdict == "passed"
    assert res.exit_code == 0
    assert "QA PASSED" in res.log_tail
    # Artifact names are BASENAMES only — never host paths.
    assert res.artifact_names == ["dashboard.html"]
    assert all("/" not in n for n in res.artifact_names)
    assert res.findings == []


def test_run_qa_phase_red_on_nonzero_exit(tmp_path, monkeypatch) -> None:
    _with_qa_script(tmp_path)
    monkeypatch.setattr(
        qa_phase, "run_with_timeout", _faithful_run_with_timeout(1, log="boom\n")
    )
    res = run_qa_phase(tmp_path, tmp_path / "run", changed_files=["Foo.tsx"])
    assert res.is_red and res.verdict == "failed"
    assert res.exit_code == 1
    assert res.reason == "qa.sh exited 1"
    assert len(res.findings) == 1
    f = res.findings[0]
    assert f["severity"] == "major"
    assert f["category"] == "visual"


def test_run_qa_phase_red_on_timeout_exit_code(tmp_path, monkeypatch) -> None:
    # 124 is run_with_timeout's timeout convention → a fail-safe RED, categorised
    # "blocked" (not a visual defect — the harness never finished).
    _with_qa_script(tmp_path)
    monkeypatch.setattr(
        qa_phase, "run_with_timeout", _faithful_run_with_timeout(124, log="...\n")
    )
    res = run_qa_phase(
        tmp_path, tmp_path / "run", changed_files=["Foo.tsx"], timeout=90
    )
    assert res.is_red
    assert res.exit_code == 124
    assert res.reason == "qa.sh timed out after 90s"
    assert res.findings[0]["category"] == "blocked"


# ---------------------------------------------------------------------------
# AC4 — a genuinely hung harness fails SAFE (real subprocess, real timeout)
# ---------------------------------------------------------------------------


def test_run_qa_phase_real_timeout_fails_safe(tmp_path) -> None:
    # A qa.sh that would sleep far past the ceiling. With NO fake, run_qa_phase
    # drives the real run_with_timeout, which must kill it and return 124 well
    # inside the sleep — proving a hung browser can never wedge a run.
    script = tmp_path / ".agentrail" / "qa.sh"
    script.parent.mkdir(parents=True, exist_ok=True)
    script.write_text("#!/usr/bin/env bash\nsleep 60\n")
    script.chmod(0o755)

    start = time.monotonic()
    res = run_qa_phase(
        tmp_path, tmp_path / "run", changed_files=["Foo.tsx"], timeout=1
    )
    elapsed = time.monotonic() - start

    assert res.is_red
    assert res.exit_code == 124
    assert "timed out after 1s" in res.reason
    # It must NOT have waited out the 60s sleep.
    assert elapsed < 20, f"run_qa_phase hung ({elapsed:.1f}s)"


# ---------------------------------------------------------------------------
# QaResult.to_json — camelCase shape for run.json
# ---------------------------------------------------------------------------


def test_qaresult_to_json_camelcase() -> None:
    res = QaResult(
        verdict="failed",
        reason="qa.sh exited 2",
        exit_code=2,
        artifacts_dir="/x/qa/artifacts",
        artifact_names=["notes.md"],
        log_tail="tail",
        findings=[{"severity": "major"}],
        evidence_refs=[{"label": "shot", "url": "http://x"}],
    )
    j = res.to_json()
    assert set(j) == {
        "verdict",
        "reason",
        "exitCode",
        "artifactsDir",
        "artifactNames",
        "logTail",
        "findings",
        "evidenceRefs",
    }
    assert j["exitCode"] == 2
    assert j["artifactNames"] == ["notes.md"]
