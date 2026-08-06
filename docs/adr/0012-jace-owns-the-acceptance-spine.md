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

The runner can now store an inspectable PNG/JPEG only by resolving a current,
planned UI criterion against its Acceptance Record and exact PR revision. It
derives the repository, PR number, head, criterion, and environment from that
plan and records an artifact key plus SHA-256 digest. This is a narrow UI
artifact seam, not a browser-exercise worker or proof of the criterion.

Not yet proven: Context-Pack token-budget/citation enforcement and canonical
compiler attestation; Codex/Claude task pickup; originating-channel
clarification; Slack/Discord contract handoff; live context-pack delivery to a
builder task; UI exercise and non-UI artifact dispatch; runtime modality-
exercise worker; API redaction worker; GitHub/Jace fallback delivery; human
outcomes/dependency workflow; and UI/browser E2E.

## Consequences

All future channel work must write the same Acceptance Record; it must not
create a parallel channel-local contract. Any review or delivery claim must be
bound to the exact contract version, PR revision, target, and recorded result.

Automatic GitHub correlation is fail-closed: a webhook may attach or trigger a
review only when the connected workspace/repository, exact PR head, and a
recorded builder task/context identify one Acceptance Record. A missing or
ambiguous builder binding requires explicit human attachment; it must never
guess from a title, branch name, or repository alone.
