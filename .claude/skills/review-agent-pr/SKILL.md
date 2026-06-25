---
name: review-agent-pr
description: Adversarially review a PR produced by AgentRail's own AFK / autonomous-loop / self-hosted runner before merging it. Use when verifying or merging a PR on an agentrail/issue-*, afk/github-*, or feat/issue-* branch, when a dashboard run shows success/failed, or when the user asks whether a loop/AFK/runner PR is mergeable. The loop ships plausible green-CI PRs that fail review — never merge on green CI alone.
---

# Review an agent-generated PR

AgentRail's autonomous loop / AFK / runner produces PRs that look done (green CI, dashboard `success`) but routinely fail review in ways CI cannot catch. **CI green ≠ correct. Dashboard status ≠ CI.** Run this checklist before any merge.

## When this applies
- PR branch is `agentrail/issue-<n>`, `afk/github-<n>`, or `feat/issue-<n>-*`.
- A hosted-dashboard run reads `success`/`failed` or `green`/`escalated-to-human`.
- User says "is this loop/AFK PR mergeable" / "merge the runner PR".

## Checklist (make a TodoWrite item per box)

1. **Check REAL GitHub CI, not the dashboard.** Dashboard run status reflects only the runner's own verify/review gate, never GitHub Actions. They routinely disagree — a CI-broken PR can show `success`, a CI-green PR can show `failed`/`escalated-to-human` (the runner just spent its 2 retries and escalated by design). Run `gh pr checks <pr>` / `gh pr view <pr>`. Source: `recordRunnerResult` in `packages/db-postgres/src/queries/runner.ts`.

2. **Dedupe duplicate PRs for the same issue.** Retries open a NEW PR each attempt, and the agent's PR branch (`feat/issue-N-*`) differs from the dashboard's run branch (`afk/github-N`). Before merging, `gh pr list --search "issue-<n>"` and pick the right one; close the rest.

3. **Hunt unwired / dead code.** The single most common failure: a function/route/handler exists and is fully tested in isolation but is never wired into the runner path / no webhook registered (e.g. gateway-notify, two-way Telegram). Grep for the new symbol's call sites in the live path, not just its tests.

4. **Check the migration journal.** New Drizzle migrations silently no-op unless registered in `_journal.json` → column never created → first runtime error throws. Confirm any new SQL migration has its `_journal.json` entry. See memory `drizzle-migration-journal-gotcha`.

5. **Audit the verify gate for false-green holes** when the PR touches safety/flow code (`agentrail/run/verify_gate.py`, `pipeline.py`, `.agentrail/verify.sh`, queue state machine). The loop CANNOT reliably fix its own brakes. Known hole: diffing `git diff HEAD` (empty for committed changes) instead of the merge-base, so a committed change with no test passes. The change set must be the UNION of committed-on-branch (`merge-base(HEAD,origin/main)..HEAD`) AND uncommitted working tree. Empty change set must stay red. See `verify-gate-two-blockers`, `loop-output-needs-human-review`.

6. **Treat flow-critical / safety / wiring PRs as hand-fix-only.** If the PR modifies the verify gate, queue state machine, notify routing, or migration plumbing, do not let the loop self-certify it — review line-by-line and hand-fix. Scoped feature work is where the loop is trustworthy.

## How to review at scale
For a batch of agent PRs, dispatch parallel `feature-dev:code-reviewer` agents (one per PR) — that combination is what caught all four unmergeable PRs on 2026-06-22. Synthesize their findings against this checklist.

## Stopping condition
Merge only when: real GitHub CI is green, exactly one canonical PR remains, every new symbol is wired into a live path, migrations are journaled, and the verify-gate diff covers committed changes. Otherwise: hand-fix, or comment and bounce back to the queue.
