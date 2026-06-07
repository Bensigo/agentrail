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

## Seeding/propagation tests must assert populated output, not only field presence

- kind: failure-pattern
- source: PR #158 review P2 finding: test_graph_expansion_seeds_from_retrieval_candidates only checked field existence, not that BM25 actually populated the seeds list
- confidence: verified
- created_at: 2026-06-07
- expires_at:

When testing a pipeline stage that feeds data into a downstream stage (e.g., BM25 retrieval seeds seeding graph expansion), assert that the output list contains the expected value — not just that the field exists and is the right type. A test that passes on an empty list does not prove the feature works.
