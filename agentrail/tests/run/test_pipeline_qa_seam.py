"""Tests for pipeline._run_qa_gate — the QA seam inside the run pipeline (#1148).

The seam was extracted from ``_run_pipeline`` precisely so it is unit-testable
without a live agent engine. These tests drive it directly with the flag toggled
via ``AGENTRAIL_QA`` and every collaborator (``run_qa_phase``, ``push_qa_gate``,
``push_failure_event``, ``collect_changed_files``) faked, and assert the three
things the seam is responsible for:

* AC3 — flag OFF: returns its inputs unchanged and NEVER touches run.json.
* AC2 — QA red: reds the run exactly like a failed verify gate (status 0→1,
  last_phase→"qa"), records the qa block, posts the gate, and pushes a
  ``qa_failed`` event carrying the log tail as evidence.
* AC1 — QA pass: last_phase→"qa", posts the gate, pushes NO failure event.
* AC4 — the QA machinery raising is swallowed; the run is never wedged.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from agentrail.run import pipeline, verify_gate
from agentrail.run.qa_phase import QaResult


# ---------------------------------------------------------------------------
# Fakes / recorders
# ---------------------------------------------------------------------------


def _qa(verdict: str, *, reason: str, log_tail: str = "log-tail") -> QaResult:
    return QaResult(
        verdict=verdict,
        reason=reason,
        exit_code={"passed": 0, "failed": 1, "skipped": 0}[verdict],
        artifacts_dir="/x/qa/artifacts",
        artifact_names=["notes.md"],
        log_tail=log_tail,
        findings=[] if verdict != "failed" else [{"severity": "major"}],
        evidence_refs=[],
    )


class _Recorder:
    def __init__(self):
        self.calls: list[tuple[tuple, dict]] = []

    def __call__(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return True

    @property
    def called(self) -> bool:
        return bool(self.calls)


def _wire(monkeypatch, *, qa_result: QaResult | None = None, raise_in_phase=None):
    """Patch the seam's collaborators. Returns (gate_rec, fail_rec)."""
    monkeypatch.setattr(verify_gate, "collect_changed_files", lambda _t: ["Foo.tsx"])

    def fake_run_qa_phase(target_dir, run_dir, *, changed_files, **kw):
        if raise_in_phase is not None:
            raise raise_in_phase
        return qa_result

    monkeypatch.setattr(pipeline, "run_qa_phase", fake_run_qa_phase)
    gate_rec, fail_rec = _Recorder(), _Recorder()
    monkeypatch.setattr(pipeline, "push_qa_gate", gate_rec)
    monkeypatch.setattr(pipeline, "push_failure_event", fail_rec)
    return gate_rec, fail_rec


def _call(meta: Path, *, status: int, last_phase: str):
    return pipeline._run_qa_gate(
        metadata_file=meta,
        target_dir=meta.parent,
        run_dir=meta.parent / "run",
        run_id="run-1",
        status=status,
        last_phase=last_phase,
    )


# ---------------------------------------------------------------------------
# AC3 — flag OFF: unchanged inputs, run.json untouched
# ---------------------------------------------------------------------------


def test_flag_off_returns_unchanged_and_never_writes(tmp_path, monkeypatch) -> None:
    monkeypatch.delenv("AGENTRAIL_QA", raising=False)
    meta = tmp_path / "run.json"

    # If any collaborator is touched with the flag off, fail loudly.
    def _boom(*a, **k):
        raise AssertionError("QA machinery must not run when the flag is OFF")

    monkeypatch.setattr(pipeline, "run_qa_phase", _boom)
    monkeypatch.setattr(verify_gate, "collect_changed_files", _boom)

    status, last_phase = _call(meta, status=0, last_phase="verify")
    assert (status, last_phase) == (0, "verify")
    assert not meta.exists()  # byte-identical to today: no run.json written


# ---------------------------------------------------------------------------
# AC2 — QA red reds the run like a failed verify gate
# ---------------------------------------------------------------------------


def test_red_flips_status_and_last_phase(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("AGENTRAIL_QA", "1")
    gate_rec, fail_rec = _wire(
        monkeypatch,
        qa_result=_qa("failed", reason="qa.sh exited 1", log_tail="TAIL-500"),
    )
    meta = tmp_path / "run.json"

    status, last_phase = _call(meta, status=0, last_phase="verify")

    assert (status, last_phase) == (1, "qa")
    # run.json records the qa block (camelCase).
    data = json.loads(meta.read_text())
    assert data["qa"]["verdict"] == "failed"
    # Gate posted, and a qa_failed event with the log tail as evidence.
    assert gate_rec.called
    (args, kwargs) = fail_rec.calls[0]
    assert args[2] == "qa_failed"
    assert args[3] == "qa"
    assert args[4] == "qa.sh exited 1"
    assert kwargs["evidence"] == "TAIL-500"


def test_red_preserves_already_nonzero_status(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("AGENTRAIL_QA", "1")
    _wire(monkeypatch, qa_result=_qa("failed", reason="qa.sh exited 1"))
    meta = tmp_path / "run.json"

    # A run that already failed upstream stays failed — QA red never *lowers*
    # a non-zero status back toward green.
    status, last_phase = _call(meta, status=3, last_phase="verify")
    assert status == 3
    assert last_phase == "qa"


# ---------------------------------------------------------------------------
# AC1 — QA pass: gate posted, no failure event, status stays green
# ---------------------------------------------------------------------------


def test_pass_posts_gate_no_failure_event(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("AGENTRAIL_QA", "1")
    gate_rec, fail_rec = _wire(
        monkeypatch, qa_result=_qa("passed", reason="qa.sh exited 0")
    )
    meta = tmp_path / "run.json"

    status, last_phase = _call(meta, status=0, last_phase="verify")

    assert (status, last_phase) == (0, "qa")
    assert json.loads(meta.read_text())["qa"]["verdict"] == "passed"
    assert gate_rec.called
    assert not fail_rec.called  # a passing QA is not a failure event


# ---------------------------------------------------------------------------
# AC3 — QA skip: recorded, but never a gate and never gates the run
# ---------------------------------------------------------------------------


def test_skip_records_but_does_not_gate(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("AGENTRAIL_QA", "1")
    gate_rec, fail_rec = _wire(
        monkeypatch,
        qa_result=_qa("skipped", reason="change-set touches no UI/runtime surface"),
    )
    meta = tmp_path / "run.json"

    status, last_phase = _call(meta, status=0, last_phase="verify")

    # Status + last_phase untouched (a skip is not a phase transition)...
    assert (status, last_phase) == (0, "verify")
    # ...but the skip IS recorded in run.json for observability...
    assert json.loads(meta.read_text())["qa"]["verdict"] == "skipped"
    # ...and neither a gate nor a failure event is posted.
    assert not gate_rec.called
    assert not fail_rec.called


# ---------------------------------------------------------------------------
# AC4 — the QA machinery raising is swallowed (run never wedged)
# ---------------------------------------------------------------------------


def test_phase_exception_is_swallowed(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("AGENTRAIL_QA", "1")
    _wire(monkeypatch, raise_in_phase=RuntimeError("browser vanished"))
    meta = tmp_path / "run.json"

    # Must not raise; must return inputs unchanged.
    status, last_phase = _call(meta, status=0, last_phase="verify")
    assert (status, last_phase) == (0, "verify")


# ---------------------------------------------------------------------------
# Sibling run.json keys survive the qa write
# ---------------------------------------------------------------------------


def test_existing_run_json_keys_preserved(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("AGENTRAIL_QA", "1")
    _wire(monkeypatch, qa_result=_qa("passed", reason="qa.sh exited 0"))
    meta = tmp_path / "run.json"
    meta.write_text(json.dumps({"objectiveGate": {"verdict": "green"}}))

    _call(meta, status=0, last_phase="verify")

    data = json.loads(meta.read_text())
    assert data["objectiveGate"] == {"verdict": "green"}  # untouched
    assert data["qa"]["verdict"] == "passed"  # added alongside
