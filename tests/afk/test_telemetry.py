"""
Tests for agentrail.afk.telemetry — journal poster to AgentRail server.

Coverage:
- success (single event, batch via flush_outbox)
- retry on transient failure (event queued to outbox when POST fails)
- outbox flush (pending events sent on next dispatch attempt)
- no-network fallback (no exception bubbles into the AFK run)
- no network call when server.json absent
"""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from agentrail.afk.state import AfkState, EnqueueIssue, Store
from agentrail.afk.telemetry import (
    ServerConfig,
    _do_post,
    _outbox_path,
    attach_telemetry,
    count_outbox,
    flush_outbox,
    load_last_flush,
    load_server_config,
    post_event,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_store() -> Store:
    return Store(
        AfkState(
            concurrency=1,
            max_retries=2,
            max_review_rounds=3,
            slots={0: None},
        )
    )


def _write_server_json(tmp_path: Path, base_url: str = "http://localhost", api_key: str = "ar_test") -> None:
    cfg = {"base_url": base_url, "api_key": api_key}
    server_json = tmp_path / ".agentrail" / "server.json"
    server_json.parent.mkdir(parents=True, exist_ok=True)
    server_json.write_text(json.dumps(cfg))


def _sample_event(seq: int = 1) -> dict:
    return {
        "session_id": "20260610-000000",
        "seq": seq,
        "ts": "2026-06-10T00:00:00+00:00",
        "kind": "action",
        "action": {"type": "EnqueueIssue", "number": 1, "title": "t", "url": "u"},
        "digest": "abc123",
    }


# ---------------------------------------------------------------------------
# load_server_config
# ---------------------------------------------------------------------------


def test_load_server_config_missing(tmp_path: Path) -> None:
    assert load_server_config(tmp_path) is None


def test_load_server_config_valid(tmp_path: Path) -> None:
    _write_server_json(tmp_path, base_url="https://example.com/", api_key="ar_key")
    cfg = load_server_config(tmp_path)
    assert cfg is not None
    assert cfg.base_url == "https://example.com"  # trailing slash stripped
    assert cfg.api_key == "ar_key"


def test_load_server_config_malformed(tmp_path: Path) -> None:
    path = tmp_path / ".agentrail" / "server.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{bad json")
    assert load_server_config(tmp_path) is None


# ---------------------------------------------------------------------------
# post_event — success path
# ---------------------------------------------------------------------------


def test_post_event_success(tmp_path: Path) -> None:
    """Single event posted successfully leaves no outbox."""
    cfg = ServerConfig(base_url="http://localhost", api_key="ar_x")
    ev = _sample_event()

    with patch("agentrail.afk.telemetry._do_post", return_value=True) as mock_post:
        post_event(cfg, tmp_path, ev)

    mock_post.assert_called_once_with(cfg, [ev])
    assert count_outbox(tmp_path) == 0


# ---------------------------------------------------------------------------
# post_event — retry / outbox
# ---------------------------------------------------------------------------


def test_post_event_failure_queues_to_outbox(tmp_path: Path) -> None:
    """When POST fails, event is appended to outbox."""
    cfg = ServerConfig(base_url="http://localhost", api_key="ar_x")
    ev = _sample_event()

    with patch("agentrail.afk.telemetry._do_post", return_value=False):
        post_event(cfg, tmp_path, ev)

    assert count_outbox(tmp_path) == 1
    outbox = (_outbox_path(tmp_path)).read_text().strip()
    assert json.loads(outbox) == ev


def test_post_event_flushes_outbox_first(tmp_path: Path) -> None:
    """Before posting the new event, pending outbox events are flushed."""
    cfg = ServerConfig(base_url="http://localhost", api_key="ar_x")
    old_event = _sample_event(seq=1)
    new_event = _sample_event(seq=2)

    # Seed outbox with old_event.
    from agentrail.afk.telemetry import _append_outbox
    _append_outbox(tmp_path, [old_event])
    assert count_outbox(tmp_path) == 1

    calls: list = []

    def fake_post(config, events):
        calls.append(events)
        return True

    with patch("agentrail.afk.telemetry._do_post", side_effect=fake_post):
        post_event(cfg, tmp_path, new_event)

    # First call: flush the outbox (old_event).
    assert calls[0] == [old_event]
    # Second call: synthetic flush signal for telemetry health.
    assert calls[1][0]["action"]["type"] == "outbox_flushed"
    # Third call: the new event.
    assert calls[2] == [new_event]
    assert count_outbox(tmp_path) == 0


# ---------------------------------------------------------------------------
# flush_outbox
# ---------------------------------------------------------------------------


def test_flush_outbox_empty(tmp_path: Path) -> None:
    cfg = ServerConfig(base_url="http://localhost", api_key="ar_x")
    assert flush_outbox(cfg, tmp_path) is True


def test_flush_outbox_success(tmp_path: Path) -> None:
    cfg = ServerConfig(base_url="http://localhost", api_key="ar_x")
    from agentrail.afk.telemetry import _append_outbox
    _append_outbox(tmp_path, [_sample_event(1), _sample_event(2)])

    with patch("agentrail.afk.telemetry._do_post", return_value=True):
        result = flush_outbox(cfg, tmp_path)

    assert result is True
    assert count_outbox(tmp_path) == 0
    # last_flush timestamp was saved
    assert load_last_flush(tmp_path) is not None


def test_flush_outbox_partial(tmp_path: Path) -> None:
    """Only up to batch_size events are flushed; the rest remain."""
    cfg = ServerConfig(base_url="http://localhost", api_key="ar_x")
    from agentrail.afk.telemetry import _append_outbox
    _append_outbox(tmp_path, [_sample_event(i) for i in range(5)])

    with patch("agentrail.afk.telemetry._do_post", return_value=True):
        flush_outbox(cfg, tmp_path, batch_size=3)

    assert count_outbox(tmp_path) == 2


def test_flush_outbox_transient_failure(tmp_path: Path) -> None:
    """When POST fails the outbox is unchanged."""
    cfg = ServerConfig(base_url="http://localhost", api_key="ar_x")
    from agentrail.afk.telemetry import _append_outbox
    _append_outbox(tmp_path, [_sample_event(1)])

    with patch("agentrail.afk.telemetry._do_post", return_value=False):
        result = flush_outbox(cfg, tmp_path)

    assert result is False
    assert count_outbox(tmp_path) == 1


# ---------------------------------------------------------------------------
# attach_telemetry — no-op when server.json absent
# ---------------------------------------------------------------------------


def test_attach_telemetry_no_server_json(tmp_path: Path) -> None:
    """attach_telemetry is a no-op when server.json is not present."""
    store = _make_store()
    # Should not raise and must not subscribe any listener.
    subscribers_before = len(store._subscribers)  # type: ignore[attr-defined]
    attach_telemetry(store, tmp_path, "test-session")
    assert len(store._subscribers) == subscribers_before  # type: ignore[attr-defined]


# ---------------------------------------------------------------------------
# attach_telemetry — posts on dispatch, never raises
# ---------------------------------------------------------------------------


def test_attach_telemetry_posts_on_dispatch(tmp_path: Path) -> None:
    """Each dispatch triggers a POST when server.json is present."""
    _write_server_json(tmp_path)
    store = _make_store()

    posted: list = []

    def fake_post_event(config, target, event):
        posted.append(event)

    with patch("agentrail.afk.telemetry.post_event", side_effect=fake_post_event):
        attach_telemetry(store, tmp_path, "sess-001")
        store.dispatch(EnqueueIssue(1, "title", "url"))

    assert len(posted) == 1
    ev = posted[0]
    # EnqueueIssue has number=1, so session_id is the derived canonical run uuid
    # (run_uuid("sess-001", 1)), not the raw session string.
    from agentrail.afk.run_register import run_uuid
    assert ev["session_id"] == run_uuid("sess-001", 1)
    assert ev["seq"] == 1
    assert ev["kind"] == "action"
    assert ev["action"]["type"] == "EnqueueIssue"
    assert "digest" in ev


def test_attach_telemetry_never_raises_on_network_error(tmp_path: Path) -> None:
    """If post_event raises, the AFK run must not be affected."""
    _write_server_json(tmp_path)
    store = _make_store()

    def boom(*_args, **_kwargs):
        raise RuntimeError("network is on fire")

    with patch("agentrail.afk.telemetry.post_event", side_effect=boom):
        attach_telemetry(store, tmp_path, "sess-002")
        # dispatch should NOT raise even though post_event explodes
        store.dispatch(EnqueueIssue(1, "t", "u"))  # must not raise


def test_attach_telemetry_batch_dispatch(tmp_path: Path) -> None:
    """Multiple dispatches produce sequential seq numbers."""
    _write_server_json(tmp_path)
    store = _make_store()

    posted: list = []

    def capture(config, target, event):
        posted.append(event)

    with patch("agentrail.afk.telemetry.post_event", side_effect=capture):
        attach_telemetry(store, tmp_path, "sess-003")
        store.dispatch(EnqueueIssue(1, "t1", "u1"))
        store.dispatch(EnqueueIssue(2, "t2", "u2"))
        store.claim_next()

    assert len(posted) == 3
    assert [e["seq"] for e in posted] == [1, 2, 3]
