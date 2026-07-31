# The Judgment Ledger — Design (Arc E)

**Date:** 2026-07-31
**Status:** Directional — approved shape; refinement pass when its build starts (consumes A–D's evidence; phased E1→E3). Per the audit: **this is the moat.**
**Scope:** Capture every human interaction with a Jace judgment as structured, workspace-specific knowledge; consume it as constraints; publish calibration; ship refusal.
**Prior art:** audit Roadmap C (C1–C5) — this spec operationalizes it; the owner memo §6–§7.
**Non-goals:** model fine-tuning (the ledger changes behavior through retrieval-as-constraints and gates, not weights); cross-workspace pooling (the value is that it is *this team's* judgment — non-copyable by design); analytics dashboards divorced from behavior change.

## Judgment removed

Cumulatively, all six categories — this is the arc that makes every other
arc's judgment **compound**: without it Jace improves only when models
improve; with it, the customer teaches it. Most directly:

- **Design tradeoffs / architecture decisions** — locked decisions and
  rejected approaches become enforceable constraints, not context prose.
- **Merge confidence** — calibration turns "trust me" into "on this repo,
  over N merges, here is our record."

## Problem

Every valuable judgment signal is generated and immediately discarded:
findings accepted or dismissed, ACs rewritten during grilling, designs
rejected in chat, PRs merged then reverted, incidents traced to merged
changes, human edits after the agent. Free, perfectly-labeled,
workspace-specific training signal — thrown away.

## Decision

**E1 — Capture** (the rows, audit C1):

| Event | Row type |
|---|---|
| Reviewer finding accepted / edited / dismissed | `review_outcome` (with the human edit as ground truth) |
| AC rewritten during grilling | `requirement_correction` |
| Design rejected in chat | `rejected_approach` (with reason) |
| PR merged then reverted | `false_green` — the most valuable row in the system |
| Incident traced to a merged change | `missed_check` (names the check that should have existed) |

`judgment_events`: `id, workspaceId, repo, type, refs { findingId?,
investigatedId?, acId?, changeRecordId?, runId? }, payload, actor,
createdAt`. Capture seams, cheapest-first: chat dispositions (the owner
reacting to a review in-channel), console one-click
accept/edit/dismiss on the review view, grilling diffs, revert detection
from GitHub events, incident links from the investigations store. The
stable ids Arc A stamped exist precisely so these rows have something to
point at.

**E2 — Consume as constraints, not context** (audit C2):

- `memory_items.type='decision'` and `rejected_approach` rows become
  *rules checked against*: `to-issues` blocks (or flags) an issue that
  contradicts a locked decision; the planner is barred from proposing a
  recorded `rejected_approach`; the reviewer suppresses a finding class
  the team has dismissed three times (per-repo suppression list retrieved
  into the reviewer prompt, with the suppression itself visible in the
  `investigated` trail — suppression is a decision, so it is evidence
  too). The difference between memory and judgment is that judgment is
  enforceable.

**E3 — Calibration + refusal as shipped features** (audit C3/C5):

- Predicted-vs-actual per repo: gate green → later reverted? Reviewer
  blocker → confirmed? Published in the console: "over N merged PRs, the
  green gate held X%; we have never verified a migration." An agent that
  knows what it's bad at is the cheapest thing to trust.
- The refusal states (Arc C's `unverifiable`, requirements-conflict
  refusals) get their **refusal rate** published alongside. A system that
  never refuses is a system whose approval carries no information.

## Evidence & reuse

Ledger rows reference Change Record stages and Arc A's stable ids; E2's
constraints feed back into every producing component (intake, planner,
reviewer); E3's calibration is rendered from ledger joins, never
hand-maintained. This closes the memo's loop: merge → production →
outcome → learning → judgment memory → future decisions.

## Testing (sketch)

Row capture idempotency; disposition seams (chat + console) write-once
semantics; constraint checks (issue-vs-decision contradiction fixture;
suppression threshold behavior with the visibility requirement);
calibration math against fixture histories; refusal-rate computation.

## Rollout

E1 first and silent (capture is harmless and starts the clock on
history); E2 per-constraint flags (blocking behaviors staged as
flag→warn→block); E3 once ≥1 workspace has enough history to publish
honestly. Dogfood on agentrail's own repos throughout.

## North-star note

This arc IS the north-star instrumentation: **reviewer agreement** =
`review_outcome` distributions; **escaped defects** = `false_green` +
`missed_check` rates; **decisions handled without human intervention** =
constraint-consumption counts. The moment E1 ships, the metrics the memo
demands stop being aspirations.
