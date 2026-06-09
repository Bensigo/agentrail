"""
Persistence for the AFK state machine: atomic JSON snapshot after every
dispatch. The store IS the state (Redux-idiomatic), so persistence is just
serialization of the whole tree to one file, written atomically via a temp
file + rename so a crash mid-write can never leave a half-state.
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Optional

from agentrail.afk.state import AfkState, IssueState, IssueStatus, Store


def state_path(target: Path) -> Path:
    return target / ".agentrail" / "afk" / "state.json"


def _issue_to_dict(issue: IssueState) -> dict:
    return {
        "number": issue.number,
        "title": issue.title,
        "url": issue.url,
        "status": issue.status.value,
        "pr": issue.pr,
        "slot": issue.slot,
        "retries": issue.retries,
        "review_rounds": issue.review_rounds,
        "error": issue.error,
    }


def _issue_from_dict(d: dict) -> IssueState:
    return IssueState(
        number=d["number"],
        title=d.get("title", ""),
        url=d.get("url", ""),
        status=IssueStatus(d.get("status", "queued")),
        pr=d.get("pr"),
        slot=d.get("slot"),
        retries=d.get("retries", 0),
        review_rounds=d.get("review_rounds", 0),
        error=d.get("error"),
    )


def to_dict(state: AfkState) -> dict:
    return {
        "schemaVersion": 1,
        "concurrency": state.concurrency,
        "max_retries": state.max_retries,
        "max_review_rounds": state.max_review_rounds,
        "completed": state.completed,
        "failed": state.failed,
        "slots": {str(k): v for k, v in state.slots.items()},
        "issues": {str(n): _issue_to_dict(i) for n, i in state.issues.items()},
    }


def from_dict(d: dict) -> AfkState:
    return AfkState(
        issues={int(n): _issue_from_dict(i) for n, i in d.get("issues", {}).items()},
        slots={int(k): v for k, v in d.get("slots", {}).items()},
        concurrency=d.get("concurrency", 2),
        max_retries=d.get("max_retries", 2),
        max_review_rounds=d.get("max_review_rounds", 3),
        completed=d.get("completed", 0),
        failed=d.get("failed", 0),
    )


def write_snapshot(target: Path, state: AfkState) -> None:
    path = state_path(target)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(to_dict(state), fh, indent=2)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)  # atomic on POSIX
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def load_snapshot(target: Path) -> Optional[AfkState]:
    path = state_path(target)
    if not path.exists():
        return None
    try:
        return from_dict(json.loads(path.read_text()))
    except (json.JSONDecodeError, KeyError, ValueError):
        return None


def attach_persistence(store: Store, target: Path) -> None:
    """Subscribe the store so every dispatch snapshots state to disk."""
    store.subscribe(lambda state, action: write_snapshot(target, state))
