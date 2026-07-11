---
name: emit-issue-brief
description: Structure a raw product idea into a well-formed AgentRail house-format issue brief (Parent, Required context, What to build, numbered checkbox Acceptance criteria, Verification evidence) ready for the create_issue tool.
---

# Emit issue brief

Turn a raw idea from the conversation into a single AgentRail house-format issue
brief. Produce these sections, in this order, mirroring the AgentRail house issue
template. Fill each with concrete content drawn from the conversation.

## Parent

The epic or milestone this issue belongs to. One line. If the human hasn't named
one, ask, or state the most plausible parent and confirm.

## Required context

The constraints that bound the work: relevant CONTEXT.md / TASTE.md decisions,
prior art, invariants, and anything the builder must not break. Reference
decisions, not file paths. When the slice depends on external tech, invoke the
**researcher** subagent first and include its citations (claim → URL → version)
here — verified facts, not a guess. The researcher is read-only; only the gated
`create_issue` call downstream publishes anything.

## What to build

Describe an end-to-end vertical slice — a thin, complete path through the system
that produces observable behavior. Describe it by behavior and outcome, not by
file paths or internal structure. Prefer one testable slice over a broad,
horizontal change.

## Acceptance criteria

Numbered, observable, testable criteria. Render each as a checkbox:

```
- [ ] AC1: <observable, testable outcome>
- [ ] AC2: <observable, testable outcome>
```

There must be at least one. Each criterion should be verifiable by someone who
did not write the code — pin exact behavior, not implementation.

## Verification evidence

State how completion is proven: the command, test, or observation that
demonstrates each acceptance criterion is met.

## Blocked by

Optional. Only include if there is a real upstream dependency that must land
first. Omit the section entirely when there is none.

---

When the brief is complete and the human agrees on its shape, it becomes the
input to the `create_issue` tool. That call is always human-approved before it
runs, and it creates exactly one issue.
