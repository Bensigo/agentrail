"""Acceptance test for issue #870: runner run telemetry emission.

The self-hosted runner emits run_start / context_pack / cost_event /
index_snapshot, but NEVER pushes review_gate, failure_event, memory_items, or
outbox_flush to ClickHouse, even when those steps occur.

This test is intentionally RED: ``emit_runner_post_run_telemetry`` does not
exist yet in ``agentrail.runner.client``, and ``CheckResult`` has no
``not_applicable`` field. Both are required for the test to turn green.

Acceptance criteria exercised (issue #870):
  AC1 - green runner run → review_gate telemetry Present
  AC2 - outbox_flush telemetry Present after a completed runner run
  AC3 - failure_event telemetry Present when runner run is red/failed
  AC4 - failure_event on a green run is not_applicable (not a red Missing)

DO NOT implement the feature here. The Implementer role makes this test green.
"""
from __future__ import annotations

import json
import unittest
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from agentrail.sandbox.docker_runner import RunResult
from agentrail.server.telemetry_completeness import check_run_telemetry

# ── RED: this function does not exist yet ──────────────────────────────────
# The Implementer must add emit_runner_post_run_telemetry to
# agentrail/runner/client.py (or a sub-module imported from there) before
# this test can turn green.
from agentrail.runner.client import emit_runner_post_run_telemetry  # noqa: E402


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class _FakeIngestTransport:
    """Captures all POST bodies sent to any /ingest/run-events endpoint."""

    def __init__(self) -> None:
        self.posted_events: List[Dict[str, Any]] = []

    def __call__(
        self,
        method: str,
        url: str,
        *,
        headers: Dict[str, str],
        body: Optional[bytes] = None,
    ) -> object:
        if body and "run-events" in url:
            try:
                batch = json.loads(body)
                if isinstance(batch, list):
                    self.posted_events.extend(batch)
            except (json.JSONDecodeError, TypeError):
                pass
        from agentrail.runner.client import Response
        return Response(status=202, body=b"")


class _FakeClickHouseFromEmitted:
    """ClickHouseClient fake that answers signal queries from runner-emitted events.

    Replays only the events that ``emit_runner_post_run_telemetry`` pushed via
    the injected transport, mirroring the field shapes the signal queries expect
    (run_id, submission_kind, event_type).
    """

    _ANCHOR = datetime(2026, 6, 1, 8, 0, 0, tzinfo=timezone.utc)

    def __init__(self, events: List[Dict[str, Any]], run_id: str) -> None:
        self._events = events
        self._run_id = run_id

    def query_rows(
        self, sql: str, params: Any
    ) -> List[Dict[str, object]]:
        first_line = sql.strip().splitlines()[0].strip()
        signal = first_line[len("-- signal:"):].strip()
        anchor_row = [{"occurred_at": self._ANCHOR}]

        if signal == "run_start":
            return anchor_row

        if signal == "index_snapshot":
            # Not the focus of this issue; treat as always-present.
            return anchor_row

        if signal == "context_pack":
            return anchor_row

        if signal == "cost_event":
            return anchor_row

        if signal == "review_gate":
            return [
                {"occurred_at": self._ANCHOR}
                for e in self._events
                if (
                    e.get("submission_kind") == "review_gate"
                    or str(e.get("event_type", "")).startswith("review_gate")
                )
                and e.get("run_id") == self._run_id
            ]

        if signal == "failure_event":
            return [
                {"occurred_at": self._ANCHOR}
                for e in self._events
                if e.get("submission_kind") == "failure_event"
                and e.get("run_id") == self._run_id
            ]

        if signal == "memory_items":
            return [
                {"occurred_at": self._ANCHOR}
                for e in self._events
                if (
                    e.get("submission_kind") == "memory"
                    or str(e.get("event_type", "")).startswith("memory_items")
                )
                and e.get("run_id") == self._run_id
            ]

        if signal == "outbox_flush":
            return [
                {"occurred_at": self._ANCHOR}
                for e in self._events
                if e.get("event_type") == "outbox_flushed"
                and e.get("run_id") == self._run_id
            ]

        return []


# ---------------------------------------------------------------------------
# Acceptance test
# ---------------------------------------------------------------------------

class RunnerTelemetryEmissionTest(unittest.TestCase):
    """Issue #870 acceptance test: runner emits the four missing telemetry signals."""

    def test_green_run_review_gate_and_outbox_flush_present_failure_not_red(
        self,
    ) -> None:
        """AC1, AC2, AC4: green run → review_gate Present, outbox_flush Present,
        failure_event not a red Missing signal.
        """
        transport = _FakeIngestTransport()

        emit_runner_post_run_telemetry(
            RunResult(status="green", cost_usd=0.05, branch="agentrail/issue-870"),
            run_id="run-870-green",
            workspace_id="ws-870",
            base_url="https://agentrail.test",
            token="tok-test",
            transport=transport,
        )

        client = _FakeClickHouseFromEmitted(transport.posted_events, "run-870-green")
        results = check_run_telemetry("ws-870", "run-870-green", client=client)
        by_signal = {r.signal: r for r in results}

        # AC1 ─ review_gate must be Present after a green run.
        self.assertTrue(
            by_signal["review_gate"].present,
            "review_gate must be Present in telemetry health after a green runner run; "
            "the Telemetry Health panel would show it as Missing (red) otherwise.",
        )

        # AC2 ─ outbox_flush must be Present.
        self.assertTrue(
            by_signal["outbox_flush"].present,
            "outbox_flush must be Present in telemetry health after a completed runner run.",
        )

        # AC4 ─ failure_event on a green run must NOT be a red Missing signal.
        # Either the runner emits a "no failures" marker (making .present True),
        # or check_run_telemetry returns it as not_applicable. Both are valid.
        fe = by_signal["failure_event"]
        failure_ok = fe.present or getattr(fe, "not_applicable", False)
        self.assertTrue(
            failure_ok,
            "failure_event on a green run must be not_applicable or Present "
            "(via a 'no-failure' marker), never a red Missing signal. "
            "See issue #870 AC4 and the chosen rule in docs.",
        )

    def test_red_run_emits_review_gate_and_failure_event(self) -> None:
        """AC1, AC3: red run → review_gate Present AND failure_event Present."""
        transport = _FakeIngestTransport()

        emit_runner_post_run_telemetry(
            RunResult(
                status="red",
                cost_usd=0.02,
                branch="",
                gate_reason="tests failed: 3 assertions",
            ),
            run_id="run-870-red",
            workspace_id="ws-870",
            base_url="https://agentrail.test",
            token="tok-test",
            transport=transport,
        )

        client = _FakeClickHouseFromEmitted(transport.posted_events, "run-870-red")
        results = check_run_telemetry("ws-870", "run-870-red", client=client)
        by_signal = {r.signal: r for r in results}

        # AC1 ─ review_gate present even when the run is red.
        self.assertTrue(
            by_signal["review_gate"].present,
            "review_gate must be Present in telemetry health after a red runner run.",
        )

        # AC3 ─ failure_event present when the run failed.
        self.assertTrue(
            by_signal["failure_event"].present,
            "failure_event must be Present when a runner run finishes with status='red'.",
        )


if __name__ == "__main__":
    unittest.main()
