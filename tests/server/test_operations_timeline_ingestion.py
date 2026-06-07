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


class CostEventAttributionTests(unittest.TestCase):
    def test_cost_events_attributed_by_workspace_team_repo_api_key_agent_and_run(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        cost_event = CostEventSubmission(
            event_id="cost_1",
            run_id="run_42",
            provider="anthropic",
            model="claude-sonnet-4-6",
            cost_usd=1.23,
            occurred_at="2026-06-07T12:00:00Z",
            agent="codex",
            phase="execute",
            team_id="team_frontend",
            api_key_id="key_prod_01",
            repository_id="repo_web",
        )

        result = ingest(
            IngestionEnvelope(workspace_id="ws_acme", repository_id="repo_web", payload=cost_event),
            policy=SourceCustodyPolicy.default(),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertTrue(result.accepted, result.errors)
        stored = telemetry_store.cost_events[0]
        self.assertEqual(stored.team_id, "team_frontend")
        self.assertEqual(stored.api_key_id, "key_prod_01")
        self.assertEqual(stored.repository_id, "repo_web")
        self.assertEqual(stored.provider, "anthropic")
        self.assertEqual(stored.model, "claude-sonnet-4-6")
        self.assertAlmostEqual(stored.cost_usd, 1.23)

        event_record = telemetry_store.event_records[0]
        self.assertEqual(event_record.workspace_id, "ws_acme")
        self.assertEqual(event_record.repository_id, "repo_web")
        self.assertEqual(event_record.run_id, "run_42")
        self.assertEqual(event_record.agent, "codex")

    def test_cost_events_without_optional_attribution_fields_accepted(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        cost_event = CostEventSubmission(
            event_id="cost_2",
            run_id="run_43",
            provider="openai",
            model="gpt-5.5",
            cost_usd=0.05,
            occurred_at="2026-06-07T12:01:00Z",
        )

        result = ingest(
            IngestionEnvelope(workspace_id="ws_acme", repository_id="repo_web", payload=cost_event),
            policy=SourceCustodyPolicy.default(),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertTrue(result.accepted, result.errors)
        stored = telemetry_store.cost_events[0]
        self.assertIsNone(stored.team_id)
        self.assertIsNone(stored.api_key_id)
        self.assertIsNone(stored.repository_id)


class HighVolumeMultiScopeTimelineTests(unittest.TestCase):
    def test_high_volume_events_across_workspaces_repos_and_runs(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        product_store = FailingProductAuthStore()
        workspaces = ["ws_alpha", "ws_beta"]
        repos = ["repo_api", "repo_web"]
        runs = ["run_1", "run_2", "run_3"]
        agents = ["codex", "claude"]
        event_count = 0

        for ws in workspaces:
            for repo in repos:
                for run in runs:
                    for agent in agents:
                        for i in range(5):
                            event_count += 1
                            result = ingest(
                                IngestionEnvelope(
                                    workspace_id=ws,
                                    repository_id=repo,
                                    payload=RunEventSubmission(
                                        event_id=f"evt_{event_count}",
                                        run_id=run,
                                        event_type="step_completed",
                                        phase="execute",
                                        severity="info",
                                        occurred_at=f"2026-06-07T10:{event_count:04d}Z",
                                        agent=agent,
                                    ),
                                ),
                                policy=SourceCustodyPolicy.default(),
                                product_store=product_store,
                                telemetry_store=telemetry_store,
                            )
                            self.assertTrue(result.accepted)

        self.assertEqual(len(telemetry_store.event_records), event_count)

        alpha_api_run1_codex = telemetry_store.query_events(
            workspace_id="ws_alpha",
            repository_id="repo_api",
            run_id="run_1",
            agent="codex",
        )
        self.assertEqual(len(alpha_api_run1_codex), 5)

        beta_events = telemetry_store.query_events(workspace_id="ws_beta")
        self.assertEqual(len(beta_events), event_count // 2)

        all_run2 = telemetry_store.query_events(run_id="run_2")
        expected_run2 = len(workspaces) * len(repos) * len(agents) * 5
        self.assertEqual(len(all_run2), expected_run2)

    def test_mixed_event_kinds_in_operations_timeline(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        product_store = FailingProductAuthStore()
        ws, repo, run = "ws_ops", "repo_ops", "run_ops"

        events = [
            RunEventSubmission(event_id="re_1", run_id=run, event_type="phase_started", phase="plan", severity="info", occurred_at="2026-06-07T10:00:00Z", agent="codex"),
            CostEventSubmission(event_id="ce_1", run_id=run, provider="anthropic", model="claude-sonnet-4-6", cost_usd=0.10, occurred_at="2026-06-07T10:01:00Z", agent="codex", phase="plan", team_id="team_1", api_key_id="key_1"),
            CommandEventSubmission(event_id="cmd_1", run_id=run, command="agentrail context query", event_type="command_finished", phase="plan", severity="info", occurred_at="2026-06-07T10:02:00Z", agent="codex", exit_code=0),
            RunEventSubmission(event_id="re_2", run_id=run, event_type="phase_started", phase="execute", severity="info", occurred_at="2026-06-07T10:03:00Z", agent="codex"),
            CostEventSubmission(event_id="ce_2", run_id=run, provider="anthropic", model="claude-sonnet-4-6", cost_usd=0.85, occurred_at="2026-06-07T10:04:00Z", agent="codex", phase="execute", team_id="team_1"),
            FailureEventSubmission(event_id="fe_1", run_id=run, event_type="test_failure", phase="verify", severity="error", occurred_at="2026-06-07T10:05:00Z", agent="codex", failure_type="unit_test", message="assertion failed"),
            AuditEventSubmission(event_id="ae_1", actor_id="agent:codex", action="source_custody_decision", decision="metadata_only", occurred_at="2026-06-07T10:06:00Z", run_id=run, agent="codex", phase="verify", event_type="policy_decision", severity="info"),
            ContextEventSubmission(event_id="ctx_1", run_id=run, event_type="context_packed", phase="plan", severity="info", occurred_at="2026-06-07T10:07:00Z", agent="codex", context_pack_id="pack_ops"),
            CommandEventSubmission(event_id="cmd_2", run_id=run, command="python3 -m unittest", event_type="command_finished", phase="verify", severity="info", occurred_at="2026-06-07T10:08:00Z", agent="codex", exit_code=1),
            RunEventSubmission(event_id="re_3", run_id=run, event_type="run_completed", phase="verify", severity="info", occurred_at="2026-06-07T10:09:00Z", agent="codex"),
        ]

        for event in events:
            result = ingest(
                IngestionEnvelope(workspace_id=ws, repository_id=repo, payload=event),
                policy=SourceCustodyPolicy.default(),
                product_store=product_store,
                telemetry_store=telemetry_store,
            )
            self.assertTrue(result.accepted, f"{event.submission_kind} {event.event_id}: {result.errors}")

        self.assertEqual(len(telemetry_store.event_records), 10)
        self.assertEqual(
            [r.submission_kind for r in telemetry_store.event_records],
            ["run_event", "cost_event", "command_event", "run_event", "cost_event",
             "failure_event", "audit_event", "context_event", "command_event", "run_event"],
        )

        plan_events = telemetry_store.query_events(workspace_id=ws, phase="plan")
        self.assertEqual(len(plan_events), 4)

        errors = telemetry_store.query_events(workspace_id=ws, severity="error")
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0].event_id, "fe_1")

        verify_events = telemetry_store.query_events(
            workspace_id=ws,
            phase="verify",
            occurred_from="2026-06-07T10:05:00Z",
            occurred_to="2026-06-07T10:09:00Z",
        )
        self.assertEqual(len(verify_events), 4)

    def test_cost_attribution_query_across_teams_and_api_keys(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        product_store = FailingProductAuthStore()

        cost_events = [
            CostEventSubmission(event_id="c1", run_id="run_1", provider="anthropic", model="opus", cost_usd=2.0, occurred_at="2026-06-07T10:00:00Z", agent="codex", phase="execute", team_id="frontend", api_key_id="key_a", repository_id="repo_web"),
            CostEventSubmission(event_id="c2", run_id="run_2", provider="anthropic", model="sonnet", cost_usd=0.5, occurred_at="2026-06-07T10:01:00Z", agent="claude", phase="execute", team_id="backend", api_key_id="key_b", repository_id="repo_api"),
            CostEventSubmission(event_id="c3", run_id="run_3", provider="openai", model="gpt-5.5", cost_usd=1.0, occurred_at="2026-06-07T10:02:00Z", agent="codex", phase="plan", team_id="frontend", api_key_id="key_a", repository_id="repo_web"),
            CostEventSubmission(event_id="c4", run_id="run_4", provider="anthropic", model="opus", cost_usd=3.0, occurred_at="2026-06-07T10:03:00Z", agent="codex", phase="execute", team_id="backend", api_key_id="key_c", repository_id="repo_api"),
        ]

        for event in cost_events:
            result = ingest(
                IngestionEnvelope(workspace_id="ws_acme", repository_id=event.repository_id, payload=event),
                policy=SourceCustodyPolicy.default(),
                product_store=product_store,
                telemetry_store=telemetry_store,
            )
            self.assertTrue(result.accepted, result.errors)

        all_costs = telemetry_store.query_events(workspace_id="ws_acme", event_type="cost_incurred")
        self.assertEqual(len(all_costs), 4)
        total_cost = sum(r.payload.cost_usd for r in all_costs)
        self.assertAlmostEqual(total_cost, 6.5)

        frontend_costs = [r for r in all_costs if r.payload.team_id == "frontend"]
        self.assertEqual(len(frontend_costs), 2)
        self.assertAlmostEqual(sum(r.payload.cost_usd for r in frontend_costs), 3.0)

        key_a_costs = [r for r in all_costs if r.payload.api_key_id == "key_a"]
        self.assertEqual(len(key_a_costs), 2)

        repo_api_costs = telemetry_store.query_events(workspace_id="ws_acme", repository_id="repo_api")
        self.assertEqual(len(repo_api_costs), 2)

        codex_costs = telemetry_store.query_events(workspace_id="ws_acme", agent="codex")
        self.assertEqual(len(codex_costs), 3)


if __name__ == "__main__":
    unittest.main()
