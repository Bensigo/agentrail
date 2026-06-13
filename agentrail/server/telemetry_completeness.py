from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Protocol


class ClickHouseClient(Protocol):
    def query(self, query: str, parameters: Mapping[str, object]) -> object: ...


SIGNALS = (
    "run_start",
    "context_pack",
    "cost_event",
    "review_gate",
    "failure_event",
    "memory_items",
    "index_snapshot",
    "outbox_flush",
)


@dataclass(frozen=True)
class CheckResult:
    signal: str
    present: bool
    missing_since: datetime | None


def check_run_telemetry(workspace_id: str, run_id: str, *, client: ClickHouseClient) -> list[CheckResult]:
    earliest = _earliest_run_event(workspace_id, run_id, client=client)
    return [
        CheckResult(
            signal=signal,
            present=present,
            missing_since=None if present else earliest,
        )
        for signal in SIGNALS
        for present in [_signal_present(signal, workspace_id, run_id, earliest, client=client)]
    ]


def _earliest_run_event(workspace_id: str, run_id: str, *, client: ClickHouseClient) -> datetime | None:
    result = client.query(
        """
        /* earliest_run_event */
        SELECT min(occurred_at) AS occurred_at
        FROM run_events
        WHERE workspace_id = {workspace_id:String}
          AND run_id = {run_id:String}
        """,
        parameters={"workspace_id": workspace_id, "run_id": run_id},
    )
    row = _first_row(result)
    if row is None:
        return None
    return _datetime_or_none(_row_value(row, "occurred_at"))


def _signal_present(
    signal: str,
    workspace_id: str,
    run_id: str,
    earliest: datetime | None,
    *,
    client: ClickHouseClient,
) -> bool:
    query, parameters = _signal_query(signal, workspace_id, run_id, earliest)
    result = client.query(query, parameters=parameters)
    row = _first_row(result)
    return _count_from_row(row) > 0


def _signal_query(
    signal: str,
    workspace_id: str,
    run_id: str,
    earliest: datetime | None,
) -> tuple[str, dict[str, object]]:
    base = {"workspace_id": workspace_id, "run_id": run_id}
    queries = {
        "run_start": """
            /* signal:run_start */
            SELECT count() AS count
            FROM run_events
            WHERE workspace_id = {workspace_id:String}
              AND run_id = {run_id:String}
        """,
        "context_pack": """
            /* signal:context_pack */
            SELECT count() AS count
            FROM context_packs
            WHERE workspace_id = {workspace_id:String}
              AND run_id = {run_id:String}
        """,
        "cost_event": """
            /* signal:cost_event */
            SELECT count() AS count
            FROM cost_events
            WHERE workspace_id = {workspace_id:String}
              AND run_id = {run_id:String}
        """,
        "review_gate": """
            /* signal:review_gate */
            SELECT count() AS count
            FROM run_events
            WHERE workspace_id = {workspace_id:String}
              AND run_id = {run_id:String}
              AND (submission_kind = 'review_gate' OR event_type LIKE 'review_gate%')
        """,
        "failure_event": """
            /* signal:failure_event */
            SELECT count() AS count
            FROM failure_events
            WHERE workspace_id = {workspace_id:String}
              AND run_id = {run_id:String}
        """,
        "memory_items": """
            /* signal:memory_items */
            SELECT count() AS count
            FROM run_events
            WHERE workspace_id = {workspace_id:String}
              AND run_id = {run_id:String}
              AND (submission_kind = 'memory' OR event_type LIKE 'memory%')
        """,
        "outbox_flush": """
            /* signal:outbox_flush */
            SELECT count() AS count
            FROM run_events
            WHERE workspace_id = {workspace_id:String}
              AND run_id = {run_id:String}
              AND event_type = 'outbox_flushed'
        """,
    }
    if signal == "index_snapshot":
        params = dict(base)
        params["run_started_at"] = _datetime_param(earliest)
        return (
            """
            /* signal:index_snapshot */
            SELECT count() AS count
            FROM index_snapshots
            WHERE workspace_id = {workspace_id:String}
              AND {run_started_at:String} != ''
              AND indexed_at >= parseDateTimeBestEffort({run_started_at:String}) - INTERVAL 48 HOUR
              AND indexed_at <= parseDateTimeBestEffort({run_started_at:String}) + INTERVAL 48 HOUR
            """,
            params,
        )
    if signal not in queries:
        raise ValueError(f"unknown telemetry signal: {signal}")
    return queries[signal], base


def _rows_from_query_result(result: object) -> Iterable[object]:
    named_results = getattr(result, "named_results", None)
    if callable(named_results):
        return named_results()
    result_rows = getattr(result, "result_rows", None)
    if result_rows is not None:
        return result_rows
    if isinstance(result, Iterable) and not isinstance(result, (str, bytes, Mapping)):
        return result
    return []


def _first_row(result: object) -> object | None:
    for row in _rows_from_query_result(result):
        return row
    return None


def _row_value(row: object, key: str) -> object:
    if isinstance(row, Mapping):
        return row.get(key)
    if isinstance(row, tuple) and row:
        return row[0]
    return row


def _count_from_row(row: object | None) -> int:
    if row is None:
        return 0
    value = _row_value(row, "count")
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0


def _datetime_param(value: datetime | None) -> str:
    if value is None:
        return ""
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _datetime_or_none(value: object) -> datetime | None:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)
    if not isinstance(value, str) or not value:
        return None
    normalized = value.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)
