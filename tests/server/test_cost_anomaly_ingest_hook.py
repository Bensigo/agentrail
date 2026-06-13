from __future__ import annotations

import unittest
from unittest.mock import patch

from agentrail.server import ingestion as ingestion_mod
from agentrail.server.cost_baseline import BaselineResult
from agentrail.server.ingestion import (
    CostEventSubmission,
    IngestionEnvelope,
    SourceCustodyPolicy,
    ingest,
)
from agentrail.server.product import InMemoryProductAuthStore
from agentrail.server.telemetry import InMemoryTelemetryStore


def _cost_event_envelope() -> IngestionEnvelope:
    return IngestionEnvelope(
        workspace_id="workspace_123",
        repository_id="repo_123",
        payload=CostEventSubmission(
            event_id="cost_event_1",
            run_id="run_123",
            provider="anthropic",
            model="claude-opus-4-6",
            cost_usd=9.99,
            occurred_at="2026-06-06T10:01:00Z",
            agent="claude",
            phase="execute",
        ),
    )


def _ingest(envelope: IngestionEnvelope, telemetry_store: InMemoryTelemetryStore):
    return ingest(
        envelope,
        policy=SourceCustodyPolicy.default(),
        product_store=InMemoryProductAuthStore(),
        telemetry_store=telemetry_store,
    )


class CostAnomalyIngestHookTests(unittest.TestCase):
    def test_anomalous_cost_event_emits_cost_anomaly_run_event(self) -> None:
        # AC1 + AC4
        telemetry_store = InMemoryTelemetryStore()
        anomaly = BaselineResult(
            mean=1.0,
            stddev=0.5,
            observation_count=10,
            is_anomaly=True,
            deviation_sigmas=17.98,
            insufficient_data=False,
        )
        with patch.object(ingestion_mod, "compute_baseline", return_value=anomaly):
            result = _ingest(_cost_event_envelope(), telemetry_store)

        self.assertTrue(result.accepted)
        anomalies = telemetry_store.query_events(run_id="run_123", event_type="cost_anomaly")
        self.assertEqual(len(anomalies), 1)
        record = anomalies[0]
        self.assertEqual(record.run_id, "run_123")
        self.assertEqual(record.workspace_id, "workspace_123")
        self.assertEqual(record.repository_id, "repo_123")
        metadata = record.payload.metadata
        self.assertEqual(metadata["model"], "claude-opus-4-6")
        self.assertEqual(metadata["phase"], "execute")
        self.assertEqual(metadata["repository_id"], "repo_123")
        self.assertEqual(metadata["cost_usd"], 9.99)
        self.assertEqual(metadata["mean"], 1.0)
        self.assertEqual(metadata["stddev"], 0.5)
        self.assertEqual(metadata["deviation_sigmas"], 17.98)

    def test_below_baseline_cost_event_emits_no_anomaly(self) -> None:
        # AC2
        telemetry_store = InMemoryTelemetryStore()
        below = BaselineResult(
            mean=1.0,
            stddev=0.5,
            observation_count=10,
            is_anomaly=False,
            deviation_sigmas=0.2,
            insufficient_data=False,
        )
        with patch.object(ingestion_mod, "compute_baseline", return_value=below):
            result = _ingest(_cost_event_envelope(), telemetry_store)

        self.assertTrue(result.accepted)
        self.assertEqual(telemetry_store.query_events(event_type="cost_anomaly"), [])

    def test_baseline_failure_does_not_block_cost_event_ingest(self) -> None:
        # AC3
        telemetry_store = InMemoryTelemetryStore()
        with patch.object(ingestion_mod, "compute_baseline", side_effect=Exception("clickhouse down")):
            result = _ingest(_cost_event_envelope(), telemetry_store)

        self.assertTrue(result.accepted)
        self.assertEqual(len(telemetry_store.cost_events), 1)
        self.assertEqual(telemetry_store.query_events(event_type="cost_anomaly"), [])

    def test_anomaly_event_id_is_deterministic_for_replay_idempotency(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        anomaly = BaselineResult(
            mean=1.0,
            stddev=0.5,
            observation_count=10,
            is_anomaly=True,
            deviation_sigmas=17.98,
            insufficient_data=False,
        )
        with patch.object(ingestion_mod, "compute_baseline", return_value=anomaly):
            _ingest(_cost_event_envelope(), telemetry_store)

        anomalies = telemetry_store.query_events(event_type="cost_anomaly")
        self.assertEqual(anomalies[0].event_id, "cost_anomaly:cost_event_1")


if __name__ == "__main__":
    unittest.main()
