# Eliminate bash — native-Python flow + tests (keep only the launcher)

**Date:** 2026-06-12
**Status:** Approved design — pending spec review
**Absorbs:** #404 (installer installs config files, not flow scripts).
**Continues:** #401 / #424 (bash → pytest test migration).

## Problem

The 6,870-line `agentrail-legacy` bash was already ported to native Python and deleted, which removed a class of bugs (e.g. the `run batch` double-shift). But bash remains in two places: **runtime flow scripts** (`pr`, `ralph-loop`, `review-pr`, `install-workflow`, `memory`, `lib/timeout.sh`) and the **bash test suite** (26 files, ~6,286 lines). Bash quoting, `set -e` surprises, and portability gaps are a recurring, non-deterministic bug source. The goal is to remove bash entirely except the one piece that must be shell.

This also delivers #404: today the installer copies the flow scripts into a project (editable, forkable) and vendors a full editable CLI copy. Once the flow is native Python in the package, the installer can ship only project-owned files and the flow becomes immutable.

## Goals

- Replace every runtime flow script and the bash test suite with deterministic, unit-testable Python.
- Keep exactly one bash file: `scripts/agentrail` (the bootstrap launcher — it finds `python3` and execs `agentrail.cli.main`; it cannot be written in Python).
- Strangler-fig discipline: port → verify → **then** delete the bash. Never delete before parity.
- Close #404 as part of the install-workflow port.

## Non-goals

- Rewriting `scripts/agentrail` (the launcher stays bash).
- Changing agent behavior or the run/AFK semantics — this is a language port, not a redesign.
- A big-bang cutover. Each script is its own verified slice.

## Verification strategy (per slice)

- **Pure-logic ports** (`pr` gaps, `install-workflow`, `memory`, `timeout.sh`): byte/behavior parity against the bash + unit tests that mock `gh`/`git`/filesystem.
- **Agent-invoking ports** (`ralph-loop`, `review-pr`): you cannot mock the real agent, so each gets a **live-agent validation** on a throwaway issue/PR (as the `run` cutover did on #383), plus a temporary `AGENTRAIL_NATIVE_*=0` escape hatch back to the bash during cutover, removed once proven.
- Full `python -m pytest` (stdlib unittest-based) green before each deletion.

## Milestones (sequenced by value / risk)

### M1 — `pr`: audit → map → port gaps → delete
`templates/scripts/pr` (1,323 lines) is a PR-lifecycle dispatcher: `review-init`/`review-checkout-main`/`review-checkout-pr`/`review-guard`/`review-artifacts-init`/`review-validate-artifacts`/`review-tests`, `prepare-init`/`prepare-validate-commit`/`prepare-gates`/`prepare-push`, `merge-verify`/`merge-run`. It is invoked from the other flow scripts and by agents via printed instructions — **no Python caller**. The native `afk/runner.py` + `internal.py` already reimplement parts (merge, review, worktree mark).

1. Audit every subcommand against existing native coverage; produce a subcommand → {COVERED | GAP} map.
2. Port only the GAPs into native code (a new `agentrail/pr/` module or extensions to `afk`/`internal`). Load-bearing logic to preserve exactly: `promote_unblocked_issues_after_merge`, blocker-number extraction, merge gates, artifact validation, `wait_for_pr_head_sha`, merge author-email retry.
3. Delete `templates/scripts/pr` and any now-dead callers/printed-instructions.

### M2 — `ralph-loop` → native execute loop
The execute phase shells into `templates/scripts/ralph-loop` (207 lines) via `run/proc.py` (`ralph_executor_path`) + `run/pipeline.py`. Port the loop (agent invocation + retry + per-attempt verify + prompt assembly) into native Python (extend `run/pipeline.py`). Live-agent validation. `AGENTRAIL_NATIVE_EXECUTE=0` escape hatch during cutover. Delete `ralph-loop`.

### M3 — `review-pr` → native
`internal review-pr` execs `templates/scripts/review-pr` (423 lines). Port the review invocation + artifact handling into `internal.py` natively. Live-agent validation. Delete `review-pr`.

### M4 — `install-workflow` → native (absorbs #404)
Port `scripts/install-workflow` (334 lines: file copy + content-hash manifest) to native Python. Because M1–M3 moved the flow into the package, the installer now writes **only project-owned files** (docs/agents, `.claude`/`.codex` config, skills content, CONTEXT/TASTE scaffolding) and drops the `.agentrail/source` flow-script vendoring. Reproducible pinning handled by a recorded version + the launcher resolving the installed package (per #404 AC3). Delete `install-workflow`. **Closes #404.**

### M5 — `memory` + `timeout.sh` → native
`templates/scripts/memory` (102 lines) → native (the `memory` command already wraps it). `lib/timeout.sh` (51 lines) is already partly ported in `run/proc.py` (`portable_timeout`) — finish and delete. Low risk.

### M6 — Bash test suite → pytest
The 26 `scripts/test-*` files (~6,286 lines) → pytest, incrementally (continues #401/#424). Remove each from the `npm test` chain as it lands with equivalent assertions. Genuinely shipping-surface checks (npm pack, file modes, real `gh`/install materialization) are ported where feasible or kept as the minimal residual bash invoked from a pytest wrapper.

## What stays bash

`scripts/agentrail` only (28 lines) — the bootstrap launcher.

## Dependency order

M1 and M6 can start in parallel. M2 → M3 (load-bearing, live-validated, one at a time). M4 depends on M2/M3 (the flow must be native before the installer stops shipping it). M5 is cleanup, last. Each milestone is broken into tracer-bullet issues via `to-issues`.

## Open questions

- M1 audit: are any `pr` subcommands invoked by agents in a way that a Python port changes the agent-facing contract (printed instruction strings)? Preserve or update those deliberately.
- M4: exact reproducible-pinning mechanism (recorded version + launcher-resolves-installed-package vs a read-only/integrity-checked vendor dir) — decide during M4, consistent with #404 AC3.
- M6: which (if any) shipping-surface bash tests are irreducible and must stay as a thin bash invoked from pytest.
