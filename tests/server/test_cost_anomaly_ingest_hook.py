from __future__ import annotations

import unittest
from unittest.mock import ANY, Mock, patch

from agentrail.server.cost_baseline import BaselineResult
from agentrail.server.ingestion import (
    CostEventSubmission,
    IngestionEnvelope,
    SourceCustodyPolicy,
    ingest,
)
from agentrail.server.product import InMemoryProductAuthStore
from agentrail.server.telemetry import InMemoryTelemetryStore


class CostAnomalyIngestHookTests(unittest.TestCase):
    def _ingest_cost_event(
        self,
        telemetry_store: InMemoryTelemetryStore,
        *,
        event_id: str = "cost_evt_1",
        cost_usd: float = 9.75,
    ):
        return ingest(
            IngestionEnvelope(
                workspace_id="workspace_1",
                repository_id="repo_1",
                payload=CostEventSubmission(
                    event_id=event_id,
                    run_id="run_1",
                    provider="openai",
                    model="gpt-5.5",
                    cost_usd=cost_usd,
                    occurred_at="2026-06-13T05:20:00Z",
                    agent="codex",
                    phase="execute",
                ),
            ),
            policy=SourceCustodyPolicy.default(),
            product_store=InMemoryProductAuthStore(),
            telemetry_store=telemetry_store,
            cost_baseline_client=Mock(),
        )

    def test_cost_event_above_baseline_emits_cost_anomaly_run_event(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        baseline = BaselineResult(
            mean=1.25,
            stddev=0.5,
            observation_count=8,
            is_anomaly=True,
            deviation_sigmas=17.0,
            insufficient_data=False,
        )

        with patch("agentrail.server.ingestion.compute_baseline", return_value=baseline) as compute:
            result = self._ingest_cost_event(telemetry_store)

        self.assertTrue(result.accepted)
        compute.assert_called_once_with(
            workspace_id="workspace_1",
            model="gpt-5.5",
            phase="execute",
            repository_id="repo_1",
            observed_cost_usd=9.75,
            client=ANY,
        )
        anomaly_events = [event for event in telemetry_store.run_events if event.event_type == "cost_anomaly"]
        self.assertEqual(len(anomaly_events), 1)
        anomaly = anomaly_events[0]
        self.assertEqual(anomaly.run_id, "run_1")
        self.assertEqual(anomaly.phase, "execute")
        self.assertEqual(anomaly.severity, "warning")
        self.assertEqual(
            anomaly.metadata,
            {
                "model": "gpt-5.5",
                "phase": "execute",
                "repository_id": "repo_1",
                "cost_usd": 9.75,
                "mean": 1.25,
                "stddev": 0.5,
                "deviation_sigmas": 17.0,
            },
        )
        record = telemetry_store.query_events(
            workspace_id="workspace_1",
            repository_id="repo_1",
            run_id="run_1",
            event_type="cost_anomaly",
        )
        self.assertEqual(len(record), 1)

    def test_cost_event_below_baseline_does_not_emit_cost_anomaly_run_event(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        baseline = BaselineResult(
            mean=1.25,
            stddev=0.5,
            observation_count=8,
            is_anomaly=False,
            deviation_sigmas=0.5,
            insufficient_data=False,
        )

        with patch("agentrail.server.ingestion.compute_baseline", return_value=baseline):
            result = self._ingest_cost_event(telemetry_store, cost_usd=1.5)

        self.assertTrue(result.accepted)
        self.assertEqual([event.event_type for event in telemetry_store.run_events], [])
        self.assertEqual([event.event_type for event in telemetry_store.cost_events], ["cost_incurred"])

    def test_replayed_cost_event_does_not_emit_duplicate_cost_anomaly_run_event(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        baseline = BaselineResult(
            mean=1.25,
            stddev=0.5,
            observation_count=8,
            is_anomaly=True,
            deviation_sigmas=17.0,
            insufficient_data=False,
        )

        with patch("agentrail.server.ingestion.compute_baseline", return_value=baseline):
            first = self._ingest_cost_event(telemetry_store)
            replay = self._ingest_cost_event(telemetry_store)

        self.assertTrue(first.accepted)
        self.assertTrue(replay.accepted)
        anomaly_events = [event for event in telemetry_store.run_events if event.event_type == "cost_anomaly"]
        self.assertEqual(len(anomaly_events), 1)

    def test_baseline_failure_does_not_block_cost_event_acceptance(self) -> None:
        telemetry_store = InMemoryTelemetryStore()

        with patch(
            "agentrail.server.ingestion.compute_baseline",
            side_effect=Exception("ClickHouse unavailable"),
        ):
            result = self._ingest_cost_event(telemetry_store)

        self.assertTrue(result.accepted)
        self.assertEqual(len(telemetry_store.cost_events), 1)
        self.assertEqual(telemetry_store.run_events, [])


if __name__ == "__main__":
    unittest.main()
