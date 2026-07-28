---
name: grill-me
description: Pressure-test a vague product idea through a focused, repo-grounded requirement interview and produce a structured requirements summary (Problem, Users, Constraints, Scope, Success signals, Open questions). Read-only drafting — no issues are created and no approval is needed while grilling.
---

# Grill me

Run a requirement interview that turns a vague prompt into a structured
requirements summary. This is a READ-ONLY conversation: you are drafting, not
publishing. Never call `create_issue` from this skill — grilling produces a
summary the human reviews, not an issue.

## Context preflight (mandatory, before question one)

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
production. Apply it as two concrete checks on every answer to a Scope or
Success-signal question:

1. **Does it name an object, an action, and a result?** ("a reader can view a
   published post at `/blog/:slug`" passes; "make it good" doesn't.)
2. **Does it actually answer what was asked?** A reply like "all of the
   above" to "give me a couple of concrete examples" answers nothing — it
   names no examples.

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
first?").

## Sharpen the domain model as you go

Grilling is also where the project's language gets sharpened — but that's a
conversation, not a write. Jace never authors `CONTEXT.md`. Repos that
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

Fold resolved terms into the requirements summary below — under Constraints or
Open questions, whichever fits — rather than into any file. The summary is
the durable record of this conversation.

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
these headings, in this order, filled from the conversation:

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

If the conversation resumes after a gap, restate the current pinned/open
state at the top rather than starting the interview over — there is no
persistent store behind this skill yet, so the conversation itself is the
only record, and re-asking a question the human already answered is exactly
the failure this skill exists to prevent.

Keep it direct and concrete — no hype, no vague reassurance, no filler. The
summary is the input to `to-prd` (to draft a PRD) or, for a small single slice,
straight to `to-issues`. Nothing is published until the human approves a
`create_issue` call.
