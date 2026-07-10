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

- Required context from `.agentrail/context.md`.
- Required product quality, UI, copy, interaction, or visual evidence guidance from `.agentrail/taste.md` when present.
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

1. Re-read `.agentrail/context.md` and `.agentrail/taste.md` when present before drafting issue bodies.
2. Create one GitHub issue per independently shippable slice.
3. Carry relevant context and taste requirements into each issue's acceptance criteria or verification evidence.
4. Add acceptance criteria to each issue.
5. Apply `ready-for-agent` only when the issue is implementable.
6. Apply `afk` only when the issue can be completed without live clarification.

If `.agentrail/context.md`, `.agentrail/taste.md`, the PRD, and the milestone disagree, resolve the conflict before creating issues. Do not publish issues that silently ignore documented project requirements.

## Completion

A milestone is complete when:

- All linked issues are closed.
- Required verification evidence exists.
- Any follow-up risks or deferred work are documented.
