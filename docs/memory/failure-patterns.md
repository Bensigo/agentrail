# Failure Patterns

Recurring ways agents, automation, tests, deployments, or product workflows fail in this project.

Keep entries concrete: what failed, how to detect it, and what future agents should do differently.

## High-volume tests that claim to cover all event kinds should list all kinds or explicitly document the subset

- kind: failure-pattern
- source: PR #152 review: high-volume test covers 4 of 6 event kinds without documenting the omission in the test name or comment
- confidence: verified
- created_at: 2026-06-07
- expires_at:

When writing high-volume ingestion tests that are mapped to an acceptance criterion about 'all event kinds', either include all kinds in the loop or add a comment explaining the intentional subset. This prevents future reviewers from flagging incomplete coverage.

## Test the QueuedIngestionPipeline unknown-kind rejection path directly, not only the BatchWriter equivalent

- kind: failure-pattern
- source: PR #151 review — P3 finding: accept() unknown-kind guard at queue.py:154-163 is untested while the analogous BatchWriter path is tested
- confidence: verified
- created_at: 2026-06-07
- expires_at:

When a pipeline has a pre-enqueue validation guard that mirrors a writer-level guard, both paths need independent tests. Testing only the writer-level path leaves the pipeline guard uncovered and creates a false sense of full coverage.

## Assertion-only tests that check field presence or type without checking content pass even when the feature produces no meaningful results

- kind: failure-pattern
- source: PR #158 P2 finding and follow-up PR #164 / issue #161: test_graph_expansion_seeds_from_retrieval_candidates checked assertIsInstance(seeds, list) but not that expected paths appeared in the list, allowing the BM25 seeding path to silently produce empty results
- confidence: verified
- created_at: 2026-06-07
- expires_at:

When writing tests that verify retrieval or seeding behavior, always assert the content of the result (e.g., that an expected path or item appears in the list), not just the presence of the field or its type. An empty list is a valid list — a type-only assertion cannot distinguish a working retrieval path from a broken one. See PR #164 / issue #161 for a concrete example.
