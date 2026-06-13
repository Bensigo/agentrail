"""Telemetry Completeness Checker for AgentRail run health.

Given a ``workspace_id`` and ``run_id`` this module checks whether each of the
eight named telemetry signals is present for that run by reading the existing
ClickHouse-backed tables (no new schema). It returns exactly eight
``CheckResult`` instances in a stable order so that "nothing happened" and
"telemetry push broke" stop looking identical on the dashboard.

The module deliberately has no FastAPI/console dependency and no import-time
side effects: ``ClickHouseClient`` is a ``Protocol`` and callers pass a concrete
client (or a fake in tests).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Optional, Protocol


# Stable, public ordering of the eight signals. ``check_run_telemetry`` always
# returns one CheckResult per entry, in this order.
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

# Index snapshots are workspace-scoped (not run-scoped); a snapshot counts as
# present for a run if one was recorded within this window of the run start.
INDEX_SNAPSHOT_RECENCY = timedelta(hours=48)


@dataclass(frozen=True)
class CheckResult:
    signal: str
    present: bool
    # For absent signals, how long the signal has been missing: the
    # ``occurred_at`` of the run's earliest event. ``None`` when the run has no
    # events at all (no anchor) or when the signal is present.
    missing_since: Optional[datetime]


class ClickHouseClient(Protocol):
    """Narrow query interface so the checker is testable with a fake now and
    wireable to a concrete ClickHouse client later."""

    def query_rows(
        self, sql: str, params: Mapping[str, object]
    ) -> Sequence[Mapping[str, object]]: ...


@dataclass(frozen=True)
class _SignalQuery:
    signal: str
    sql: str


# Each query is tagged with a ``-- signal: <key>`` marker on its first line so
# the read path stays self-documenting; the marker is a plain SQL comment.
def _run_events_query(signal: str, predicate: str) -> _SignalQuery:
    return _SignalQuery(
        signal=signal,
        sql=(
            f"-- signal: {signal}\n"
            "SELECT occurred_at FROM run_events\n"
            "WHERE run_id = %(run_id)s\n"
            f"{predicate}"
            "ORDER BY occurred_at ASC"
        ),
    )


def _table_query(signal: str, table: str) -> _SignalQuery:
    return _SignalQuery(
        signal=signal,
        sql=(
            f"-- signal: {signal}\n"
            f"SELECT occurred_at FROM {table}\n"
            "WHERE run_id = %(run_id)s\n"
            "ORDER BY occurred_at ASC"
        ),
    )


_SIGNAL_QUERIES: dict[str, _SignalQuery] = {
    "run_start": _run_events_query("run_start", ""),
    "context_pack": _table_query("context_pack", "context_packs"),
    "cost_event": _table_query("cost_event", "cost_events"),
    "review_gate": _run_events_query(
        "review_gate",
        "AND (submission_kind = 'review_gate' OR event_type LIKE 'review_gate%')\n",
    ),
    "failure_event": _table_query("failure_event", "failure_events"),
    "memory_items": _run_events_query(
        "memory_items",
        "AND (submission_kind = 'memory' OR event_type LIKE 'memory_items%')\n",
    ),
    # index_snapshot handled specially (workspace + recency) in the checker.
    "outbox_flush": _run_events_query(
        "outbox_flush",
        "AND event_type = 'outbox_flushed'\n",
    ),
}

_INDEX_SNAPSHOT_SQL = (
    "-- signal: index_snapshot\n"
    "SELECT occurred_at FROM index_snapshots\n"
    "WHERE workspace_id = %(workspace_id)s\n"
    "AND occurred_at >= %(since)s\n"
    "ORDER BY occurred_at ASC"
)


def check_run_telemetry(
    workspace_id: str, run_id: str, *, client: ClickHouseClient
) -> list[CheckResult]:
    """Return one :class:`CheckResult` per named signal, in :data:`SIGNALS` order.

    A signal is ``present`` when at least one matching record exists. For absent
    signals ``missing_since`` is the run's earliest ``run_events`` timestamp (the
    anchor), or ``None`` when the run has no events to anchor against.
    """

    run_rows = client.query_rows(
        _SIGNAL_QUERIES["run_start"].sql, {"run_id": run_id}
    )
    anchor = _earliest_occurred_at(run_rows)

    results: list[CheckResult] = []
    for signal in SIGNALS:
        if signal == "run_start":
            present = bool(run_rows)
        elif signal == "index_snapshot":
            present = _index_snapshot_present(workspace_id, anchor, client)
        else:
            rows = client.query_rows(
                _SIGNAL_QUERIES[signal].sql, {"run_id": run_id}
            )
            present = bool(rows)
        results.append(
            CheckResult(
                signal=signal,
                present=present,
                missing_since=None if present else anchor,
            )
        )
    return results


def _index_snapshot_present(
    workspace_id: str, anchor: Optional[datetime], client: ClickHouseClient
) -> bool:
    if anchor is None:
        return False
    rows = client.query_rows(
        _INDEX_SNAPSHOT_SQL,
        {"workspace_id": workspace_id, "since": anchor - INDEX_SNAPSHOT_RECENCY},
    )
    return bool(rows)


def _earliest_occurred_at(
    rows: Sequence[Mapping[str, object]],
) -> Optional[datetime]:
    timestamps = [
        row["occurred_at"]
        for row in rows
        if isinstance(row.get("occurred_at"), datetime)
    ]
    if not timestamps:
        return None
    return min(timestamps)
