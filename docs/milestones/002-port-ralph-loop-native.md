# Milestone 002 — Port `ralph-loop` to native Python execute loop

Source: `docs/superpowers/specs/2026-06-12-eliminate-bash-design.md` (M2).

## Outcome

`templates/scripts/ralph-loop` (207 lines) is deleted. `run/pipeline.py` natively handles agent invocation, retry, per-attempt verify, and prompt assembly. `run/proc.py:ralph_executor_path` is removed (or left a no-op tombstone). An `AGENTRAIL_NATIVE_EXECUTE=0` escape hatch back to the bash exists during cutover, then is removed after live validation.

## Why next

`ralph-loop` is the hot path for every `agentrail run` execution — the last bash subprocess in the critical execution path. Must land before M004 (the installer must not ship it).

## Testable proof

Live-agent validation on a throwaway issue with `AGENTRAIL_NATIVE_EXECUTE=1` (as the `run` #383 cutover did); `python -m pytest` green; `ralph-loop` absent.

## Likely issue slices

- Map `ralph-loop` behavior to `run/pipeline.py` entry points
- Extend `run/pipeline.py` with the native execute loop (agent invoke + retry + per-attempt verify)
- Add `AGENTRAIL_NATIVE_EXECUTE` escape hatch
- Live-agent validation on a throwaway issue
- Delete `templates/scripts/ralph-loop`; remove escape hatch; pytest green

## Blocked by

M001 — confirms the `pr` subcommands `ralph-loop` calls are native first.
