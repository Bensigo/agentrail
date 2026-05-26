# Triage Labels

Use labels as workflow state, not decoration.

## Canonical Labels

### `ready-for-agent`

The issue is clear enough for an agent to implement.

Apply when:

- Acceptance criteria are explicit.
- Scope is bounded.
- Required context is linked or available.
- Verification expectations are clear.

Do not apply when the issue still needs product decisions.

Do not apply while the issue has open blockers in its `## Blocked by` section. Merge tooling may apply this label automatically after the blocking PR closes its issue and all listed blockers are closed.

### `afk`

The issue can be picked up by an unattended agent workflow.

Apply when:

- The issue already has `ready-for-agent`.
- The task does not require live clarification.
- The agent can run or describe enough verification.
- The blast radius is acceptable for unattended work.

### `afk-in-progress`

An unattended worker has claimed the issue.

Use this to prevent duplicate work.
Remove it when the worker is blocked or has opened the implementation PR.

### `review-fix`

The issue was created from actionable PR review feedback.

Apply when:

- The review finding is concrete.
- The fix is scoped.
- The originating PR is linked.

### `memory-suggestion`

The issue proposes source-linked project memory from review or implementation feedback.

Apply when:

- The source issue, PR, review finding, ADR, or file is linked.
- The proposed memory entry uses the standard `docs/memory/` format.
- The lesson is specific enough to help future agents avoid a repeated mistake or preserve a real project preference.

Do not apply to generic engineering advice, unsourced guesses, secrets, customer data, or private personal data.

### `pr-reviewed`

The PR has received an agent review.

Apply after:

- Review findings have been posted, or
- The reviewer found no blocking issues.

This label does not mean the PR is approved by a human owner.

## Label Hygiene

- Keep labels mutually useful and low in number.
- Do not create near-duplicates.
- Remove stale state labels.
- Prefer comments for nuance and labels for workflow state.
