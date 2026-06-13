from __future__ import annotations

import unittest
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone

from agentrail.server.telemetry_completeness import (
    SIGNALS,
    CheckResult,
    check_run_telemetry,
)


RUN_START = datetime(2026, 6, 13, 8, 0, 0, tzinfo=timezone.utc)
LATER = datetime(2026, 6, 13, 8, 5, 0, tzinfo=timezone.utc)


class FakeClickHouseClient:
    """Routes queries by the ``-- signal: <key>`` marker on the first SQL line."""

    def __init__(self, rows_by_signal: Mapping[str, Sequence[Mapping[str, object]]]) -> None:
        self._rows_by_signal = rows_by_signal
        self.queries: list[tuple[str, Mapping[str, object]]] = []

    def query_rows(self, sql: str, params: Mapping[str, object]) -> list[Mapping[str, object]]:
        self.queries.append((sql, params))
        signal = _signal_from_sql(sql)
        return list(self._rows_by_signal.get(signal, []))


def _signal_from_sql(sql: str) -> str:
    first_line = sql.strip().splitlines()[0].strip()
    marker = "-- signal:"
    assert first_line.startswith(marker), f"query missing signal marker: {first_line!r}"
    return first_line[len(marker):].strip()


def _all_present_rows() -> dict[str, list[dict[str, object]]]:
    return {
        "run_start": [{"occurred_at": RUN_START}, {"occurred_at": LATER}],
        "context_pack": [{"occurred_at": LATER}],
        "cost_event": [{"occurred_at": LATER}],
        "review_gate": [{"occurred_at": LATER}],
        "failure_event": [{"occurred_at": LATER}],
        "memory_items": [{"occurred_at": LATER}],
        "index_snapshot": [{"occurred_at": LATER}],
        "outbox_flush": [{"occurred_at": LATER}],
    }


class TelemetryCompletenessCheckerTests(unittest.TestCase):
    def test_all_present_returns_eight_results_all_present(self) -> None:
        client = FakeClickHouseClient(_all_present_rows())

        results = check_run_telemetry("workspace_1", "run_1", client=client)

        self.assertEqual(len(results), 8)
        self.assertTrue(all(isinstance(r, CheckResult) for r in results))
        self.assertTrue(all(r.present for r in results), [r.signal for r in results if not r.present])
        self.assertTrue(all(r.missing_since is None for r in results))

    def test_missing_cost_event_reports_missing_since_earliest_run_event(self) -> None:
        rows = _all_present_rows()
        rows["cost_event"] = []
        client = FakeClickHouseClient(rows)

        results = check_run_telemetry("workspace_1", "run_1", client=client)

        by_signal = {r.signal: r for r in results}
        self.assertFalse(by_signal["cost_event"].present)
        self.assertEqual(by_signal["cost_event"].missing_since, RUN_START)
        self.assertTrue(by_signal["context_pack"].present)
        self.assertIsNone(by_signal["context_pack"].missing_since)

    def test_always_returns_eight_results_in_stable_order(self) -> None:
        client = FakeClickHouseClient({})

        results = check_run_telemetry("workspace_1", "run_1", client=client)

        self.assertEqual(len(results), 8)
        self.assertEqual(
            [r.signal for r in results],
            [
                "run_start",
                "context_pack",
                "cost_event",
                "review_gate",
                "failure_event",
                "memory_items",
                "index_snapshot",
                "outbox_flush",
            ],
        )
        self.assertEqual([r.signal for r in results], list(SIGNALS))

    def test_no_run_events_yields_missing_since_none(self) -> None:
        client = FakeClickHouseClient({})

        results = check_run_telemetry("workspace_1", "run_1", client=client)

        for result in results:
            self.assertFalse(result.present)
            self.assertIsNone(result.missing_since)

    def test_module_import_has_no_side_effects_and_no_fastapi_dependency(self) -> None:
        import importlib
        import sys

        module = importlib.import_module("agentrail.server.telemetry_completeness")
        self.assertTrue(hasattr(module, "check_run_telemetry"))
        self.assertNotIn("fastapi", sys.modules)


if __name__ == "__main__":
    unittest.main()
