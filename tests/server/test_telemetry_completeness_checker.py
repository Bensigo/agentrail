from __future__ import annotations

import unittest
from datetime import datetime, timezone
from typing import Mapping, Optional

from agentrail.server.telemetry_completeness import (
    SIGNALS,
    CheckResult,
    check_run_telemetry,
)

WORKSPACE_ID = "workspace_123"
RUN_ID = "run_abc"
# Earliest run event for the run -> the anchor used for missing_since.
ANCHOR_RAW = "2026-06-13 04:00:00.000"
ANCHOR_DT = datetime(2026, 6, 13, 4, 0, 0, tzinfo=timezone.utc)


def _extract_signal(sql: str) -> str:
    """Read the ``-- signal:<name>`` routing marker the module prefixes to SQL."""
    first_line = sql.splitlines()[0].strip()
    assert first_line.startswith("-- signal:"), f"missing signal marker: {sql!r}"
    return first_line[len("-- signal:") :]


class FakeClickHouseClient:
    """Routes canned rows by the ``-- signal:<name>`` marker in each query."""

    def __init__(self, rows_by_signal: Mapping[str, list[Mapping[str, object]]]):
        self._rows = rows_by_signal
        self.calls: list[tuple[str, Optional[Mapping[str, object]]]] = []

    def query(
        self, sql: str, *, params: Optional[Mapping[str, object]] = None
    ) -> list[Mapping[str, object]]:
        signal = _extract_signal(sql)
        self.calls.append((signal, params))
        return list(self._rows.get(signal, []))


def _all_present_rows() -> dict[str, list[Mapping[str, object]]]:
    return {
        "_anchor": [{"occurred_at": ANCHOR_RAW}],
        "context_pack": [{"x": 1}],
        "cost_event": [{"x": 1}],
        "review_gate": [{"x": 1}],
        "failure_event": [{"x": 1}],
        "memory_items": [{"x": 1}],
        # Indexed 30 minutes before the run anchor -> within the 48h window.
        "index_snapshot": [{"indexed_at": "2026-06-13 03:30:00.000"}],
        "outbox_flush": [{"x": 1}],
    }


class TelemetryCompletenessCheckerTests(unittest.TestCase):
    def test_all_signals_present_returns_eight_present_results(self) -> None:
        # AC1: a run with records in all eight sources -> 8 results, all present.
        client = FakeClickHouseClient(_all_present_rows())

        results = check_run_telemetry(WORKSPACE_ID, RUN_ID, client=client)

        self.assertEqual(len(results), 8)
        self.assertTrue(all(isinstance(r, CheckResult) for r in results))
        self.assertTrue(all(r.present for r in results), results)
        self.assertTrue(all(r.missing_since is None for r in results), results)

    def test_missing_cost_event_sets_missing_since_to_anchor(self) -> None:
        # AC2: missing cost_event -> present=False, missing_since = earliest event.
        rows = _all_present_rows()
        rows["cost_event"] = []
        client = FakeClickHouseClient(rows)

        results = check_run_telemetry(WORKSPACE_ID, RUN_ID, client=client)
        by_signal = {r.signal: r for r in results}

        cost = by_signal["cost_event"]
        self.assertFalse(cost.present)
        self.assertEqual(cost.missing_since, ANCHOR_DT)
        self.assertIsNotNone(cost.missing_since)
        self.assertIsNotNone(cost.missing_since.tzinfo)

        # Every other signal stays present with no missing_since.
        for signal, result in by_signal.items():
            if signal == "cost_event":
                continue
            self.assertTrue(result.present, signal)
            self.assertIsNone(result.missing_since, signal)

    def test_always_returns_eight_results_in_stable_order(self) -> None:
        # AC3: exactly eight results, one per signal, in stable order — both cases.
        present_client = FakeClickHouseClient(_all_present_rows())
        empty_client = FakeClickHouseClient({})

        present = check_run_telemetry(WORKSPACE_ID, RUN_ID, client=present_client)
        empty = check_run_telemetry(WORKSPACE_ID, RUN_ID, client=empty_client)

        self.assertEqual([r.signal for r in present], list(SIGNALS))
        self.assertEqual([r.signal for r in empty], list(SIGNALS))

    def test_all_missing_when_no_run_events(self) -> None:
        # No run events at all -> run_start absent, anchor unknown (None).
        client = FakeClickHouseClient({})

        results = check_run_telemetry(WORKSPACE_ID, RUN_ID, client=client)

        self.assertEqual(len(results), 8)
        self.assertTrue(all(not r.present for r in results), results)
        # With no run events there is no anchor to report.
        self.assertTrue(all(r.missing_since is None for r in results), results)

    def test_anchor_is_earliest_run_event(self) -> None:
        # The anchor query is ordered ASC LIMIT 1, so the first row is earliest.
        rows = _all_present_rows()
        rows["_anchor"] = [{"occurred_at": ANCHOR_RAW}]
        rows["failure_event"] = []
        client = FakeClickHouseClient(rows)

        results = check_run_telemetry(WORKSPACE_ID, RUN_ID, client=client)
        failure = next(r for r in results if r.signal == "failure_event")

        self.assertFalse(failure.present)
        self.assertEqual(failure.missing_since, ANCHOR_DT)

    def test_index_snapshot_outside_window_is_absent(self) -> None:
        # An index snapshot older than 48h from the anchor does not count.
        rows = _all_present_rows()
        rows["index_snapshot"] = [{"indexed_at": "2026-06-01 00:00:00.000"}]
        client = FakeClickHouseClient(rows)

        results = check_run_telemetry(WORKSPACE_ID, RUN_ID, client=client)
        snapshot = next(r for r in results if r.signal == "index_snapshot")

        self.assertFalse(snapshot.present)
        self.assertEqual(snapshot.missing_since, ANCHOR_DT)


if __name__ == "__main__":
    unittest.main()
