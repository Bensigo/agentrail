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
from agentrail.run.cost_push import build_cost_record, push_cost_event
from agentrail.run.pricing import resolve_price_source
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
        cache_creation_tokens=10,
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

    usage = Usage(model="claude-opus-4-6", input_tokens=200, output_tokens=80,
                  cache_tokens=40, cache_creation_tokens=15)
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
    # cache_creation tokens are part of the total token count.
    assert body["tokens"] == 200 + 80 + 40 + 15
    assert body["cost_usd"] == pytest.approx(0.123)
    assert body["model"] == "claude-opus-4-6"
    assert body["occurred_at"].endswith("Z")
    assert len(body["event_id"]) == 36  # uuid4 format
    # New per-phase + token-split fields (AC2).
    assert body["phase"] == "execute"
    assert body["input_tokens"] == 200
    assert body["output_tokens"] == 80
    assert body["cache_tokens"] == 40
    # AC3 wiring: cache-creation tokens persisted as their own field.
    assert body["cache_creation_tokens"] == 15


# ---------------------------------------------------------------------------
# #1337 PR② — price_source threaded into the durable ledger + remote payload.
#
# Regression coverage for the [High] review finding: cost_breakdown computed
# price_source but nothing carried it past the Langfuse filter, so neither the
# local JSONL ledger nor POST /api/v1/ingest/cost-events ever saw it (AC1
# unmet). These exercise the exact pipeline→cost_push seam pipeline.py wires:
#   price_source = resolve_price_source(usage.model)
#   build_cost_record(run_id, phase, usage, cost, price_source)  /  push_cost_event(...)
# ---------------------------------------------------------------------------


def test_build_cost_record_carries_explicit_price_source() -> None:
    record = build_cost_record("run-1", "execute", _sample_usage(), 0.02, "gateway")
    assert record["price_source"] == "gateway"


def test_build_cost_record_defaults_price_source_to_none() -> None:
    """Back-compat: callers that don't pass a source still build a valid record
    (the key is present, valued None) — no existing call site breaks."""
    record = build_cost_record("run-1", "execute", _sample_usage(), 0.02)
    assert record["price_source"] is None


def test_pipeline_seam_gateway_model_records_gateway_source() -> None:
    """The exact composition pipeline.py performs, for a real live gateway slug:
    resolve_price_source(usage.model) → build_cost_record(...) yields a ledger
    record stamped price_source="gateway"."""
    usage = Usage(
        model="anthropic/claude-sonnet-5",  # a real OpenRouter slug in the snapshot
        input_tokens=1000,
        output_tokens=500,
        cache_tokens=0,
        cache_creation_tokens=0,
    )
    price_source = resolve_price_source(usage.model)
    assert price_source == "gateway"
    record = build_cost_record("run-2", "execute", usage, 0.01, price_source)
    assert record["price_source"] == "gateway"


def test_pipeline_seam_bare_model_records_price_table_source() -> None:
    """A bare, non-gateway id (direct Anthropic API, never through OpenRouter)
    resolves via the PRICE_TABLE tier — the ledger records that honestly."""
    usage = Usage(
        model="claude-sonnet-4-6",
        input_tokens=1000,
        output_tokens=500,
        cache_tokens=0,
        cache_creation_tokens=0,
    )
    price_source = resolve_price_source(usage.model)
    assert price_source == "price_table"
    record = build_cost_record("run-3", "execute", usage, 0.01, price_source)
    assert record["price_source"] == "price_table"


def test_pipeline_seam_unknown_model_records_none_source() -> None:
    """An unknown model has no price source — the field is None, not a fake ''."""
    usage = Usage(
        model="not-a-real-model-xyz",
        input_tokens=1000,
        output_tokens=500,
        cache_tokens=0,
        cache_creation_tokens=0,
    )
    price_source = resolve_price_source(usage.model)
    assert price_source is None
    record = build_cost_record("run-4", "execute", usage, 0.0, price_source)
    assert record["price_source"] is None


def test_push_cost_event_posts_price_source_to_the_wire(tmp_path: Path, monkeypatch) -> None:
    """price_source reaches the remote POST body, not just the local record —
    proving it lands in the durable ClickHouse ledger, not only the JSONL."""
    _write_server_json(tmp_path)
    captured: dict = {}

    class FakeResp:
        status = 202
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def fake_urlopen(req, timeout):
        captured["body"] = json.loads(req.data)
        return FakeResp()

    monkeypatch.setattr(cost_push.urllib.request, "urlopen", fake_urlopen)
    usage = Usage(model="anthropic/claude-sonnet-5", input_tokens=1000,
                  output_tokens=500, cache_tokens=0, cache_creation_tokens=0)
    price_source = resolve_price_source(usage.model)
    push_cost_event(tmp_path, run_id="run-5", phase="execute", usage=usage,
                    cost=0.01, price_source=price_source)
    assert captured["body"]["price_source"] == "gateway"


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
