"""Tests for agentrail.run.qa_push — the QA review-gate payload and HTTP push (#1148).

Mirrors test_failure_push.py: a linked target (``.agentrail/server.json``) plus a
faked ``urllib.request.urlopen`` so the payload, Bearer header, and endpoint are
asserted without a live console. Non-fatal contract is exercised at both ends —
an unlinked target and a raising ``urlopen`` both return ``False`` and never raise.
A *skipped* verdict is never posted (a skip is not a gate) and must not touch the
network at all.
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path

from agentrail.run import qa_push
from agentrail.run.qa_phase import QaResult


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_server_json(
    tmp_path: Path,
    base_url: str = "http://localhost:3000",
    api_key: str = "ar_test",
    repository_id: str = "repo-abc",
) -> None:
    d = tmp_path / ".agentrail"
    d.mkdir(parents=True, exist_ok=True)
    (d / "server.json").write_text(json.dumps({
        "base_url": base_url,
        "api_key": api_key,
        "repository_id": repository_id,
    }))


def _passed_qa() -> QaResult:
    return QaResult(
        verdict="passed",
        reason="qa.sh exited 0",
        exit_code=0,
        artifacts_dir="/x/qa/artifacts",
        artifact_names=["dashboard.html", "notes.md"],
        log_tail="✅ QA PASSED\n",
        findings=[],
        evidence_refs=[],
    )


def _failed_qa() -> QaResult:
    return QaResult(
        verdict="failed",
        reason="qa.sh exited 1",
        exit_code=1,
        artifacts_dir="/x/qa/artifacts",
        artifact_names=["notes.md"],
        log_tail="❌ QA FAILED: dashboard returned HTTP 500\n",
        findings=[{
            "severity": "major",
            "category": "visual",
            "description": "qa.sh exited 1",
            "suggested_fix": "inspect the QA log tail",
        }],
        evidence_refs=[],
    )


def _skipped_qa() -> QaResult:
    return QaResult(
        verdict="skipped",
        reason="no .agentrail/qa.sh in target repo",
        exit_code=0,
        artifacts_dir="",
        artifact_names=[],
        log_tail="",
        findings=[],
        evidence_refs=[],
    )


def _capture_urlopen(captured: dict):
    class FakeResp:
        status = 202
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def fake_urlopen(req, timeout):
        captured["url"] = req.full_url
        captured["auth"] = req.get_header("Authorization")
        captured["method"] = req.get_method()
        captured["body"] = json.loads(req.data)
        return FakeResp()

    return fake_urlopen


# ---------------------------------------------------------------------------
# Not linked → False (no network call)
# ---------------------------------------------------------------------------


def test_push_qa_gate_returns_false_when_not_linked(tmp_path: Path, monkeypatch) -> None:
    """No server.json → load_link returns None → no network, returns False."""
    def boom(req, timeout):
        raise AssertionError("must not hit the network when unlinked")

    monkeypatch.setattr(qa_push.urllib.request, "urlopen", boom)
    assert qa_push.push_qa_gate(tmp_path, "run-001", _passed_qa()) is False


# ---------------------------------------------------------------------------
# A skipped verdict is never posted (a skip is not a gate) — no network
# ---------------------------------------------------------------------------


def test_push_qa_gate_skipped_is_not_posted(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path)

    def boom(req, timeout):
        raise AssertionError("a skipped QA verdict must not be posted")

    monkeypatch.setattr(qa_push.urllib.request, "urlopen", boom)
    assert qa_push.push_qa_gate(tmp_path, "run-skip", _skipped_qa()) is False


# ---------------------------------------------------------------------------
# 202 → True
# ---------------------------------------------------------------------------


def test_push_qa_gate_returns_true_on_202(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path)
    captured: dict = {}
    monkeypatch.setattr(qa_push.urllib.request, "urlopen", _capture_urlopen(captured))
    assert qa_push.push_qa_gate(tmp_path, "run-202", _passed_qa()) is True


# ---------------------------------------------------------------------------
# Passed payload: endpoint, Bearer, gate_name, deterministic id, no blockers
# ---------------------------------------------------------------------------


def test_push_qa_gate_passed_payload_and_headers(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(
        tmp_path,
        base_url="http://localhost:4000",
        api_key="ar_key99",
        repository_id="repo-xyz",
    )
    captured: dict = {}
    monkeypatch.setattr(qa_push.urllib.request, "urlopen", _capture_urlopen(captured))

    qa_push.push_qa_gate(tmp_path, "run-pass", _passed_qa())

    body = captured["body"]
    assert captured["url"] == "http://localhost:4000/api/v1/ingest/review-gates"
    assert captured["auth"] == "Bearer ar_key99"
    assert captured["method"] == "POST"
    assert body["gate_name"] == "qa"
    assert body["status"] == "passed"
    assert body["repository_id"] == "repo-xyz"
    assert body["run_id"] == "run-pass"
    # Deterministic id → a re-push upserts the same row.
    assert body["id"] == str(uuid.uuid5(uuid.NAMESPACE_URL, "qa-gate:run-pass"))
    assert body["blocking_reasons"] == []
    assert body["findings"] == []
    assert body["evaluated_at"]


# ---------------------------------------------------------------------------
# Failed payload: status failed, blocking_reasons + findings carried
# ---------------------------------------------------------------------------


def test_push_qa_gate_failed_payload_carries_blockers_and_findings(
    tmp_path: Path, monkeypatch
) -> None:
    _write_server_json(tmp_path)
    captured: dict = {}
    monkeypatch.setattr(qa_push.urllib.request, "urlopen", _capture_urlopen(captured))

    qa_push.push_qa_gate(tmp_path, "run-red", _failed_qa())

    body = captured["body"]
    assert body["status"] == "failed"
    assert body["blocking_reasons"] == [{"reason": "qa.sh exited 1"}]
    assert body["findings"][0]["severity"] == "major"
    assert body["findings"][0]["category"] == "visual"


# ---------------------------------------------------------------------------
# build_qa_gate_payload is deterministic per run_id
# ---------------------------------------------------------------------------


def test_build_qa_gate_payload_id_is_stable_per_run() -> None:
    a = qa_push.build_qa_gate_payload("repo-1", "run-42", _passed_qa())
    b = qa_push.build_qa_gate_payload("repo-1", "run-42", _failed_qa())
    # Same run → same gate row id (an upsert), regardless of verdict.
    assert a["id"] == b["id"]
    c = qa_push.build_qa_gate_payload("repo-1", "run-99", _passed_qa())
    assert c["id"] != a["id"]


# ---------------------------------------------------------------------------
# urlopen raises → False (never raises)
# ---------------------------------------------------------------------------


def test_push_qa_gate_returns_false_on_network_error(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path)

    def boom(req, timeout):
        raise OSError("network down")

    monkeypatch.setattr(qa_push.urllib.request, "urlopen", boom)
    assert qa_push.push_qa_gate(tmp_path, "run-err", _passed_qa()) is False


# ---------------------------------------------------------------------------
# Non-202 → False
# ---------------------------------------------------------------------------


def test_push_qa_gate_returns_false_on_non_202(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path)

    class FakeResp:
        status = 500
        def __enter__(self): return self
        def __exit__(self, *a): return False

    monkeypatch.setattr(qa_push.urllib.request, "urlopen", lambda req, timeout: FakeResp())
    assert qa_push.push_qa_gate(tmp_path, "run-500", _passed_qa()) is False


# ---------------------------------------------------------------------------
# Corrupt server.json → False (non-fatal)
# ---------------------------------------------------------------------------


def test_push_qa_gate_returns_false_on_corrupt_link(tmp_path: Path) -> None:
    d = tmp_path / ".agentrail"
    d.mkdir()
    (d / "server.json").write_text("{invalid json")
    assert qa_push.push_qa_gate(tmp_path, "run-corrupt", _passed_qa()) is False
