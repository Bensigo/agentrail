from __future__ import annotations

from unittest.mock import patch

from agentrail.server.cost_baseline import BaselineResult
from agentrail.server.ingestion import (
    CostEventSubmission,
    IngestionEnvelope,
    SourceCustodyPolicy,
    ingest,
)
from agentrail.server.product import InMemoryProductAuthStore
from agentrail.server.telemetry import InMemoryTelemetryStore


def _cost_event(cost_usd: float = 0.5) -> CostEventSubmission:
    return CostEventSubmission(
        event_id="cost-event-001",
        run_id="run-001",
        provider="anthropic",
        model="claude-sonnet-4-6",
        cost_usd=cost_usd,
        occurred_at="2026-06-13T00:00:00Z",
        phase="execute",
        agent="codex",
    )


def test_cost_event_ingest_emits_cost_anomaly_run_event_when_baseline_flags_anomaly() -> None:
    telemetry_store = InMemoryTelemetryStore()
    baseline = BaselineResult(
        mean=0.05,
        stddev=0.02,
        observation_count=30,
        is_anomaly=True,
        deviation_sigmas=22.5,
        insufficient_data=False,
    )

    with patch("agentrail.server.ingestion.compute_baseline", return_value=baseline) as compute:
        result = ingest(
            IngestionEnvelope(
                workspace_id="workspace-001",
                repository_id="repo-001",
                payload=_cost_event(),
            ),
            policy=SourceCustodyPolicy.default(),
            product_store=InMemoryProductAuthStore(),
            telemetry_store=telemetry_store,
        )

    assert result.accepted is True
    compute.assert_called_once()
    assert len(telemetry_store.cost_events) == 1
    assert len(telemetry_store.run_events) == 1

    anomaly = telemetry_store.run_events[0]
    assert anomaly.event_type == "cost_anomaly"
    assert anomaly.run_id == "run-001"
    assert anomaly.phase == "execute"
    assert anomaly.severity == "warning"
    assert anomaly.event_id == "cost-event-001:cost_anomaly"
    assert anomaly.metadata["payload"] == {
        "model": "claude-sonnet-4-6",
        "phase": "execute",
        "repository_id": "repo-001",
        "cost_usd": 0.5,
        "mean": 0.05,
        "stddev": 0.02,
        "deviation_sigmas": 22.5,
    }


def test_cost_event_ingest_does_not_emit_anomaly_when_cost_is_below_baseline() -> None:
    telemetry_store = InMemoryTelemetryStore()
    baseline = BaselineResult(
        mean=0.05,
        stddev=0.02,
        observation_count=30,
        is_anomaly=False,
        deviation_sigmas=1.5,
        insufficient_data=False,
    )

    with patch("agentrail.server.ingestion.compute_baseline", return_value=baseline):
        result = ingest(
            IngestionEnvelope("workspace-001", _cost_event(0.08), repository_id="repo-001"),
            policy=SourceCustodyPolicy.default(),
            product_store=InMemoryProductAuthStore(),
            telemetry_store=telemetry_store,
        )

    assert result.accepted is True
    assert len(telemetry_store.cost_events) == 1
    assert telemetry_store.run_events == []


def test_cost_baseline_failure_does_not_block_cost_event_ingest() -> None:
    telemetry_store = InMemoryTelemetryStore()

    with patch("agentrail.server.ingestion.compute_baseline", side_effect=RuntimeError("clickhouse down")):
        result = ingest(
            IngestionEnvelope("workspace-001", _cost_event(), repository_id="repo-001"),
            policy=SourceCustodyPolicy.default(),
            product_store=InMemoryProductAuthStore(),
            telemetry_store=telemetry_store,
        )

    assert result.accepted is True
    assert len(telemetry_store.cost_events) == 1
    assert telemetry_store.run_events == []
