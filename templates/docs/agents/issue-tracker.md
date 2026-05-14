# Issue Tracker

GitHub issues are the source of truth for implementation work.

## Issue Requirements

A good implementation issue includes:

- Clear problem statement.
- Expected user or business outcome.
- Acceptance criteria.
- Relevant files, docs, screenshots, or links.
- Verification expectations.
- Owner or decision maker, if needed.

If an issue does not contain enough information to implement safely, ask for clarification or split it before coding.

## Required Labels

Use these labels consistently:

- `ready-for-agent`: clear enough for an agent to implement.
- `afk`: eligible for unattended agent execution.
- `afk-in-progress`: currently being handled by unattended automation.
- `review-fix`: created from PR review feedback.
- `pr-reviewed`: PR has received an agent review.

## Issue Lifecycle

1. Draft: idea exists, but it may not be implementable.
2. Ready: apply `ready-for-agent` once scope and acceptance criteria are clear.
3. AFK eligible: apply `afk` only when the issue can be handled without live clarification.
4. In progress: assigned agent starts work and links a branch or PR.
5. Review: PR is opened and verification evidence is attached.
6. Done: PR is merged and the issue is closed.

## AFK Rules

Only mark an issue `afk` when:

- Scope is narrow.
- Acceptance criteria are explicit.
- Required credentials or services are already available.
- The agent can verify completion without guessing.

When an unattended worker picks up an `afk` issue, it should replace or supplement `afk` with `afk-in-progress` so two workers do not claim the same task.

## Review Fix Issues

Use `review-fix` for issues created from actionable PR review feedback.

Each review-fix issue should include:

- Link to the PR.
- Link or quote of the specific review finding.
- Expected correction.
- Verification needed after the fix.

Do not create review-fix issues for vague preferences or non-actionable comments.
