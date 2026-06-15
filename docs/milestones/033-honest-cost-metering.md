# Milestone 033: Honest Cost Metering + Falsifiable Cost Surface

## Source PRD

[agentrail#767](https://github.com/Bensigo/agentrail/issues/767) — Verification-contract loop.

## Required Context

- `CONTEXT.md`: **Cost Meter**, **Cost-per-Issue-to-Green**; the console display rule (only falsifiable metrics); the one-sided savings surface is removed. See ADR 0009. Canonical price table with `cached_write` 1.25× / `cached_read` 0.1× lives in `agentrail/context/pricing.py`.
- Code area: `agentrail/run/usage_capture.py` (capture `cache_creation_input_tokens`), `agentrail/run/pricing.py`, `agentrail/run/cost_push.py`, `packages/db-clickhouse` (`cost_events` add `cache_creation_tokens` column via additive ALTER), `apps/console` cost surface.
- `TASTE.md`: console cost surface follows dense observability patterns; before/after screenshots required.

## Outcome

Cache-write tokens are captured and priced (they were previously dropped), real **Cost-per-Issue-to-Green** is shown, the cache read-to-creation ratio is surfaced, and the one-sided "savings" widget is removed from the console.

## Users

- Startup engineer who needs to know real per-issue cost and whether caching helps.

## Vertical Scope

- Data/storage: add `cache_creation_tokens` to `cost_events` (additive ALTER + migration registration).
- Domain logic: Cost Meter — capture cache-creation, apply multipliers, compute Cost-per-Issue-to-Green + read/creation ratio.
- UI: console cost surface shows real cost; remove savings widget.
- Tests: Cost Meter unit tests.

## Acceptance Criteria

- [ ] AC1: `cache_creation_input_tokens` is captured from the agent transcript.
- [ ] AC2: Cost math applies write 1.25× / read 0.1×, matching the canonical price table.
- [ ] AC3: `cost_events` has a `cache_creation_tokens` column via additive migration.
- [ ] AC4: Cost-per-Issue-to-Green and the read-to-creation ratio are computed and shown.
- [ ] AC5: The one-sided savings widget is removed from the console.
- [ ] AC6: Before/after console screenshots (desktop + mobile).

## Test Plan

- Unit: Cost Meter — token capture incl. cache-creation; multiplier/ratio math; parity with `agentrail/context/pricing.py`.
- Migration: column-exists check.

## Likely Issue Slices

- Capture `cache_creation` in `usage_capture`; price it in `run/pricing`.
- `cost_events` `cache_creation_tokens` column + migration.
- Cost-per-Issue-to-Green + read/creation ratio read model.
- Console: remove savings widget, show real cost.

## Blocked By

None.
