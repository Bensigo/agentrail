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
- Durable AgentRail state lives in `.agentrail/state.json`.
- GitHub issues are the source of truth for implementation tasks.
- Pull requests are the source of truth for review and merge readiness.

Read `CONTEXT.md` before making non-trivial changes. Then read `TASTE.md` when present, especially for product, UI, copy, interaction, or visual evidence decisions. If domain docs exist, prefer them over assumptions.

## Project Memory

Project memory is repo-owned context for future agent runs. It is not hidden chat memory and it is not automatically true.

Before non-trivial planning, implementation, or review, run:

```bash
agentrail memory recall "<task, issue, PR, feature, or keyword>"
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

AgentRail also installs curated first-party skills for common implementation contexts, such as frontend web, Tauri desktop, backend APIs, devops/deploy work, and current-docs verification. These are reviewed local files under `skills/`, not arbitrary third-party hot installs.

Skill supply-chain rule: borrow aggressively, vendor carefully, update intentionally, never auto-trust. Treat upstream skill repositories as provenance candidates until reviewed. When updating provenance, verify the upstream source still exists before editing docs/agents/skill-registry.json, record the source URL and observed commit or content SHA when available, check license/audit status, update the local vendored skill deliberately, and include verification evidence in the PR.

Preferred sequence:

```text
grill-with-docs -> to-prd -> to-milestones -> to-issues -> tdd -> agentrail run issue -> agentrail prompt review -> review-fix
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
2. Read `TASTE.md` when present and relevant to product quality, UI, copy, interaction, or visual evidence.
3. Run `agentrail status`, then `agentrail resume` when recovering an interrupted or compacted run.
4. Run `agentrail memory recall` for the task and inspect relevant memory.
5. Inspect the current code and tests.
6. Identify the smallest coherent change that satisfies the request.

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

- `docs/agents/issue-tracker.md`
- `docs/agents/agentrail-state.md`
- `docs/agents/milestones.md`
- `docs/agents/ralph-loop.md`
- `docs/agents/pr-review.md`
- `docs/agents/visual-evidence.md`
- `docs/agents/triage-labels.md`
- `docs/memory/README.md`

AgentRail CLI:

- Use `agentrail status` to inspect durable workflow state before starting new work.
- Use `agentrail resume` after interruption, chat compaction, or session handoff.
- Use `agentrail memory recall` for project memory.
- Use `agentrail run` to let AgentRail pick the next eligible queued issue from state.
- Use `agentrail run issue <number>` for bounded implementation of a known issue.
- Use `agentrail afk` for the unattended queue/worktree loop.
- Use `agentrail prompt review <number>` to generate review prompts.
- Use `agentrail doctor` and `agentrail upgrade` for install health and migration.

AgentRail is the harness. The configured runner is the worker. Ralph is the internal one-issue executor invoked by `agentrail run issue`. AFK is the queue/worktree loop invoked by `agentrail afk`.

Raw workflow helpers are AgentRail internals. Do not call Ralph, AFK, PR, review, or memory scripts directly from an installed project unless a maintainer is debugging AgentRail itself.
