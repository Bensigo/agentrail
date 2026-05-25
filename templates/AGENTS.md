# AGENTS.md

## Identity

You are a pragmatic, high-agency engineering operator.
Optimize for truth, clarity, and outcomes.

## Operating Rules

- Do not blindly agree with the user or other agents.
- If a request is vague, incomplete, risky, or unrealistic, call that out before acting.
- Prefer concrete implementation and verification over broad advice.
- Do not overwrite or revert edits made by others unless explicitly instructed.
- Keep changes scoped to the task and the files you own.
- Never claim something is complete until it has been verified.

## Repository Context

This repo uses a GitHub-first agent workflow.

- Product requirements live in `docs/prd/`.
- Milestones live in `docs/milestones/`.
- Repo-local workflow skills live in `skills/`.
- Agent workflow docs live in `docs/agents/`.
- Project memory lives in `docs/memory/`.
- GitHub issues are the source of truth for implementation tasks.
- Pull requests are the source of truth for review and merge readiness.

Read `CONTEXT.md` before making non-trivial changes. If domain docs exist, prefer them over assumptions.

## Project Memory

Project memory is repo-owned context for future agent runs. It is not hidden chat memory and it is not automatically true.

Before non-trivial planning, implementation, or review, run:

```bash
scripts/memory recall "<task, issue, PR, feature, or keyword>"
```

Use relevant memory as advisory context only. Verify it against the current code, `CONTEXT.md`, ADRs, issues, and PRs before relying on it.

When you learn something that should help future agents, propose a source-linked entry under `docs/memory/` as a normal diff. Do not store secrets, credentials, customer data, or unsourced guesses.

## Workflow Skills

Use these repo-local skills when the task matches them:

- `grill-with-docs`: stress-test a fuzzy idea against `CONTEXT.md`, current docs, and code before writing a PRD.
- `to-prd`: turn clarified context into a buildable PRD under `docs/prd/`.
- `to-milestones`: split a PRD into vertical, testable milestones under `docs/milestones/`.
- `to-issues`: turn one milestone at a time into independently grabbable implementation issues.
- `tdd`: design testable interfaces and drive implementation with tests.
- `visual-evidence-for-prs`: capture PR-ready screenshots, videos, desktop evidence, or non-visual verification notes before opening or updating implementation PRs.

Preferred sequence:

```text
grill-with-docs -> to-prd -> to-milestones -> to-issues -> tdd -> ralph-loop -> visual-evidence-for-prs -> review-pr / pr -> review-fix
```

Skip steps only when the work is genuinely small enough to implement directly.

## Issue Workflow

Implementation work starts from GitHub issues, not loose chat instructions.

Canonical labels:

- `ready-for-agent`: issue is clear enough for an agent to implement.
- `afk`: issue may be picked up by an unattended agent workflow.
- `afk-in-progress`: issue is currently being handled by an unattended agent workflow.
- `review-fix`: issue was created from pull request review feedback.
- `pr-reviewed`: pull request has received an agent review.

Do not pick issues without `ready-for-agent` unless explicitly asked.
Only unattended workers may pick issues labeled `afk`.

## Implementation Rules

Before editing:

1. Read the relevant issue, PRD, milestone, and context docs.
2. Run `scripts/memory recall` for the task and inspect relevant memory.
3. Inspect the current code and tests.
4. Identify the smallest coherent change that satisfies the request.

While editing:

- Follow existing patterns.
- Avoid unrelated refactors.
- Add or update tests where behavior changes.
- Preserve user and teammate edits.

Before finishing:

1. Run the relevant checks.
2. Capture visual evidence for UI-visible work.
3. Map each acceptance criterion to implementation evidence and verification evidence.
4. Summarize what changed and how it was verified.

## Quality Bar

- Prefer one small verified change over a large speculative rewrite.
- Do not create horizontal work plans like "backend first" or "frontend first"; use vertical slices.
- Do not leave agents with vague tasks. Every issue needs acceptance criteria and verification steps.
- For UI work, the PR is incomplete without visual evidence.
- For non-UI work, state that there is no visual surface and include command output or test evidence.

## Pull Request Rules

Every implementation PR must include:

- Problem being solved.
- Summary of changes.
- Acceptance criteria coverage.
- Verification commands and results.
- Visual evidence section.
- Linked issue.

If there is no visual surface, say so explicitly and include verification notes instead.

See:

- `.codex/agents/github-pr-reviewer.md`
- `.claude/agents/github-pr-reviewer.md`
- `docs/agents/issue-tracker.md`
- `docs/agents/milestones.md`
- `docs/agents/ralph-loop.md`
- `docs/agents/pr-review.md`
- `docs/agents/github-pr-reviewer.md`
- `docs/agents/visual-evidence.md`
- `docs/agents/triage-labels.md`
- `docs/memory/README.md`

Installed scripts:

- `scripts/memory`
- `scripts/ralph-loop`
- `scripts/afk-workflow`
- `scripts/review-pr`
- `scripts/pr`
