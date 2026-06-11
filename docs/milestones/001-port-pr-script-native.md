# Milestone 001 — Delete the `pr` script (DONE — #427 / PR #433)

Source: `docs/superpowers/specs/2026-06-12-eliminate-bash-design.md` (M1).

> **Resolved as DELETE, not port.** The #427 audit found `templates/scripts/pr` is
> **not** agentrail's flow and **not** duplicated in the AFK runner — it's a
> 1,323-line PR-lifecycle helper hardcoded to a dead prototype project's
> conventions (`openclaw#N` subjects, `pnpm vitest`, CHANGELOG enforcement) with
> **no runtime caller**. So M1 deleted it rather than porting. The one useful
> behavior it held (`promote_unblocked_issues_after_merge`) is tracked as a
> follow-up to add natively to the AFK runner.

## Outcome (as delivered)

`templates/scripts/pr` and `scripts/test-promote-unblocked-issues` deleted; deregistered from the doctor source manifest + `test-install` checks; dropped from the npm test chain. `scripts/pr` kept in `LEGACY_SCRIPT_PATHS` so doctor still cleans up stale copies in old installs. pytest green; `test-install` passes.

## Testable proof

`python -m pytest` green; a native equivalent of each ported subcommand produces the same result as the bash original on fixture PRs (mocked `gh`/`git`); `templates/scripts/pr` is absent.

## Likely issue slices

- Audit every `pr` subcommand against native coverage → `COVERED`/`GAP` map
- Port GAP: `promote_unblocked_issues_after_merge`
- Port GAP: blocker-number extraction + merge gates
- Port GAP: artifact validation + `wait_for_pr_head_sha`
- Port GAP: merge author-email retry
- Update agent-facing printed instruction strings to native paths
- Delete `templates/scripts/pr`; pytest green

## Blocked by

None — can start immediately.
