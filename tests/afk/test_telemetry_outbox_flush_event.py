from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from agentrail.afk.telemetry import ServerConfig, _append_outbox, count_outbox, flush_outbox


def _event(session_id: str = "run-001", seq: int = 1) -> dict:
    return {
        "workspace_id": "workspace-001",
        "session_id": session_id,
        "seq": seq,
        "ts": "2026-06-13T00:00:00+00:00",
        "kind": "action",
        "action": {"type": "EnqueueIssue", "number": 556},
        "digest": "abc123",
    }


def test_flush_outbox_emits_outbox_flushed_event_after_successful_drain(tmp_path: Path) -> None:
    cfg = ServerConfig(base_url="http://localhost", api_key="ar_x")
    _append_outbox(tmp_path, [_event(seq=1), _event(seq=2)])

    calls: list[list[dict]] = []

    def fake_post(_config: ServerConfig, events: list[dict]) -> bool:
        calls.append(events)
        return True

    with patch("agentrail.afk.telemetry._do_post", side_effect=fake_post):
        result = flush_outbox(cfg, tmp_path)

    assert result is True
    assert count_outbox(tmp_path) == 0
    assert calls[0] == [_event(seq=1), _event(seq=2)]
    assert len(calls) == 2

    flush_event = calls[1][0]
    assert flush_event["session_id"] == "run-001"
    assert flush_event["kind"] == "outbox_flush"
    assert flush_event["action"]["type"] == "outbox_flushed"
    assert flush_event["action"]["event_type"] == "outbox_flushed"
    assert flush_event["action"]["run_id"] == "run-001"
    assert flush_event["action"]["workspace_id"] == "workspace-001"
    assert flush_event["action"]["occurred_at"] == flush_event["ts"]
    assert flush_event["action"]["payload"] == {"pending_before": 2, "pending_after": 0}
    assert flush_event["seq"] not in {1, 2}


def test_flush_outbox_empty_does_not_emit_outbox_flushed_event(tmp_path: Path) -> None:
    cfg = ServerConfig(base_url="http://localhost", api_key="ar_x")

    with patch("agentrail.afk.telemetry._do_post") as mock_post:
        result = flush_outbox(cfg, tmp_path)

    assert result is True
    mock_post.assert_not_called()


def test_flush_outbox_swallow_synthetic_event_post_failure(tmp_path: Path) -> None:
    cfg = ServerConfig(base_url="http://localhost", api_key="ar_x")
    _append_outbox(tmp_path, [_event()])

    def fake_post(_config: ServerConfig, _events: list[dict]) -> bool:
        if len(_events) == 1 and _events[0]["action"]["type"] == "outbox_flushed":
            raise RuntimeError("synthetic event post failed")
        return True

    with patch("agentrail.afk.telemetry._do_post", side_effect=fake_post):
        result = flush_outbox(cfg, tmp_path)

    assert result is True
    assert count_outbox(tmp_path) == 0
