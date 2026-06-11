# Milestone 001 — Port `pr` script to native Python

Source: `docs/superpowers/specs/2026-06-12-eliminate-bash-design.md` (M1).

## Outcome

`templates/scripts/pr` (1,323 lines) is deleted. Every subcommand (`review-init`, `review-checkout-main`/`-pr`, `review-guard`, `review-artifacts-init`, `review-validate-artifacts`, `review-tests`, `prepare-init`/`-validate-commit`/`-gates`/`-push`, `merge-verify`, `merge-run`) either has confirmed native coverage in `afk/runner.py`/`internal.py` or is ported into a native `agentrail/pr/` module. Agents that invoke `pr` via printed instructions are updated to the native paths.

## Why first

Largest bash file → biggest bug surface. Pure logic, no live-agent validation needed. Map-then-delete against existing native coverage keeps new code minimal. Can run in parallel with M006.

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
