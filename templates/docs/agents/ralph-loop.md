# Ralph Loop

The Ralph loop is a repeatable agent execution cycle for implementing one ready GitHub issue at a time.

It is designed for founder and small-team repos where agents need tight scope, visible progress, and reviewable output.

## Inputs

Required:

- One GitHub issue labeled `ready-for-agent`.
- Acceptance criteria.
- Repository context from `CONTEXT.md`.
- Relevant project memory from `scripts/agentrail memory recall`.

Optional:

- `afk` label for unattended execution.
- PRD under `docs/prd/`.
- Milestone under `docs/milestones/`.
- Design, screenshot, or workflow reference.

## Loop

1. Select one eligible issue.
2. Read the issue, context docs, and relevant code.
3. Run `scripts/agentrail memory recall "<issue title, feature, or key terms>"`.
4. Verify relevant memory against current code and docs before using it.
5. Create or switch to a task branch.
6. Implement the smallest coherent change.
7. Run relevant tests and checks.
8. Capture visual evidence for UI-visible changes.
9. Open or update a pull request.
10. Link the issue.
11. Record acceptance criteria coverage, verification, and evidence in the PR.
12. Stop.

Do not continue into unrelated issues in the same loop. One loop handles one issue.

## AFK Behavior

For unattended runs:

- Only pick issues labeled `afk`.
- Mark the issue `afk-in-progress` when claimed.
- If blocked, comment with the blocker and remove `afk-in-progress`.
- If completed, open or update a PR and remove `afk-in-progress`.

Do not guess through missing product decisions. A blocked issue is better than a wrong implementation.

## Project Memory

Project memory lives in `docs/memory/` and is searched through `scripts/agentrail memory recall`.

Use it to avoid repeated mistakes and preserve durable project preferences across agent runs. Treat it as advisory unless backed by current source links. If memory conflicts with code, `CONTEXT.md`, ADRs, the issue, or the PRD, stop and surface the conflict instead of guessing.

If implementation reveals a reusable lesson or decision, propose a source-linked memory entry in the PR. Do not silently add broad advice or unsourced assumptions.

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

## Acceptance Criteria Coverage

Every implementation PR must map the linked issue's acceptance criteria to concrete implementation and verification evidence. Use this table in the PR body:

```markdown
## Acceptance Criteria Coverage

| Criterion | Implementation Evidence | Verification |
|---|---|---|
| AC1 | <What changed to satisfy it> | <Test, check, screenshot, log, or manual path> |
| AC2 | <What changed to satisfy it> | <Test, check, screenshot, log, or manual path> |
```

If an acceptance criterion cannot be satisfied or verified, stop and mark the issue blocked instead of opening a PR that claims completion.

## PR Output

The PR body should include:

- Linked issue.
- Summary.
- Acceptance criteria coverage.
- Verification.
- Visual evidence.
- Memory updates, if any.
- Known risks or follow-ups.
