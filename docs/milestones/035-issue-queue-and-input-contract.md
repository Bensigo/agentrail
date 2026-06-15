# Milestone 035: Issue Queue + Input Contract

## Source PRD

[agentrail#767](https://github.com/Bensigo/agentrail/issues/767) — Verification-contract loop.

## Required Context

- `CONTEXT.md`: **Issue Queue** (concurrency-bounded, carries tier/budget/state), **Run Outcome** terminal states (green / escalated-to-human / blocked, never infinite retry), **Issue Input-Contract validator**. See ADR 0010.
- Code area: `agentrail/afk` (existing run state/slots), new queue state machine + input-contract validator; `apps/console` queue view.
- `TASTE.md`: queue view follows dense observability patterns; screenshot evidence required.

## Outcome

Issues enter a concurrency-bounded queue only if they carry machine-checkable acceptance criteria; each issue moves through a state machine to exactly one terminal state (green, escalated-to-human, or blocked) and never retries forever; the queue is visible on the dashboard with each issue's tier, budget, and state.

## Users

- Team lead watching what is queued, running, escalated, blocked, or done.

## Vertical Scope

- Domain logic: Issue Queue state machine; Input-Contract validator.
- Data/storage: queue/state persistence (extend existing AFK state).
- UI: queue view on the console.
- Tests: state-machine + validator unit tests.

## Acceptance Criteria

- [ ] AC1: An issue without machine-checkable acceptance criteria is rejected from the queue.
- [ ] AC2: Queue entries carry tier, remaining budget, and state.
- [ ] AC3: The state machine reaches exactly one terminal (green / escalated-to-human / blocked); no transition loops forever.
- [ ] AC4: A `blocked-by` dependency parks an issue rather than attempting it.
- [ ] AC5: The console shows the queue with per-issue state.
- [ ] AC6: Console screenshots (desktop + mobile).

## Test Plan

- Unit: state-machine transitions incl. all terminals + no-infinite-loop; Input-Contract validator (accept machine-checkable AC, reject vague).

## Likely Issue Slices

- Queue state machine + tests.
- Input-Contract validator + tests.
- Queue read model + console queue view.

## Blocked By

Milestone 031.
