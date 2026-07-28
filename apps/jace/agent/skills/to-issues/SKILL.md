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
human-approved before it runs (approve/deny buttons in chat). You never batch, never
create issues any other way, and never apply labels — the factory applies its
`ready-for-agent` trigger label server-side. Use the `emit-issue-brief` skill to
shape each brief into the house format before you call the tool.

## Readiness gate — check before you publish anything

If the work you are about to publish traces back to a **brief** (the durable,
per-idea understanding `grill-me` builds and `fetch_briefs`/`save_brief` read
and write — a resolved slug, or the brief currently anchored to this
conversation), check that brief's readiness BEFORE the first `create_issue`
call, not after drafting looks done.

**Why this exists:** a brief item with `kind: "unknown"` is a question nobody
has answered yet. If it reaches an issue anyway, the builder finds the gap in
the acceptance criteria and fills it by INVENTING one — that is precisely
where hallucination enters the factory. Catching this here, before an issue
exists, is cheaper than catching it after a PR ships against a guess.

**The check:** call `fetch_briefs(mode: "get", slug: <the brief's slug>)` — or
`fetch_briefs(mode: "anchor")` if you're working from whatever brief this
conversation is anchored to — and read the `readiness` object it returns
(`{ ready, blockingItems }`, relayed VERBATIM from the console's own
`computeBriefReadiness` — never re-derived here). Use `readiness.ready` for
the decision and `readiness.blockingItems` to name the actual unanswered
questions. **Do not decide readiness yourself by reading each item's
`statement` and judging whether it "seems" settled** — that is exactly the
model-confidence failure this gate exists to close; a confident read of an
ambiguous item is how a question that was never actually answered gets
treated as answered. Trust `readiness.ready`/`readiness.blockingItems`,
nothing else.

**Treat a missing `readiness` (not computed) the same as `ready: false`.**
`fetch_briefs` returns `readiness` as `undefined` — never a fabricated
`ready: true` — when the console it's talking to hasn't computed one for
this call (an older deployment, or a mode that doesn't carry it). Absence is
not clearance. An unverifiable gate must fail closed: if you cannot confirm
`readiness.ready === true`, refuse and say plainly that you could not verify
readiness for this brief, rather than proceeding as if it were ready. A gate
that silently stops gating the moment its input goes missing is the worst
failure mode for this particular check — the whole point is to stop
unanswered questions reaching the builder.

**If `readiness.ready` is `false`, or `readiness` is missing entirely, refuse
to call `create_issue`** for any work derived from this brief — including a
slice that looks unrelated to the open question, since you can't be sure
it's unrelated until the question is answered. When `blockingItems` is
available, name each one by area and statement, never a bare "not ready" —
for example:

> This brief still has 1 open question I can't publish past:
> - [scope] "Does the approver need to be a repo admin, or just a workspace
>   member?"
>
> Answer it, or tell me to mark it out-of-scope, and I'll continue.

When `readiness` is missing rather than `false` — nothing to name — say so
instead of inventing blocking items:

> I can't verify this brief is ready to publish from (the readiness check
> didn't come back for this brief) — I won't publish from it until I can
> confirm it, or you tell me to proceed some other way.

**Both exits are legitimate; name both, every time you refuse:**
1. **Answer it.** The human supplies the answer (or a further grilling turn
   settles it), and its `kind` changes to `required` or `optional` via
   `save_brief`. It resolves normally after that.
2. **Mark it out-of-scope.** The human decides this brief doesn't need an
   answer to this question right now; `save_brief` sets `kind:
   "out-of-scope"`. This clears the gate without pretending the question was
   answered — the item stays on the brief as a recorded decision, not an
   erased one.

Deleting the item outright is the only OTHER way past the gate, and it is a
human console action, visible there — never suggest deletion as a shortcut to
unblock yourself; that erases the question instead of answering it, which is
the opposite of what this gate is for.

**The honest limit of this gate:** it lives here, in `to-issues`, not inside
`create_issue` itself. `create_issue` has no notion of briefs at all — it
publishes whatever house-format brief you hand it, from any source. So this
refusal only holds for work that actually goes through THIS skill. An issue
filed some other way — a different skill, a manual `create_issue` call
outside this flow, or any future caller that skips this check — is not
gated by any of this. If asked whether this is enforced everywhere, say
plainly that it is enforced here, at the skill level, and nowhere else yet —
don't imply the factory's write path itself refuses unready work, because it
doesn't.

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
  bound this slice. Decisions, not file paths. For any external tech the slice
  depends on, invoke the **researcher** subagent first and paste its citations
  (claim → URL → version) here, so the builder inherits verified facts instead of
  a guess. The researcher is read-only and never publishes — only your gated
  `create_issue` call does.
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
