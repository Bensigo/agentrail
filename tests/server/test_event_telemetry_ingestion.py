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


    def test_cost_event_attribution_by_team_api_key_agent_and_run(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        cost_event = CostEventSubmission(
            event_id="cost_attrib_1",
            run_id="run_abc",
            provider="anthropic",
            model="claude-sonnet-4-6",
            cost_usd=1.25,
            occurred_at="2026-06-07T09:00:00Z",
            agent="ralph",
            phase="execute",
            team_id="team_eng",
            api_key_id="key_prod_001",
            metadata={"tokens_in": 5000, "tokens_out": 1200},
        )

        result = ingest(
            IngestionEnvelope(workspace_id="workspace_abc", repository_id="repo_abc", payload=cost_event),
            policy=SourceCustodyPolicy.default(),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertTrue(result.accepted)
        stored = telemetry_store.cost_events[0]
        self.assertEqual(stored.team_id, "team_eng")
        self.assertEqual(stored.api_key_id, "key_prod_001")
        self.assertEqual(stored.agent, "ralph")
        self.assertEqual(stored.run_id, "run_abc")
        self.assertEqual(stored.cost_usd, 1.25)
        event_record = telemetry_store.event_records[0]
        self.assertEqual(event_record.workspace_id, "workspace_abc")
        self.assertEqual(event_record.repository_id, "repo_abc")
        self.assertEqual(event_record.run_id, "run_abc")
        self.assertEqual(event_record.agent, "ralph")
        self.assertEqual(event_record.phase, "execute")

    def test_high_volume_ingestion_and_timeline_filtering_across_multiple_scopes(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        product_store = FailingProductAuthStore()

        workspaces = ["ws_alpha", "ws_beta", "ws_gamma"]
        repos = ["repo_x", "repo_y"]
        runs = ["run_1", "run_2", "run_3"]
        agents = ["codex", "ralph", "claude"]
        event_kinds = [
            ("run_event", "phase_started"),
            ("cost_event", "cost_incurred"),
            ("failure_event", "test_failure"),
            ("command_event", "command_finished"),
        ]

        event_counter = 0
        for workspace_id in workspaces:
            for repository_id in repos:
                for run_id in runs:
                    for agent in agents:
                        for kind, event_type in event_kinds:
                            event_id = f"evt_{event_counter}"
                            event_counter += 1
                            minute = event_counter % 60
                            occurred_at = f"2026-06-07T10:{minute:02d}:00Z"
                            if kind == "run_event":
                                payload = RunEventSubmission(
                                    event_id=event_id,
                                    run_id=run_id,
                                    event_type=event_type,
                                    phase="execute",
                                    severity="info",
                                    occurred_at=occurred_at,
                                    agent=agent,
                                )
                            elif kind == "cost_event":
                                payload = CostEventSubmission(
                                    event_id=event_id,
                                    run_id=run_id,
                                    provider="anthropic",
                                    model="claude-sonnet-4-6",
                                    cost_usd=0.01 * event_counter,
                                    occurred_at=occurred_at,
                                    agent=agent,
                                    phase="execute",
                                    team_id=f"team_{workspace_id}",
                                    api_key_id=f"key_{agent}",
                                )
                            elif kind == "failure_event":
                                payload = FailureEventSubmission(
                                    event_id=event_id,
                                    run_id=run_id,
                                    event_type=event_type,
                                    phase="verify",
                                    severity="error",
                                    occurred_at=occurred_at,
                                    agent=agent,
                                    failure_type="unit_test",
                                )
                            else:
                                payload = CommandEventSubmission(
                                    event_id=event_id,
                                    run_id=run_id,
                                    command="python3 -m unittest",
                                    event_type=event_type,
                                    phase="verify",
                                    severity="info",
                                    occurred_at=occurred_at,
                                    agent=agent,
                                )
                            result = ingest(
                                IngestionEnvelope(
                                    workspace_id=workspace_id,
                                    repository_id=repository_id,
                                    payload=payload,
                                ),
                                policy=SourceCustodyPolicy.default(),
                                product_store=product_store,
                                telemetry_store=telemetry_store,
                            )
                            self.assertTrue(result.accepted, f"{event_id} rejected: {result.errors}")

        total_expected = len(workspaces) * len(repos) * len(runs) * len(agents) * len(event_kinds)
        self.assertEqual(len(telemetry_store.event_records), total_expected)

        # Filter by a single workspace/repo/run/agent produces the right subset
        matched = telemetry_store.query_events(
            workspace_id="ws_alpha",
            repository_id="repo_x",
            run_id="run_1",
            agent="codex",
        )
        self.assertEqual(len(matched), len(event_kinds))

        # Filter across workspace shows only that workspace
        ws_beta_events = telemetry_store.query_events(workspace_id="ws_beta")
        ws_beta_expected = len(repos) * len(runs) * len(agents) * len(event_kinds)
        self.assertEqual(len(ws_beta_events), ws_beta_expected)

        # Filter by run_id spans all workspaces and repos
        run_1_events = telemetry_store.query_events(run_id="run_1")
        run_1_expected = len(workspaces) * len(repos) * len(agents) * len(event_kinds)
        self.assertEqual(len(run_1_events), run_1_expected)

        # Cost events carry attribution fields
        cost_records = [e for e in telemetry_store.cost_events if e.agent == "ralph" and e.run_id == "run_2"]
        for cr in cost_records:
            self.assertIsNotNone(cr.team_id)
            self.assertEqual(cr.api_key_id, "key_ralph")


if __name__ == "__main__":
    unittest.main()
