# PR Review

PR review exists to catch defects, unclear behavior, missing verification, and avoidable operational risk.

Review should be direct and actionable. Do not use review as a place for vague taste comments.

For bounded custom subagent runs, see `docs/agents/github-pr-reviewer.md`.

## Review Priorities

Inspect in this order:

1. Correctness and regressions.
2. Security, privacy, and data loss risk.
3. Missing tests or weak verification.
4. Product behavior mismatches.
5. Maintainability issues that will matter soon.
6. Style only when it affects clarity or consistency.

## Required Review Checks

Confirm:

- PR links the relevant issue.
- Scope matches the issue.
- Relevant project memory was recalled or the PR explains why none applied.
- Acceptance criteria are satisfied.
- PR includes an acceptance criteria coverage table.
- Each acceptance criterion has concrete implementation evidence.
- Each acceptance criterion has verification evidence.
- Verification commands or manual checks are listed.
- UI-visible work includes visual evidence.
- Memory changes, if present, are source-linked and not generic advice.
- No unrelated files or refactors are included.
- No secrets, credentials, or sensitive customer data are committed.

## Acceptance Criteria Coverage

Treat the linked issue's acceptance criteria as the review contract. For each criterion:

- Confirm the PR body maps it to implementation evidence.
- Confirm the listed verification actually proves the criterion.
- Inspect the diff when the PR body evidence is vague or overstated.
- File a finding when any criterion is missing, only partially implemented, or verified by assertion instead of evidence.

Missing or weak acceptance criteria coverage is at least a `P1` when it blocks knowing whether the issue is actually complete. Use `P2` only when the gap is narrow and the implemented behavior is still clearly correct.

## Project Memory Checks

Before reviewing, run:

```bash
scripts/memory recall "<PR title, linked issue, feature, or key terms>"
```

Use relevant memory to check whether the PR repeats known mistakes or violates source-linked project preferences. Memory is advisory: if it conflicts with current code, `CONTEXT.md`, ADRs, the issue, or the PRD, call out the conflict and prefer the current source of truth.

Block memory changes when they are unsourced, too broad to be useful, duplicate canonical docs, or contain secrets, customer data, credentials, or private personal data.

## Memory Pattern Check

For each `P0`, `P1`, or `P2` finding, classify whether it is:

- One-off defect.
- Recurring failure pattern.
- Project preference violation.
- Missing context or decision.
- Unclear acceptance criteria.

If the finding is a recurring failure pattern, project preference violation, or missing context that future agents would realistically repeat, propose a source-linked memory entry for `docs/memory/failure-patterns.md`, `docs/memory/project-preferences.md`, or the appropriate memory file.

Do not propose memory for generic engineering advice, speculative preferences, or one-off mistakes. Memory suggestions must cite the source PR, issue, review finding, ADR, or file that proves the pattern.

## Finding Format

Use this structure for actionable findings:

- Severity: `P0`, `P1`, `P2`, or `P3`.
- File and line, when possible.
- Concrete problem.
- Why it matters.
- Suggested correction.

Severity guide:

- `P0`: must fix immediately; breaks production, security, or data integrity.
- `P1`: must fix before merge.
- `P2`: should fix before merge unless explicitly accepted.
- `P3`: minor improvement or follow-up.

## Review Output Routing

After an agent review is complete, apply `pr-reviewed` to the PR or linked tracking issue if the workflow supports it.

- `P0` findings must create a new GitHub issue labeled `review-fix` and `ready-for-agent`.
- Non-`P0` findings should be left as PR review comments unless the maintainer explicitly wants a tracking issue.
- Recurring failure patterns should create a memory suggestion issue labeled `memory-suggestion` and `ready-for-agent`, not silently edit memory.
- Do not bury production-breaking, security, data-loss, or merge-blocking findings in PR comments only.

For workflow automation, include a machine-readable block when fix issues or memory suggestions are needed:

```text
BEGIN_REVIEW_FIX_ISSUES_JSON
{
  "fix_issues": [],
  "memory_suggestions": []
}
END_REVIEW_FIX_ISSUES_JSON
```

## Non-Findings

Do not block a PR for:

- Personal style preferences.
- Broad rewrites unrelated to the issue.
- Speculative architecture concerns without concrete risk.
- Missing work that was explicitly out of scope.

Document those as follow-ups only when they are worth tracking.
