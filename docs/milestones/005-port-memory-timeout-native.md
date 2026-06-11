# Milestone 005 — Port `memory` script + `timeout.sh` to native Python

Source: `docs/superpowers/specs/2026-06-12-eliminate-bash-design.md` (M5).

## Outcome

`templates/scripts/memory` (102 lines) and `templates/scripts/lib/timeout.sh` (51 lines, already partially ported in `run/proc.py:portable_timeout`) are deleted. The `memory` CLI command is fully native; `run/proc.py` has the complete portable-timeout implementation with no bash shim.

## Why last

Pure-logic ports, low risk, no live-agent validation. Both are already partly covered by native Python. Finishing them clears the last bash **runtime** files (only `scripts/agentrail`, the launcher, remains by design).

## Testable proof

`agentrail memory` works end-to-end in tests with no subprocess call to `templates/scripts/memory`; `run/proc.py` has full `portable_timeout` with no bash shim; `python -m pytest` green; both files absent.

## Likely issue slices

- Audit `memory` script vs `cli/commands/memory.py`; port any GAPs
- Finish `portable_timeout` in `run/proc.py`; remove any remaining bash shim
- Delete `templates/scripts/memory` and `lib/timeout.sh`; pytest green

## Blocked by

M004 — confirms the install path is clean before declaring all bash runtime deleted.
