---
name: grill-me
description: Pressure-test a vague product idea through a focused requirement interview and produce a structured requirements summary (Problem, Users, Constraints, Scope, Success signals, Open questions). Read-only drafting — no issues are created and no approval is needed while grilling.
---

# Grill me

Run a requirement interview that turns a vague prompt into a structured
requirements summary. This is a READ-ONLY conversation: you are drafting, not
publishing. Never call `create_issue` from this skill — grilling produces a
summary the human reviews, not an issue.

## How to grill

Ask sharp, one-at-a-time questions. Do not accept the first answer as final;
pressure-test it. Prefer concrete over abstract, behavior over implementation.
Keep the AgentRail house standard in view: the factory's output quality is
bounded by the quality of the acceptance criteria, so grill hardest on how the
human will KNOW the thing is done.

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

## Sharpen the domain model as you go

Grilling is also where the project's language gets sharpened. Drafting a summary
does not cross the factory boundary, and neither does editing local context docs
— only `create_issue` does — so capture terms and decisions inline as they
resolve rather than batching them to the end.

- **Challenge against the glossary.** When a term conflicts with the existing
  language in `CONTEXT.md`, call it out at once: "your glossary defines
  'cancellation' as X, but you seem to mean Y — which is it?"
- **Sharpen fuzzy language.** When a term is vague or overloaded, propose a
  precise canonical one: "you're saying 'account' — do you mean the Customer or
  the User? Those are different things."
- **Cross-reference with code.** When the human states how something works, check
  whether the code agrees, and surface any contradiction you find.
- **Capture terms inline.** When a term is resolved, update `CONTEXT.md` right
  then, in the format in [CONTEXT-FORMAT.md](./CONTEXT-FORMAT.md). Don't couple it
  to implementation details — only terms meaningful to domain experts. Create the
  file lazily, when the first term is resolved.

Most repos have a single root `CONTEXT.md`. If a `CONTEXT-MAP.md` exists at the
root, the repo has multiple contexts and the map points to where each one lives;
infer which context the current topic belongs to, and ask if it is unclear.

## Record decisions as ADRs (sparingly)

Offer to write an ADR only when all three are true — otherwise skip it:

1. **Hard to reverse** — the cost of changing your mind later is meaningful.
2. **Surprising without context** — a future reader will wonder "why this way?"
3. **The result of a real trade-off** — there were genuine alternatives and you
   picked one for specific reasons.

When all three hold, write it in the format in [ADR-FORMAT.md](./ADR-FORMAT.md),
lazily creating `docs/adr/` when the first ADR is needed.

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

Keep it direct and concrete — no hype, no vague reassurance, no filler. The
summary is the input to `to-prd` (to draft a PRD) or, for a small single slice,
straight to `to-issues`. Nothing is published until the human approves a
`create_issue` call.
