# Milestone 036: Escalate-on-Failure Cascade + Budget Leash

## Source PRD

[agentrail#767](https://github.com/Bensigo/agentrail/issues/767) — Verification-contract loop.

## Required Context

- `CONTEXT.md`: **Budget Leash** (per-issue ceiling + escalation-attempt limit), **Compaction / Failure-Handoff builder**, escalate-on-failure (difficulty revealed, not predicted), escalation as an **Issue Queue** transition. See ADR 0011.
- Code area: `agentrail/run` routing/escalation; new Budget Leash + Compaction builder; queue transition (M035).
- `TASTE.md`: No new console surface beyond the queue view (M035) showing escalation/budget state.

## Outcome

The cheap model runs first; on an Objective Gate failure the issue escalates to a stronger model carrying a compacted failure handoff (goal + attempted diff + exact gate error); a per-issue cost ceiling plus an escalation-attempt limit bound total spend and route a hopeless issue to escalated-to-human — never an infinite retry.

## Users

- Startup engineer who needs the loop safe to leave unattended without unbounded spend.

## Vertical Scope

- Domain logic: Budget Leash (continue/escalate/stop-to-human); Compaction builder; cheap-first routing.
- API/routes: escalation modeled as a queue transition (re-enqueue at higher tier, decremented budget).
- Tests: Budget Leash + Compaction builder unit tests.

## Acceptance Criteria

- [ ] AC1: The first attempt runs on the cheap model.
- [ ] AC2: On gate failure with budget remaining, the issue escalates to the stronger model with a compacted handoff.
- [ ] AC3: The handoff preserves failure-relevant context (error, failing region, attempt) and drops redundant exploration.
- [ ] AC4: A per-issue cost ceiling and escalation-attempt limit are enforced.
- [ ] AC5: Exhausting the budget routes the issue to escalated-to-human with state preserved; it never retries forever.

## Test Plan

- Unit: Budget Leash — continue under budget, escalate on gate-fail with budget left, stop-to-human when exhausted/attempt-limit hit; Compaction builder — preserves failure-relevant content.
- Manual: a hard demo issue escalates then stops-to-human.

## Likely Issue Slices

- Budget Leash module + tests.
- Compaction / Failure-Handoff builder + tests.
- Cheap-first routing + escalation queue transition.

## Blocked By

Milestone 035.
