"""Tests for agentrail.afk.review_push — push_review_gate.

Coverage:
- Correct payload mapping (id, run_id, gate_name, status, blocking_reasons, repository_id).
- Not linked (no server.json) → returns False, no HTTP call made.
- HTTP error → returns False, never raises (non-fatal).
- "passed" status when objective gate passes.
- "failed" status when objective gate fails.
- build_gate_payload carries only objective-gate state — no findings field
  (the advisory LLM-review parser was deleted with the Arc B
  reviewer-of-record wave; see test_reviewer_of_record_deletion.py).
- extract_memory_suggestions / push_memory_items (unrelated to the deleted
  findings parser — these survive the wave untouched).
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path
from types import SimpleNamespace

from agentrail.afk import review_push
from agentrail.afk.objective_gate import ObjectiveGateResult


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
    gate = ObjectiveGateResult("pass", [])
    result = review_push.push_review_gate(tmp_path, "run-id", 1, gate)
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
    gate = ObjectiveGateResult("fail", ["CI check 'test' failed"])

    result = review_push.push_review_gate(tmp_path, run_id, round_no, gate)

    assert result is True
    assert captured["url"] == "http://localhost:4000/api/v1/ingest/review-gates"
    assert captured["auth"] == "Bearer key-abc"
    body = captured["body"]
    assert body["run_id"] == run_id
    assert body["repository_id"] == "repo-xyz"
    assert body["gate_name"] == f"review-round-{round_no}"
    assert body["status"] == "failed"
    assert body["blocking_reasons"] == ["CI check 'test' failed"]
    assert "evaluated_at" in body
    # id is uuid5 of review-gate:<run_id>:<round_no>
    expected_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"review-gate:{run_id}:{round_no}"))
    assert body["id"] == expected_id


def test_push_status_passed_when_gate_passes(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path)
    captured: dict = {}

    def fake_urlopen(req, timeout):
        captured["body"] = json.loads(req.data)
        return FakeResp()

    monkeypatch.setattr(review_push.urllib.request, "urlopen", fake_urlopen)

    gate = ObjectiveGateResult("pass", [])
    review_push.push_review_gate(tmp_path, "run-1", 1, gate)

    assert captured["body"]["status"] == "passed"
    assert captured["body"]["blocking_reasons"] == []


def test_push_status_failed_when_gate_fails(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path)
    captured: dict = {}

    def fake_urlopen(req, timeout):
        captured["body"] = json.loads(req.data)
        return FakeResp()

    monkeypatch.setattr(review_push.urllib.request, "urlopen", fake_urlopen)

    gate = ObjectiveGateResult("fail", ["CI check 'lint' failed"])
    review_push.push_review_gate(tmp_path, "run-2", 1, gate)

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
    gate = ObjectiveGateResult("pass", [])
    result = review_push.push_review_gate(tmp_path, "run-3", 1, gate)
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
    gate = ObjectiveGateResult("pass", [])
    review_push.push_review_gate(tmp_path, run_id, round_no, gate)
    review_push.push_review_gate(tmp_path, run_id, round_no, gate)

    assert len(ids) == 2
    assert ids[0] == ids[1]


def test_push_id_differs_by_round(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path)
    ids: list = []

    def fake_urlopen(req, timeout):
        ids.append(json.loads(req.data)["id"])
        return FakeResp()

    monkeypatch.setattr(review_push.urllib.request, "urlopen", fake_urlopen)

    gate = ObjectiveGateResult("pass", [])
    review_push.push_review_gate(tmp_path, "run-x", 1, gate)
    review_push.push_review_gate(tmp_path, "run-x", 2, gate)

    assert ids[0] != ids[1]


# ---------------------------------------------------------------------------
# build_gate_payload — objective-gate-only payload (ADR 0007 realignment;
# the advisory findings half — parse_findings and the "findings" field —
# was deleted with the Arc B reviewer-of-record wave).
# ---------------------------------------------------------------------------


def test_build_gate_payload_uses_objective_status():
    gate = ObjectiveGateResult("fail", ["CI check 'test' failed"])
    payload = review_push.build_gate_payload(
        repository_id="r", run_id="run1", round_no=1, gate=gate
    )
    assert payload["status"] == "failed"                      # from objective gate
    assert payload["blocking_reasons"] == ["CI check 'test' failed"]
    assert "findings" not in payload


def test_build_gate_payload_passed_status():
    gate = ObjectiveGateResult("pass", [])
    payload = review_push.build_gate_payload(
        repository_id="r", run_id="run1", round_no=1, gate=gate
    )
    assert payload["status"] == "passed" and payload["blocking_reasons"] == []


# ---------------------------------------------------------------------------
# extract_memory_suggestions
# ---------------------------------------------------------------------------


def _make_outcome_with_memory(suggestions) -> SimpleNamespace:
    """Duck-typed stand-in for a review outcome — extract_memory_suggestions
    and push_memory_items only ever read ``.memory_suggestions`` (see
    review_push.py; the ``ReviewOutcome`` dataclass this used to build lived
    in agentrail.afk.review, deleted with the Arc B reviewer-of-record wave)."""
    return SimpleNamespace(memory_suggestions=suggestions)


def test_extract_memory_suggestions_empty_list() -> None:
    outcome = _make_outcome_with_memory([])
    assert review_push.extract_memory_suggestions(outcome) == []


def test_extract_memory_suggestions_none() -> None:
    outcome = _make_outcome_with_memory(None)
    assert review_push.extract_memory_suggestions(outcome) == []


def test_extract_memory_suggestions_present() -> None:
    suggestions = [
        {
            "kind": "lesson",
            "title": "Always mock subprocess",
            "target_file": "tests/conftest.py",
            "source": "review",
            "body": "Always mock subprocess calls in tests to prevent hangs.",
        }
    ]
    outcome = _make_outcome_with_memory(suggestions)
    items = review_push.extract_memory_suggestions(outcome)
    assert len(items) == 1
    assert items[0]["content"] == "Always mock subprocess calls in tests to prevent hangs."
    assert "kind:lesson" in items[0]["tags"]
    assert "file:tests/conftest.py" in items[0]["tags"]


def test_extract_memory_suggestions_skips_empty_body() -> None:
    suggestions = [
        {"kind": "lesson", "title": "No body here", "body": ""},
        {"kind": "note", "title": "Also empty", "body": "   "},
        {"kind": "tip", "title": "Has body", "body": "Use fixtures."},
    ]
    outcome = _make_outcome_with_memory(suggestions)
    items = review_push.extract_memory_suggestions(outcome)
    assert len(items) == 1
    assert items[0]["content"] == "Use fixtures."


def test_extract_memory_suggestions_multiple() -> None:
    suggestions = [
        {"body": "First note.", "kind": "lesson", "target_file": "a.py"},
        {"body": "Second note.", "kind": "pattern"},
        {"body": "Third note."},
    ]
    outcome = _make_outcome_with_memory(suggestions)
    items = review_push.extract_memory_suggestions(outcome)
    assert len(items) == 3
    assert items[0]["content"] == "First note."
    assert "kind:lesson" in items[0]["tags"]
    assert "file:a.py" in items[0]["tags"]
    assert items[1]["content"] == "Second note."
    assert "kind:pattern" in items[1]["tags"]
    assert "file:a.py" not in items[1]["tags"]
    assert items[2]["content"] == "Third note."
    assert items[2]["tags"] == []


# ---------------------------------------------------------------------------
# push_memory_items
# ---------------------------------------------------------------------------


def test_push_memory_items_returns_true_when_no_suggestions(tmp_path: Path, monkeypatch) -> None:
    """No items → returns True without making HTTP call."""
    captured = []

    def fake_urlopen(req, timeout):
        captured.append(req)
        return FakeResp()

    monkeypatch.setattr(review_push.urllib.request, "urlopen", fake_urlopen)
    outcome = _make_outcome_with_memory([])
    result = review_push.push_memory_items(tmp_path, "run-m1", outcome)
    assert result is True
    assert not captured


def test_push_memory_items_returns_false_when_not_linked(tmp_path: Path, monkeypatch) -> None:
    """Items present but no server.json → False, no HTTP."""
    for key in ("AGENTRAIL_SERVER_BASE_URL", "AGENTRAIL_SERVER_API_KEY",
                "AGENTRAIL_SERVER_REPOSITORY_ID"):
        monkeypatch.delenv(key, raising=False)

    captured = []

    def fake_urlopen(req, timeout):
        captured.append(req)
        return FakeResp()

    monkeypatch.setattr(review_push.urllib.request, "urlopen", fake_urlopen)
    outcome = _make_outcome_with_memory([{"body": "note", "kind": "lesson"}])
    result = review_push.push_memory_items(tmp_path, "run-m2", outcome)
    assert result is False
    assert not captured


def test_push_memory_items_payload(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path, base_url="http://localhost:5000",
                       api_key="key-mem", repository_id="repo-mem")
    captured: dict = {}

    def fake_urlopen(req, timeout):
        captured["url"] = req.full_url
        captured["auth"] = req.get_header("Authorization")
        captured["body"] = json.loads(req.data)
        return FakeResp()

    monkeypatch.setattr(review_push.urllib.request, "urlopen", fake_urlopen)

    suggestions = [{"body": "Mock subprocess in tests.", "kind": "lesson"}]
    outcome = _make_outcome_with_memory(suggestions)
    result = review_push.push_memory_items(tmp_path, "run-m3", outcome)

    assert result is True
    assert captured["url"] == "http://localhost:5000/api/v1/ingest/memory-items"
    assert captured["auth"] == "Bearer key-mem"
    body = captured["body"]
    assert body["run_id"] == "run-m3"
    assert body["repository_id"] == "repo-mem"
    assert len(body["items"]) == 1
    assert body["items"][0]["content"] == "Mock subprocess in tests."
    assert "kind:lesson" in body["items"][0]["tags"]


def test_push_memory_items_non_fatal_on_error(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path)

    def boom(req, timeout):
        raise OSError("network down")

    monkeypatch.setattr(review_push.urllib.request, "urlopen", boom)
    suggestions = [{"body": "Some note.", "kind": "tip"}]
    outcome = _make_outcome_with_memory(suggestions)
    result = review_push.push_memory_items(tmp_path, "run-m4", outcome)
    assert result is False  # never raises
