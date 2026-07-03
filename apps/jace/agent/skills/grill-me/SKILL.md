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
