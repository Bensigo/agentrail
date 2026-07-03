# PRD: Jace on Eve

## Problem

Ideation→issues is manual today: requirement interviews, PRD drafting, breaking
PRDs into house-format issues, standup, and codebase Q&A all run through
hand-driven sessions. The decision is locked (2026-07-02): **Jace**, the
coordinator built on Eve, owns that front office; AgentRail core stays a pure
SDLC factory (queue → run → verify gate → PR). Two products, one contract:
Jace's only write path into the factory is a single gated create-issue tool
emitting house-format issues.

The comms channels are part of this split. Telegram/Slack/Discord currently
live in the factory's console — one-way terminal-state pings (`notify.ts`) plus
a webhook whose replies are canned (`decideReply`: /status, help). That is not
bidirectional communication; it's a doorbell. The channels **move** to Jace:
Jace becomes the single conversational gateway (in AND out), and the factory
keeps no chat surface at all — it produces events and data; Jace does all the
talking.

## Goals

1. **Production self-hosted deployment** — Eve self-hosted on exact pinned
   versions. The hosting decision is made and documented as part of the
   skeleton work: Eve is a Node/Nitro process spoken to over HTTP, which fits
   neither deploy target of the runner model (hosted console + downloaded CLI)
   as-is — decide where the sidecar runs, its public reachability, and whether
   the console keeps a thin relay endpoint or channels point directly at Jace.
2. **Channel migration** — Telegram, Slack, and Discord move from the factory
   console to Jace; Jace becomes the ONLY conversational
   surface, bidirectional by construction. Factory run notifications are
   delivered *through Jace* so the user can reply in-thread ("what
   happened?" → Q&A). Order: Telegram first (webhook + secret infra exists and
   is battle-tested), Discord second (workspace-level secret storage exists),
   Slack last (greenfield — a `GATEWAY_SENDERS` slot exists but nothing more).
3. **Single gated create-issue tool**, `needsApproval: always()`; house issue
   format; PRDs publish as parent epic issues through the same path. No second
   write path.
4. **Skills**: grill-me, to-prd, to-issues, standup, Q&A — plus a persona/tone
   spec in the Jace system prompt (the "personality" requirement).
5. **Shared memory** — extend the existing store (see Design 2); Jace
   writes conversation-derived entries, factory reads a capped memory lane.
6. **Kill switch** beyond per-issue approval.

## Non-goals

- **Not blocked on PRD1.** Jace launches human-gated in parallel;
  PRD1 (queue-entrance guardrails) is the prerequisite for *relaxing*
  `needsApproval`, not for launching.
- No memory primitive inside Eve — memory lives in AgentRail Postgres only.
- No chat/personality features in the Python CLI; after migration, no comms
  channels in the factory at all (the console keeps at most a dumb public
  relay endpoint — see Design 3 — never conversation logic).
- No period with two brains on one channel: the legacy console notify +
  canned-reply paths are retired per-channel as Jace takes each over, not
  left running in parallel.

## Design

Anchor files: `packages/db-postgres/src/schema/memory_items.ts:5-18`,
`apps/console/app/api/v1/ingest/memory-items/`,
`apps/console/app/api/v1/connectors/telegram/webhook/[workspaceId]/route.ts`,
`agentrail/connectors/github.py:462-482` (create-issue applies the trigger
label), `packages/db-postgres/src/schema/runs.ts:19-50`.

1. **Production self-hosted deployment** — self-hosted via
   `@workflow/world-postgres`, exact version pins (beta churn: ~41
   releases/2wks; never let pins float). The hosting decision (sidecar
   location, public reachability, relay-vs-direct) is made and documented as
   part of the skeleton work; channel migration builds on that answer. Keep
   all Jace logic (skills, prompts, the issue contract) portable so the
   thin-shell fallback stays cheap if Eve fails.
2. **Memory = extend `memory_items`, don't create.** The table + ingest route
   already exist (migration 0007). Add an enum-constrained `type`
   (decision | preference | fact) and a writer-attribution column;
   secret-scan/deny-list on write; the factory reads a size-capped, delimited,
   untrusted-framed memory lane into packs. The workspace read route currently
   returns full content unmasked to any member — tighten it or accept that
   explicitly. Drizzle gotcha: the migration must land in `_journal.json`
   (numbers have collided before) or it is silently skipped.
3. **Channel migration (Telegram first)** — conversation ownership moves to
   Jace. What stays console-side is at most a thin relay (workspace
   lookup + secret verify + forward to Jace) — whether the relay is
   needed at all is decided by the skeleton work's hosting decision: the Eve
   sidecar may not be publicly reachable, the console already is. Either way:
   - **Inbound:** REQUIRED fix before any traffic increase — replace the plain
     `!==` secret compare with `timingSafeEqual`
     (`telegram/webhook/[workspaceId]/route.ts:52` — the GitHub route already
     does this correctly). `webhookSecret` lives in readable jsonb `config`,
     so rotate it on any read-path change. Keep the chat-id allowlist as the
     Jace-side check.
   - **Outbound moves too:** `result/notify.ts` (terminal-state pings from
     `recordRunnerResult`) is replaced by Jace-delivered notifications,
     preserving its hard-won rule — notify ONLY on a non-null `terminalState`,
     never on a retry. A "run failed" message then lands in a thread the user
     can reply to, answered within Design 5's schema-backed limits.
   - **Retire as you go:** once Jace handles a channel end-to-end,
     delete that channel's `decideReply` path and its `GATEWAY_SENDERS` entry
     in the same PR arc.
   - **Discord** reuses the workspace-level secret storage already in place;
     **Slack** is greenfield and goes last.
4. **Codebase Q&A** — Jace invokes `agentrail context
   query/def/callers` execFile-style with an args array, never via a shell
   string; read-only.
5. **Standup scoped to schema-backed facts** — counts, cost, PR links,
   escalations, queue states. `runs` has NO error/reason column and dashboard
   status reflects the local verify gate, not real CI: a "why did it fail"
   narrative requires a failure-summary source (new column or event read) as a
   separate, explicit dependency. Do not promise it in v1.
6. **Kill switch** — the per-workspace connector `enabled` flag pattern
   (`github_intake.ts:117-124`) plus the chat-id allowlist; flipping `enabled`
   off halts all inbound Jace traffic without touching the factory.

## Measurement (definition of success)

- Deployment: Eve runs self-hosted on exact pinned versions with the hosting
  decision documented; create-issue `needsApproval` round-trip works
  end-to-end.
- MVP: a grill→PRD→issues conversation lands real house-format issues through
  the gate, and the factory picks them up via the trigger label with zero
  Jace-specific plumbing.
- Standup answers come from AgentRail Postgres read-only.
- Bidirectional round-trip: a factory run's terminal notification arrives via
  Jace, the user replies in-thread, and Jace answers —
  with the legacy console notify + canned-reply path for that channel deleted
  (one brain per channel).
- A memory written in conversation appears — typed and attributed — in a
  factory pack's memory lane, and survives the write-side secret scan.

## Risks

- Eve beta churn → exact pins, portable skills, GitHub-as-interface fallback
  (only the thin shell would be rewritten).
- The memory lane is a prompt-injection surface crossing the trust boundary
  from chat into the factory → write-side scan + read-side cap/delimit/
  attribute; PRD1's read-side framing applies to this lane too.
- Sidecar hosting mismatch → the hosting decision is made as part of the
  skeleton work, before channel wiring starts. The same answer settles whether
  the console keeps a thin relay endpoint or channels point straight at Jace.
- Migration regressions → notifications must not go dark or double-fire during
  cutover: flip the notify source per workspace behind the connector `enabled`
  flag, verify one terminal notification arrives exactly once via the new
  path, then delete the legacy path.
