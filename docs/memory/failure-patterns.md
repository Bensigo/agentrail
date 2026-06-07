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

## Duplicate scoring formulas create silent drift when constants are tuned

- kind: failure-pattern
- source: PR #158 review P3 finding: _pre_bm25_scores at retrieval.py:398 duplicates BM25 formula from main scorer at :498 with hardcoded k1/b constants
- confidence: verified
- created_at: 2026-06-07
- expires_at:

When implementing a pre-scoring pass that mirrors an existing scorer, extract the shared formula into a helper rather than inlining the constants twice. If k1 or b are later tuned in one copy, seeds and final scores diverge without any test catching it.
