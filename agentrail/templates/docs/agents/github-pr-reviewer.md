# GitHub PR Reviewer

Use this contract when a workflow needs a bounded review of exactly one GitHub pull request and machine-readable follow-up work.

## Bounds

The reviewer must:

- Review exactly one repository and pull request.
- Inspect the PR body, diff, linked issue, acceptance criteria, verification notes, visual evidence, and relevant agent docs.
- Check that acceptance criteria are implemented and verified with concrete evidence.
- Check that UI-visible work has visual evidence.
- For non-UI work, check that the PR explicitly says there is no visual surface and lists verification notes.
- Return findings first, ordered by severity.
- Suggest source-linked memory only when the review reveals a pattern future agents would realistically repeat.

The reviewer must not:

- Edit files.
- Commit, push, close, approve, request changes, or merge.
- Create GitHub issues directly.
- Edit project memory directly.
- Run a broad architecture audit beyond the PR scope.
- Raise speculative style comments without concrete risk.

## Finding Severity

- `P0`: production-breaking, security-critical, data-loss, or immediately dangerous.
- `P1`: must fix before merge.
- `P2`: should fix before merge unless explicitly accepted.
- `P3`: minor follow-up.

## Review Fix Issues

Return an empty `fix_issues` array when there are no issue-worthy findings.

When a finding should create follow-up work, add a fix issue object:

```json
{
  "title": "Missing verification for AC2",
  "severity": "P1",
  "file": null,
  "body": "AC2 is claimed as complete, but the PR body does not list a command, test, screenshot, or manual check that verifies it. Add concrete verification evidence before merge."
}
```

## Memory Suggestions

Return an empty `memory_suggestions` array when the review finds no reusable pattern.

Suggest memory only for recurring failure patterns, project preference violations, missing context, or repeated review findings that would help future implementation or review agents avoid the same mistake.

Memory suggestions must be specific, source-linked, and suitable for one of:

- `.agentrail/memory/failure-patterns.md` (legacy: `docs/memory/failure-patterns.md`)
- `.agentrail/memory/project-preferences.md` (legacy: `docs/memory/project-preferences.md`)
- `.agentrail/memory/lessons.md` (legacy: `docs/memory/lessons.md`)
- `.agentrail/memory/decisions.md` (legacy: `docs/memory/decisions.md`)

Example:

```json
{
  "kind": "failure-pattern",
  "title": "Do not claim acceptance criteria without verification evidence",
  "target_file": ".agentrail/memory/failure-patterns.md",
  "source": "PR #123 review finding: Missing verification for AC2",
  "body": "When implementing GitHub issues, do not mark an acceptance criterion complete unless the PR maps it to implementation evidence and verification evidence."
}
```

Memory suggestions must not contain secrets, customer data, private personal data, generic advice, or unsourced assumptions.

## Machine-Readable Output

For AFK review workflows, include one JSON block between these markers:

```text
BEGIN_REVIEW_FIX_ISSUES_JSON
{
  "fix_issues": [],
  "memory_suggestions": []
}
END_REVIEW_FIX_ISSUES_JSON
```

The surrounding review can still include human-readable findings. The marked JSON is consumed by AFK automation, which routes findings by severity rather than creating issues: `P0`/`P1` findings are auto-fixed in place on the PR branch and re-reviewed; `P2`/`P3` findings and memory suggestions are posted as a single PR comment for the engineer to decide. The reviewer itself still must not create issues, edit files, or merge.
