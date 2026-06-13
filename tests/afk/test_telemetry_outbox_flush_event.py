"""
Tests for the synthetic ``outbox_flushed`` run event emitted by
``flush_outbox`` in ``agentrail.afk.telemetry`` (M016 #556).

Coverage:
- non-empty outbox drain -> a second ``_do_post`` carries an
  ``event_type == "outbox_flushed"`` run_event (AC1, AC4)
- empty outbox -> ``_do_post`` never called, no synthetic event (AC2)
- synthetic-post failure is swallowed; drain result unaffected (AC3)
"""
from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from agentrail.afk.telemetry import (
    ServerConfig,
    _append_outbox,
    count_outbox,
    flush_outbox,
)


def _sample_event(seq: int = 1) -> dict:
    return {
        "session_id": "20260610-000000",
        "seq": seq,
        "ts": "2026-06-10T00:00:00+00:00",
        "kind": "action",
        "action": {"type": "EnqueueIssue", "number": 1, "title": "t", "url": "u"},
        "digest": "abc123",
    }


def test_flush_outbox_emits_outbox_flushed_event(tmp_path: Path) -> None:
    """AC1/AC4: draining >=1 event posts a second outbox_flushed run_event."""
    cfg = ServerConfig(base_url="http://localhost", api_key="ar_x")
    _append_outbox(tmp_path, [_sample_event(1), _sample_event(2)])

    calls: list = []

    def fake_post(config, events):
        calls.append(events)
        return True

    with patch("agentrail.afk.telemetry._do_post", side_effect=fake_post):
        result = flush_outbox(cfg, tmp_path)

    assert result is True
    assert count_outbox(tmp_path) == 0
    # First call drains the batch; second call is the synthetic event.
    assert len(calls) == 2
    synthetic = calls[1]
    assert isinstance(synthetic, list) and len(synthetic) == 1
    ev = synthetic[0]
    assert ev["event_type"] == "outbox_flushed"
    assert ev["submission_kind"] == "run_event"
    assert ev["run_id"] == "20260610-000000"
    assert "workspace_id" in ev
    assert "occurred_at" in ev
    assert ev["payload"] == {"pending_before": 2, "pending_after": 0}


def test_flush_outbox_partial_payload_counts(tmp_path: Path) -> None:
    """AC4: payload reflects pending counts before and after the drain."""
    cfg = ServerConfig(base_url="http://localhost", api_key="ar_x")
    _append_outbox(tmp_path, [_sample_event(i) for i in range(5)])

    calls: list = []

    def fake_post(config, events):
        calls.append(events)
        return True

    with patch("agentrail.afk.telemetry._do_post", side_effect=fake_post):
        flush_outbox(cfg, tmp_path, batch_size=3)

    assert len(calls) == 2
    ev = calls[1][0]
    assert ev["payload"] == {"pending_before": 5, "pending_after": 2}


def test_flush_outbox_empty_emits_no_event(tmp_path: Path) -> None:
    """AC2: an empty outbox does not call _do_post at all."""
    cfg = ServerConfig(base_url="http://localhost", api_key="ar_x")

    with patch("agentrail.afk.telemetry._do_post") as mock_post:
        result = flush_outbox(cfg, tmp_path)

    assert result is True
    mock_post.assert_not_called()


def test_flush_outbox_synthetic_failure_swallowed(tmp_path: Path) -> None:
    """AC3: a raising synthetic post does not break the real drain."""
    cfg = ServerConfig(base_url="http://localhost", api_key="ar_x")
    _append_outbox(tmp_path, [_sample_event(1)])

    calls: list = []

    def flaky_post(config, events):
        calls.append(events)
        # First (real drain) succeeds; second (synthetic) raises.
        if len(calls) == 1:
            return True
        raise RuntimeError("synthetic post exploded")

    with patch("agentrail.afk.telemetry._do_post", side_effect=flaky_post):
        result = flush_outbox(cfg, tmp_path)

    # Real drain still reported success and the outbox is empty.
    assert result is True
    assert count_outbox(tmp_path) == 0
    assert len(calls) == 2
