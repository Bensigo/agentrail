from __future__ import annotations

from dataclasses import replace
import unittest

from agentrail.server.ingestion import (
    BoundedSnippet,
    ContextPackAnchor,
    ContextPackBudget,
    ContextPackCitation,
    ContextPackDecision,
    ContextPackMetadataSubmission,
    ContextPackQualityMetrics,
    IngestionEnvelope,
    SourceCustodyPolicy,
    ingest,
)
from agentrail.server.product import InMemoryProductAuthStore
from agentrail.server.telemetry import InMemoryTelemetryStore


class FailingProductAuthStore(InMemoryProductAuthStore):
    def write(self, envelope: IngestionEnvelope) -> None:
        raise AssertionError(f"context-pack metadata used product/auth store: {envelope.payload.submission_kind}")


class ContextPackMetadataIngestionTests(unittest.TestCase):
    def test_metadata_only_context_pack_submission_records_audit_ready_fields(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        payload = _context_pack_metadata_submission()

        result = ingest(
            IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
            policy=SourceCustodyPolicy.default(),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertTrue(result.accepted, result.errors)
        self.assertEqual(len(telemetry_store.records), 1)
        self.assertEqual(len(telemetry_store.context_pack_metadata), 1)
        stored = telemetry_store.context_pack_metadata[0]
        self.assertEqual(stored.context_pack_id, "pack_138")
        self.assertEqual(stored.workspace_id, "workspace_123")
        self.assertEqual(stored.repository_id, "repo_123")
        self.assertEqual(stored.run_id, "run_138")
        self.assertIsNone(stored.pull_request_id)
        self.assertEqual(stored.target_kind, "issue")
        self.assertEqual(stored.target_id, "138")
        self.assertEqual(stored.source_hashes["agentrail/server/ingestion.py"], "sha256:source123")
        self.assertEqual(stored.anchors[0].reason, "server ingestion contract")
        self.assertEqual(stored.citations[0].source_hash, "sha256:context123")
        self.assertEqual(stored.inclusions[0].reason, "defines context-pack metadata ingestion")
        self.assertEqual(stored.exclusions[0].reason, "console UI is out of scope")
        self.assertEqual(stored.budgets.max_input_tokens, 12000)
        self.assertEqual(stored.quality_metrics.citation_coverage, 1.0)
        self.assertEqual(stored.artifact_ref, "object://context-packs/pack_138.json")

    def test_repeated_context_pack_metadata_submission_is_idempotent(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        payload = _context_pack_metadata_submission()

        for _ in range(2):
            result = ingest(
                IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
                policy=SourceCustodyPolicy.default(),
                product_store=FailingProductAuthStore(),
                telemetry_store=telemetry_store,
            )
            self.assertTrue(result.accepted, result.errors)

        self.assertEqual([record.payload.submission_kind for record in telemetry_store.records], ["context_pack_metadata"])
        self.assertEqual(len(telemetry_store.context_pack_metadata), 1)

    def test_context_pack_metadata_rejects_full_source_content_without_writing(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        payload = _context_pack_metadata_submission(
            metadata={"source_files": {"agentrail/server/ingestion.py": "def upload_everything(): pass"}}
        )

        result = ingest(
            IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
            policy=SourceCustodyPolicy.default(),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertFalse(result.accepted)
        self.assertEqual(telemetry_store.records, [])
        self.assertEqual(result.errors[0].code, "full_source_forbidden")
        self.assertEqual(result.errors[0].field, "payload.metadata.source_files")

    def test_context_pack_nested_decision_metadata_cannot_hide_full_source_content(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        payload = _context_pack_metadata_submission(
            inclusions=[
                ContextPackDecision(
                    item_id="agentrail/server/ingestion.py",
                    citation="agentrail/server/ingestion.py:167",
                    reason="defines context-pack metadata ingestion",
                    metadata={"source_files": {"agentrail/server/ingestion.py": "def upload_everything(): pass"}},
                )
            ]
        )

        result = ingest(
            IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
            policy=SourceCustodyPolicy.default(),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertFalse(result.accepted)
        self.assertEqual(telemetry_store.records, [])
        self.assertEqual(result.errors[0].code, "full_source_forbidden")
        self.assertEqual(result.errors[0].field, "payload.inclusions[0].metadata.source_files")

    def test_context_pack_nested_decision_metadata_cannot_hide_large_inline_artifacts(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        payload = _context_pack_metadata_submission(
            inclusions=[
                ContextPackDecision(
                    item_id="agentrail/server/ingestion.py",
                    citation="agentrail/server/ingestion.py:167",
                    reason="defines context-pack metadata ingestion",
                    metadata={"log": "x" * 5000},
                )
            ]
        )

        result = ingest(
            IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
            policy=SourceCustodyPolicy.default(),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertFalse(result.accepted)
        self.assertEqual(telemetry_store.records, [])
        self.assertEqual(result.errors[0].code, "inline_artifact_body_forbidden")
        self.assertEqual(result.errors[0].field, "payload.inclusions[0].metadata.log")

    def test_context_pack_decisions_require_citation_and_reason(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        payload = _context_pack_metadata_submission(
            inclusions=[
                ContextPackDecision(
                    item_id="agentrail/server/ingestion.py",
                    citation="",
                    reason="",
                )
            ],
            exclusions=[
                ContextPackDecision(
                    item_id="agent-operations-console",
                    citation="",
                    reason="",
                )
            ],
        )

        result = ingest(
            IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
            policy=SourceCustodyPolicy.default(),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertFalse(result.accepted)
        self.assertEqual(telemetry_store.records, [])
        self.assertEqual(
            [(error.code, error.field) for error in result.errors],
            [
                ("context_pack_decision_citation_required", "payload.inclusions[0].citation"),
                ("context_pack_decision_reason_required", "payload.inclusions[0].reason"),
                ("context_pack_decision_citation_required", "payload.exclusions[0].citation"),
                ("context_pack_decision_reason_required", "payload.exclusions[0].reason"),
            ],
        )

    def test_context_pack_decisions_require_item_id(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        payload = _context_pack_metadata_submission(
            inclusions=[
                ContextPackDecision(
                    item_id="",
                    citation="agentrail/server/ingestion.py:167",
                    reason="defines context-pack metadata ingestion",
                )
            ],
            exclusions=[
                ContextPackDecision(
                    item_id="",
                    citation="milestones/004-server-ingestion-spine.md:57",
                    reason="console UI is out of scope",
                )
            ],
        )

        result = ingest(
            IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
            policy=SourceCustodyPolicy.default(),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertFalse(result.accepted)
        self.assertEqual(telemetry_store.records, [])
        self.assertEqual(
            [(error.code, error.field) for error in result.errors],
            [
                ("context_pack_decision_item_id_required", "payload.inclusions[0].item_id"),
                ("context_pack_decision_item_id_required", "payload.exclusions[0].item_id"),
            ],
        )

    def test_context_pack_anchors_and_citations_require_auditable_fields(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        payload = _context_pack_metadata_submission(
            anchors=[
                ContextPackAnchor(
                    anchor_id="",
                    path="",
                    citation="",
                    reason="",
                    source_hash="",
                )
            ],
            citations=[
                ContextPackCitation(
                    citation_id="",
                    path="",
                    source_hash="",
                )
            ],
        )

        result = ingest(
            IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
            policy=SourceCustodyPolicy.default(),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertFalse(result.accepted)
        self.assertEqual(telemetry_store.records, [])
        self.assertEqual(
            [(error.code, error.field) for error in result.errors],
            [
                ("context_pack_anchor_id_required", "payload.anchors[0].anchor_id"),
                ("context_pack_anchor_path_required", "payload.anchors[0].path"),
                ("context_pack_anchor_citation_required", "payload.anchors[0].citation"),
                ("context_pack_anchor_reason_required", "payload.anchors[0].reason"),
                ("context_pack_anchor_source_hash_required", "payload.anchors[0].source_hash"),
                ("context_pack_citation_id_required", "payload.citations[0].citation_id"),
                ("context_pack_citation_path_required", "payload.citations[0].path"),
                ("context_pack_citation_source_hash_required", "payload.citations[0].source_hash"),
            ],
        )

    def test_context_pack_anchors_and_citations_must_match_source_inventory(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        payload = _context_pack_metadata_submission(
            source_hashes={
                "agentrail/server/ingestion.py": "sha256:source123",
                "milestones/004-server-ingestion-spine.md": "sha256:milestone004",
            },
            anchors=[
                ContextPackAnchor(
                    anchor_id="anchor_context",
                    path="CONTEXT.md",
                    citation="CONTEXT.md:1",
                    reason="canonical domain language",
                    source_hash="sha256:context123",
                )
            ],
            citations=[
                ContextPackCitation(
                    citation_id="citation_ingestion",
                    path="agentrail/server/ingestion.py",
                    source_hash="sha256:wrong",
                )
            ],
        )

        result = ingest(
            IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
            policy=SourceCustodyPolicy.default(),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertFalse(result.accepted)
        self.assertEqual(telemetry_store.records, [])
        self.assertEqual(
            [(error.code, error.field) for error in result.errors],
            [
                ("context_pack_anchor_source_hash_mismatch", "payload.anchors[0].source_hash"),
                ("context_pack_citation_source_hash_mismatch", "payload.citations[0].source_hash"),
            ],
        )

    def test_context_pack_anchor_citations_must_resolve_to_anchor_path(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        payload = _context_pack_metadata_submission(
            anchors=[
                ContextPackAnchor(
                    anchor_id="anchor_context",
                    path="CONTEXT.md",
                    citation="secret.py:1",
                    reason="citation must not name a different source path",
                    start_line=1,
                    end_line=20,
                    source_hash="sha256:context123",
                )
            ]
        )

        result = ingest(
            IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
            policy=SourceCustodyPolicy.default(),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertFalse(result.accepted)
        self.assertEqual(telemetry_store.records, [])
        self.assertEqual(
            [(error.code, error.field) for error in result.errors],
            [("context_pack_anchor_citation_not_in_inventory", "payload.anchors[0].citation")],
        )

    def test_context_pack_null_required_collections_return_validation_errors(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        payload = replace(
            _context_pack_metadata_submission(),
            source_hashes=None,
            anchors=None,
            citations=None,
            inclusions=None,
            exclusions=None,
        )

        result = ingest(
            IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
            policy=SourceCustodyPolicy.default(),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertFalse(result.accepted)
        self.assertEqual(telemetry_store.records, [])
        self.assertEqual(
            [(error.code, error.field) for error in result.errors],
            [
                ("context_pack_source_hashes_required", "payload.source_hashes"),
                ("context_pack_anchors_required", "payload.anchors"),
                ("context_pack_citations_required", "payload.citations"),
                ("context_pack_inclusions_required", "payload.inclusions"),
            ],
        )

    def test_context_pack_budgets_and_quality_metrics_are_required(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        payload = replace(
            _context_pack_metadata_submission(),
            budgets=None,
            quality_metrics=None,
        )

        result = ingest(
            IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
            policy=SourceCustodyPolicy.default(),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertFalse(result.accepted)
        self.assertEqual(telemetry_store.records, [])
        self.assertEqual(
            [(error.code, error.field) for error in result.errors],
            [
                ("context_pack_budgets_required", "payload.budgets"),
                ("context_pack_quality_metrics_required", "payload.quality_metrics"),
            ],
        )

    def test_context_pack_budgets_must_have_valid_token_counts(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        payload = replace(
            _context_pack_metadata_submission(),
            budgets=ContextPackBudget(
                max_input_tokens=-1,
                used_input_tokens=99,
                max_output_tokens=-2,
            ),
        )

        result = ingest(
            IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
            policy=SourceCustodyPolicy.default(),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertFalse(result.accepted)
        self.assertEqual(telemetry_store.records, [])
        self.assertEqual(
            [(error.code, error.field) for error in result.errors],
            [
                ("context_pack_budget_max_input_tokens_invalid", "payload.budgets.max_input_tokens"),
                ("context_pack_budget_max_output_tokens_invalid", "payload.budgets.max_output_tokens"),
            ],
        )

    def test_context_pack_used_input_tokens_must_not_exceed_max(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        payload = replace(
            _context_pack_metadata_submission(),
            budgets=ContextPackBudget(
                max_input_tokens=10,
                used_input_tokens=11,
                max_output_tokens=0,
            ),
        )

        result = ingest(
            IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
            policy=SourceCustodyPolicy.default(),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertFalse(result.accepted)
        self.assertEqual(telemetry_store.records, [])
        self.assertEqual(
            [(error.code, error.field) for error in result.errors],
            [("context_pack_budget_used_input_tokens_exceeds_max", "payload.budgets.used_input_tokens")],
        )

    def test_context_pack_quality_metrics_must_have_valid_ranges(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        payload = replace(
            _context_pack_metadata_submission(),
            quality_metrics=ContextPackQualityMetrics(
                required_source_coverage=-0.5,
                citation_coverage=1.5,
                stale_or_denied_leakage=-1,
                precision_at_budget=2.0,
            ),
        )

        result = ingest(
            IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
            policy=SourceCustodyPolicy.default(),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertFalse(result.accepted)
        self.assertEqual(telemetry_store.records, [])
        self.assertEqual(
            [(error.code, error.field) for error in result.errors],
            [
                (
                    "context_pack_quality_required_source_coverage_invalid",
                    "payload.quality_metrics.required_source_coverage",
                ),
                ("context_pack_quality_citation_coverage_invalid", "payload.quality_metrics.citation_coverage"),
                (
                    "context_pack_quality_stale_or_denied_leakage_invalid",
                    "payload.quality_metrics.stale_or_denied_leakage",
                ),
                ("context_pack_quality_precision_at_budget_invalid", "payload.quality_metrics.precision_at_budget"),
            ],
        )

    def test_context_pack_content_hash_is_required_for_identity(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        payload = replace(_context_pack_metadata_submission(), content_hash="")

        result = ingest(
            IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
            policy=SourceCustodyPolicy.default(),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertFalse(result.accepted)
        self.assertEqual(telemetry_store.records, [])
        self.assertEqual(
            [(error.code, error.field) for error in result.errors],
            [("context_pack_content_hash_required", "payload.content_hash")],
        )

    def test_context_pack_content_hash_must_be_a_hash_reference(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        payload = replace(_context_pack_metadata_submission(), content_hash="def upload_everything(): pass")

        result = ingest(
            IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
            policy=SourceCustodyPolicy.default(),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertFalse(result.accepted)
        self.assertEqual(telemetry_store.records, [])
        self.assertEqual(
            [(error.code, error.field) for error in result.errors],
            [("context_pack_content_hash_invalid", "payload.content_hash")],
        )

    def test_context_pack_target_fields_are_required_for_provenance(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        payload = replace(_context_pack_metadata_submission(), target_kind="", target_id="")

        result = ingest(
            IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
            policy=SourceCustodyPolicy.default(),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertFalse(result.accepted)
        self.assertEqual(telemetry_store.records, [])
        self.assertEqual(
            [(error.code, error.field) for error in result.errors],
            [
                ("context_pack_target_required", "payload.target_kind"),
                ("context_pack_target_required", "payload.target_id"),
            ],
        )

    def test_context_pack_decision_citations_must_match_source_inventory(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        payload = _context_pack_metadata_submission(
            inclusions=[
                ContextPackDecision(
                    item_id="secret.py",
                    citation="secret.py:1",
                    reason="should not be accepted without source provenance",
                )
            ],
            exclusions=[
                ContextPackDecision(
                    item_id="other.py",
                    citation="other.py:1",
                    reason="should not be accepted without source provenance",
                )
            ],
        )

        result = ingest(
            IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
            policy=SourceCustodyPolicy.default(),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertFalse(result.accepted)
        self.assertEqual(telemetry_store.records, [])
        self.assertEqual(
            [(error.code, error.field) for error in result.errors],
            [
                ("context_pack_decision_citation_not_in_inventory", "payload.inclusions[0].citation"),
                ("context_pack_decision_citation_not_in_inventory", "payload.exclusions[0].citation"),
            ],
        )

    def test_context_pack_decision_citations_must_match_recorded_citation_ranges(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        payload = _context_pack_metadata_submission(
            inclusions=[
                ContextPackDecision(
                    item_id="agentrail/server/ingestion.py",
                    citation="agentrail/server/ingestion.py:999999",
                    reason="must not cite a line outside the recorded citation range",
                )
            ]
        )

        result = ingest(
            IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
            policy=SourceCustodyPolicy.default(),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertFalse(result.accepted)
        self.assertEqual(telemetry_store.records, [])
        self.assertEqual(
            [(error.code, error.field) for error in result.errors],
            [("context_pack_decision_citation_not_in_inventory", "payload.inclusions[0].citation")],
        )

    def test_context_pack_decisions_can_reference_namespaced_citation_ids(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        payload = _context_pack_metadata_submission(
            citations=[
                ContextPackCitation(
                    citation_id="citation:ingestion",
                    path="agentrail/server/ingestion.py",
                    source_hash="sha256:source123",
                    start_line=167,
                    end_line=190,
                ),
                ContextPackCitation(
                    citation_id="citation:milestone",
                    path="milestones/004-server-ingestion-spine.md",
                    source_hash="sha256:milestone004",
                    start_line=57,
                    end_line=66,
                ),
            ],
            inclusions=[
                ContextPackDecision(
                    item_id="agentrail/server/ingestion.py",
                    citation="citation:ingestion",
                    reason="direct citation IDs may use namespace separators",
                )
            ],
            exclusions=[
                ContextPackDecision(
                    item_id="agent-operations-console",
                    citation="citation:milestone",
                    reason="console UI is out of scope",
                )
            ],
        )

        result = ingest(
            IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
            policy=SourceCustodyPolicy.default(),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertTrue(result.accepted, result.errors)
        self.assertEqual(len(telemetry_store.context_pack_metadata), 1)

    def test_context_pack_path_like_citation_ids_do_not_bypass_source_inventory(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        payload = _context_pack_metadata_submission(
            citations=[
                ContextPackCitation(
                    citation_id="secret.py",
                    path="CONTEXT.md",
                    source_hash="sha256:context123",
                    start_line=1,
                    end_line=20,
                ),
                ContextPackCitation(
                    citation_id="secret.py:1",
                    path="CONTEXT.md",
                    source_hash="sha256:context123",
                    start_line=1,
                    end_line=20,
                ),
                ContextPackCitation(
                    citation_id="citation_milestone",
                    path="milestones/004-server-ingestion-spine.md",
                    source_hash="sha256:milestone004",
                    start_line=57,
                    end_line=66,
                ),
            ],
            inclusions=[
                ContextPackDecision(
                    item_id="secret.py",
                    citation="secret.py",
                    reason="bare path-like citation IDs must resolve through source inventory",
                ),
                ContextPackDecision(
                    item_id="secret.py:1",
                    citation="secret.py:1",
                    reason="path-like citation IDs must resolve through source inventory",
                )
            ],
            exclusions=[
                ContextPackDecision(
                    item_id="agent-operations-console",
                    citation="milestones/004-server-ingestion-spine.md:66",
                    reason="console UI is out of scope",
                )
            ],
        )

        result = ingest(
            IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
            policy=SourceCustodyPolicy.default(),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertFalse(result.accepted)
        self.assertEqual(telemetry_store.records, [])
        self.assertEqual(
            [(error.code, error.field) for error in result.errors],
            [
                ("context_pack_decision_citation_not_in_inventory", "payload.inclusions[0].citation"),
                ("context_pack_decision_citation_not_in_inventory", "payload.inclusions[1].citation"),
            ],
        )

    def test_context_pack_decision_hash_line_citations_must_match_recorded_citation_ranges(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        payload = _context_pack_metadata_submission(
            inclusions=[
                ContextPackDecision(
                    item_id="agentrail/server/ingestion.py",
                    citation="agentrail/server/ingestion.py#L999999",
                    reason="must not cite a line outside the recorded citation range",
                )
            ]
        )

        result = ingest(
            IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
            policy=SourceCustodyPolicy.default(),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertFalse(result.accepted)
        self.assertEqual(telemetry_store.records, [])
        self.assertEqual(
            [(error.code, error.field) for error in result.errors],
            [("context_pack_decision_citation_not_in_inventory", "payload.inclusions[0].citation")],
        )

    def test_context_pack_decision_hash_line_ranges_must_stay_within_recorded_citation_ranges(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        payload = _context_pack_metadata_submission(
            inclusions=[
                ContextPackDecision(
                    item_id="agentrail/server/ingestion.py",
                    citation="agentrail/server/ingestion.py#L167-L999999",
                    reason="must not cite a range wider than the recorded citation range",
                )
            ]
        )

        result = ingest(
            IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
            policy=SourceCustodyPolicy.default(),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertFalse(result.accepted)
        self.assertEqual(telemetry_store.records, [])
        self.assertEqual(
            [(error.code, error.field) for error in result.errors],
            [("context_pack_decision_citation_not_in_inventory", "payload.inclusions[0].citation")],
        )

    def test_context_pack_decision_line_citations_must_be_positive(self) -> None:
        cases = [
            "agentrail/server/ingestion.py:0",
            "agentrail/server/ingestion.py#L0",
        ]
        for citation in cases:
            with self.subTest(citation=citation):
                telemetry_store = InMemoryTelemetryStore()
                payload = _context_pack_metadata_submission(
                    inclusions=[
                        ContextPackDecision(
                            item_id="agentrail/server/ingestion.py",
                            citation=citation,
                            reason="line references must start at one",
                        )
                    ],
                    exclusions=[],
                )

                result = ingest(
                    IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
                    policy=SourceCustodyPolicy.default(),
                    product_store=FailingProductAuthStore(),
                    telemetry_store=telemetry_store,
                )

                self.assertFalse(result.accepted)
                self.assertEqual(telemetry_store.records, [])
                self.assertEqual(
                    [(error.code, error.field) for error in result.errors],
                    [("context_pack_decision_citation_not_in_inventory", "payload.inclusions[0].citation")],
                )

    def test_context_pack_decision_malformed_hash_line_citations_are_rejected(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        payload = _context_pack_metadata_submission(
            inclusions=[
                ContextPackDecision(
                    item_id="agentrail/server/ingestion.py",
                    citation="agentrail/server/ingestion.py#L167-Lbad",
                    reason="malformed line references must not degrade to path-only citations",
                )
            ]
        )

        result = ingest(
            IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
            policy=SourceCustodyPolicy.default(),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertFalse(result.accepted)
        self.assertEqual(telemetry_store.records, [])
        self.assertEqual(
            [(error.code, error.field) for error in result.errors],
            [("context_pack_decision_citation_not_in_inventory", "payload.inclusions[0].citation")],
        )

    def test_context_pack_decision_reversed_line_ranges_are_rejected(self) -> None:
        cases = [
            "agentrail/server/ingestion.py#L190-L167",
            "agentrail/server/ingestion.py:190-167",
        ]
        for citation in cases:
            with self.subTest(citation=citation):
                telemetry_store = InMemoryTelemetryStore()
                payload = _context_pack_metadata_submission(
                    inclusions=[
                        ContextPackDecision(
                            item_id="agentrail/server/ingestion.py",
                            citation=citation,
                            reason="reversed line ranges must not resolve to recorded citations",
                        )
                    ]
                )

                result = ingest(
                    IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
                    policy=SourceCustodyPolicy.default(),
                    product_store=FailingProductAuthStore(),
                    telemetry_store=telemetry_store,
                )

                self.assertFalse(result.accepted)
                self.assertEqual(telemetry_store.records, [])
                self.assertEqual(
                    [(error.code, error.field) for error in result.errors],
                    [("context_pack_decision_citation_not_in_inventory", "payload.inclusions[0].citation")],
                )

    def test_context_pack_source_hash_paths_are_not_scanned_as_metadata_keys(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        payload = _context_pack_metadata_submission(
            source_hashes={
                "source_files": "sha256:source-files",
                "milestones/004-server-ingestion-spine.md": "sha256:milestone004",
            },
            anchors=[
                ContextPackAnchor(
                    anchor_id="anchor_source_files",
                    path="source_files",
                    citation="source_files:1",
                    reason="repo path whose final segment matches a forbidden metadata key",
                    start_line=1,
                    end_line=1,
                    source_hash="sha256:source-files",
                )
            ],
            citations=[
                ContextPackCitation(
                    citation_id="citation_source_files",
                    path="source_files",
                    source_hash="sha256:source-files",
                    start_line=1,
                    end_line=1,
                ),
                ContextPackCitation(
                    citation_id="citation_milestone",
                    path="milestones/004-server-ingestion-spine.md",
                    source_hash="sha256:milestone004",
                    start_line=57,
                    end_line=66,
                )
            ],
            inclusions=[
                ContextPackDecision(
                    item_id="source_files",
                    citation="source_files:1",
                    reason="path-only source hash inventory must not be treated as inline source upload",
                )
            ],
        )

        result = ingest(
            IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
            policy=SourceCustodyPolicy.default(),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertTrue(result.accepted, result.errors)
        self.assertEqual(len(telemetry_store.context_pack_metadata), 1)

    def test_context_pack_source_hash_values_cannot_hide_full_source_content(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        smuggled_source = "def upload_everything():\n    return open('agentrail/server/ingestion.py').read()"
        payload = _context_pack_metadata_submission(
            source_hashes={
                "agentrail/server/ingestion.py": smuggled_source,
                "CONTEXT.md": "sha256:context123",
                "milestones/004-server-ingestion-spine.md": "sha256:milestone004",
            },
            anchors=[
                ContextPackAnchor(
                    anchor_id="anchor_ingestion",
                    path="agentrail/server/ingestion.py",
                    citation="agentrail/server/ingestion.py:167",
                    reason="server ingestion contract",
                    start_line=167,
                    end_line=190,
                    source_hash=smuggled_source,
                )
            ],
            citations=[
                ContextPackCitation(
                    citation_id="citation_context",
                    path="CONTEXT.md",
                    source_hash="sha256:context123",
                    start_line=1,
                    end_line=20,
                ),
                ContextPackCitation(
                    citation_id="citation_ingestion",
                    path="agentrail/server/ingestion.py",
                    source_hash=smuggled_source,
                    start_line=167,
                    end_line=190,
                ),
                ContextPackCitation(
                    citation_id="citation_milestone",
                    path="milestones/004-server-ingestion-spine.md",
                    source_hash="sha256:milestone004",
                    start_line=57,
                    end_line=66,
                ),
            ],
        )

        result = ingest(
            IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
            policy=SourceCustodyPolicy.default(),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertFalse(result.accepted)
        self.assertEqual(telemetry_store.records, [])
        self.assertEqual(
            [(error.code, error.field) for error in result.errors],
            [("context_pack_source_hash_invalid", "payload.source_hashes[0].hash")],
        )

    def test_context_pack_source_hash_errors_do_not_echo_rejected_source_paths(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        smuggled_source_path = "def upload_everything(): pass"
        payload = _context_pack_metadata_submission(
            source_hashes={
                smuggled_source_path: "not a hash",
                "agentrail/server/ingestion.py": "sha256:source123",
                "CONTEXT.md": "sha256:context123",
                "milestones/004-server-ingestion-spine.md": "sha256:milestone004",
            },
        )

        result = ingest(
            IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
            policy=SourceCustodyPolicy.default(),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertFalse(result.accepted)
        self.assertEqual(telemetry_store.records, [])
        self.assertEqual(
            [(error.code, error.field) for error in result.errors],
            [
                ("context_pack_source_hash_path_invalid", "payload.source_hashes[0].path"),
                ("context_pack_source_hash_invalid", "payload.source_hashes[0].hash"),
            ],
        )
        self.assertTrue(all(smuggled_source_path not in error.field for error in result.errors))

    def test_context_pack_source_hash_paths_cannot_hide_full_source_content(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        smuggled_source_path = "def upload_everything(): pass"
        payload = _context_pack_metadata_submission(
            source_hashes={
                smuggled_source_path: "sha256:smuggled",
                "agentrail/server/ingestion.py": "sha256:source123",
                "CONTEXT.md": "sha256:context123",
                "milestones/004-server-ingestion-spine.md": "sha256:milestone004",
            },
        )

        result = ingest(
            IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
            policy=SourceCustodyPolicy.default(),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertFalse(result.accepted)
        self.assertEqual(telemetry_store.records, [])
        self.assertEqual(
            [(error.code, error.field) for error in result.errors],
            [("context_pack_source_hash_path_invalid", "payload.source_hashes[0].path")],
        )

    def test_context_pack_source_hash_paths_reject_one_line_source_calls(self) -> None:
        cases = [
            "print(open('agentrail/server/ingestion.py').read())",
            "api_key = 'secret'",
        ]
        for smuggled_source_path in cases:
            with self.subTest(path=smuggled_source_path):
                telemetry_store = InMemoryTelemetryStore()
                payload = _context_pack_metadata_submission(
                    source_hashes={
                        smuggled_source_path: "sha256:smuggled",
                        "agentrail/server/ingestion.py": "sha256:source123",
                        "CONTEXT.md": "sha256:context123",
                        "milestones/004-server-ingestion-spine.md": "sha256:milestone004",
                    },
                )

                result = ingest(
                    IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
                    policy=SourceCustodyPolicy.default(),
                    product_store=FailingProductAuthStore(),
                    telemetry_store=telemetry_store,
                )

                self.assertFalse(result.accepted)
                self.assertEqual(telemetry_store.records, [])
                self.assertEqual(
                    [(error.code, error.field) for error in result.errors],
                    [("context_pack_source_hash_path_invalid", "payload.source_hashes[0].path")],
                )

    def test_context_pack_source_hash_paths_reject_windows_paths_and_traversal(self) -> None:
        cases = [
            r"C:\repo\secret.py",
            "C:/repo/secret.py",
            "C:repo/secret.py",
            "C:",
            r"..\secret.py",
        ]
        for invalid_path in cases:
            with self.subTest(path=invalid_path):
                telemetry_store = InMemoryTelemetryStore()
                payload = _context_pack_metadata_submission(
                    source_hashes={
                        invalid_path: "sha256:invalid",
                        "agentrail/server/ingestion.py": "sha256:source123",
                        "CONTEXT.md": "sha256:context123",
                        "milestones/004-server-ingestion-spine.md": "sha256:milestone004",
                    },
                )

                result = ingest(
                    IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
                    policy=SourceCustodyPolicy.default(),
                    product_store=FailingProductAuthStore(),
                    telemetry_store=telemetry_store,
                )

                self.assertFalse(result.accepted)
                self.assertEqual(telemetry_store.records, [])
                self.assertEqual(
                    [(error.code, error.field) for error in result.errors],
                    [("context_pack_source_hash_path_invalid", "payload.source_hashes[0].path")],
                )

    def test_context_pack_source_hash_paths_accept_local_indexer_paths(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        spaced_path = "docs/Architecture Decision.md"
        unicode_path = "docs/cafe-notes-é.md"
        redacted_path = "docs/[REDACTED:secret_assignment]-notes.md"
        package_path = "package.json"
        public_path = "public/index.html"
        private_path = "private/config.py"
        parenthesized_doc_path = "docs/Architecture (final).md"
        parenthesized_fixture_path = "fixtures/foo(bar).json"
        payload = _context_pack_metadata_submission(
            source_hashes={
                spaced_path: "sha256:architecture",
                unicode_path: "sha256:unicode",
                redacted_path: "sha256:redacted",
                package_path: "sha256:package",
                public_path: "sha256:public",
                private_path: "sha256:private",
                parenthesized_doc_path: "sha256:parenthesized-doc",
                parenthesized_fixture_path: "sha256:parenthesized-fixture",
                "milestones/004-server-ingestion-spine.md": "sha256:milestone004",
            },
            anchors=[
                ContextPackAnchor(
                    anchor_id="anchor_architecture",
                    path=spaced_path,
                    citation=f"{spaced_path}:1",
                    reason="local indexer emits raw relative paths",
                    start_line=1,
                    end_line=1,
                    source_hash="sha256:architecture",
                ),
                ContextPackAnchor(
                    anchor_id="anchor_unicode",
                    path=unicode_path,
                    citation=f"{unicode_path}:2",
                    reason="local indexer paths may include non-ascii characters",
                    start_line=2,
                    end_line=2,
                    source_hash="sha256:unicode",
                ),
                ContextPackAnchor(
                    anchor_id="anchor_redacted",
                    path=redacted_path,
                    citation=f"{redacted_path}:3",
                    reason="redacted descriptor paths may include bracketed tokens",
                    start_line=3,
                    end_line=3,
                    source_hash="sha256:redacted",
                ),
                ContextPackAnchor(
                    anchor_id="anchor_package",
                    path=package_path,
                    citation=f"{package_path}:4",
                    reason="root package files are valid local indexer paths",
                    start_line=4,
                    end_line=4,
                    source_hash="sha256:package",
                ),
                ContextPackAnchor(
                    anchor_id="anchor_public",
                    path=public_path,
                    citation=f"{public_path}:5",
                    reason="public folders are valid local indexer paths",
                    start_line=5,
                    end_line=5,
                    source_hash="sha256:public",
                ),
                ContextPackAnchor(
                    anchor_id="anchor_private",
                    path=private_path,
                    citation=f"{private_path}:6",
                    reason="private folders are valid local indexer paths",
                    start_line=6,
                    end_line=6,
                    source_hash="sha256:private",
                ),
                ContextPackAnchor(
                    anchor_id="anchor_parenthesized_doc",
                    path=parenthesized_doc_path,
                    citation=f"{parenthesized_doc_path}:7",
                    reason="parentheses in filenames are valid local indexer paths",
                    start_line=7,
                    end_line=7,
                    source_hash="sha256:parenthesized-doc",
                ),
                ContextPackAnchor(
                    anchor_id="anchor_parenthesized_fixture",
                    path=parenthesized_fixture_path,
                    citation=f"{parenthesized_fixture_path}:8",
                    reason="parentheses in fixture filenames are valid local indexer paths",
                    start_line=8,
                    end_line=8,
                    source_hash="sha256:parenthesized-fixture",
                ),
            ],
            citations=[
                ContextPackCitation(
                    citation_id="citation_architecture",
                    path=spaced_path,
                    source_hash="sha256:architecture",
                    start_line=1,
                    end_line=1,
                ),
                ContextPackCitation(
                    citation_id="citation_unicode",
                    path=unicode_path,
                    source_hash="sha256:unicode",
                    start_line=2,
                    end_line=2,
                ),
                ContextPackCitation(
                    citation_id="citation_redacted",
                    path=redacted_path,
                    source_hash="sha256:redacted",
                    start_line=3,
                    end_line=3,
                ),
                ContextPackCitation(
                    citation_id="citation_package",
                    path=package_path,
                    source_hash="sha256:package",
                    start_line=4,
                    end_line=4,
                ),
                ContextPackCitation(
                    citation_id="citation_public",
                    path=public_path,
                    source_hash="sha256:public",
                    start_line=5,
                    end_line=5,
                ),
                ContextPackCitation(
                    citation_id="citation_private",
                    path=private_path,
                    source_hash="sha256:private",
                    start_line=6,
                    end_line=6,
                ),
                ContextPackCitation(
                    citation_id="citation_parenthesized_doc",
                    path=parenthesized_doc_path,
                    source_hash="sha256:parenthesized-doc",
                    start_line=7,
                    end_line=7,
                ),
                ContextPackCitation(
                    citation_id="citation_parenthesized_fixture",
                    path=parenthesized_fixture_path,
                    source_hash="sha256:parenthesized-fixture",
                    start_line=8,
                    end_line=8,
                ),
                ContextPackCitation(
                    citation_id="citation_milestone",
                    path="milestones/004-server-ingestion-spine.md",
                    source_hash="sha256:milestone004",
                    start_line=57,
                    end_line=66,
                ),
            ],
            inclusions=[
                ContextPackDecision(
                    item_id="architecture",
                    citation=f"{spaced_path}:1",
                    reason="valid path with space must ingest",
                ),
                ContextPackDecision(
                    item_id="unicode",
                    citation=f"{unicode_path}:2",
                    reason="valid path with non-ascii must ingest",
                ),
                ContextPackDecision(
                    item_id="redacted",
                    citation=f"{redacted_path}:3",
                    reason="valid path with bracketed token must ingest",
                ),
                ContextPackDecision(
                    item_id="package",
                    citation=f"{package_path}:4",
                    reason="valid root package path must ingest",
                ),
                ContextPackDecision(
                    item_id="public",
                    citation=f"{public_path}:5",
                    reason="valid public path must ingest",
                ),
                ContextPackDecision(
                    item_id="private",
                    citation=f"{private_path}:6",
                    reason="valid private path must ingest",
                ),
                ContextPackDecision(
                    item_id="parenthesized-doc",
                    citation=f"{parenthesized_doc_path}:7",
                    reason="valid parenthesized doc path must ingest",
                ),
                ContextPackDecision(
                    item_id="parenthesized-fixture",
                    citation=f"{parenthesized_fixture_path}:8",
                    reason="valid parenthesized fixture path must ingest",
                ),
            ],
        )

        result = ingest(
            IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
            policy=SourceCustodyPolicy.default(),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertTrue(result.accepted, result.errors)
        self.assertEqual(len(telemetry_store.context_pack_metadata), 1)

    def test_context_pack_allowed_bounded_snippets_must_use_source_inventory_paths(self) -> None:
        cases = [
            (
                "def secret(): pass",
                "context_pack_bounded_snippet_path_invalid",
            ),
            (
                "secret.py",
                "context_pack_bounded_snippet_path_not_in_inventory",
            ),
        ]
        for snippet_path, expected_code in cases:
            with self.subTest(snippet_path=snippet_path):
                telemetry_store = InMemoryTelemetryStore()
                payload = _context_pack_metadata_submission(
                    bounded_snippets=[
                        BoundedSnippet(
                            path=snippet_path,
                            citation=f"{snippet_path}:1",
                            start_line=1,
                            end_line=1,
                            content="print('bounded')",
                            content_hash="sha256:snippet123",
                        )
                    ]
                )

                result = ingest(
                    IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
                    policy=SourceCustodyPolicy(
                        mode="bounded_snippets",
                        allow_bounded_snippets=True,
                        max_snippet_chars=120,
                    ),
                    product_store=FailingProductAuthStore(),
                    telemetry_store=telemetry_store,
                )

                self.assertFalse(result.accepted)
                self.assertEqual(telemetry_store.records, [])
                self.assertEqual(
                    [(error.code, error.field) for error in result.errors],
                    [(expected_code, "payload.bounded_snippets[0].path")],
                )

    def test_context_pack_citations_preserve_literal_hashes_and_colons_in_paths(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        hash_path = "docs/foo#bar.md"
        hash_line_marker_path = "docs/foo#L1.md"
        colon_path = "docs/[REDACTED:secret]-notes.md"
        colon_digits_path = "docs/foo:123"
        payload = _context_pack_metadata_submission(
            source_hashes={
                hash_path: "sha256:hash-path",
                hash_line_marker_path: "sha256:hash-line-marker-path",
                colon_path: "sha256:colon-path",
                colon_digits_path: "sha256:colon-digits-path",
                "milestones/004-server-ingestion-spine.md": "sha256:milestone004",
            },
            anchors=[
                ContextPackAnchor(
                    anchor_id="anchor_hash",
                    path=hash_path,
                    citation=f"{hash_path}:1",
                    reason="hash characters may be literal path characters before line suffixes",
                    start_line=1,
                    end_line=1,
                    source_hash="sha256:hash-path",
                ),
                ContextPackAnchor(
                    anchor_id="anchor_hash_line_marker",
                    path=hash_line_marker_path,
                    citation=hash_line_marker_path,
                    reason="hash line marker text may be part of a literal path",
                    source_hash="sha256:hash-line-marker-path",
                ),
                ContextPackAnchor(
                    anchor_id="anchor_colon",
                    path=colon_path,
                    citation=colon_path,
                    reason="colon characters may be literal path characters without numeric line suffixes",
                    source_hash="sha256:colon-path",
                ),
                ContextPackAnchor(
                    anchor_id="anchor_colon_digits",
                    path=colon_digits_path,
                    citation=colon_digits_path,
                    reason="colon digit suffixes may be part of a literal path",
                    source_hash="sha256:colon-digits-path",
                ),
            ],
            citations=[
                ContextPackCitation(
                    citation_id="citation_hash",
                    path=hash_path,
                    source_hash="sha256:hash-path",
                    start_line=1,
                    end_line=1,
                ),
                ContextPackCitation(
                    citation_id="citation_hash_line_marker",
                    path=hash_line_marker_path,
                    source_hash="sha256:hash-line-marker-path",
                    start_line=1,
                    end_line=1,
                ),
                ContextPackCitation(
                    citation_id="citation_colon",
                    path=colon_path,
                    source_hash="sha256:colon-path",
                ),
                ContextPackCitation(
                    citation_id="citation_colon_digits",
                    path=colon_digits_path,
                    source_hash="sha256:colon-digits-path",
                ),
                ContextPackCitation(
                    citation_id="citation_milestone",
                    path="milestones/004-server-ingestion-spine.md",
                    source_hash="sha256:milestone004",
                    start_line=57,
                    end_line=66,
                ),
            ],
            inclusions=[
                ContextPackDecision(
                    item_id="hash-path",
                    citation=f"{hash_path}:1",
                    reason="literal hash path with numeric line suffix must resolve",
                ),
                ContextPackDecision(
                    item_id="hash-line-marker-path",
                    citation=f"{hash_line_marker_path}:1",
                    reason="literal hash line marker path must resolve before colon line suffixes",
                ),
                ContextPackDecision(
                    item_id="colon-path",
                    citation=colon_path,
                    reason="literal colon path without numeric line suffix must resolve",
                ),
                ContextPackDecision(
                    item_id="colon-digits-path",
                    citation=colon_digits_path,
                    reason="literal colon digit path must resolve exactly",
                ),
            ],
        )

        result = ingest(
            IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
            policy=SourceCustodyPolicy.default(),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertTrue(result.accepted, result.errors)
        self.assertEqual(len(telemetry_store.context_pack_metadata), 1)

    def test_context_pack_decisions_resolve_numeric_citation_ids_before_path_parsing(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        payload = _context_pack_metadata_submission(
            citations=[
                ContextPackCitation(
                    citation_id="citation:1",
                    path="agentrail/server/ingestion.py",
                    source_hash="sha256:source123",
                    start_line=167,
                    end_line=190,
                ),
                ContextPackCitation(
                    citation_id="chunk:42",
                    path="CONTEXT.md",
                    source_hash="sha256:context123",
                    start_line=1,
                    end_line=20,
                ),
                ContextPackCitation(
                    citation_id="citation_milestone",
                    path="milestones/004-server-ingestion-spine.md",
                    source_hash="sha256:milestone004",
                    start_line=57,
                    end_line=66,
                ),
            ],
            inclusions=[
                ContextPackDecision(
                    item_id="citation-id",
                    citation="citation:1",
                    reason="citation ids may contain numeric namespaces",
                ),
                ContextPackDecision(
                    item_id="chunk-id",
                    citation="chunk:42",
                    reason="chunk ids may contain numeric namespaces",
                ),
            ],
        )

        result = ingest(
            IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
            policy=SourceCustodyPolicy.default(),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertTrue(result.accepted, result.errors)
        self.assertEqual(len(telemetry_store.context_pack_metadata), 1)

    def test_context_pack_citation_inventory_ranges_must_be_valid(self) -> None:
        cases = [
            ContextPackCitation(
                citation_id="citation_ingestion",
                path="agentrail/server/ingestion.py",
                source_hash="sha256:source123",
                start_line=0,
                end_line=1,
            ),
            ContextPackCitation(
                citation_id="citation_ingestion",
                path="agentrail/server/ingestion.py",
                source_hash="sha256:source123",
                start_line=190,
                end_line=167,
            ),
            ContextPackCitation(
                citation_id="citation_ingestion",
                path="agentrail/server/ingestion.py",
                source_hash="sha256:source123",
                end_line=167,
            ),
        ]
        for citation in cases:
            with self.subTest(citation=citation):
                telemetry_store = InMemoryTelemetryStore()
                payload = _context_pack_metadata_submission(
                    citations=[
                        citation,
                        ContextPackCitation(
                            citation_id="citation_milestone",
                            path="milestones/004-server-ingestion-spine.md",
                            source_hash="sha256:milestone004",
                            start_line=57,
                            end_line=66,
                        ),
                    ]
                )

                result = ingest(
                    IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
                    policy=SourceCustodyPolicy.default(),
                    product_store=FailingProductAuthStore(),
                    telemetry_store=telemetry_store,
                )

                self.assertFalse(result.accepted)
                self.assertEqual(telemetry_store.records, [])
                self.assertEqual(result.errors[0].code, "context_pack_citation_line_range_invalid")

    def test_context_pack_anchor_ranges_must_be_valid(self) -> None:
        cases = [
            ContextPackAnchor(
                anchor_id="anchor_ingestion",
                path="agentrail/server/ingestion.py",
                citation="agentrail/server/ingestion.py",
                reason="line ranges must be valid",
                start_line=0,
                end_line=1,
                source_hash="sha256:source123",
            ),
            ContextPackAnchor(
                anchor_id="anchor_ingestion",
                path="agentrail/server/ingestion.py",
                citation="agentrail/server/ingestion.py",
                reason="line ranges must be valid",
                start_line=190,
                end_line=167,
                source_hash="sha256:source123",
            ),
            ContextPackAnchor(
                anchor_id="anchor_ingestion",
                path="agentrail/server/ingestion.py",
                citation="agentrail/server/ingestion.py",
                reason="line ranges must be valid",
                end_line=167,
                source_hash="sha256:source123",
            ),
        ]
        for anchor in cases:
            with self.subTest(anchor=anchor):
                telemetry_store = InMemoryTelemetryStore()
                payload = _context_pack_metadata_submission(anchors=[anchor])

                result = ingest(
                    IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
                    policy=SourceCustodyPolicy.default(),
                    product_store=FailingProductAuthStore(),
                    telemetry_store=telemetry_store,
                )

                self.assertFalse(result.accepted)
                self.assertEqual(telemetry_store.records, [])
                self.assertEqual(result.errors[0].code, "context_pack_anchor_line_range_invalid")

    def test_context_pack_bounded_snippets_are_denied_by_default(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        payload = _context_pack_metadata_submission(
            bounded_snippets=[
                BoundedSnippet(
                    path="agentrail/server/ingestion.py",
                    citation="agentrail/server/ingestion.py:167",
                    start_line=167,
                    end_line=170,
                    content="@dataclass(frozen=True)\nclass ContextPackMetadataSubmission:\n    ...",
                    content_hash="sha256:snippet123",
                )
            ]
        )

        result = ingest(
            IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
            policy=SourceCustodyPolicy.default(),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertFalse(result.accepted)
        self.assertEqual(telemetry_store.records, [])
        self.assertEqual(result.errors[0].code, "bounded_snippet_not_allowed")
        self.assertEqual(result.errors[0].field, "payload.bounded_snippets")

    def test_context_pack_bounded_snippets_are_accepted_when_policy_allows_them(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        snippet = BoundedSnippet(
            path="agentrail/server/ingestion.py",
            citation="agentrail/server/ingestion.py:167",
            start_line=167,
            end_line=170,
            content="@dataclass(frozen=True)\nclass ContextPackMetadataSubmission:\n    ...",
            content_hash="sha256:snippet123",
        )
        payload = _context_pack_metadata_submission(bounded_snippets=[snippet])

        result = ingest(
            IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
            policy=SourceCustodyPolicy(
                mode="bounded_snippets",
                allow_bounded_snippets=True,
                max_snippet_chars=120,
            ),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertTrue(result.accepted, result.errors)
        self.assertEqual(telemetry_store.context_pack_metadata[0].bounded_snippets, [snippet])

    def test_context_pack_allowed_bounded_snippets_require_path_and_hash(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        payload = _context_pack_metadata_submission(
            bounded_snippets=[
                BoundedSnippet(
                    path="",
                    citation="agentrail/server/ingestion.py:167",
                    start_line=167,
                    end_line=170,
                    content="@dataclass(frozen=True)\nclass ContextPackMetadataSubmission:\n    ...",
                    content_hash="",
                )
            ]
        )

        result = ingest(
            IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
            policy=SourceCustodyPolicy(
                mode="bounded_snippets",
                allow_bounded_snippets=True,
                max_snippet_chars=120,
            ),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertFalse(result.accepted)
        self.assertEqual(telemetry_store.records, [])
        self.assertEqual(
            [(error.code, error.field) for error in result.errors],
            [
                ("bounded_snippet_missing_path", "payload.bounded_snippets[0].path"),
                ("bounded_snippet_missing_content_hash", "payload.bounded_snippets[0].content_hash"),
            ],
        )

    def test_context_pack_artifact_reference_must_point_to_object_storage(self) -> None:
        telemetry_store = InMemoryTelemetryStore()

        result = ingest(
            IngestionEnvelope(
                workspace_id="workspace_123",
                repository_id="repo_123",
                payload=_context_pack_metadata_submission(artifact_ref="https://cdn.example.com/context-pack.json"),
            ),
            policy=SourceCustodyPolicy.default(),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertFalse(result.accepted)
        self.assertEqual(telemetry_store.records, [])
        self.assertEqual(result.errors[0].code, "context_pack_artifact_ref_not_object_ref")
        self.assertEqual(result.errors[0].field, "payload.artifact_ref")

    def test_context_pack_citation_artifact_reference_must_point_to_object_storage(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        payload = _context_pack_metadata_submission(
            citations=[
                ContextPackCitation(
                    citation_id="citation_context",
                    path="CONTEXT.md",
                    source_hash="sha256:context123",
                    artifact_ref="https://cdn.example.com/context-citation.json",
                )
            ]
        )

        result = ingest(
            IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
            policy=SourceCustodyPolicy.default(),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertFalse(result.accepted)
        self.assertEqual(telemetry_store.records, [])
        self.assertEqual(result.errors[0].code, "context_pack_citation_artifact_ref_not_object_ref")
        self.assertEqual(result.errors[0].field, "payload.citations[0].artifact_ref")


def _context_pack_metadata_submission(
    *,
    metadata: dict[str, object] | None = None,
    source_hashes: dict[str, str] | None = None,
    anchors: list[ContextPackAnchor] | None = None,
    citations: list[ContextPackCitation] | None = None,
    inclusions: list[ContextPackDecision] | None = None,
    exclusions: list[ContextPackDecision] | None = None,
    bounded_snippets: list[BoundedSnippet] | None = None,
    artifact_ref: str = "object://context-packs/pack_138.json",
) -> ContextPackMetadataSubmission:
    return ContextPackMetadataSubmission(
        context_pack_id="pack_138",
        workspace_id="workspace_123",
        repository_id="repo_123",
        run_id="run_138",
        pull_request_id=None,
        target_kind="issue",
        target_id="138",
        content_hash="sha256:pack138",
        source_hashes=source_hashes
        or {
            "agentrail/server/ingestion.py": "sha256:source123",
            "CONTEXT.md": "sha256:context123",
            "milestones/004-server-ingestion-spine.md": "sha256:milestone004",
        },
        anchors=anchors or [
            ContextPackAnchor(
                anchor_id="anchor_ingestion",
                path="agentrail/server/ingestion.py",
                citation="agentrail/server/ingestion.py:167",
                reason="server ingestion contract",
                start_line=167,
                end_line=190,
                source_hash="sha256:source123",
            )
        ],
        citations=citations or [
            ContextPackCitation(
                citation_id="citation_context",
                path="CONTEXT.md",
                source_hash="sha256:context123",
                start_line=1,
                end_line=20,
            ),
            ContextPackCitation(
                citation_id="citation_ingestion",
                path="agentrail/server/ingestion.py",
                source_hash="sha256:source123",
                start_line=167,
                end_line=190,
            ),
            ContextPackCitation(
                citation_id="citation_milestone",
                path="milestones/004-server-ingestion-spine.md",
                source_hash="sha256:milestone004",
                start_line=57,
                end_line=66,
            )
        ],
        inclusions=inclusions or [
            ContextPackDecision(
                item_id="agentrail/server/ingestion.py",
                citation="agentrail/server/ingestion.py:167",
                reason="defines context-pack metadata ingestion",
            )
        ],
        exclusions=exclusions or [
            ContextPackDecision(
                item_id="agent-operations-console",
                citation="milestones/004-server-ingestion-spine.md:66",
                reason="console UI is out of scope",
            )
        ],
        budgets=ContextPackBudget(
            max_input_tokens=12000,
            used_input_tokens=3900,
            max_output_tokens=2000,
        ),
        quality_metrics=ContextPackQualityMetrics(
            required_source_coverage=1.0,
            citation_coverage=1.0,
            stale_or_denied_leakage=0,
            precision_at_budget=0.92,
        ),
        artifact_ref=artifact_ref,
        bounded_snippets=bounded_snippets or [],
        metadata=metadata or {"phase": "execute"},
    )


if __name__ == "__main__":
    unittest.main()
