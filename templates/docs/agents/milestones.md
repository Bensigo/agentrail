# Milestones

Milestones turn PRDs into vertical, testable slices of work.

Use local milestone files under `docs/milestones/` before creating a large batch of GitHub issues.

## When To Create Milestones

Create milestones when:

- A PRD contains multiple implementation phases.
- Work spans frontend, backend, data, integrations, or operations.
- Multiple agents or teammates may work in parallel.
- The team needs a clear delivery sequence.

For small one-off fixes, a GitHub issue is enough.

## Milestone File Shape

Each milestone should include:

- Goal.
- User or business outcome.
- Scope.
- Non-goals.
- Dependencies.
- Implementation slices.
- Acceptance criteria.
- Verification plan.
- GitHub issues to create.

## Slicing Rules

Prefer milestones that produce usable behavior, not technical layers.

Good slices:

- A founder can import leads and review enrichment results.
- A teammate can approve an AI-generated draft before it is sent.
- A user can complete checkout and receive confirmation.

Weak slices:

- Add database tables.
- Build API layer.
- Create UI components.

Technical work is valid, but it should be tied to a visible or testable outcome.

## Issue Creation

After a milestone is clear:

1. Create one GitHub issue per independently shippable slice.
2. Add acceptance criteria to each issue.
3. Apply `ready-for-agent` only when the issue is implementable.
4. Apply `afk` only when the issue can be completed without live clarification.

## Completion

A milestone is complete when:

- All linked issues are closed.
- Required verification evidence exists.
- Any follow-up risks or deferred work are documented.
