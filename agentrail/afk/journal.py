"""
Flight recorder for the AFK state machine.

The Redux store already turns every change to the fleet into a typed,
serializable action applied by a *pure* reducer. That makes event-sourcing
almost free: append every dispatched action to an on-disk log and you can later
replay the exact run, reconstruct state at any step deterministically, and
derive observability metrics — without any extra instrumentation in the
business logic.

This module is the recorder. It (de)serializes actions and appends one JSON
line per dispatch to ``.agentrail/afk/events.jsonl``. The snapshot in
``state.json`` answers "where are we now"; this journal answers "how did we get
here" and "what exactly happened, when".

Format (one JSON object per line):

    {"v": 1, "session": "...", "seq": 0, "ts": "...", "kind": "init",
     "state": {<AfkState dict>}, "digest": "..."}
    {"v": 1, "session": "...", "seq": 1, "ts": "...", "kind": "action",
     "action": {"type": "EnqueueIssue", ...}, "digest": "..."}

``kind == "init"`` carries the starting state so a replay can begin from it;
every subsequent line is one action. ``digest`` is a short hash of the state
*after* the event, so a replay can verify it reproduced the recorded run
exactly (it always will, because reducers are pure — a mismatch means the log
was tampered with or the reducer changed).
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
from dataclasses import asdict
from pathlib import Path
from typing import Iterable, List, Optional

from agentrail.afk.state import (
    ClaimIssue,
    EnqueueIssue,
    FreeSlot,
    IncrementReviewRound,
    IssueStatus,
    RecordFailure,
    ReleaseIssue,
    RequeueIssue,
    SetPr,
    SetStatus,
    Store,
)
from agentrail.afk.store import to_dict

JOURNAL_VERSION = 1

# Maps an action's type name (as stored in the log) back to its class so a
# replay can rebuild the exact action object and feed it through ``reduce``.
_ACTION_TYPES = {
    cls.__name__: cls
    for cls in (
        EnqueueIssue,
        ClaimIssue,
        ReleaseIssue,
        SetStatus,
        SetPr,
        RecordFailure,
        IncrementReviewRound,
        FreeSlot,
        RequeueIssue,
    )
}


def events_path(target: Path) -> Path:
    return target / ".agentrail" / "afk" / "events.jsonl"


def _now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat()


def new_session_id() -> str:
    return _dt.datetime.now().strftime("%Y%m%d-%H%M%S")


def action_to_dict(action: object) -> dict:
    """Serialize an action dataclass to a plain dict tagged with its type."""
    name = type(action).__name__
    if name not in _ACTION_TYPES:
        raise TypeError(f"cannot serialize unknown action: {action!r}")
    payload = asdict(action)
    # The only non-JSON-native field across the action set is SetStatus.status,
    # which is an IssueStatus enum.
    if isinstance(payload.get("status"), IssueStatus):
        payload["status"] = payload["status"].value
    payload["type"] = name
    return payload


def action_from_dict(d: dict) -> object:
    """Rebuild an action dataclass from its serialized dict."""
    data = dict(d)
    name = data.pop("type")
    cls = _ACTION_TYPES.get(name)
    if cls is None:
        raise TypeError(f"unknown action type in journal: {name!r}")
    if name == "SetStatus" and not isinstance(data.get("status"), IssueStatus):
        data["status"] = IssueStatus(data["status"])
    return cls(**data)


def state_digest(state) -> str:
    """Short, order-independent hash of a state — used to verify replays."""
    blob = json.dumps(to_dict(state), sort_keys=True).encode("utf-8")
    return hashlib.sha1(blob).hexdigest()[:12]


def _append(path: Path, record: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(record, separators=(",", ":"))
    # Append + fsync so a crash mid-run still leaves a complete, valid prefix.
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    try:
        os.write(fd, (line + "\n").encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)


def attach_journal(store: Store, target: Path, session: Optional[str] = None) -> str:
    """
    Subscribe the store so every dispatch appends one event to the flight
    recorder. Records an ``init`` line first (the starting state) so the session
    is self-contained and replayable on its own. Returns the session id.

    Stateless side effect: like ``attach_persistence``, this only *reads* state
    and writes to disk, so the reducers stay pure and untouched.
    """
    sid = session or new_session_id()
    path = events_path(target)
    seq = {"n": 0}

    # init line: the state as it is at attach time (before any further dispatch)
    _append(path, {
        "v": JOURNAL_VERSION,
        "session": sid,
        "seq": 0,
        "ts": _now_iso(),
        "kind": "init",
        "state": to_dict(store.state),
        "digest": state_digest(store.state),
    })
    seq["n"] = 1

    def _record(state, action) -> None:
        try:
            entry = {
                "v": JOURNAL_VERSION,
                "session": sid,
                "seq": seq["n"],
                "ts": _now_iso(),
                "kind": "action",
                "action": action_to_dict(action),
                "digest": state_digest(state),
            }
        except TypeError:
            return  # never let an unserializable action break the run
        _append(path, entry)
        seq["n"] += 1

    store.subscribe(_record)
    return sid


def read_events(target: Path) -> List[dict]:
    """Read all events, tolerating a torn final line from a crash mid-write."""
    path = events_path(target)
    if not path.exists():
        return []
    out: List[dict] = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue  # partial trailing line — safe to drop
    return out


def list_sessions(events: Iterable[dict]) -> List[str]:
    """Session ids in first-seen order."""
    seen: List[str] = []
    for ev in events:
        sid = ev.get("session")
        if sid and sid not in seen:
            seen.append(sid)
    return seen


def session_events(events: Iterable[dict], session: Optional[str] = None) -> List[dict]:
    """Events for one session (the latest if none named)."""
    evs = list(events)
    sids = list_sessions(evs)
    if not sids:
        return []
    target_sid = session or sids[-1]
    return [e for e in evs if e.get("session") == target_sid]
