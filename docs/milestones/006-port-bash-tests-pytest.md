# Milestone 006 — Port bash test suite to pytest (continues #401/#424)

Source: `docs/superpowers/specs/2026-06-12-eliminate-bash-design.md` (M6).

## Outcome

All 26 `scripts/test-*` files (~6,286 lines) are either replaced by pytest equivalents or confirmed minimal-residual bash invoked from a pytest wrapper. The `npm test` chain no longer references bash test files that have pytest equivalents. Genuinely irreducible shipping-surface checks (npm pack, file modes, real `gh`/install materialization) are ported where feasible or kept as thin bash called from pytest.

## Why parallel with M001

The bash test suite is independent of the runtime flow — migration can proceed issue-by-issue while M001–M005 land. Continues the existing #401/#424 effort.

## Testable proof

`python -m pytest` covers all behaviors previously in the migrated bash tests; removed bash files are absent; any residual bash is called from a pytest wrapper; `npm test` passes.

## Likely issue slices

(one issue per migrated file or logical group)

- Port `test-promote-unblocked-issues` → pytest
- Port `test-runner-adapter` → pytest
- Port `test-resume-handoff` → pytest
- Port `test-worktree-cleanup` → pytest
- Port `test-skill-resolution` + `test-skill-registry-validation` → pytest
- Port `test-context-*` group (7 files) → pytest
- Port `test-prompt-generation` → pytest
- Port `test-doctor` + `test-upgrade` → pytest
- Port `test-install` + `test-install.sh` → pytest (shipping-surface: npm pack, file modes, `gh`)
- Port remaining files (`test-mcp`, `test-label-sync`, `test-public-positioning`, etc.) → pytest
- Remove each migrated file from the `npm test` chain; final pytest green

## Blocked by

None — can start immediately, in parallel with M001.
