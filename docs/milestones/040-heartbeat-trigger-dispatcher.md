# Milestone 040: Heartbeat / Trigger Dispatcher (Capstone)

## Source PRD

[agentrail#767](https://github.com/Bensigo/agentrail/issues/767) — Verification-contract loop.

## Required Context

- `CONTEXT.md`: **Heartbeat** is event-first (issue labeled, CI fails) with a scheduled-cadence fallback, dispatches from the **Issue Queue**, and stops when the queue is empty. It is the capstone — enabled only after the Objective Gate, Budget Leash, and metrics exist. See ADR 0010.
- Code area: trigger dispatcher (webhook + cadence); queue dispatch (M035/M036).
- `TASTE.md`: trigger/heartbeat config surface follows console patterns; screenshot evidence required.

## Outcome

Event triggers (issue labeled, CI fails) and a scheduled cadence dispatch queued issues automatically, and the heartbeat stops when the queue is empty — the system finds and does work without a human running it, and never spins on invented work.

## Users

- Team lead who wants the system to run itself safely on the backlog.

## Vertical Scope

- Domain logic: trigger dispatcher (event + cadence); empty-queue stop.
- Integrations: webhook intake (label/CI) via connectors; nightly cadence + triage summary.
- UI: trigger/heartbeat config surface on the console.
- Tests: dispatcher unit tests.

## Acceptance Criteria

- [ ] AC1: An event trigger (issue labeled / CI fail) enqueues and dispatches the issue.
- [ ] AC2: A scheduled cadence scans the backlog, runs grabbable issues, and posts a triage summary.
- [ ] AC3: The heartbeat stops when the queue is empty and never runs without grabbable work.
- [ ] AC4: The heartbeat is gated off until the Objective Gate, Budget Leash, and metrics are in place.
- [ ] AC5: Console screenshots of the trigger/heartbeat config (desktop + mobile).

## Test Plan

- Unit: dispatcher — event → dispatch; empty queue → idle; cadence tick → backlog scan.
- Manual: a labeled issue auto-runs end to end; empty queue goes idle.

## Likely Issue Slices

- Event trigger (webhook: label / CI).
- Scheduled cadence + morning triage summary.
- Dispatch-from-queue + empty-queue stop.
- Console trigger/heartbeat config surface.

## Blocked By

Milestones 035, 036, 037.
