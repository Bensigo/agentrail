# ADR 0012: Jace owns the acceptance spine; external agents implement

## Status

Accepted for the trust-layer MVP. Implementation is partial; this document is
not evidence that every integration is live.

## Decision

Jace is an agent-agnostic acceptance and evidence layer, not another code
generator. An engineer may begin a task in Codex, Claude Code, Slack, Discord,
or a future supported channel. Every entry resolves to one canonical Acceptance
Record with `originChannel` and bounded source references.

Jace owns the spine:

1. Receive the task and ask only unresolved questions in the originating
   channel when that channel supports replies.
2. Draft an Acceptance Contract, then require explicit human confirmation.
3. Compile a bounded, versioned, cited Context Pack from the connected
   repository/wiki. It includes only task-relevant source ranges, boundaries,
   tests, decisions, exclusions, freshness/provenance, and an explicit token
   budget; it never substitutes a repository or chat-history dump. Durable
   intent stays in the Acceptance Record. Side agents may contribute compact,
   cited findings, but cannot become a second unbounded context source.
4. Hand the confirmed contract and pack to the selected external builder.
5. Attach the builder's PR at a canonical repository identity and exact head.
6. Independently plan and verify each criterion against the strongest safe
   observable modality for its environment: browser interaction and screenshots
   for UI, redacted request/response/assertions for APIs, a trigger plus bounded
   output/log/artifact for jobs, and authorized readback/assertion for data or
   integrations. User-visible criteria require a criterion-specific flow and
   inspectable artifact on that exact PR head and environment; a
   homepage/page-load smoke test is never sufficient. If no safe environment or
   exercise exists, record `not_testable` or `not_proven`, never a fabricated
   pass. API evidence must redact credentials, tokens, and sensitive fields.
7. Emit only evidence-bound blockers. A blocker must name its contract,
   architecture, enforced convention, or concrete risk; cite evidence; state
   impact; require a correction; and specify re-verification.
8. Return correction packets to the builder task context where possible, or a
   durable fallback (GitHub/Jace inbox). `queued` or `attempted` is not
   notification; the builder must acknowledge receipt.
9. Keep the final outcome a human decision. Jace never silently edits code or
   merges a PR.

## Non-goals

- Replacing Codex, Claude Code, Cursor, or another implementation agent.
- Advisory/style review comments without a required code change.
- Treating a generic preview health check as behavioral proof.
- Claiming a builder resumed from an undelivered correction.

## Current evidence and gaps

Implemented and tested foundations: manual/MCP draft records, human contract
confirmation, metadata-only Context Packs, manual and fail-closed webhook
exact-head PR revisions,
criterion-level evidence validation, durable blocking correction-packet fields,
human-selected builder handoff bindings, and MCP acknowledgement of a
correction delivery. A worker-only API now persists exactly one safe
verification plan for every confirmed criterion, bound to its current exact PR
revision and contract; it rejects generic non-UI plans for user-visible
criteria and requires a safe environment/flow or an explicit `not_testable`
reason. A persisted plan is not proof.

The canonical Acceptance Review validator rejects advisory/random findings: a
blocker needs an allowed basis, exact evidence, impact, required correction,
and re-verification; a repository-convention blocker additionally needs an
enforced rule identity. The old GitHub advisory-comment tool is disabled from
Jace's runtime registry, its headless worker is not wired at startup, and its
standalone entrypoint exits without starting work. Its core/source remains only
as quarantined historical cleanup material until dependencies and retained data
are safely migrated; it is not a supported product review or merge-gate path.

Context Pack recording now rejects an unbounded or uncited manifest. A pack
must declare an explicit token budget/count, cited source ranges, the exact
confirmed criterion IDs, architecture boundaries, tests, decisions,
exclusions, freshness, and a no-full-source custody declaration. This is
structural handoff enforcement, not yet a live compiler attestation.

The runner can now store an inspectable PNG/JPEG only by resolving a current,
planned UI criterion against its Acceptance Record and exact PR revision. It
derives the repository, PR number, head, criterion, and environment from that
plan and records an artifact key plus SHA-256 digest. A parallel API-only
route accepts structured request/response-status/assertion evidence only for a
current planned API criterion, redacts credential-bearing fields and common
credential text before storing a JSON artifact, and binds the same exact-head
identity. Neither route exercises its flow, verifies its assertions, or proves
the criterion.

Planned API criteria now carry a bounded immutable request descriptor: `GET`,
a same-preview-origin path, and expected status. The queue can claim such a
criterion only when its exact PR-head preview is ready; Jace instructs QA to
fetch only that descriptor and upload a redacted request/response/assertion
artifact through the plan boundary. No deployed execution or independent
semantic assertion evaluator is proven. Mutating, credential-bearing, and
external API requests remain outside this MVP execution path.

Jace now has a separate exact-head criterion-execution queue, a guarded worker
result seam, and a default-off Eve worker that claims only those plan-bound
jobs, asks root Jace to execute one constrained criterion prompt, and completes
through the trust endpoint. A `proven` result requires observed behavior and
artifacts bound to that plan; neither the worker, queueing, nor a screenshot
alone proves that a browser executed the criterion flow.

An owner/admin can now record one immutable final decision against a current,
exact-head Evidence Review in the Acceptance Record. `approved` requires
Jace's recorded `proven` verdict; a non-proven review can only be accepted as
an explicit, explained exception. The record never changes Jace's verdict and
does not merge the PR. The older post-merge rework/revert metric ledger remains
aggregate outcome evidence, not the final Acceptance Record decision source.

Not yet proven: Context-Pack canonical compiler attestation; Codex/Claude task pickup; originating-channel
clarification; Slack/Discord contract handoff; live context-pack delivery to a
builder task; a deployed UI exercise and non-UI artifact dispatch; API
execution/assertion worker; automatic Jace fallback delivery and external-builder receipt;
human-decision live/migrated-DB proof; dependency workflow; and UI/browser E2E. An owner/admin can now dispatch the persisted
packet as a GitHub PR issue-comment only when the exact review revision is
still current; it records `delivered` or `failed`, but does not prove that the
builder received or resumed. A scoped MCP credential can retrieve the
evidence-bound packet for its recorded builder task context, but this is a
durable inbox/readback mechanism—not proof that the external builder was
notified or resumed; acknowledgement remains required.

## Consequences

All future channel work must write the same Acceptance Record; it must not
create a parallel channel-local contract. Any review or delivery claim must be
bound to the exact contract version, PR revision, target, and recorded result.

Automatic GitHub correlation is fail-closed: a webhook may attach or trigger a
review only when the connected workspace/repository, exact PR head, and a
recorded builder task/context identify one Acceptance Record. A missing or
ambiguous builder binding requires explicit human attachment; it must never
guess from a title, branch name, or repository alone.
