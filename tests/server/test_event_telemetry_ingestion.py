from __future__ import annotations

import unittest

from agentrail.server.ingestion import (
    AuditEventSubmission,
    CommandEventSubmission,
    ContextEventSubmission,
    CostEventSubmission,
    FailureEventSubmission,
    IngestionEnvelope,
    RunEventSubmission,
    SourceCustodyPolicy,
    ingest,
)
from agentrail.server.product import InMemoryProductAuthStore
from agentrail.server.telemetry import InMemoryTelemetryStore


class FailingProductAuthStore(InMemoryProductAuthStore):
    def write(self, envelope: IngestionEnvelope) -> None:
        raise AssertionError(f"telemetry payload used product/auth store: {envelope.payload.submission_kind}")


class EventTelemetryIngestionTests(unittest.TestCase):
    def test_accepts_all_high_volume_event_kinds_as_append_only_timeline_records(self) -> None:
        product_store = FailingProductAuthStore()
        telemetry_store = InMemoryTelemetryStore()
        payloads = [
            RunEventSubmission(
                event_id="run_event_1",
                run_id="run_123",
                event_type="phase_started",
                phase="execute",
                severity="info",
                occurred_at="2026-06-06T10:00:00Z",
                agent="codex",
                metadata={"issue": "135"},
            ),
            CostEventSubmission(
                event_id="cost_event_1",
                run_id="run_123",
                provider="openai",
                model="gpt-5.5",
                cost_usd=0.42,
                occurred_at="2026-06-06T10:01:00Z",
                agent="codex",
                phase="execute",
                event_type="cost_incurred",
                severity="info",
                metadata={"unit": "tokens"},
            ),
            AuditEventSubmission(
                event_id="audit_event_1",
                actor_id="agent:codex",
                action="source_custody_decision",
                decision="metadata_only",
                occurred_at="2026-06-06T10:02:00Z",
                run_id="run_123",
                agent="codex",
                phase="context",
                event_type="policy_decision",
                severity="info",
                metadata={"policy": "source_custody"},
            ),
            FailureEventSubmission(
                event_id="failure_event_1",
                run_id="run_123",
                event_type="test_failure",
                phase="verify",
                severity="error",
                occurred_at="2026-06-06T10:03:00Z",
                agent="codex",
                failure_type="unit_test",
                message="tests.server.test_event_telemetry_ingestion failed",
            ),
            CommandEventSubmission(
                event_id="command_event_1",
                run_id="run_123",
                command="python3 -m unittest",
                event_type="command_finished",
                phase="verify",
                severity="info",
                occurred_at="2026-06-06T10:04:00Z",
                agent="codex",
                exit_code=0,
            ),
            ContextEventSubmission(
                event_id="context_event_1",
                run_id="run_123",
                event_type="context_excluded",
                phase="plan",
                severity="warning",
                occurred_at="2026-06-06T10:05:00Z",
                agent="codex",
                context_pack_id="pack_123",
                decision="excluded",
                metadata={"reason": "policy_denied"},
            ),
        ]

        for payload in payloads:
            result = ingest(
                IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
                policy=SourceCustodyPolicy.default(),
                product_store=product_store,
                telemetry_store=telemetry_store,
            )
            self.assertTrue(result.accepted, f"{payload} should be accepted: {result.errors}")

        self.assertEqual(
            [record.payload.submission_kind for record in telemetry_store.records],
            ["run_event", "cost_event", "audit_event", "failure_event", "command_event", "context_event"],
        )
        self.assertEqual(
            [record.submission_kind for record in telemetry_store.event_records],
            ["run_event", "cost_event", "audit_event", "failure_event", "command_event", "context_event"],
        )
        first_event = telemetry_store.event_records[0]
        self.assertEqual(first_event.workspace_id, "workspace_123")
        self.assertEqual(first_event.repository_id, "repo_123")
        self.assertEqual(first_event.run_id, "run_123")
        self.assertEqual(first_event.agent, "codex")
        self.assertEqual(first_event.phase, "execute")
        self.assertEqual(first_event.event_type, "phase_started")
        self.assertEqual(first_event.severity, "info")
        self.assertEqual(first_event.occurred_at, "2026-06-06T10:00:00Z")
        self.assertIs(first_event.payload, payloads[0])

        duplicate_result = ingest(
            IngestionEnvelope(
                workspace_id="workspace_123",
                repository_id="repo_123",
                payload=RunEventSubmission(
                    event_id="run_event_1",
                    run_id="run_123",
                    event_type="phase_started",
                    phase="execute",
                    severity="info",
                    occurred_at="2026-06-06T10:06:00Z",
                    agent="codex",
                ),
            ),
            policy=SourceCustodyPolicy.default(),
            product_store=product_store,
            telemetry_store=telemetry_store,
        )

        self.assertTrue(duplicate_result.accepted)
        duplicate_records = [record for record in telemetry_store.event_records if record.event_id == "run_event_1"]
        self.assertEqual([record.occurred_at for record in duplicate_records], ["2026-06-06T10:00:00Z", "2026-06-06T10:06:00Z"])

    def test_audit_events_preserve_structured_provider_redaction_context_and_policy_metadata(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        audit_event = AuditEventSubmission(
            event_id="audit_event_1",
            actor_id="agent:codex",
            action="context_policy_decision",
            decision="excluded",
            occurred_at="2026-06-06T11:00:00Z",
            run_id="run_123",
            agent="codex",
            phase="context",
            event_type="context_policy_decision",
            severity="warning",
            provider_call={"provider": "openai", "model": "gpt-5.5", "operation": "chat.completions"},
            redaction={"rule_id": "secret_literal", "redacted_fields": ["api_key"]},
            context_decision={"context_pack_id": "pack_123", "item_id": "src/secret.py", "decision": "excluded"},
            policy_decision={"policy": "source_custody", "decision": "metadata_only", "allowed": False},
            metadata={"reason": "source_custody_policy"},
        )

        result = ingest(
            IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=audit_event),
            policy=SourceCustodyPolicy.default(),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertTrue(result.accepted)
        stored_event = telemetry_store.audit_events[0]
        self.assertEqual(stored_event.provider_call["provider"], "openai")
        self.assertEqual(stored_event.redaction["redacted_fields"], ["api_key"])
        self.assertEqual(stored_event.context_decision["decision"], "excluded")
        self.assertEqual(stored_event.policy_decision["policy"], "source_custody")
        self.assertEqual(telemetry_store.event_records[0].payload.policy_decision["allowed"], False)

    def test_dashboard_filters_by_workspace_repo_run_agent_phase_type_severity_and_time_range(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        product_store = FailingProductAuthStore()

        events = [
            ("match", "workspace_a", "repo_a", "run_a", "codex", "execute", "command_finished", "info", "2026-06-06T10:05:00Z"),
            ("wrong_workspace", "workspace_b", "repo_a", "run_a", "codex", "execute", "command_finished", "info", "2026-06-06T10:05:00Z"),
            ("wrong_repo", "workspace_a", "repo_b", "run_a", "codex", "execute", "command_finished", "info", "2026-06-06T10:05:00Z"),
            ("wrong_run", "workspace_a", "repo_a", "run_b", "codex", "execute", "command_finished", "info", "2026-06-06T10:05:00Z"),
            ("wrong_agent", "workspace_a", "repo_a", "run_a", "claude", "execute", "command_finished", "info", "2026-06-06T10:05:00Z"),
            ("wrong_phase", "workspace_a", "repo_a", "run_a", "codex", "verify", "command_finished", "info", "2026-06-06T10:05:00Z"),
            ("wrong_type", "workspace_a", "repo_a", "run_a", "codex", "execute", "phase_started", "info", "2026-06-06T10:05:00Z"),
            ("wrong_severity", "workspace_a", "repo_a", "run_a", "codex", "execute", "command_finished", "warning", "2026-06-06T10:05:00Z"),
            ("too_early", "workspace_a", "repo_a", "run_a", "codex", "execute", "command_finished", "info", "2026-06-06T09:59:59Z"),
            ("too_late", "workspace_a", "repo_a", "run_a", "codex", "execute", "command_finished", "info", "2026-06-06T10:10:01Z"),
        ]
        for event_id, workspace_id, repository_id, run_id, agent, phase, event_type, severity, occurred_at in events:
            result = ingest(
                IngestionEnvelope(
                    workspace_id=workspace_id,
                    repository_id=repository_id,
                    payload=CommandEventSubmission(
                        event_id=event_id,
                        run_id=run_id,
                        command="python3 -m unittest",
                        event_type=event_type,
                        phase=phase,
                        severity=severity,
                        occurred_at=occurred_at,
                        agent=agent,
                    ),
                ),
                policy=SourceCustodyPolicy.default(),
                product_store=product_store,
                telemetry_store=telemetry_store,
            )
            self.assertTrue(result.accepted, event_id)

        matched = telemetry_store.query_events(
            workspace_id="workspace_a",
            repository_id="repo_a",
            run_id="run_a",
            agent="codex",
            phase="execute",
            event_type="command_finished",
            severity="info",
            occurred_from="2026-06-06T10:00:00Z",
            occurred_to="2026-06-06T10:10:00Z",
        )

        self.assertEqual([event.event_id for event in matched], ["match"])


if __name__ == "__main__":
    unittest.main()
