"""Tests for agentrail.run.cost_push — cost event payload and HTTP push.

Coverage:
- push_cost_event returns False when not linked (no server.json).
- push_cost_event returns True on HTTP 202; payload carries all required fields
  and correct Bearer header.
- push_cost_event returns False (never raises) when urlopen raises.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from agentrail.run import cost_push
from agentrail.run.usage_capture import Usage


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


def _sample_usage() -> Usage:
    return Usage(
        model="claude-sonnet-4-6",
        input_tokens=100,
        output_tokens=50,
        cache_tokens=25,
    )


# ---------------------------------------------------------------------------
# AC2 — not linked → False (no network call)
# ---------------------------------------------------------------------------


def test_push_cost_event_returns_false_when_not_linked(tmp_path: Path) -> None:
    """No server.json → load_link returns None → no network, returns False."""
    result = cost_push.push_cost_event(
        tmp_path,
        run_id="run-001",
        phase="execute",
        usage=_sample_usage(),
        cost=0.042,
    )
    assert result is False


# ---------------------------------------------------------------------------
# AC1 — mocked server: correct payload + Bearer header; 202 → True
# ---------------------------------------------------------------------------


def test_push_cost_event_returns_true_on_202(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path)

    class FakeResp:
        status = 202
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def fake_urlopen(req, timeout):
        return FakeResp()

    monkeypatch.setattr(cost_push.urllib.request, "urlopen", fake_urlopen)
    result = cost_push.push_cost_event(
        tmp_path,
        run_id="run-202",
        phase="execute",
        usage=_sample_usage(),
        cost=0.01,
    )
    assert result is True


def test_push_cost_event_payload_and_headers(tmp_path: Path, monkeypatch) -> None:
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

    monkeypatch.setattr(cost_push.urllib.request, "urlopen", fake_urlopen)

    usage = Usage(model="claude-opus-4-6", input_tokens=200, output_tokens=80, cache_tokens=40)
    cost_push.push_cost_event(
        tmp_path,
        run_id="run-verify",
        phase="execute",
        usage=usage,
        cost=0.123,
    )

    body = captured["body"]
    assert captured["url"] == "http://localhost:4000/api/v1/ingest/cost-events"
    assert captured["auth"] == "Bearer ar_key99"
    assert body["run_id"] == "run-verify"
    assert body["repository_id"] == "repo-xyz"
    assert body["cost_type"] == "model_call"
    assert body["tokens"] == 200 + 80 + 40
    assert body["cost_usd"] == pytest.approx(0.123)
    assert body["model"] == "claude-opus-4-6"
    assert body["occurred_at"].endswith("Z")
    assert len(body["event_id"]) == 36  # uuid4 format


# ---------------------------------------------------------------------------
# AC2 — urlopen raises → False (never raises)
# ---------------------------------------------------------------------------


def test_push_cost_event_returns_false_on_network_error(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path)

    def boom(req, timeout):
        raise OSError("network down")

    monkeypatch.setattr(cost_push.urllib.request, "urlopen", boom)
    result = cost_push.push_cost_event(
        tmp_path,
        run_id="run-err",
        phase="execute",
        usage=_sample_usage(),
        cost=0.0,
    )
    assert result is False  # never raises
