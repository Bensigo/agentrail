"""Tests for agentrail.run.context_pack_push — payload mapping and HTTP push.

Coverage:
- push_context_pack returns False when not linked (no server.json).
- push_context_pack returns True on HTTP 202; payload carries all required fields
  and correct Bearer header.
- push_context_pack returns False (never raises) when urlopen raises.
- push_context_pack handles empty retrieval dict gracefully (zeros).
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from agentrail.run import context_pack_push


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


def _sample_retrieval() -> dict:
    return {
        "retrievalBudget": 8000,
        "selectedContextTokens": 3200,
        "selectedSources": ["src/a.py", "src/b.py", "src/c.py"],
    }


# ---------------------------------------------------------------------------
# AC2 — not linked → False (no network call)
# ---------------------------------------------------------------------------


def test_push_context_pack_returns_false_when_not_linked(tmp_path: Path) -> None:
    """No server.json → load_link returns None → no network, returns False."""
    result = context_pack_push.push_context_pack(
        tmp_path,
        run_id="run-001",
        retrieval=_sample_retrieval(),
    )
    assert result is False


# ---------------------------------------------------------------------------
# AC1 — mocked server: correct payload + Bearer header; 202 → True
# ---------------------------------------------------------------------------


def test_push_context_pack_returns_true_on_202(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path)

    class FakeResp:
        status = 202
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def fake_urlopen(req, timeout):
        return FakeResp()

    monkeypatch.setattr(context_pack_push.urllib.request, "urlopen", fake_urlopen)
    result = context_pack_push.push_context_pack(
        tmp_path,
        run_id="run-202",
        retrieval=_sample_retrieval(),
    )
    assert result is True


def test_push_context_pack_payload_and_headers(tmp_path: Path, monkeypatch) -> None:
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

    monkeypatch.setattr(context_pack_push.urllib.request, "urlopen", fake_urlopen)

    retrieval = {
        "retrievalBudget": 10000,
        "selectedContextTokens": 4500,
        "selectedSources": ["a.py", "b.py"],
    }
    context_pack_push.push_context_pack(
        tmp_path,
        run_id="run-verify",
        retrieval=retrieval,
    )

    body = captured["body"]
    assert captured["url"] == "http://localhost:4000/api/v1/ingest/context-packs"
    assert captured["auth"] == "Bearer ar_key99"
    assert body["run_id"] == "run-verify"
    assert body["repository_id"] == "repo-xyz"
    assert body["token_budget"] == 10000
    assert body["tokens_used"] == 4500
    assert body["sources_considered"] == 2
    assert body["occurred_at"].endswith("Z")
    assert len(body["context_pack_id"]) == 36  # uuid4 format


# ---------------------------------------------------------------------------
# AC2 — urlopen raises → False (never raises)
# ---------------------------------------------------------------------------


def test_push_context_pack_returns_false_on_network_error(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path)

    def boom(req, timeout):
        raise OSError("network down")

    monkeypatch.setattr(context_pack_push.urllib.request, "urlopen", boom)
    result = context_pack_push.push_context_pack(
        tmp_path,
        run_id="run-err",
        retrieval=_sample_retrieval(),
    )
    assert result is False  # never raises


# ---------------------------------------------------------------------------
# Edge case — empty retrieval dict → zeros, still sends
# ---------------------------------------------------------------------------


def test_push_context_pack_empty_retrieval_sends_zeros(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path)
    captured: dict = {}

    class FakeResp:
        status = 202
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def fake_urlopen(req, timeout):
        captured["body"] = json.loads(req.data)
        return FakeResp()

    monkeypatch.setattr(context_pack_push.urllib.request, "urlopen", fake_urlopen)
    result = context_pack_push.push_context_pack(
        tmp_path,
        run_id="run-empty",
        retrieval={},
    )

    assert result is True
    body = captured["body"]
    assert body["token_budget"] == 0
    assert body["tokens_used"] == 0
    assert body["sources_considered"] == 0
