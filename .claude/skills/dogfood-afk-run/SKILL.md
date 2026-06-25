---
name: dogfood-afk-run
description: Safely launch, monitor, and stop an `agentrail afk` dogfood run against AgentRail's own GitHub issues. Use when the user wants to run AFK on agentrail's own tickets, dogfood the loop, kick off a batch run, or stop a running AFK orchestrator. Covers the footguns that previously wiped dev config and left zombie orchestrators.
---

# Dogfood an AFK run on AgentRail itself

`agentrail afk` drives the autonomous loop over labeled GitHub issues. Running it against agentrail's OWN repo is the primary dogfood path — but it mutates working trees and is easy to launch/stop wrong. Follow this exactly.

## Preconditions (all required)

1. **Run from a SEPARATE clean clone**, never your working checkout. AFK manipulates the main repo's HEAD/working tree during review and silently discards uncommitted changes (this wiped the user's dev-env config twice). `git clone https://github.com/Bensigo/agentrail <dir>` — clone the GitHub URL so `origin` + `gh` work; AFK bases worktrees on `origin/main`, so push any fix you depend on first. See `afk-mutates-main-working-tree`, `afk-worktree-base-is-origin`.
2. **Label issues** `afk` **AND** a queue label (`ready-for-agent` or `review-fix`). The selector `agentrail/afk/github.py:list_queue_issues` requires both. Prune stale/completed tracking issues that still carry `afk` or they get re-implemented.
3. **`AGENTRAIL_ALLOW_SOURCE_RUN=1`** — the target IS the agentrail source, so the source-checkout guard otherwise refuses.

## Launch

1. **Dry-run first, always:** `cd <clone> && AGENTRAIL_ALLOW_SOURCE_RUN=1 ./scripts/agentrail afk --dry-run` — prints exactly which issues it will pick. Verify the list before spending tokens.
2. Real run: `cd <clone> && AGENTRAIL_ALLOW_SOURCE_RUN=1 ./scripts/agentrail afk --base main --concurrency 2`. Engine defaults to `claude` (must be on PATH + authed). State: `<clone>/.agentrail/afk/state.json`.

## While it runs
- **Do NOT manually `gh pr merge`** an issue's PR while the run is alive — AFK's idempotency only sees its own view, so it re-implements and opens a conflicting duplicate. Let the run own merges (it auto-merges clean PRs). See `dont-manual-merge-during-afk-run`.
- Review its output adversarially before trusting any merge — use the `review-agent-pr` skill. CI-green loop PRs are frequently unmergeable.

## Stop it correctly
`pkill -f 'agentrail afk'` does NOT work — the real cmdline is `agentrail.cli.main afk`, and per-issue workers are `agentrail.cli.main run`. Use:
```
pkill -9 -f 'cli.main afk'; pkill -9 -f 'cli.main run'; pkill -9 -f 'caffeinate'
ps aux | grep -E 'cli.main (afk|run)'   # confirm none survive
```
Missing this left 3 zombie orchestrators that kept claiming issues and opening PRs after a "stop". See `afk-pkill-pattern-gotcha`.

## After the run
- Confirm no orchestrator survives (above), THEN reconcile/merge manually.
- Check `git status` / `git reflog` on the clone's main for stranded uncommitted agent output before any further git op — preserve it to a branch immediately if found.

## Stopping condition
Run is done when the process list is empty, every claimed issue has exactly one reviewed PR, and no uncommitted work is stranded on main.
