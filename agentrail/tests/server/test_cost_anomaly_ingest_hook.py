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


class _StubClient:
    """Minimal ClickHouseClient stub; the hook only forwards it to compute_baseline."""

    def query_cost_per_run(self, **_kwargs):  # pragma: no cover - patched out
        return []


def _cost_envelope() -> IngestionEnvelope:
    return IngestionEnvelope(
        workspace_id="workspace_123",
        repository_id="repo_123",
        payload=CostEventSubmission(
            event_id="cost_event_1",
            run_id="run_123",
            provider="openai",
            model="gpt-5.5",
            cost_usd=9.99,
            occurred_at="2026-06-06T10:01:00Z",
            agent="codex",
            phase="execute",
        ),
    )


def _ingest(envelope, telemetry_store, **kwargs):
    return ingest(
        envelope,
        policy=SourceCustodyPolicy.default(),
        product_store=InMemoryProductAuthStore(),
        telemetry_store=telemetry_store,
        baseline_client=_StubClient(),
        **kwargs,
    )


class CostAnomalyIngestHookTests(unittest.TestCase):
    def test_anomalous_cost_emits_cost_anomaly_run_event(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        result_obj = BaselineResult(
            mean=1.0,
            stddev=0.5,
            observation_count=10,
            is_anomaly=True,
            deviation_sigmas=17.98,
            insufficient_data=False,
        )
        with patch.object(ingestion_mod, "compute_baseline", return_value=result_obj):
            result = _ingest(_cost_envelope(), telemetry_store)

        self.assertTrue(result.accepted)
        anomalies = telemetry_store.query_events(event_type="cost_anomaly")
        self.assertEqual(len(anomalies), 1)
        self.assertEqual(anomalies[0].run_id, "run_123")

    def test_non_anomalous_cost_writes_no_anomaly_event(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        result_obj = BaselineResult(
            mean=1.0,
            stddev=0.5,
            observation_count=10,
            is_anomaly=False,
            deviation_sigmas=0.1,
            insufficient_data=False,
        )
        with patch.object(ingestion_mod, "compute_baseline", return_value=result_obj):
            result = _ingest(_cost_envelope(), telemetry_store)

        self.assertTrue(result.accepted)
        self.assertEqual(telemetry_store.query_events(event_type="cost_anomaly"), [])

    def test_baseline_failure_does_not_block_cost_event_ingest(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        with patch.object(ingestion_mod, "compute_baseline", side_effect=RuntimeError("clickhouse down")):
            result = _ingest(_cost_envelope(), telemetry_store)

        self.assertTrue(result.accepted)
        self.assertEqual(result.errors, [])
        self.assertEqual(len(telemetry_store.cost_events), 1)
        self.assertEqual(telemetry_store.query_events(event_type="cost_anomaly"), [])

    def test_anomaly_payload_carries_required_fields(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        result_obj = BaselineResult(
            mean=1.5,
            stddev=0.5,
            observation_count=10,
            is_anomaly=True,
            deviation_sigmas=16.98,
            insufficient_data=False,
        )
        with patch.object(ingestion_mod, "compute_baseline", return_value=result_obj):
            self.assertTrue(_ingest(_cost_envelope(), telemetry_store).accepted)

        anomalies = telemetry_store.query_events(event_type="cost_anomaly")
        self.assertEqual(len(anomalies), 1)
        metadata = anomalies[0].payload.metadata
        for key in ("model", "phase", "repository_id", "cost_usd", "mean", "stddev", "deviation_sigmas"):
            self.assertIn(key, metadata)
        self.assertEqual(metadata["model"], "gpt-5.5")
        self.assertEqual(metadata["phase"], "execute")
        self.assertEqual(metadata["repository_id"], "repo_123")
        self.assertEqual(metadata["cost_usd"], 9.99)
        self.assertEqual(metadata["mean"], 1.5)
        self.assertEqual(metadata["stddev"], 0.5)
        self.assertEqual(metadata["deviation_sigmas"], 16.98)

    def test_no_baseline_client_skips_hook(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        with patch.object(ingestion_mod, "compute_baseline") as compute:
            result = ingest(
                _cost_envelope(),
                policy=SourceCustodyPolicy.default(),
                product_store=InMemoryProductAuthStore(),
                telemetry_store=telemetry_store,
            )
        self.assertTrue(result.accepted)
        compute.assert_not_called()
        self.assertEqual(telemetry_store.query_events(event_type="cost_anomaly"), [])


if __name__ == "__main__":
    unittest.main()
