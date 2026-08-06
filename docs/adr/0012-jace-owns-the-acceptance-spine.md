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
3. Compile a bounded, cited Context Pack from the connected repository/wiki.
4. Hand the confirmed contract and pack to the selected external builder.
5. Attach the builder's PR at a canonical repository identity and exact head.
6. Independently verify each criterion. User-visible criteria require a
   criterion-specific flow and inspectable artifact on that exact PR head and
   environment; a homepage/page-load smoke test is never sufficient.
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
confirmation, metadata-only Context Packs, exact-head PR revisions,
criterion-level evidence validation, blocking correction packets, and MCP
acknowledgement of a correction delivery.

Not yet proven: Codex/Claude task pickup, originating-channel clarification,
Slack/Discord contract handoff, live context-pack delivery to a builder task,
review-bound artifact upload/dispatch, GitHub/Jace fallback delivery, runtime
exercise worker, human outcomes/dependency workflow, and UI/browser E2E.

## Consequences

All future channel work must write the same Acceptance Record; it must not
create a parallel channel-local contract. Any review or delivery claim must be
bound to the exact contract version, PR revision, target, and recorded result.
