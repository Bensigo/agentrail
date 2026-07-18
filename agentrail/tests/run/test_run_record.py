"""Unit tests for agentrail/run/run_record.py — the production-run record
assembler (issue #1178, AC1 local slice), plus its CLI wrapper
agentrail/cli/commands/run_records.py.

Fixture run dirs are built by hand under tmp_path to match the on-disk shapes
agentrail/run/artifacts.py and agentrail/run/pipeline.py actually produce (see
those modules + their tests for the source-of-truth field names). No real repo
data is touched here.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

from agentrail.run.run_record import (
    assemble_all,
    assemble_run_record,
    list_candidate_run_ids,
    write_run_record,
)
from agentrail.cli.commands.run_records import run_run_records


# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------

def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def _run_json(**overrides: Any) -> Dict[str, Any]:
    """A realistic run.json payload (agentrail.run.artifacts.write_run_metadata
    shape), with attempt-tracking fields update_run_metadata_attempts adds."""
    defaults: Dict[str, Any] = {
        "startedAt": "2026-07-05T10:00:00Z",
        "targetType": "issue",
        "targetIssue": 1178,
        "agent": "claude",
        "command": "claude -p --dangerously-skip-permissions",
        "executionAttempt": 1,
        "maxExecutionAttempts": 3,
        "failedVerificationAttempts": 0,
        "promptFile": "prompt.md",
        "contextPackFile": "context-pack.json",
        "contextRetrieval": {"chunks": 5},
        "resolvedSkillsFile": "skills.json",
        "resolvedSkills": [{"name": "foo"}],
    }
    defaults.update(overrides)
    return defaults


def _write_phase(
    run_dir: Path,
    dir_name: str,
    *,
    phase_field: Optional[str] = None,
    status: str = "completed",
    started_at: Optional[str] = "2026-07-05T10:01:00Z",
    finished_at: Optional[str] = "2026-07-05T10:05:00Z",
    exit_status: int = 0,
    with_output: bool = True,
    verdict: Optional[Dict[str, Any]] = None,
    budget_marker: Optional[Dict[str, Any]] = None,
) -> Path:
    """Write a phase dir (agentrail.run.artifacts.write_phase_status shape).

    dir_name is the directory name (may be retry-suffixed, e.g. "execute-2");
    phase_field is the "phase" key inside status.json, which the real pipeline
    always sets to the *base* name even inside a retry dir — defaults to
    dir_name when not overridden. ``verdict``, when given, mirrors what
    agentrail.run.artifacts.write_phase_verdict merges onto a verify phase's
    status.json post-#1181; omitted by default (no "verdict" key at all),
    matching a phase status.json that predates the write-back or was never a
    verify phase. ``budget_marker``, when given, mirrors what
    agentrail.run.artifacts.write_phase_budget_marker merges on post-#1269
    review (e.g. ``{"budgetExceeded": True, "budgetSpentUsd": 1.5,
    "budgetCeilingUsd": 1.0}``); omitted by default (no budget keys at all),
    matching a phase that never had a budget stop.
    """
    phase_dir = run_dir / dir_name
    payload: Dict[str, Any] = {
        "phase": phase_field or dir_name,
        "status": status,
        "startedAt": started_at,
        "finishedAt": finished_at,
        "exitStatus": exit_status,
        "metadataFile": f"{dir_name}/metadata.json",
        "outputFile": f"{dir_name}/output.md" if with_output else None,
        "executionAttempt": 1,
        "maxExecutionAttempts": 3,
    }
    if verdict is not None:
        payload["verdict"] = verdict
    if budget_marker is not None:
        payload.update(budget_marker)
    _write_json(phase_dir / "status.json", payload)
    if with_output:
        (phase_dir / "output.md").write_text("phase output\n", encoding="utf-8")
    return phase_dir


def _ledger_event(**overrides: Any) -> Dict[str, Any]:
    """A cost-events.jsonl row (agentrail.run.cost_push.build_cost_record shape)."""
    defaults: Dict[str, Any] = {
        "run_id": "run-1",
        "cost_type": "model_call",
        "tokens": 1260,
        "cost_usd": 0.05,
        "model": "claude-sonnet-5",
        "occurred_at": "2026-07-05T10:03:00Z",
        "event_id": "evt-1",
        "phase": "execute",
        "input_tokens": 1000,
        "output_tokens": 200,
        "cache_tokens": 50,
        "cache_creation_tokens": 10,
        "cache_savings": 0.0,
    }
    defaults.update(overrides)
    return defaults


def _write_ledger(path: Path, events: List[Dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        for ev in events:
            fh.write(json.dumps(ev) + "\n")


def _seed_run(target: Path, run_id: str, **run_json_overrides: Any) -> Path:
    """Seed a full run dir under <target>/.agentrail/runs/<run_id>/ with a
    run.json and one completed "execute" phase — for assemble_all/CLI tests."""
    run_dir = target / ".agentrail" / "runs" / run_id
    _write_json(run_dir / "run.json", _run_json(**run_json_overrides))
    _write_phase(run_dir, "execute", started_at="2026-07-05T10:02:00Z", finished_at="2026-07-05T10:10:00Z")
    return run_dir


# ---------------------------------------------------------------------------
# Scenario 1: modern full run with ledger
# ---------------------------------------------------------------------------

def test_modern_full_run_with_ledger(tmp_path: Path) -> None:
    run_id = "20260705-100000-issue-1178-claude-1111"
    run_dir = tmp_path / run_id
    _write_json(run_dir / "run.json", _run_json(
        readsCoverage={"precision": 0.8, "recall": 0.9},
        objectiveGate={"passed": True, "reason": "tests green"},
        review={"outcome": "approved"},
    ))
    _write_phase(run_dir, "plan", started_at="2026-07-05T10:00:05Z", finished_at="2026-07-05T10:02:00Z")
    _write_phase(run_dir, "execute", started_at="2026-07-05T10:02:00Z", finished_at="2026-07-05T10:10:00Z")
    _write_phase(
        run_dir, "verify", started_at="2026-07-05T10:10:00Z", finished_at="2026-07-05T10:12:00Z",
        verdict={"accepted": True, "reason": "tests pin the AC"},
    )

    ledger_path = tmp_path / "cost-events.jsonl"
    _write_ledger(ledger_path, [
        _ledger_event(run_id=run_id, phase="plan", cost_usd=0.01),
        _ledger_event(run_id=run_id, phase="execute", cost_usd=0.05),
        _ledger_event(run_id=run_id, phase="verify", cost_usd=0.02),
        _ledger_event(run_id="some-other-run", phase="execute", cost_usd=99.0),  # must be filtered out
    ])

    record = assemble_run_record(run_dir, ledger_path)

    assert record["record_version"] == 1
    assert record["source"] == "production"
    assert record["run_id"] == run_id
    assert record["run_dir"] == str(run_dir.resolve())
    assert record["target_type"] == "issue"
    assert record["issue"] == 1178
    assert record["agent"] == "claude"
    assert record["command"] == "claude -p --dangerously-skip-permissions"
    assert record["started_at"] == "2026-07-05T10:00:00Z"
    assert record["finished_at"] == "2026-07-05T10:12:00Z"
    assert record["attempts"] == {
        "execution_attempt": 1,
        "max_execution_attempts": 3,
        "failed_verification_attempts": 0,
    }
    assert record["resolved_skills"] == [{"name": "foo"}]
    assert record["context_pack_file"] == "context-pack.json"
    assert record["context_retrieval"] == {"chunks": 5}
    assert record["reads_coverage"] == {"precision": 0.8, "recall": 0.9}

    names = [p["name"] for p in record["phases"]]
    assert names == ["plan", "execute", "verify"]  # time order, not alpha order
    for p in record["phases"]:
        assert p["status"] == "completed"
        assert p["cost_usd"] is not None
    plan_phase = record["phases"][0]
    assert plan_phase["tokens"] == {"input": 1000, "output": 200, "cache": 50, "cache_creation": 10}
    assert plan_phase["model"] == "claude-sonnet-5"
    assert plan_phase["cost_usd"] == pytest.approx(0.01)

    assert record["cost"]["events"] == 3  # the other-run event is excluded
    assert record["cost"]["unmatched_phases"] == []
    assert record["cost"]["total_usd"] == pytest.approx(0.08)

    assert record["objective_gate"] == {"passed": True, "reason": "tests green"}
    assert record["review"] == {"outcome": "approved"}
    assert record["verify_phase_ran"] is True
    assert record["verify_verdict"] == {"accepted": True, "reason": "tests pin the AC"}
    verify_phase = next(p for p in record["phases"] if p["name"] == "verify")
    assert verify_phase["verdict"] == {"accepted": True, "reason": "tests pin the AC"}
    assert record["blocked_reason"] is None
    assert record["verifier_findings_file"] is None
    assert record["ci_outcome"] is None
    assert record["review_outcome"] is None
    assert record["branch"] is None
    assert record["diff_path"] is None
    assert record["missing"] == []
    assert record["assembled_at"].endswith("Z")


# ---------------------------------------------------------------------------
# Scenario 2: legacy run without readsCoverage/objectiveGate/ledger
# ---------------------------------------------------------------------------

def test_legacy_run_missing_newer_fields_and_ledger(tmp_path: Path) -> None:
    run_id = "20260610-090000-issue-42-claude-2222"
    run_dir = tmp_path / run_id
    _write_json(run_dir / "run.json", _run_json(targetIssue=42))  # predates readsCoverage/objectiveGate
    _write_phase(run_dir, "plan", started_at="2026-06-10T09:00:05Z", finished_at="2026-06-10T09:02:00Z")
    _write_phase(run_dir, "execute", started_at="2026-06-10T09:02:00Z", finished_at="2026-06-10T09:20:00Z")

    record = assemble_run_record(run_dir, ledger_path=None)

    assert record["reads_coverage"] is None
    assert record["objective_gate"] is None
    assert record["review"] is None
    assert record["blocked_reason"] is None
    assert record["verifier_findings_file"] is None
    assert record["verify_phase_ran"] is False  # no "verify" dir
    assert record["cost"] == {"total_usd": None, "events": 0, "unmatched_phases": []}

    assert "readsCoverage (absent in run.json)" in record["missing"]
    assert "objectiveGate (absent in run.json)" in record["missing"]
    assert "cost-events.jsonl (absent)" in record["missing"]
    # review/blockedReason/verifierFindingsFile absence is a normal run state
    # (not blocked, not reviewed, no findings) — NOT a legacy-data gap.
    assert not any("review" in m for m in record["missing"])
    assert not any("blockedReason" in m for m in record["missing"])
    assert not any("verifierFindingsFile" in m for m in record["missing"])


# ---------------------------------------------------------------------------
# Scenario 3: parked run with blockedReason and zero phase dirs
# ---------------------------------------------------------------------------

def test_parked_run_blocked_reason_zero_phases(tmp_path: Path) -> None:
    run_id = "20260703-140000-issue-77-claude-3333"
    run_dir = tmp_path / run_id
    _write_json(run_dir / "run.json", _run_json(
        targetIssue=77,
        blockedReason="awaiting human review: ambiguous acceptance criteria",
        readsCoverage={"precision": 0.5, "recall": 0.6},
        objectiveGate={"passed": False, "reason": "blocked before verify"},
    ))
    # No phase subdirectories at all — run parked before any phase completed.

    record = assemble_run_record(run_dir, ledger_path=None)

    assert record["phases"] == []
    assert record["finished_at"] is None
    assert record["verify_phase_ran"] is False
    assert record["blocked_reason"] == "awaiting human review: ambiguous acceptance criteria"
    assert record["objective_gate"] == {"passed": False, "reason": "blocked before verify"}
    # readsCoverage/objectiveGate are present, so the only gap is the ledger.
    assert record["missing"] == ["cost-events.jsonl (absent)"]


# ---------------------------------------------------------------------------
# Scenario 4: run dir with no run.json at all
# ---------------------------------------------------------------------------

def test_run_dir_with_no_run_json(tmp_path: Path) -> None:
    run_id = "20260701-080000-issue-9-claude-4444"
    run_dir = tmp_path / run_id
    _write_phase(run_dir, "execute", started_at="2026-07-01T08:00:10Z", finished_at="2026-07-01T08:05:00Z")

    record = assemble_run_record(run_dir, ledger_path=None)

    assert record["run_id"] == run_id
    assert record["target_type"] is None
    assert record["issue"] is None
    assert record["agent"] is None
    assert record["command"] is None
    assert record["started_at"] is None
    assert record["attempts"] == {
        "execution_attempt": None,
        "max_execution_attempts": None,
        "failed_verification_attempts": None,
    }
    assert record["resolved_skills"] is None
    assert len(record["phases"]) == 1
    assert record["finished_at"] == "2026-07-01T08:05:00Z"

    assert "run.json (absent)" in record["missing"]
    assert "cost-events.jsonl (absent)" in record["missing"]
    # The readsCoverage/objectiveGate missing-checks only fire when run.json IS
    # present but lacks them — an absent run.json must not double-report.
    assert not any("readsCoverage" in m for m in record["missing"])
    assert not any("objectiveGate" in m for m in record["missing"])


# ---------------------------------------------------------------------------
# Robustness: "never raises on missing/malformed artifacts" (explicit contract)
# ---------------------------------------------------------------------------

def test_assemble_run_record_never_raises_on_totally_missing_run_dir(tmp_path: Path) -> None:
    ghost_dir = tmp_path / "does-not-exist-at-all"
    record = assemble_run_record(ghost_dir, ledger_path=None)
    assert record["run_id"] == "does-not-exist-at-all"
    assert record["phases"] == []
    assert "run.json (absent)" in record["missing"]


def test_assemble_run_record_never_raises_on_malformed_run_json(tmp_path: Path) -> None:
    run_id = "20260701-080000-issue-9-claude-5555"
    run_dir = tmp_path / run_id
    run_dir.mkdir(parents=True)
    (run_dir / "run.json").write_text("{not valid json", encoding="utf-8")

    record = assemble_run_record(run_dir, ledger_path=None)

    assert record["run_id"] == run_id
    assert record["target_type"] is None
    assert any(m.startswith("run.json (unreadable") for m in record["missing"])


def test_assemble_run_record_never_raises_on_malformed_phase_status(tmp_path: Path) -> None:
    run_id = "20260701-080000-issue-9-claude-6666"
    run_dir = tmp_path / run_id
    _write_json(run_dir / "run.json", _run_json())
    phase_dir = run_dir / "execute"
    phase_dir.mkdir(parents=True)
    (phase_dir / "status.json").write_text("[]", encoding="utf-8")  # valid JSON, not an object

    record = assemble_run_record(run_dir, ledger_path=None)

    phase = record["phases"][0]
    assert phase["name"] == "execute"
    assert phase["status"] is None
    assert any("execute/status.json" in m for m in record["missing"])


# ---------------------------------------------------------------------------
# write_run_record: path convention + json format
# ---------------------------------------------------------------------------

def test_write_run_record_path_and_format(tmp_path: Path) -> None:
    record = {"run_id": "myrun-123", "foo": "bar"}
    records_dir = tmp_path / "records"
    out_path = write_run_record(record, records_dir)

    assert out_path == records_dir / "myrun-123.json"
    text = out_path.read_text(encoding="utf-8")
    assert text.endswith("\n")
    assert json.loads(text) == record
    assert '"foo": "bar"' in text  # indent=2 pretty-printing


# ---------------------------------------------------------------------------
# Scenario 5: idempotency (assemble_all twice -> skip; force=True rewrites)
# ---------------------------------------------------------------------------

def test_assemble_all_idempotent_and_force_rewrites(tmp_path: Path) -> None:
    _seed_run(tmp_path, "20260705-100000-issue-1-claude-1", targetIssue=1)
    _seed_run(tmp_path, "20260705-110000-issue-2-claude-2", targetIssue=2)

    written_first = assemble_all(tmp_path)
    assert len(written_first) == 2
    records_dir = tmp_path / ".agentrail" / "run-records"
    assert (records_dir / "20260705-100000-issue-1-claude-1.json").exists()
    assert (records_dir / "20260705-110000-issue-2-claude-2.json").exists()

    written_second = assemble_all(tmp_path)
    assert written_second == []  # both already have records, no force

    # Mutate one record on disk to prove force=True rewrites it (not a no-op).
    rec_path = records_dir / "20260705-100000-issue-1-claude-1.json"
    tampered = json.loads(rec_path.read_text())
    tampered["missing"] = ["tampered-marker"]
    rec_path.write_text(json.dumps(tampered))

    written_forced = assemble_all(tmp_path, force=True)
    assert len(written_forced) == 2
    rewritten = json.loads(rec_path.read_text())
    assert rewritten["missing"] != ["tampered-marker"]


# ---------------------------------------------------------------------------
# Scenario 6: retry dir "execute-2" as own phase entry + unmatched ledger
# phase "gather"
# ---------------------------------------------------------------------------

def test_retry_phase_dir_and_unmatched_ledger_phase(tmp_path: Path) -> None:
    run_id = "20260706-090000-issue-55-claude-6666"
    run_dir = tmp_path / run_id
    _write_json(run_dir / "run.json", _run_json(
        targetIssue=55, executionAttempt=2, failedVerificationAttempts=1,
    ))
    _write_phase(run_dir, "plan", started_at="2026-07-06T09:00:05Z", finished_at="2026-07-06T09:01:00Z")
    _write_phase(
        run_dir, "execute", status="failed", exit_status=1,
        started_at="2026-07-06T09:01:00Z", finished_at="2026-07-06T09:05:00Z",
    )
    _write_phase(
        run_dir, "execute-2", phase_field="execute",
        started_at="2026-07-06T09:06:00Z", finished_at="2026-07-06T09:12:00Z",
    )

    ledger_path = tmp_path / "cost-events.jsonl"
    _write_ledger(ledger_path, [
        _ledger_event(run_id=run_id, phase="plan", cost_usd=0.01),
        # The ledger only ever tags the BASE phase name — pipeline.py pushes
        # cost events keyed by `phase`, never the retry-suffixed dir name — so
        # this event can only ever attribute to the "execute" dir, never
        # "execute-2". That is a real system limitation, not a bug here.
        _ledger_event(run_id=run_id, phase="execute", cost_usd=0.03),
        # "gather" has no matching phase dir in this run at all.
        _ledger_event(run_id=run_id, phase="gather", cost_usd=0.02),
    ])

    record = assemble_run_record(run_dir, ledger_path)

    names = [p["name"] for p in record["phases"]]
    assert names == ["plan", "execute", "execute-2"]

    execute_1 = next(p for p in record["phases"] if p["name"] == "execute")
    assert execute_1["status"] == "failed"
    assert execute_1["cost_usd"] == pytest.approx(0.03)

    execute_2 = next(p for p in record["phases"] if p["name"] == "execute-2")
    assert execute_2["status"] == "completed"
    assert execute_2["cost_usd"] is None  # unattributable — ledger has no "execute-2" tag
    assert execute_2["tokens"] is None

    assert record["cost"]["unmatched_phases"] == ["gather"]
    assert record["cost"]["events"] == 3
    assert record["cost"]["total_usd"] == pytest.approx(0.01 + 0.03 + 0.02)
    assert record["verify_phase_ran"] is False


# ---------------------------------------------------------------------------
# Scenario 7: since filter, including run-ids without a date prefix
# ---------------------------------------------------------------------------

def test_since_filter_keeps_undated_run_ids(tmp_path: Path) -> None:
    _seed_run(tmp_path, "20260601-090000-issue-1-claude-1")  # before since -> excluded
    _seed_run(tmp_path, "20260710-090000-issue-2-claude-2")  # on/after since -> included
    _seed_run(tmp_path, "prompt-adhoc-followup")             # no parseable date prefix -> always kept

    candidates = list_candidate_run_ids(tmp_path, since="2026-07-01")
    assert "20260601-090000-issue-1-claude-1" not in candidates
    assert "20260710-090000-issue-2-claude-2" in candidates
    assert "prompt-adhoc-followup" in candidates

    # assemble_all applies the identical filter end-to-end.
    written = assemble_all(tmp_path, since="2026-07-01")
    written_ids = {p.stem for p in written}
    assert "20260601-090000-issue-1-claude-1" not in written_ids
    assert "20260710-090000-issue-2-claude-2" in written_ids
    assert "prompt-adhoc-followup" in written_ids

    # No filter -> everything is a candidate.
    assert set(list_candidate_run_ids(tmp_path, since=None)) == {
        "20260601-090000-issue-1-claude-1",
        "20260710-090000-issue-2-claude-2",
        "prompt-adhoc-followup",
    }


# ---------------------------------------------------------------------------
# Scenario 8: CLI invocation
# ---------------------------------------------------------------------------

def test_cli_run_records_writes_and_reports(tmp_path: Path, capsys: pytest.CaptureFixture) -> None:
    _seed_run(tmp_path, "20260705-100000-issue-1-claude-1", targetIssue=1)
    _seed_run(tmp_path, "20260705-110000-issue-2-claude-2", targetIssue=2)

    rc = run_run_records(["--target", str(tmp_path)])
    assert rc == 0
    out = capsys.readouterr().out
    assert "assembled 20260705-100000-issue-1-claude-1 ->" in out
    assert "assembled 20260705-110000-issue-2-claude-2 ->" in out
    assert "2 assembled, 0 skipped" in out

    records_dir = tmp_path / ".agentrail" / "run-records"
    assert (records_dir / "20260705-100000-issue-1-claude-1.json").exists()
    assert (records_dir / "20260705-110000-issue-2-claude-2.json").exists()


def test_cli_run_records_json_output_parses_and_skips_existing(
    tmp_path: Path, capsys: pytest.CaptureFixture,
) -> None:
    _seed_run(tmp_path, "20260705-100000-issue-1-claude-1", targetIssue=1)
    _seed_run(tmp_path, "20260705-110000-issue-2-claude-2", targetIssue=2)
    records_dir = tmp_path / ".agentrail" / "run-records"

    rc = run_run_records(["--target", str(tmp_path), "--json"])
    assert rc == 0
    payload = json.loads(capsys.readouterr().out)
    assert sorted(payload["assembled"]) == sorted(
        str(records_dir / f"{rid}.json")
        for rid in ("20260705-100000-issue-1-claude-1", "20260705-110000-issue-2-claude-2")
    )
    assert payload["skipped"] == []

    # Second run: already-assembled records are skipped, not rewritten.
    rc2 = run_run_records(["--target", str(tmp_path), "--json"])
    assert rc2 == 0
    payload2 = json.loads(capsys.readouterr().out)
    assert payload2["assembled"] == []
    assert sorted(payload2["skipped"]) == [
        "20260705-100000-issue-1-claude-1",
        "20260705-110000-issue-2-claude-2",
    ]

    # --force rewrites and reports both as assembled again.
    rc3 = run_run_records(["--target", str(tmp_path), "--force", "--json"])
    assert rc3 == 0
    payload3 = json.loads(capsys.readouterr().out)
    assert sorted(payload3["assembled"]) == sorted(
        str(records_dir / f"{rid}.json")
        for rid in ("20260705-100000-issue-1-claude-1", "20260705-110000-issue-2-claude-2")
    )
    assert payload3["skipped"] == []


def test_cli_help_flag_returns_0(capsys: pytest.CaptureFixture) -> None:
    rc = run_run_records(["--help"])
    assert rc == 0


def test_cli_bad_since_returns_2(capsys: pytest.CaptureFixture) -> None:
    rc = run_run_records(["--since", "07-01-2026"])
    assert rc == 2
    assert "--since must be YYYY-MM-DD" in capsys.readouterr().err


def test_cli_missing_target_value_returns_2(capsys: pytest.CaptureFixture) -> None:
    rc = run_run_records(["--target"])
    assert rc == 2


def test_cli_unknown_option_returns_2(capsys: pytest.CaptureFixture) -> None:
    rc = run_run_records(["--bogus"])
    assert rc == 2
    assert "Unknown option: --bogus" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# Scenario 9: verify verdict pass-through + missing[] semantics (issue #1181)
# ---------------------------------------------------------------------------
#
# A phase's status.json is written purely from the process exit code: a verify
# agent that runs cleanly but REJECTS the change in prose is otherwise
# structurally indistinguishable from a genuine approval (status="completed",
# exitStatus=0 either way). agentrail.run.pipeline now writes the parsed
# Verdict back onto verify/status.json (agentrail.run.artifacts.write_phase_verdict)
# right after agentrail.run.verifier.parse_verdict runs; these tests exercise
# how that structured field surfaces in the assembled record.

def test_verify_phase_without_verdict_field_flags_missing(tmp_path: Path) -> None:
    """A verify phase dir exists but its status.json predates the #1181
    write-back (no "verdict" key at all) -> verify_verdict is null AND the gap
    is named in missing, distinct from "no verify phase ran"."""
    run_id = "20260610-090000-issue-42-claude-7777"
    run_dir = tmp_path / run_id
    _write_json(run_dir / "run.json", _run_json(targetIssue=42))
    _write_phase(run_dir, "execute", started_at="2026-06-10T09:00:05Z", finished_at="2026-06-10T09:02:00Z")
    _write_phase(run_dir, "verify", started_at="2026-06-10T09:02:00Z", finished_at="2026-06-10T09:04:00Z")

    record = assemble_run_record(run_dir, ledger_path=None)

    assert record["verify_phase_ran"] is True
    assert record["verify_verdict"] is None
    verify_phase = next(p for p in record["phases"] if p["name"] == "verify")
    assert verify_phase["verdict"] is None
    assert "verify verdict (absent in verify/status.json)" in record["missing"]


def test_no_verify_phase_does_not_flag_missing_verdict(tmp_path: Path) -> None:
    """No verify phase ran at all (e.g. no distinct verifier model configured)
    -> verify_verdict is null but this must NOT be reported in missing (that
    absence is already fully explained by verify_phase_ran=False)."""
    run_id = "20260610-090000-issue-42-claude-8888"
    run_dir = tmp_path / run_id
    _write_json(run_dir / "run.json", _run_json(targetIssue=42))
    _write_phase(run_dir, "execute", started_at="2026-06-10T09:00:05Z", finished_at="2026-06-10T09:02:00Z")

    record = assemble_run_record(run_dir, ledger_path=None)

    assert record["verify_phase_ran"] is False
    assert record["verify_verdict"] is None
    assert not any("verify verdict" in m for m in record["missing"])


def test_verify_verdict_rejected_passes_through_per_phase_and_top_level(tmp_path: Path) -> None:
    run_id = "20260706-090000-issue-99-claude-9999"
    run_dir = tmp_path / run_id
    _write_json(run_dir / "run.json", _run_json(targetIssue=99))
    _write_phase(run_dir, "execute", started_at="2026-07-06T09:00:05Z", finished_at="2026-07-06T09:02:00Z")
    _write_phase(
        run_dir, "verify", started_at="2026-07-06T09:02:00Z", finished_at="2026-07-06T09:04:00Z",
        verdict={"accepted": False, "reason": "tautological test, never observed red"},
    )

    record = assemble_run_record(run_dir, ledger_path=None)

    expected = {"accepted": False, "reason": "tautological test, never observed red"}
    assert record["verify_verdict"] == expected
    verify_phase = next(p for p in record["phases"] if p["name"] == "verify")
    assert verify_phase["verdict"] == expected
    # A rejected verdict is not itself a data gap — the field IS present.
    assert not any("verify verdict" in m for m in record["missing"])


def test_ac3_prose_reject_with_clean_exit_is_distinguishable_from_approval(tmp_path: Path) -> None:
    """AC3 regression (issue #1181): reproduce the historical false-green shape
    — the verify agent process exits 0 and its own status.json says
    status="completed" exactly as an approval would, but its output.md is a
    prose REJECT. Before this fix, nothing in the phase's own artifacts (nor
    the assembled record) distinguished this from a genuine approval; only the
    structured "verdict" field does. This pins that the structured field alone
    is sufficient to tell them apart — a judge/consumer must not need to
    re-parse output.md prose."""
    run_id = "20260628-090000-issue-1181-claude-aaaa"
    run_dir = tmp_path / run_id
    _write_json(run_dir / "run.json", _run_json(targetIssue=1181))
    _write_phase(run_dir, "execute", started_at="2026-06-28T09:00:05Z", finished_at="2026-06-28T09:02:00Z")

    # The historical shape: clean process exit, "completed" status — nothing
    # here says REJECT ...
    verify_dir = _write_phase(
        run_dir, "verify", status="completed", exit_status=0,
        started_at="2026-06-28T09:02:00Z", finished_at="2026-06-28T09:04:00Z",
        with_output=False,
        # ... except the structured verdict the #1181 fix now writes back:
        verdict={"accepted": False, "reason": "asserts nothing about the acceptance criteria"},
    )
    # ... and the agent's own prose, buried in output.md, is the only OTHER
    # place a rejection shows up pre-fix — a judge should NOT need to parse this.
    (verify_dir / "output.md").write_text(
        'VERDICT: {"verdict": "reject", "reason": "asserts nothing about the acceptance criteria"}\n',
        encoding="utf-8",
    )

    record = assemble_run_record(run_dir, ledger_path=None)

    verify_phase = next(p for p in record["phases"] if p["name"] == "verify")
    # The structurally ambiguous fields, taken alone, look exactly like an
    # approval — this is precisely the bug #1181 fixes.
    assert verify_phase["status"] == "completed"
    assert verify_phase["exit_status"] == 0
    # The verdict field is what actually distinguishes reject from accept.
    assert verify_phase["verdict"]["accepted"] is False
    assert record["verify_verdict"]["accepted"] is False
    assert not any("verify verdict" in m for m in record["missing"])


# ---------------------------------------------------------------------------
# Scenario 10: budget-stop marker pass-through (issue #1269 review, Fix 1)
# ---------------------------------------------------------------------------
#
# A phase the Budget Leash stops writes status="failed" indistinguishably from
# a genuine agent failure (run_issue_phase forces the exit status non-zero
# either way). agentrail.run.pipeline now writes a structured budget marker
# back onto the TRIGGERING phase's status.json (agentrail.run.artifacts.
# write_phase_budget_marker) right after the Budget Leash trips; these tests
# exercise how that field surfaces in the assembled record.

def test_budget_exceeded_marker_passes_through_to_phase_record(tmp_path: Path) -> None:
    run_id = "20260718-090000-issue-1269-claude-bbbb"
    run_dir = tmp_path / run_id
    _write_json(run_dir / "run.json", _run_json(targetIssue=1269))
    _write_phase(run_dir, "test-author", started_at="2026-07-18T09:00:05Z", finished_at="2026-07-18T09:01:00Z")
    _write_phase(
        run_dir, "execute", status="failed", exit_status=1,
        started_at="2026-07-18T09:01:00Z", finished_at="2026-07-18T09:02:00Z",
        budget_marker={
            "budgetExceeded": True, "budgetSpentUsd": 1.50, "budgetCeilingUsd": 1.00,
        },
    )

    record = assemble_run_record(run_dir, ledger_path=None)

    execute_phase = next(p for p in record["phases"] if p["name"] == "execute")
    assert execute_phase["budget_exceeded"] is True
    assert execute_phase["budget_spent_usd"] == 1.50
    assert execute_phase["budget_ceiling_usd"] == 1.00


def test_budget_exceeded_absent_when_phase_never_budget_stopped(tmp_path: Path) -> None:
    """A phase that failed for an ordinary reason (no budget marker written)
    surfaces budget_exceeded as None, not False — "never recorded" stays
    distinguishable from "recorded, and it was clean" (mirrors verify_verdict's
    None-when-absent contract above)."""
    run_id = "20260718-090000-issue-1269-claude-cccc"
    run_dir = tmp_path / run_id
    _write_json(run_dir / "run.json", _run_json(targetIssue=1269))
    _write_phase(
        run_dir, "execute", status="failed", exit_status=124,
        started_at="2026-07-18T09:01:00Z", finished_at="2026-07-18T09:02:00Z",
    )

    record = assemble_run_record(run_dir, ledger_path=None)

    execute_phase = next(p for p in record["phases"] if p["name"] == "execute")
    assert execute_phase["budget_exceeded"] is None
    assert execute_phase["budget_spent_usd"] is None
    assert execute_phase["budget_ceiling_usd"] is None
