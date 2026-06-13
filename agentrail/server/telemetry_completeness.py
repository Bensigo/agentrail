"""Telemetry Completeness Checker (M016).

Given a ``workspace_id`` and ``run_id``, this module inspects the existing
ClickHouse telemetry tables and reports whether each of the eight named run
signals is present. A signal is "missing" when no record for it exists yet;
``missing_since`` then carries the run's earliest event timestamp so the
console can show how long the signal has been absent.

The module is deliberately dependency-light: it imports only stdlib and
defines the ClickHouse access surface as a local ``Protocol`` so it has no
import-time side effects and no coupling to FastAPI or the console app.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Protocol

# Single source of truth for the count and order of signals (milestone order).
SIGNALS: tuple[str, ...] = (
    "run_start",
    "context_pack",
    "cost_event",
    "review_gate",
    "failure_event",
    "memory_items",
    "index_snapshot",
    "outbox_flush",
)

# An index snapshot counts as present for a run when it was indexed within this
# window of the run's anchor (earliest run event).
INDEX_SNAPSHOT_RECENCY = timedelta(hours=48)


@dataclass(frozen=True)
class CheckResult:
    """Presence of a single telemetry signal for one run."""

    signal: str
    present: bool
    missing_since: datetime | None


class ClickHouseClient(Protocol):
    """Minimal row-returning query surface.

    Mirrors the TS ``client.query(...).json()`` shape (rows as dict-like
    mappings) so a real ClickHouse adapter can satisfy it trivially. SQL uses
    ClickHouse named placeholders (e.g. ``{run_id:String}``) bound via
    ``params``.
    """

    def query(
        self, sql: str, *, params: Mapping[str, object] | None = None
    ) -> list[Mapping[str, object]]: ...


_RUN_ANCHOR_SQL = (
    "-- signal:_anchor\n"
    "SELECT occurred_at FROM run_events "
    "WHERE workspace_id = {workspace_id:String} AND run_id = {run_id:String} "
    "ORDER BY occurred_at ASC LIMIT 1"
)

_CONTEXT_PACK_SQL = (
    "-- signal:context_pack\n"
    "SELECT 1 FROM context_packs "
    "WHERE workspace_id = {workspace_id:String} AND run_id = {run_id:String} LIMIT 1"
)

_COST_EVENT_SQL = (
    "-- signal:cost_event\n"
    "SELECT 1 FROM cost_events "
    "WHERE workspace_id = {workspace_id:String} AND run_id = {run_id:String} LIMIT 1"
)

_REVIEW_GATE_SQL = (
    "-- signal:review_gate\n"
    "SELECT 1 FROM run_events "
    "WHERE workspace_id = {workspace_id:String} AND run_id = {run_id:String} "
    "AND (submission_kind = 'review_gate' OR event_type LIKE 'review_gate%') LIMIT 1"
)

_FAILURE_EVENT_SQL = (
    "-- signal:failure_event\n"
    "SELECT 1 FROM failure_events "
    "WHERE workspace_id = {workspace_id:String} AND run_id = {run_id:String} LIMIT 1"
)

_MEMORY_ITEMS_SQL = (
    "-- signal:memory_items\n"
    "SELECT 1 FROM run_events "
    "WHERE workspace_id = {workspace_id:String} AND run_id = {run_id:String} "
    "AND submission_kind = 'memory' LIMIT 1"
)

_INDEX_SNAPSHOT_SQL = (
    "-- signal:index_snapshot\n"
    "SELECT indexed_at FROM index_snapshots "
    "WHERE workspace_id = {workspace_id:String} ORDER BY indexed_at DESC LIMIT 100"
)

_OUTBOX_FLUSH_SQL = (
    "-- signal:outbox_flush\n"
    "SELECT 1 FROM run_events "
    "WHERE workspace_id = {workspace_id:String} AND run_id = {run_id:String} "
    "AND event_type = 'outbox_flushed' LIMIT 1"
)


def _parse_dt(value: object) -> datetime | None:
    """Parse a ClickHouse ``DateTime64(3,'UTC')`` value into an aware datetime."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        text = text.replace(" ", "T")
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        parsed = datetime.fromisoformat(text)
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    return None


def _run_anchor(
    client: ClickHouseClient, workspace_id: str, run_id: str
) -> datetime | None:
    """Earliest ``run_events.occurred_at`` for the run, or ``None`` if no events."""
    rows = client.query(
        _RUN_ANCHOR_SQL, params={"workspace_id": workspace_id, "run_id": run_id}
    )
    if not rows:
        return None
    return _parse_dt(rows[0].get("occurred_at"))


def _exists(
    client: ClickHouseClient, sql: str, params: Mapping[str, object]
) -> bool:
    return bool(client.query(sql, params=params))


def _index_snapshot_present(
    client: ClickHouseClient, workspace_id: str, anchor: datetime | None
) -> bool:
    rows = client.query(_INDEX_SNAPSHOT_SQL, params={"workspace_id": workspace_id})
    if not rows:
        return False
    if anchor is None:
        return True
    window = INDEX_SNAPSHOT_RECENCY.total_seconds()
    for row in rows:
        indexed_at = _parse_dt(row.get("indexed_at"))
        if indexed_at is None:
            continue
        if abs((anchor - indexed_at).total_seconds()) <= window:
            return True
    return False


def check_run_telemetry(
    workspace_id: str, run_id: str, *, client: ClickHouseClient
) -> list[CheckResult]:
    """Return one :class:`CheckResult` per named signal, in ``SIGNALS`` order.

    For absent signals, ``missing_since`` is the run's earliest event
    timestamp (its anchor), indicating how long the signal has been missing.
    """
    anchor = _run_anchor(client, workspace_id, run_id)
    params: Mapping[str, object] = {"workspace_id": workspace_id, "run_id": run_id}

    presence: dict[str, bool] = {
        "run_start": anchor is not None,
        "context_pack": _exists(client, _CONTEXT_PACK_SQL, params),
        "cost_event": _exists(client, _COST_EVENT_SQL, params),
        "review_gate": _exists(client, _REVIEW_GATE_SQL, params),
        "failure_event": _exists(client, _FAILURE_EVENT_SQL, params),
        "memory_items": _exists(client, _MEMORY_ITEMS_SQL, params),
        "index_snapshot": _index_snapshot_present(client, workspace_id, anchor),
        "outbox_flush": _exists(client, _OUTBOX_FLUSH_SQL, params),
    }

    return [
        CheckResult(
            signal=signal,
            present=presence[signal],
            missing_since=None if presence[signal] else anchor,
        )
        for signal in SIGNALS
    ]
