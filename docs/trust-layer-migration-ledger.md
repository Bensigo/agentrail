# Jace trust-layer migration ledger

Last reconciled: 2026-08-06. Canonical product decision: [ADR 0012](adr/0012-jace-owns-the-acceptance-spine.md).

## Canonical MVP flow

1. A task starts in Codex, Claude Code, Slack, Discord, or another supported
   channel and becomes one Acceptance Record carrying origin provenance.
2. Jace asks only unresolved questions in the originating channel where that
   integration supports it, drafts an Acceptance Contract, and a human
   confirms it.
3. Jace creates a bounded, versioned, cited Context Pack. It contains only
   acceptance criteria, relevant source ranges, architecture/repository
   boundaries, tests, decisions, exclusions, freshness/provenance, and an
   explicit token budget. Durable intent belongs to the Record, not a growing
   chat. Side agents return compact cited findings to the Record and cannot
   become an unbounded context source.
4. A human selects an external builder. Jace records the builder task context,
   repository, planned branch, confirmed contract, and selected pack; the
   builder implements without Jace silently changing code.
5. A PR is attached manually or correlated only from that exact recorded
   handoff. Its repository, PR number, exact head, and revisions are durable.
6. For every criterion, Jace plans the strongest safe proof for the available
   environment: browser interaction/artifact for UI; redacted request-response
   evidence for API; trigger plus bounded output/log/artifact for jobs;
   authorized readback/assertion for data/integrations; otherwise
   `not_testable`/`not_proven`. Every proof is bound to the PR head/environment.
7. Jace emits a blocker only for a required code change grounded in the
   contract, architecture boundary, enforced convention, or concrete risk.
   It includes evidence, impact, correction, and criterion-specific recheck.
8. A correction goes to the builder task context when supported, otherwise a
   durable GitHub/Jace fallback. Delivery attempts and acknowledgement are
   recorded; no claimed notification or resume without acknowledgement.
9. Human decides the PR outcome. Jace never auto-merges.

## Implemented and objectively checked foundations

| Slice | Commits | Evidence |
| --- | --- | --- |
| Record, immutable contract draft, human confirmation | `8bc3a80c` through `0ec7d2e6` | focused console route/contract tests; contract parser |
| Metadata-only context-pack record and MCP read surface | `989e3b7c` through `a4f7b8cc` | Python context-pack tests and focused console tests |
| Dedicated scoped agent-MCP credentials | `2b179526`, `c27b6564` | focused bearer/API/MCP tests and package typecheck |
| Manual connected-repository PR attachment and immutable head revisions | `93efb0a3` | focused attachment route tests |
| Independent criterion review validation and generic-smoke rejection | `78f92fc4` through `1034f42e` | `evidence-review-validation` and runner completion tests |
| Correction delivery acknowledgement seam | `429eb1a2` | focused MCP acknowledgement tests |

The active uncommitted slice adds durable correction-packet fields and a
pre-PR builder-handoff table. It has not yet passed verification or been
committed; do not treat it as delivered.

## Remaining work, in dependency order

1. Complete and test builder handoff; use it in GitHub webhook correlation;
   remove unlinked advisory review admission.
2. Add review-bound artifact storage and a verification-plan model. Build a
   worker that executes criterion-specific modality plans in a safe exact-head
   environment; API evidence must redact secrets/sensitive fields.
3. Add correction-delivery queue/dispatch/readback for supported MCP task
   contexts and durable GitHub/Jace fallback, retaining attempt/outcome and
   acknowledgement.
4. Implement supported channel intake, missing-question replies, human
   confirmation, and Context Pack handoff. Slack/Discord are not implemented
   merely because their names appear in this document.
5. Add human PR outcome, dependency-upgrade acceptance flow, Console removal
   of obsolete factory/advisory surfaces, and copy-only landing pivot.
6. Migrate a clean database, run full targeted suites, then browser/E2E proof
   against a live safe preview. No migration, delivery channel, or UI is live
   verified yet.

## Non-goals

- Building a replacement coding agent, code factory, or automatic merge lane.
- Advisory/random/style review. Style is a blocker only when an explicit
  enforced convention or approved architecture rule is violated.
- Generic page-load checks presented as behavioral proof.
- Whole-repository or chat-history prompt dumps.

## Unverified assumptions and current boundaries

- No Codex/Claude live pickup, Slack/Discord runtime integration, GitHub
  canonical PR fetch, context compiler attestation, evidence-exercise worker,
  browser proof, live delivery dispatch, or migration smoke exists yet.
- Worktree: `/Users/macbook/work/bensigo-ai-workflow-trust-record` on
  `codex/trust-layer-acceptance-record`, based at local commit `3c1d251e`
  before the active uncommitted slice. Preserve the shared dirty checkout at
  `/Users/macbook/work/bensigo-ai-workflow` and generated ignored dependency
  directories in this worktree.
- This ledger is the implementation checkpoint. Re-read it and ADR 0012
  before each substantial slice; current code and tests outrank a side audit.

## Delegation policy

The main agent is the coordinator: it owns scope decisions, architecture
synthesis, ledger maintenance, integration/rejection of returned diffs, and
cross-slice verification. By default, a short-lived smaller subagent owns one
bounded implementation slice with explicit acceptance criteria, write paths,
and tests. Main-agent edits are limited to tiny glue that cannot be separated
safely. No two agents may edit overlapping paths.

A read-only audit is permitted only for one bounded independent question whose
answer can be returned as compact evidence without the full migration history.
Every delegation names its question or implementation slice, allowed sources or
write paths, decision value, acceptance criteria, and stop condition. A side
audit returns only established facts with sources, contradictions, and a
recommendation; the coordinator independently verifies it before integration.
An implementation agent must list changed files and tests. Do not delegate
broad implementation, overlapping design, or open-ended exploration. Keep
parallel work at the smallest number needed.

Before each new slice, the coordinator says why it is local or delegated,
prunes obsolete context, and confirms it advances the accepted MVP flow. The
already-started builder-handoff foundation is completed locally as an exception
because this policy arrived mid-slice. Next, a subagent will own only GitHub
webhook correlation and its tests. After integration, one subagent may own the
verification-plan/artifact inventory or an equally isolated implementation
slice; the coordinator makes all cross-slice decisions.
