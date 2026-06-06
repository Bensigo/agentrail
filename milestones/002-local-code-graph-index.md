# Milestone 002: Local Code Graph Index

Status: Completed

## Source PRD

docs/prd/context-compiler-enterprise-control-plane.md

## Outcome

The Local Indexer extracts deterministic Code Graph data from repositories, including Codebase Units, files, symbols, imports, tests, commit SHAs, hashes, and graph edges.

## Users

- Context-engine maintainer
- Developer relying on relationship-aware context
- Enterprise security owner validating local-first indexing

## Vertical Scope

This milestone may touch:

- Domain logic: Codebase Unit detection, graph node and edge extraction, symbol/import/test relationships.
- Data/storage: local index artifacts for graph nodes, graph edges, commit SHAs, source hashes, and freshness metadata.
- Integrations/jobs: git metadata and local parsing.
- Tests: fixtures for monorepo-style, single-package, and weak-manifest repositories.
- Docs/config: local indexing contract and Codebase Unit detection behavior.

## Acceptance Criteria

- [x] Local indexing emits graph nodes and edges for files, symbols, imports, tests, and Codebase Units.
- [x] Index snapshots include commit SHA, source hashes, freshness metadata, and ingestion health.
- [x] Codebase Unit detection works with zero config and can be overridden by config.
- [x] LLM-generated graph enrichment is not treated as authoritative graph data.
- [x] Tests cover at least one monorepo-style fixture, one simple repo fixture, and one weak-manifest fixture.

## Test Plan

- Run `bash scripts/test-python`.
- Run `bash scripts/test-context-index`.
- Run `bash scripts/test-context-sources`.
- Add graph-index fixture tests for Codebase Units, symbols, imports, tests, and commit metadata.

## Likely Issue Slices

- Add graph node and edge models to local index artifacts.
- Detect Codebase Units from common manifests and fallback heuristics.
- Extract deterministic symbols and import edges.
- Infer test-to-source relationships from paths/imports.
- Add index snapshot metadata and graph fixture tests.

## Blocked By

Milestone 001: Context Compiler Contract.

## Notes

Prefer deterministic, inspectable extraction over broad LLM inference. Language support can start narrow, but the schema must not assume one ecosystem.

Completion evidence:

- `agentrail/context/index.py` emits `code-graph-v1` nodes and edges for Codebase Units, files, chunks, symbols, imports, tests, and test-source relationships.
- Index snapshots include commit SHA, source hashes, freshness, source custody, and ingestion health metadata.
- Graph authority is deterministic; LLM-generated enrichment is explicitly non-authoritative.
- `bash scripts/test-python` and `bash scripts/test-context-index` pass, including monorepo, simple repo, weak-manifest, and config override coverage.
