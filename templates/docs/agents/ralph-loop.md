# Ralph Loop

The Ralph loop is a repeatable agent execution cycle for implementing one ready GitHub issue at a time.

It is designed for founder and small-team repos where agents need tight scope, visible progress, and reviewable output.

## Inputs

Required:

- One GitHub issue labeled `ready-for-agent`.
- Acceptance criteria.
- Repository context from `CONTEXT.md`.

Optional:

- `afk` label for unattended execution.
- PRD under `docs/prd/`.
- Milestone under `docs/milestones/`.
- Design, screenshot, or workflow reference.

## Loop

1. Select one eligible issue.
2. Read the issue, context docs, and relevant code.
3. Create or switch to a task branch.
4. Implement the smallest coherent change.
5. Run relevant tests and checks.
6. Capture visual evidence for UI-visible changes.
7. Open or update a pull request.
8. Link the issue.
9. Record verification and evidence in the PR.
10. Stop.

Do not continue into unrelated issues in the same loop. One loop handles one issue.

## AFK Behavior

For unattended runs:

- Only pick issues labeled `afk`.
- Mark the issue `afk-in-progress` when claimed.
- If blocked, comment with the blocker and remove `afk-in-progress`.
- If completed, open or update a PR and remove `afk-in-progress`.

Do not guess through missing product decisions. A blocked issue is better than a wrong implementation.

## Branch Naming

Use short descriptive branches, for example:

- `agent/issue-123-lead-import`
- `agent/issue-148-review-fix`

If the repo has a branch naming convention, follow it.

## Verification

Verification should match the change:

- Unit tests for logic.
- Integration tests for data and API behavior.
- Browser checks for UI workflows.
- Screenshots or videos for visual changes.
- Manual notes when automation is not practical.

Never write "tested" without saying how.

## PR Output

The PR body should include:

- Linked issue.
- Summary.
- Verification.
- Visual evidence.
- Known risks or follow-ups.
