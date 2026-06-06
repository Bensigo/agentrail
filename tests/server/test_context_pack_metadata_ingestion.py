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
                end_line=57,
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
