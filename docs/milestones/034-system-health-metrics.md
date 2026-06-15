# Milestone 034: System-Health Metrics (Accept Rate, Escalation Rate)

## Source PRD

[agentrail#767](https://github.com/Bensigo/agentrail/issues/767) — Verification-contract loop.

## Required Context

- `CONTEXT.md`: **Metrics read-model**; the console display rule — no metric that cannot come back negative; accept rate > 50% is the health line. See ADR 0009.
- Code area: `agentrail/server` read models; `apps/console`.
- `TASTE.md`: dense observability surface; screenshot evidence required.

## Outcome

The console shows accept rate (issues that passed the Objective Gate ÷ attempted) and escalation rate, both falsifiable, and a check confirms no console metric remains that cannot come back negative.

## Users

- Team lead deciding whether the loop is winning (>50% accepted) or losing.

## Vertical Scope

- Domain logic: accept-rate and escalation-rate read models.
- UI: console health surface.
- Tests: read-model aggregation tests over fixture events.

## Acceptance Criteria

- [ ] AC1: Accept rate is computed (green ÷ attempted) and can display a value below 50%.
- [ ] AC2: Escalation rate is computed and shown.
- [ ] AC3: An audit confirms no remaining console metric is non-falsifiable (cannot go negative).
- [ ] AC4: Console screenshots (desktop + mobile).

## Test Plan

- Unit: accept-rate / escalation-rate aggregation over fixture cost/run events.

## Likely Issue Slices

- Accept-rate read model + tests.
- Escalation-rate read model + tests.
- Console health surface.
- Falsifiable-metric audit pass across console.

## Blocked By

Milestone 033.
