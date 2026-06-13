from __future__ import annotations

import sys
from datetime import datetime, timezone

from agentrail.server.telemetry_completeness import SIGNALS, check_run_telemetry


class FakeQueryResult:
    def __init__(self, rows: list[dict[str, object]]) -> None:
        self._rows = rows

    def named_results(self) -> list[dict[str, object]]:
        return self._rows


class FakeClickHouseClient:
    def __init__(self, *, present: set[str], earliest: str = "2026-06-13T00:00:00Z") -> None:
        self.present = present
        self.earliest = earliest
        self.queries: list[tuple[str, dict[str, object]]] = []

    def query(self, query: str, parameters: dict[str, object]) -> FakeQueryResult:
        self.queries.append((query, parameters))
        if "/* earliest_run_event */" in query:
            return FakeQueryResult([{"occurred_at": self.earliest}])

        for signal in SIGNALS:
            if f"/* signal:{signal} */" in query:
                return FakeQueryResult([{"count": 1 if signal in self.present else 0}])

        raise AssertionError(f"unexpected query: {query}")


def test_check_run_telemetry_returns_all_present_results_for_complete_signal_set() -> None:
    client = FakeClickHouseClient(present=set(SIGNALS))

    results = check_run_telemetry("workspace-001", "run-001", client=client)

    assert [result.signal for result in results] == list(SIGNALS)
    assert len(results) == 8
    assert all(result.present for result in results)
    assert all(result.missing_since is None for result in results)


def test_check_run_telemetry_marks_missing_cost_event_with_run_start_timestamp() -> None:
    client = FakeClickHouseClient(present=set(SIGNALS) - {"cost_event"})

    results = check_run_telemetry("workspace-001", "run-001", client=client)

    cost_event = next(result for result in results if result.signal == "cost_event")
    assert cost_event.present is False
    assert cost_event.missing_since == datetime(2026, 6, 13, tzinfo=timezone.utc)


def test_check_run_telemetry_returns_stable_eight_signal_order_for_empty_run() -> None:
    client = FakeClickHouseClient(present=set(), earliest="")

    results = check_run_telemetry("workspace-001", "run-001", client=client)

    assert [result.signal for result in results] == list(SIGNALS)
    assert len(results) == 8
    assert all(result.present is False for result in results)
    assert all(result.missing_since is None for result in results)


def test_telemetry_completeness_module_has_no_fastapi_dependency() -> None:
    assert "fastapi" not in sys.modules
