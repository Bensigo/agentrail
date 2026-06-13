"""
AFK telemetry poster.

When ``.agentrail/server.json`` is present, each Redux action dispatched
by the AFK store is POSTed to ``POST /api/v1/ingest/run-events`` on the
AgentRail server.  On network or HTTP failure the event is appended to
``.agentrail/afk/outbox.jsonl``; the next dispatch triggers a flush
attempt (up to 100 events) before sending the new event.

The local ``.agentrail/afk/events.jsonl`` flight-recorder journal is
**always** written (by ``attach_journal``) regardless of this module.

Network problems never propagate exceptions into the AFK run.

Server config file shape (``server.json``):
  {"base_url": "https://...", "api_key": "ar_..."}
"""
from __future__ import annotations

import datetime as _dt
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional
import urllib.error
import urllib.request

from agentrail.afk.run_register import run_uuid
from agentrail.afk.state import Store


@dataclass
class ServerConfig:
    base_url: str
    api_key: str


# ---------------------------------------------------------------------------
# Config loading
# ---------------------------------------------------------------------------


def _server_json_path(target: Path) -> Path:
    return target / ".agentrail" / "server.json"


def load_server_config(target: Path) -> Optional[ServerConfig]:
    """Return ServerConfig if ``.agentrail/server.json`` exists and is valid."""
    path = _server_json_path(target)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
        return ServerConfig(
            base_url=str(data["base_url"]).rstrip("/"),
            api_key=str(data["api_key"]),
        )
    except (KeyError, ValueError, OSError):
        return None


# ---------------------------------------------------------------------------
# Outbox helpers
# ---------------------------------------------------------------------------


def _outbox_path(target: Path) -> Path:
    return target / ".agentrail" / "afk" / "outbox.jsonl"


def _telemetry_state_path(target: Path) -> Path:
    return target / ".agentrail" / "afk" / "telemetry_state.json"


def _append_outbox(target: Path, events: List[Dict[str, Any]]) -> None:
    path = _outbox_path(target)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a") as fh:
        for ev in events:
            fh.write(json.dumps(ev, separators=(",", ":")) + "\n")


def _read_outbox(target: Path) -> List[Dict[str, Any]]:
    path = _outbox_path(target)
    if not path.exists():
        return []
    events: List[Dict[str, Any]] = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if line:
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return events


def _write_outbox(target: Path, events: List[Dict[str, Any]]) -> None:
    path = _outbox_path(target)
    if not events:
        path.unlink(missing_ok=True)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as fh:
        for ev in events:
            fh.write(json.dumps(ev, separators=(",", ":")) + "\n")


def count_outbox(target: Path) -> int:
    """Return the number of queued events in the outbox (0 if no outbox)."""
    path = _outbox_path(target)
    if not path.exists():
        return 0
    return sum(1 for line in path.read_text().splitlines() if line.strip())


def _now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat()


def _synthetic_seq(batch: List[Dict[str, Any]], offset: int = 0) -> int:
    max_batch_seq = 0
    for event in batch:
        seq = event.get("seq")
        if isinstance(seq, int):
            max_batch_seq = max(max_batch_seq, seq)
    now_ms = int(_dt.datetime.now(_dt.timezone.utc).timestamp() * 1000)
    return max(now_ms + offset, max_batch_seq + offset + 1)


def _event_field(event: Dict[str, Any], field: str) -> str:
    value = event.get(field)
    if isinstance(value, str):
        return value
    action = event.get("action")
    if isinstance(action, dict):
        action_value = action.get(field)
        if isinstance(action_value, str):
            return action_value
    return ""


def _outbox_flushed_events(
    batch: List[Dict[str, Any]],
    *,
    pending_before: int,
    pending_after: int,
    occurred_at: str,
) -> List[Dict[str, Any]]:
    by_session: Dict[str, Dict[str, Any]] = {}
    for event in batch:
        session_id = _event_field(event, "session_id") or _event_field(event, "run_id")
        if session_id and session_id not in by_session:
            by_session[session_id] = event

    events: List[Dict[str, Any]] = []
    for offset, (session_id, source) in enumerate(by_session.items()):
        workspace_id = _event_field(source, "workspace_id")
        action = {
            "type": "outbox_flushed",
            "event_type": "outbox_flushed",
            "run_id": session_id,
            "workspace_id": workspace_id,
            "occurred_at": occurred_at,
            "payload": {
                "pending_before": pending_before,
                "pending_after": pending_after,
            },
        }
        events.append({
            "workspace_id": workspace_id,
            "session_id": session_id,
            "seq": _synthetic_seq(batch, offset=offset),
            "ts": occurred_at,
            "kind": "outbox_flush",
            "action": action,
            "digest": f"outbox_flushed:{session_id}:{pending_before}->{pending_after}",
        })
    return events


def _post_outbox_flushed_events(
    config: ServerConfig,
    batch: List[Dict[str, Any]],
    *,
    pending_before: int,
    pending_after: int,
    occurred_at: str,
) -> None:
    events = _outbox_flushed_events(
        batch,
        pending_before=pending_before,
        pending_after=pending_after,
        occurred_at=occurred_at,
    )
    if not events:
        return
    try:
        _do_post(config, events)
    except Exception:  # noqa: BLE001 - synthetic signal must never affect the real drain
        pass


def _save_last_flush(target: Path, ts: str) -> None:
    path = _telemetry_state_path(target)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"last_flush": ts}))


def load_last_flush(target: Path) -> Optional[str]:
    """Return ISO timestamp of last successful flush, or None."""
    path = _telemetry_state_path(target)
    if not path.exists():
        return None
    try:
        return str(json.loads(path.read_text()).get("last_flush", ""))
    except (json.JSONDecodeError, OSError):
        return None


# ---------------------------------------------------------------------------
# HTTP transport
# ---------------------------------------------------------------------------


def _do_post(config: ServerConfig, events: List[Dict[str, Any]]) -> bool:
    """POST events to the server. Returns True on 202, False otherwise."""
    body = json.dumps(events).encode("utf-8")
    req = urllib.request.Request(
        f"{config.base_url}/api/v1/ingest/run-events",
        data=body,
        headers={
            "Authorization": f"Bearer {config.api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return int(resp.status) == 202
    except (urllib.error.URLError, OSError, Exception):  # noqa: BLE001
        return False


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def flush_outbox(config: ServerConfig, target: Path, batch_size: int = 100) -> bool:
    """
    Drain up to ``batch_size`` events from the outbox and POST them.
    Returns True when the batch was accepted (outbox may still have remaining events).
    Remaining events stay in the outbox; on success the flush timestamp is updated.
    """
    outbox = _read_outbox(target)
    if not outbox:
        return True
    batch, remaining = outbox[:batch_size], outbox[batch_size:]
    pending_before = len(outbox)
    if _do_post(config, batch):
        _write_outbox(target, remaining)
        flushed_at = _now_iso()
        _save_last_flush(target, flushed_at)
        _post_outbox_flushed_events(
            config,
            batch,
            pending_before=pending_before,
            pending_after=len(remaining),
            occurred_at=flushed_at,
        )
        return True
    return False


def post_event(config: ServerConfig, target: Path, event: Dict[str, Any]) -> None:
    """
    Best-effort: flush pending outbox, then POST ``event``.
    On any failure the event is appended to the outbox.
    Never raises.
    """
    try:
        flush_outbox(config, target)
        if not _do_post(config, [event]):
            _append_outbox(target, [event])
    except Exception:  # noqa: BLE001
        try:
            _append_outbox(target, [event])
        except Exception:  # noqa: BLE001
            pass


def attach_telemetry(store: Store, target: Path, session_id: str) -> None:
    """
    Subscribe a second listener on ``store`` that ships every dispatched
    action to the AgentRail server.  No-op when ``.agentrail/server.json``
    is absent.  All errors are swallowed so the AFK run is never affected.
    """
    config = load_server_config(target)
    if config is None:
        return

    seq: Dict[str, int] = {"n": 1}

    def _ship(state: Any, action: Any) -> None:
        try:
            from agentrail.afk.journal import action_to_dict, state_digest  # local import avoids cycle

            ts = _dt.datetime.now(_dt.timezone.utc).isoformat()
            try:
                action_dict = action_to_dict(action)
            except TypeError:
                return
            num = getattr(action, "number", None)
            rid = run_uuid(session_id, num) if isinstance(num, int) else session_id
            event: Dict[str, Any] = {
                "session_id": rid,
                "seq": seq["n"],
                "ts": ts,
                "kind": "action",
                "action": action_dict,
                "digest": state_digest(state),
            }
            seq["n"] += 1
            post_event(config, target, event)
        except Exception:  # noqa: BLE001
            pass

    store.subscribe(_ship)
