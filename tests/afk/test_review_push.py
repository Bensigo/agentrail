"""Tests for agentrail.afk.review_push — push_review_gate.

Coverage:
- Correct payload mapping (id, run_id, gate_name, status, blocking_reasons, repository_id).
- Not linked (no server.json) → returns False, no HTTP call made.
- HTTP error → returns False, never raises (non-fatal).
- "passed" status when no blocking findings.
- "failed" status when blocking findings present.
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest

from agentrail.afk import review_push
from agentrail.afk.review import Finding, ReviewOutcome


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_server_json(tmp_path: Path, base_url: str = "http://localhost:3000",
                       api_key: str = "ar_test", repository_id: str = "repo-abc") -> None:
    d = tmp_path / ".agentrail"
    d.mkdir(parents=True, exist_ok=True)
    (d / "server.json").write_text(json.dumps({
        "base_url": base_url,
        "api_key": api_key,
        "repository_id": repository_id,
    }))


def _make_outcome(blocking=(), advisory=()) -> ReviewOutcome:
    return ReviewOutcome(
        blocking=list(blocking),
        advisory=list(advisory),
        memory_suggestions=[],
    )


def _finding(title="Bug", severity="P0", file="foo.py", body="fix it") -> Finding:
    return Finding(title=title, severity=severity, file=file, body=body)


class FakeResp:
    status = 202
    def __enter__(self): return self
    def __exit__(self, *a): return False


# ---------------------------------------------------------------------------
# Not linked
# ---------------------------------------------------------------------------


def test_push_returns_false_when_not_linked(tmp_path: Path, monkeypatch) -> None:
    """No server.json and no env vars → load_link returns None → returns False, no HTTP."""
    # Clear any server env vars so load_link has nothing to fall back to
    for key in ("AGENTRAIL_SERVER_BASE_URL", "AGENTRAIL_SERVER_API_KEY",
                "AGENTRAIL_SERVER_REPOSITORY_ID"):
        monkeypatch.delenv(key, raising=False)

    captured = []

    def fake_urlopen(req, timeout):
        captured.append(req)
        return FakeResp()

    monkeypatch.setattr(review_push.urllib.request, "urlopen", fake_urlopen)
    result = review_push.push_review_gate(tmp_path, "run-id", 1, _make_outcome())
    assert result is False
    assert not captured


# ---------------------------------------------------------------------------
# Payload mapping
# ---------------------------------------------------------------------------


def test_push_payload_fields(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path, base_url="http://localhost:4000",
                       api_key="key-abc", repository_id="repo-xyz")
    captured: dict = {}

    def fake_urlopen(req, timeout):
        captured["url"] = req.full_url
        captured["auth"] = req.get_header("Authorization")
        captured["body"] = json.loads(req.data)
        return FakeResp()

    monkeypatch.setattr(review_push.urllib.request, "urlopen", fake_urlopen)

    run_id = "run-000"
    round_no = 3
    finding = _finding(title="Null deref", severity="P0", file="main.py", body="check it")
    outcome = _make_outcome(blocking=[finding])

    result = review_push.push_review_gate(tmp_path, run_id, round_no, outcome)

    assert result is True
    assert captured["url"] == "http://localhost:4000/api/v1/ingest/review-gates"
    assert captured["auth"] == "Bearer key-abc"
    body = captured["body"]
    assert body["run_id"] == run_id
    assert body["repository_id"] == "repo-xyz"
    assert body["gate_name"] == f"review-round-{round_no}"
    assert body["status"] == "failed"
    assert len(body["blocking_reasons"]) == 1
    assert body["blocking_reasons"][0]["title"] == "Null deref"
    assert body["blocking_reasons"][0]["severity"] == "P0"
    assert body["blocking_reasons"][0]["file"] == "main.py"
    assert body["blocking_reasons"][0]["body"] == "check it"
    assert "evaluated_at" in body
    # id is uuid5 of review-gate:<run_id>:<round_no>
    expected_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"review-gate:{run_id}:{round_no}"))
    assert body["id"] == expected_id


def test_push_status_passed_when_no_blocking(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path)
    captured: dict = {}

    def fake_urlopen(req, timeout):
        captured["body"] = json.loads(req.data)
        return FakeResp()

    monkeypatch.setattr(review_push.urllib.request, "urlopen", fake_urlopen)

    advisory_finding = _finding(severity="P2")
    outcome = _make_outcome(advisory=[advisory_finding])
    review_push.push_review_gate(tmp_path, "run-1", 1, outcome)

    assert captured["body"]["status"] == "passed"
    assert captured["body"]["blocking_reasons"] == []


def test_push_status_failed_when_blocking(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path)
    captured: dict = {}

    def fake_urlopen(req, timeout):
        captured["body"] = json.loads(req.data)
        return FakeResp()

    monkeypatch.setattr(review_push.urllib.request, "urlopen", fake_urlopen)

    outcome = _make_outcome(blocking=[_finding(severity="P1")])
    review_push.push_review_gate(tmp_path, "run-2", 1, outcome)

    assert captured["body"]["status"] == "failed"
    assert len(captured["body"]["blocking_reasons"]) == 1


# ---------------------------------------------------------------------------
# Non-fatal
# ---------------------------------------------------------------------------


def test_push_returns_false_on_http_error(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path)

    def boom(req, timeout):
        raise OSError("network down")

    monkeypatch.setattr(review_push.urllib.request, "urlopen", boom)
    result = review_push.push_review_gate(tmp_path, "run-3", 1, _make_outcome())
    assert result is False  # never raises


def test_push_id_is_deterministic(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path)
    ids: list = []

    def fake_urlopen(req, timeout):
        ids.append(json.loads(req.data)["id"])
        return FakeResp()

    monkeypatch.setattr(review_push.urllib.request, "urlopen", fake_urlopen)

    run_id = "stable-run"
    round_no = 2
    review_push.push_review_gate(tmp_path, run_id, round_no, _make_outcome())
    review_push.push_review_gate(tmp_path, run_id, round_no, _make_outcome())

    assert len(ids) == 2
    assert ids[0] == ids[1]


def test_push_id_differs_by_round(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path)
    ids: list = []

    def fake_urlopen(req, timeout):
        ids.append(json.loads(req.data)["id"])
        return FakeResp()

    monkeypatch.setattr(review_push.urllib.request, "urlopen", fake_urlopen)

    review_push.push_review_gate(tmp_path, "run-x", 1, _make_outcome())
    review_push.push_review_gate(tmp_path, "run-x", 2, _make_outcome())

    assert ids[0] != ids[1]
