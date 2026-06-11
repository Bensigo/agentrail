# Milestone 003 — Port `review-pr` to native Python

Source: `docs/superpowers/specs/2026-06-12-eliminate-bash-design.md` (M3).

## Outcome

`templates/scripts/review-pr` (423 lines) is deleted. `agentrail internal review-pr` routes through native Python in `internal.py` (and a new `afk/review.py` helper) instead of shelling out. Review invocation and artifact handling are native.

## Why next

`internal.py` currently `subprocess.run`s the bash review script. Once `ralph-loop` is native (M002), this is the only remaining bash subprocess in the non-installer flow.

## Testable proof

Live-agent validation on a throwaway PR; `python -m pytest` green; `review-pr` absent.

## Likely issue slices

- Map `review-pr` logic to `internal.py` + `afk/review.py` helpers
- Port review invocation + artifact handling natively
- Add `AGENTRAIL_NATIVE_REVIEW=0` escape hatch
- Live-agent validation on a throwaway PR
- Delete `templates/scripts/review-pr`; remove escape hatch; pytest green

## Blocked by

M002.
