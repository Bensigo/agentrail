---
name: to-prd
description: Draft a PRD from the requirements interview or conversation — Problem, Goals, Non-goals, Design, Slices, Measurement, Risks. Read-only drafting; no issues are created and no approval is needed while drafting.
---

# To PRD

Draft a Product Requirements Document from the grill-me requirements summary (or
the conversation so far). This is READ-ONLY drafting: producing a PRD creates
nothing and crosses no factory boundary, so there is no approval friction here.
Never call `create_issue` from this skill.

## What a Jace PRD contains

Produce these sections, in this order, filled with concrete content from the
conversation. Mirror the AgentRail PRD shape so `to-issues` can slice it cleanly.

```
# PRD: <title>

## Problem
<what is broken today and for whom — carry the grill-me Problem forward, sharpened>

## Goals
1. <numbered, outcome-shaped goal>
2. <numbered, outcome-shaped goal>

## Non-goals
- <explicitly out of scope, so slices don't drift into it>

## Design
<the approach: the vertical slices, the invariants they respect, the decisions
(CONTEXT.md / TASTE.md) they must not break. Reference decisions, not file paths.
Actively look for deep modules to extract — a deep module encapsulates a lot of
functionality behind a simple, testable interface that rarely changes; it is the
opposite of a shallow module whose interface is nearly as complex as what it
hides. Name the deep modules the slices build against.>

## Slices
1. <one thin, end-to-end, independently shippable vertical slice — behavior, not files>
2. <the next slice>

Each slice must be small enough to become ONE house-format issue with its own
acceptance criteria. A slice that cannot be stated as an observable, testable
outcome is too big — split it.

## Measurement (definition of success)
- <observable signal that proves the PRD's goal is met>

## Testing
- <what makes a good test here: assert external behavior, not implementation
  details, so tests survive refactors>
- <which deep modules get tests, and the prior art (a similar existing test in
  the codebase) each should follow>

## Risks
- <a real risk and how the design mitigates it>
```

## Tone

Direct and concrete. Name the object, the action, and the result. No hype, no
vague reassurance, no filler — the same tone the generated issues must carry
(quality is bounded by the acceptance criteria, and the criteria inherit their
clarity from here).

## What happens next

The PRD is a draft artifact for the human to review; it is not yet in the
factory. Two things route it across the boundary, both ONLY through the single
gated `create_issue` tool and each individually human-approved:

- `to-issues` breaks the **Slices** into house-format vertical-slice issues, one
  approved `create_issue` call per slice.
- The PRD itself is published as a **parent epic issue** through that same tool,
  so the slice issues can reference it as their Parent.

Nothing here writes anything. Publishing is `to-issues`' job, and only via the
one gate.
