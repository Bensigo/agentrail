---
name: to-issues
description: Break a PRD into house-format, vertical-slice AgentRail issues and publish them one-by-one through the single gated create_issue tool (each issue individually human-approved). Publishes the PRD itself as a parent epic issue through the same path. This is the ONLY skill that publishes.
---

# To issues

Turn a PRD (or a grill-me requirements summary for a single small slice) into
AgentRail house-format issues and publish them into the factory. This is the
ONLY ideation skill that crosses the factory boundary, and it crosses it ONLY
through the single gated `create_issue` tool — there is no other write path.

## The one write path

Every issue is created by ONE call to the `create_issue` tool, and every call is
human-approved before it runs (`approval: always()`). You never batch, never
create issues any other way, and never apply labels — the factory applies its
`ready-for-agent` trigger label server-side. Use the `emit-issue-brief` skill to
shape each brief into the house format before you call the tool.

## Order of publication

1. **Publish the PRD as the parent epic issue first.** Call `create_issue` once
   with the PRD as a house-format epic (its Acceptance criteria are the PRD's
   Measurement signals, rendered as observable checkboxes). Capture the returned
   issue number/URL — it is the Parent every slice issue points to. This call is
   individually approved like any other.
2. **Then publish each slice as its own issue, one approved call at a time.** For
   each slice in the PRD, shape a house-format brief and call `create_issue`
   once. Set its `parent` to the epic from step 1. Wait for the human's
   approve/reject on each call before moving to the next slice. If a slice is
   rejected, refine it and propose again; do not skip ahead or batch.

Never collapse multiple slices into one `create_issue` call, and never fan out
several calls without waiting for each approval. One approved call, one issue.

## What makes a slice

Each slice is a tracer bullet: a thin, end-to-end path that cuts through every
layer the behavior needs (schema, API, UI, tests), not a horizontal slice of one
layer. Hold each proposed slice to this:

- It delivers a narrow but complete path through every layer, demoable or
  verifiable on its own.
- Prefer many thin slices over few thick ones.
- Do not propose setup-only slices — fold setup into the first slice whose
  user-visible behavior needs it.

A slice that can't be demoed by itself is too horizontal; split it the other way.

## Each issue must be house-format

Every brief you pass to `create_issue` must carry all six house sections and
labeled acceptance criteria:

- **Parent** — the epic from step 1 (or the named milestone). One line.
- **Required context** — the CONTEXT.md / TASTE.md decisions and invariants that
  bound this slice. Decisions, not file paths.
- **What to build** — the thin, end-to-end vertical slice, described by behavior
  and observable outcome, not by file paths or internal structure.
- **Acceptance criteria** — numbered, observable, testable, each a checkbox
  (`- [ ] AC1:` …). At least one; the factory's `validateAcceptanceCriteria`
  gate rejects a body with no checkbox. Quality is bounded by these — pin exact
  behavior, verifiable by someone who did not write the code. Never write vague
  criteria like "works correctly", "is polished", or "handles edge cases"
  without naming the concrete behavior; the agent will satisfy the letter of a
  loose criterion and miss the intent.
- **Verification evidence** — the command, test, or observation that proves each
  acceptance criterion.
- **Blocked by** — optional; include only for a real upstream dependency (for a
  slice that must land after another slice, cite that slice's issue number).

The `create_issue` tool renders these into the body itself; you supply the
fields (`title`, `parent`, `requiredContext`, `whatToBuild`, `acceptanceCriteria`
as a list, `verification`) and it produces the checkboxed house format.

## After publication

Each approved call creates one real GitHub issue and returns its URL. The
factory picks each up on its own by polling for the trigger label — you do
nothing to hand it off, and add no Jace-specific plumbing. Report the created
issue URLs back to the human as you go.
