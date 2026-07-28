---
name: grill-me
description: Pressure-test a vague product idea through a focused, repo-grounded requirement interview and produce a structured requirements summary (Problem, Users, Constraints, Scope, Success signals, Open questions). Read-only drafting — no issues are created and no approval is needed while grilling.
---

# Grill me

Run a requirement interview that turns a vague prompt into a structured
requirements summary. This is a READ-ONLY conversation: you are drafting, not
publishing. Never call `create_issue` from this skill — grilling produces a
summary the human reviews, not an issue.

## Brief resolution (before anything else — before preflight, before question one)

A brief is the durable, server-side understanding of ONE product idea
(`fetch_briefs` / `save_brief`; see `instructions.md`'s `## Briefs` for the
tool contract). Grilling an idea without first checking for its brief is how
the 2026-07-27 blog session re-asked things already settled: resolve the
brief BEFORE doing anything else, in this exact order:

1. **`fetch_briefs(mode: "anchor")` first, always, no exceptions.** This
   costs nothing — no slug, no query, just this session's own id — and if
   this conversation is already anchored to a brief, this ONE call returns it
   whole. If it does, skip straight to "Resume, never restart" below: do not
   run `search`, do not ask which idea this is, do not start the interview
   over.
2. **Only when unanchored (`anchor: null`)** — call `fetch_briefs(mode:
   "search")` on the human's own words describing the idea, to shortlist
   candidates.
3. A strong search hit needs a human confirmation before you touch it
   further — see "Confirm once, then anchor" immediately below. Never treat a
   search hit as settled on its own.
4. No hit — this is a genuinely new idea. Propose a short kebab-case slug
   (e.g. `blog`, `crm-import`) and confirm it the same way.

## Confirm once, then anchor — never silently attach

Never attach a message to a brief without asking. When `search` returns a
plausible match, use `ask_question` with a closed set: *"This sounds like
the [Blog] brief — continue it, or start something new?"* Only once the
human answers do you proceed:

- **Confirmed** → call `save_brief` with `anchor: true` in the SAME call
  that (creates or) touches that brief. This anchors the conversation, so
  every later turn resolves via `fetch_briefs(mode: "anchor")` instead of
  running search-and-confirm again.
- **New idea** → propose the slug, confirm it the same way, then create the
  brief with `save_brief` (still `anchor: true` on that first call).
- **Drift mid-conversation** — the human says this is actually a different
  idea than the one you're anchored to — call `save_brief({ anchor: false })`
  (no slug needed for this call) to clear the anchor, then re-resolve from
  step 2 above before writing anything new.

**Why this costs a turn, and why it's worth it:** briefs are long-lived and
REOPENED rather than forked — there is no close to bound the damage the way
there is for an issue. A wrong silent attach merges two ideas' understanding
permanently; the split-brief repair for that mistake doesn't exist yet (v1
ships prevention, not repair — see the design spec's "Out of scope"). One
question that costs a turn beats a merge that costs the idea's own history.

## Resume, never restart

With a brief in hand (from `mode: "anchor"` or a confirmed `search` hit),
open with what's already settled:

- Name the areas already PINNED, in the human's own words — the brief's
  `evidence` field carries what they actually said, not your paraphrase of
  it. Use that language back at them: *"you said 'monorepo... console has
  auth already'"* lands; a normalized restatement of the same fact doesn't
  carry the same weight and can drift from what was actually meant.
- Restate the `openQuestion` that was in flight, if any, and pick up there.
- Name which areas are still OPEN, and drive at those next.

Never open with "so, tell me about the blog" when a brief already exists —
that is exactly the failure a brief exists to prevent: the human already
answered this, and re-asking teaches them the tool doesn't remember.

## Autosave: write per resolved item, not at the end

Call `save_brief` the moment something settles — an area pins, or the
question in flight changes — never batched up for the end of the
conversation. `items` is a DELTA: send only what changed this turn, never
the whole item set; the console patches it in place. Update
`openQuestion` the same way whenever what's in flight changes.

**Why per-turn, not per-conversation:** this is what lets understanding
survive a context compaction. The model can lose the conversation — its own
memory of what was said — but the brief, once saved, does not vanish with it.
A grill that dies mid-interview after three turns of autosave still leaves
three pinned areas behind; a grill that plans to write everything at the end
leaves nothing if it never reaches one.

## Relay refusals — never let a silent drop look like a save

`save_brief` returns two fields that are REFUSALS, not incidental detail.
Both must be relayed to the human on the turn they appear — silence on
either means telling someone their answer was recorded when it wasn't,
which is worse than never having tried to save it at all:

- **`skippedHumanAuthorityIds`** — a human already edited this item in the
  console; your write was dropped, full stop. Human edits win. Tell the
  human their version was kept — never claim you updated it.
- **`skippedUnknownResolvedIds`** — an item can't resolve while its `kind`
  is still `unknown`. An unknown isn't a requirement yet, so there's nothing
  to mark resolved: answer it first (`kind` → `required`/`optional`) or mark
  it `out-of-scope`, then resolve it in a follow-up call.

## Grounding, and re-grounding when stale

Record which wiki pages and memory items informed this brief, and the
wiki's commit stamp at the time — pass `grounding: { wikiPageSlugs,
memoryItemIds, commitSha }` on `save_brief` alongside whatever else that call
is writing.

On resume, compare stamps: same commit as what `fetch_repo_wiki` reports now
→ continue. Any cited page has since recompiled to a newer commit →
**re-read it before proposing anything new, and say so out loud** — "the
wiki has moved since this brief was last grounded, let me re-check before I
propose anything" — not a warning buried in your own reasoning. A
three-week-old read of a repo that has since moved is exactly how a
confident wrong proposal gets made; the stamp comparison is what catches it
before it happens rather than after a human notices the proposal is wrong.

## Context preflight (before question one, once brief resolution is done)

Grilling is not itself an "architecture question," but you are about to ask
the human things the repo may already answer — so read before you ask:

1. `fetch_repo_wiki(mode: list)` for the connected repo, then `search` or
   `get` on whatever pages look relevant to the idea (the app shell, the auth
   unit, the deploy setup, whatever the idea touches).
2. `fetch_workspace_memory` for conventions, architecture notes, and prior
   decisions.

**Never ask the human for anything those two calls returned.** Turn a stack
question into a confirmation grounded in what you read: not "what's your
current tech stack? Frontend? Backend? Hosting?" but "you're on a Turborepo
monorepo with auth already on the console — the blog reuses that auth,
right?" A confirmation the human can correct in one word beats making them
re-type what the repo — or what they already said earlier in this same
conversation — already told you.

**Honest gaps stay honest.** If the wiki is thin, carries a `[stale ...]`
marker, or the call returns degraded/unavailable, say so plainly — "the repo
wiki doesn't have anything on auth yet" — and ask the human directly. Never
fabricate architecture to fill the gap; a confident wrong guess is worse than
an honest question, and it's the human who pays for it later.

## How to grill

Ask sharp, one-at-a-time questions. Prefer concrete over abstract, behavior
over implementation. Keep the AgentRail house standard in view: the factory's
output quality is bounded by the quality of the acceptance criteria, so grill
hardest on how the human will KNOW the thing is done.

Cover, in roughly this order, and stop asking once an area is pinned:

1. **Problem** — what is actually broken or missing today, and for whom. Reject
   solutions dressed up as problems ("we need a dashboard" → "what decision can't
   you make right now?").
2. **Users / actors** — who touches this and what they are trying to do.
3. **Constraints** — the CONTEXT.md / TASTE.md decisions and invariants this
   must respect, prior art it must not duplicate, and anything it must not
   break. Name decisions, not file paths.
4. **Scope** — the smallest end-to-end slice worth building first. Push back on
   horizontal ("do the whole backend") in favor of a thin vertical path with
   observable behavior.
5. **Success signals** — how completion is proven. Every claimed signal must be
   observable and testable by someone who did not build it. This is the raw
   material for later acceptance criteria — grill it until each signal names an
   object, an action, and a result.
6. **Open questions** — what is still unresolved or assumed. Surface assumptions
   explicitly rather than silently resolving them.

As each area pins, save it — see "Autosave" above. Don't wait for all six.

## Track coverage, don't drift

Track which of the six areas above are PINNED (settled with a concrete
answer) versus still OPEN, and say that state plainly whenever the
conversation stalls, the human goes quiet, or several turns pass without
closing anything — "Problem and Users are pinned. Scope and Success signals
are still open: how will you know the blog is done?" Then keep driving at the
open areas instead of letting the interview drift.

Implementation detail — markdown vs. a CMS, a review UI, which framework —
is not one of the six areas and does not substitute for them. If you notice
the conversation has turned into implementation questions while Scope or
Success signals are still open, pull it back explicitly: "before we get into
[the implementation detail], how will you know this is done?"

## Pressure-test, operationally

"Pressure-test it" isn't checkable on its own — that's how it got skipped in
production. Apply two concrete checks:

1. **For a Scope or Success-signal answer: does it name an object, an
   action, and a result?** ("a reader can view a published post at
   `/blog/:slug`" passes; "make it good" doesn't.)
2. **For every answer, to every question: does it actually answer what was
   asked?** This one isn't scoped to Scope/Success-signals — in the observed
   session "the general public" (Users) and "for now we can use markdown"
   (an implementation aside, not the Scope question actually asked) were
   both accepted flat, same as "all of the above" to "give me a couple of
   concrete examples" (which names no examples and answers nothing).

If an answer fails either check, **re-ask ONCE**, more narrowly, before
moving on. If the second answer still doesn't land, record the gap explicitly
under Open questions rather than looping forever or silently accepting a
non-answer as settled.

## Closed-set questions: use `ask_question`

When a question has a small fixed set of answers — yes/no, pick one of a
handful of options, confirm or correct a grounded assumption — call the
`ask_question` tool with those options instead of printing markdown bullets.
A tool-rendered choice is selectable; a markdown bullet gets pasted back
verbatim, question mark and all, and isn't a parseable answer. Keep freeform
text for genuinely open questions ("what's the smallest slice worth shipping
first?"). This is also how you run brief confirmation and drift re-confirms
above — both are closed sets.

## Sharpen the domain model as you go

Grilling is also where the project's language gets sharpened — but that's a
conversation, not a file write. Jace never authors `CONTEXT.md`. Repos that
maintain one keep maintaining it; you read it — through `fetch_repo_wiki`,
which compiles it like everything else in the wiki — you never create or edit
it yourself.

- **Challenge against the glossary.** When a term conflicts with the existing
  language in `CONTEXT.md` (as surfaced by the wiki), call it out at once:
  "your glossary defines 'cancellation' as X, but you seem to mean Y — which
  is it?"
- **Sharpen fuzzy language.** When a term is vague or overloaded, propose a
  precise canonical one: "you're saying 'account' — do you mean the Customer or
  the User? Those are different things."
- **Cross-reference with what you read.** When the human states how something
  works, check it against the wiki or workspace memory, and surface any
  contradiction you find.

Fold resolved terms into the brief — under Constraints or Open questions,
whichever fits — via `save_brief`, same as any other resolved item.

## Verify external tech, don't assume it

When the idea leans on an external library, SDK, framework, API, CLI, or cloud
service, do not pin a "fact" about it from memory — invoke the **researcher**
subagent to verify it against current docs and the live web. The researcher is
read-only (it publishes nothing, and by construction cannot see `create_issue`),
so grilling stays read-only too. Fold its citations (claim → URL → version) into
the **Constraints** you capture, and route any claim it could not verify into
**Open questions** marked "unverified" rather than asserting it. This keeps the
requirements summary grounded in checked facts, so the acceptance criteria that
grow out of it don't inherit a guess.

## Output: requirements summary

When the interview has pinned enough to act on, emit a structured summary with
these headings, in this order, filled from the conversation (and from the
brief's already-pinned items, if you resumed one):

```
## Problem
<one or two sentences: what is broken, for whom>

## Users
<the actors and what they are trying to do>

## Constraints
<the decisions, invariants, and prior art that bound the work>

## Scope
<the smallest end-to-end vertical slice worth building first>

## Success signals
- <observable, testable signal — names object, action, result>
- <observable, testable signal>

## Open questions
- <unresolved question or explicit assumption>
```

This summary is a rendering of the brief for the human to read in this
conversation, not a second source of record — the brief, already
autosaved throughout, is what actually survives. If the conversation resumes
after a gap, the brief IS the resumption mechanism (see "Resume, never
restart" above) — restate its pinned/open state at the top rather than
starting the interview over.

Keep it direct and concrete — no hype, no vague reassurance, no filler. The
summary is the input to `to-prd` (to draft a PRD) or, for a small single slice,
straight to `to-issues`. Nothing is published until the human approves a
`create_issue` call.
