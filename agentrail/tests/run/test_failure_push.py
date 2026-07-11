"""Tests for agentrail.run.failure_push — failure event payload and HTTP push.

Coverage:
- push_failure_event returns False when not linked (no server.json).
- push_failure_event returns True on HTTP 202; payload carries all required fields
  and correct Bearer header.
- push_failure_event returns False (never raises) when urlopen raises.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from agentrail.run import failure_push


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


# ---------------------------------------------------------------------------
# Not linked → False (no network call)
# ---------------------------------------------------------------------------


def test_push_failure_event_returns_false_when_not_linked(tmp_path: Path) -> None:
    """No server.json → load_link returns None → no network, returns False."""
    result = failure_push.push_failure_event(
        tmp_path,
        run_id="run-001",
        failure_type="phase_failure",
        phase="execute",
        message="exit status 1",
    )
    assert result is False


# ---------------------------------------------------------------------------
# Mocked server: correct payload + Bearer header; 202 → True
# ---------------------------------------------------------------------------


def test_push_failure_event_returns_true_on_202(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path)

    class FakeResp:
        status = 202
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def fake_urlopen(req, timeout):
        return FakeResp()

    monkeypatch.setattr(failure_push.urllib.request, "urlopen", fake_urlopen)
    result = failure_push.push_failure_event(
        tmp_path,
        run_id="run-202",
        failure_type="phase_failure",
        phase="execute",
        message="phase failed",
    )
    assert result is True


def test_push_failure_event_payload_and_headers(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(
        tmp_path,
        base_url="http://localhost:4000",
        api_key="ar_key99",
        repository_id="repo-xyz",
    )
    captured: dict = {}

    class FakeResp:
        status = 202
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def fake_urlopen(req, timeout):
        captured["url"] = req.full_url
        captured["auth"] = req.get_header("Authorization")
        captured["body"] = json.loads(req.data)
        return FakeResp()

    monkeypatch.setattr(failure_push.urllib.request, "urlopen", fake_urlopen)

    failure_push.push_failure_event(
        tmp_path,
        run_id="run-verify",
        failure_type="timeout",
        phase="execute",
        message="agent timed out after 1800s",
    )

    body = captured["body"]
    assert captured["url"] == "http://localhost:4000/api/v1/ingest/failure-events"
    assert captured["auth"] == "Bearer ar_key99"
    assert body["run_id"] == "run-verify"
    assert body["repository_id"] == "repo-xyz"
    assert body["failure_type"] == "timeout"
    assert body["phase"] == "execute"
    assert body["message"] == "agent timed out after 1800s"
    assert body["normalized_error"]
    assert body["normalized_error"] != body["message"]
    assert "1800" not in body["normalized_error"]
    assert body["fingerprint"]
    assert body["severity"] == "error"
    assert body["occurred_at"].endswith("Z")


# ---------------------------------------------------------------------------
# AC1 — evidence flows into the payload (bounded)
# ---------------------------------------------------------------------------


def _capture_urlopen(captured: dict):
    class FakeResp:
        status = 202
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def fake_urlopen(req, timeout):
        captured["body"] = json.loads(req.data)
        return FakeResp()

    return fake_urlopen


def test_push_failure_event_includes_evidence_in_payload(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path)
    captured: dict = {}
    monkeypatch.setattr(failure_push.urllib.request, "urlopen", _capture_urlopen(captured))

    evidence = "verify.sh failed\nE   AssertionError: expected 3 got 4\n"
    failure_push.push_failure_event(
        tmp_path,
        run_id="run-ev",
        failure_type="phase_failure",
        phase="verify",
        message="verify phase exited with status 1",
        evidence=evidence,
    )

    body = captured["body"]
    assert "evidence" in body
    assert "AssertionError: expected 3 got 4" in body["evidence"]


def test_push_failure_event_empty_evidence_default(tmp_path: Path, monkeypatch) -> None:
    """Callers that omit evidence still send the key as an empty string."""
    _write_server_json(tmp_path)
    captured: dict = {}
    monkeypatch.setattr(failure_push.urllib.request, "urlopen", _capture_urlopen(captured))

    failure_push.push_failure_event(
        tmp_path,
        run_id="run-noev",
        failure_type="budget_exceeded",
        phase="plan",
        message="budget exceeded",
    )
    assert captured["body"]["evidence"] == ""


def test_push_failure_event_caps_evidence_lines(tmp_path: Path, monkeypatch) -> None:
    """Evidence is tailed to the last ~200 lines so it can't balloon the row."""
    _write_server_json(tmp_path)
    captured: dict = {}
    monkeypatch.setattr(failure_push.urllib.request, "urlopen", _capture_urlopen(captured))

    lines = [f"log line {i}" for i in range(1000)]
    failure_push.push_failure_event(
        tmp_path,
        run_id="run-big",
        failure_type="phase_failure",
        phase="execute",
        message="boom",
        evidence="\n".join(lines),
    )
    ev = captured["body"]["evidence"]
    assert ev.count("\n") + 1 <= failure_push._EVIDENCE_MAX_LINES
    # The TAIL is what survives (most recent output), not the head.
    assert "log line 999" in ev
    assert "log line 0\n" not in ev


def test_push_failure_event_caps_evidence_bytes(tmp_path: Path, monkeypatch) -> None:
    """Even within the line budget, evidence is byte-capped (UI-facing column)."""
    _write_server_json(tmp_path)
    captured: dict = {}
    monkeypatch.setattr(failure_push.urllib.request, "urlopen", _capture_urlopen(captured))

    # 50 very long lines (well under the line cap, well over the byte cap).
    fat = "\n".join("x" * 4000 for _ in range(50))
    failure_push.push_failure_event(
        tmp_path,
        run_id="run-fat",
        failure_type="phase_failure",
        phase="execute",
        message="boom",
        evidence=fat,
    )
    assert len(captured["body"]["evidence"].encode("utf-8")) <= failure_push._EVIDENCE_MAX_BYTES


# ---------------------------------------------------------------------------
# AC5 — planted credentials are scrubbed before send
# ---------------------------------------------------------------------------


def test_push_failure_event_scrubs_credentials_in_evidence(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path)
    captured: dict = {}
    monkeypatch.setattr(failure_push.urllib.request, "urlopen", _capture_urlopen(captured))

    secret = "sk-ant-api03-PLANTEDplantedPLANTED0123456789abcdef"
    evidence = f"env dump:\nANTHROPIC_API_KEY={secret}\nverify failed\n"
    failure_push.push_failure_event(
        tmp_path,
        run_id="run-secret",
        failure_type="phase_failure",
        phase="verify",
        message="verify failed",
        evidence=evidence,
    )
    ev = captured["body"]["evidence"]
    assert secret not in ev
    assert "[REDACTED" in ev
    # Non-secret context around it survives.
    assert "verify failed" in ev


# ---------------------------------------------------------------------------
# urlopen raises → False (never raises)
# ---------------------------------------------------------------------------


def test_push_failure_event_returns_false_on_network_error(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path)

    def boom(req, timeout):
        raise OSError("network down")

    monkeypatch.setattr(failure_push.urllib.request, "urlopen", boom)
    result = failure_push.push_failure_event(
        tmp_path,
        run_id="run-err",
        failure_type="phase_failure",
        phase="plan",
        message="plan failed",
    )
    assert result is False  # never raises


# ---------------------------------------------------------------------------
# AC2 — push failure never changes run exit codes
# ---------------------------------------------------------------------------


def test_push_failure_event_does_not_raise_on_bad_link(tmp_path: Path) -> None:
    """Even with a broken link config, push is non-fatal."""
    d = tmp_path / ".agentrail"
    d.mkdir()
    (d / "server.json").write_text("{invalid json")  # corrupt file

    result = failure_push.push_failure_event(
        tmp_path,
        run_id="run-corrupt",
        failure_type="phase_failure",
        phase="execute",
        message="fail",
    )
    assert result is False
