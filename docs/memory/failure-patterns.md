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

## Seeding/propagation tests must assert populated output, not only field presence

- kind: failure-pattern
- source: PR #158 review P2 finding: test_graph_expansion_seeds_from_retrieval_candidates only checked field existence, not that BM25 actually populated the seeds list
- confidence: verified
- created_at: 2026-06-07
- expires_at:

When testing a pipeline stage that feeds data into a downstream stage (e.g., BM25 retrieval seeds seeding graph expansion), assert that the output list contains the expected value — not just that the field exists and is the right type. A test that passes on an empty list does not prove the feature works.

## Protocol write() methods that reference types from a circular-import module need TYPE_CHECKING guard imports

- kind: failure-pattern
- source: PR #163 review: ProductAuthStore and TelemetryStore Protocol methods reference IngestionEnvelope without importing it, breaking static type analysis
- confidence: verified
- created_at: 2026-06-07
- expires_at:

When defining Protocol classes in modules that would create a circular import if the referenced type were imported at the top level, use a TYPE_CHECKING guard so the annotation is resolvable by static type checkers without affecting the runtime import graph:

    from typing import TYPE_CHECKING
    if TYPE_CHECKING:
        from agentrail.server.ingestion import IngestionEnvelope

Omitting this means the Protocol's method signatures cannot be verified by mypy/pyright, negating the type-safety benefit of introducing Protocol abstractions.

## Assertion-only tests that check field presence or type without checking content pass even when the feature produces no meaningful results

- kind: failure-pattern
- source: PR #158 P2 finding and follow-up PR #164 / issue #161: test_graph_expansion_seeds_from_retrieval_candidates checked assertIsInstance(seeds, list) but not that expected paths appeared in the list, allowing the BM25 seeding path to silently produce empty results
- confidence: verified
- created_at: 2026-06-07
- expires_at:

When writing tests that verify retrieval or seeding behavior, always assert the content of the result (e.g., that an expected path or item appears in the list), not just the presence of the field or its type. An empty list is a valid list — a type-only assertion cannot distinguish a working retrieval path from a broken one. See PR #164 / issue #161 for a concrete example.

## Closing keywords do not auto-close issues when PR base is not the default branch

- kind: failure-pattern
- source: PR #169 review finding P2: closingIssuesReferences empty despite 'Closes #166' in body because base branch is not main
- confidence: verified
- created_at: 2026-06-07
- expires_at:

When a fix PR targets a feature branch (not the default branch), GitHub 'Closes #N' keywords have no effect. The closingIssuesReferences API field will be empty. AFK workflows must manually close the linked issue after such PRs merge, or confirm closure by polling the issue state rather than relying on the merge event.

## TYPE_CHECKING fix ACs must be verified with a type-checker invocation, not just runtime tests

- kind: failure-pattern
- source: PR #173 review: issue #167 AC verification gap
- confidence: verified
- created_at: 2026-06-07
- expires_at:

When a fix is specifically for a static type-checker error (e.g. undefined name under TYPE_CHECKING guard), the PR verification must include actual type-checker output (mypy or pyright command + result). Runtime import tests and pytest only confirm no circular import at runtime — they do not confirm the type-checker error is resolved. Always run `python3 -m mypy <file> --ignore-missing-imports` or `pyright <file>` and include the output as verification evidence.

## Show full command output in verification sections, not just the command

- kind: failure-pattern
- source: PR #179 review finding P3: unfiltered mypy command shown without its output
- confidence: verified
- created_at: 2026-06-08
- expires_at:

When adding verification evidence to a PR body, always include the actual command output, not just the command. Showing a command without output forces reviewers to trust implicit claims (e.g. 'remaining errors are only union-attr') rather than verifying them from the PR body. If the raw output is noisy, grep for the relevant error codes and show the summary line.

## AFK memory-suggestion workflow can create duplicate issues from the same source finding

- kind: failure-pattern
- source: PR #177 review: issues #162 and #165 both derived from PR #158 P2 finding on test_graph_expansion_seeds_from_retrieval_candidates; both were implemented independently, producing near-duplicate entries in failure-patterns.md
- confidence: verified
- created_at: 2026-06-08
- expires_at:

When the AFK workflow creates a memory-suggestion issue, check whether an existing open or recently-closed issue already targets the same source finding before creating a new one. Before implementing a memory-suggestion issue, search failure-patterns.md for entries citing the same source PR/test. If a broader or equivalent entry already exists, close the issue as superseded rather than adding a duplicate. See PR #177 vs commit 157636a (issue #165) for a concrete example.
