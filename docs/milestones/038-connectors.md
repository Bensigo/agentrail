# Milestone 038: Connectors (GitHub, Linear, Discord)

## Source PRD

[agentrail#767](https://github.com/Bensigo/agentrail/issues/767) — Verification-contract loop.

## Required Context

- `CONTEXT.md`: connectors feed the **Issue Queue** and report results; two-way communication. **Execution-Only Autonomy** — connectors bring in human-created work, the agent never invents it (ADR 0010).
- Code area: shared connector interface + GitHub/Linear/Discord adapters; `apps/console` connector management.
- `TASTE.md`: connector management surface follows console patterns; screenshot evidence required.

## Outcome

A user connects GitHub, Linear, and Discord from the dashboard; connectors ingest human-created issues into the queue, post results back, and notify channels — two-way.

## Users

- Team lead who wants AgentRail to work in the tools the team already uses.

## Vertical Scope

- Domain logic: shared Connector interface.
- Integrations: GitHub adapter (ingest labeled issues + post results), Linear adapter, Discord notify.
- UI: connector management on the console.
- Tests: adapter integration tests against mocked APIs.

## Acceptance Criteria

- [ ] AC1: A shared Connector interface exists (ingest issue, post result, notify).
- [ ] AC2: The GitHub adapter ingests a labeled issue into the queue and posts the result back.
- [ ] AC3: The Linear adapter ingests issues and posts results.
- [ ] AC4: The Discord connector notifies a channel on completion/escalation.
- [ ] AC5: Connectors can be connected and managed on the dashboard.
- [ ] AC6: Console screenshots (desktop + mobile).

## Test Plan

- Integration: each adapter against a mocked API; ingest → queue path.

## Likely Issue Slices

- Shared Connector interface.
- GitHub adapter (ingest + post).
- Linear adapter.
- Discord notify.
- Console connector management surface.

## Blocked By

Milestone 035.

## Notes

GitHub-first is acceptable if Linear/Discord need to split into a follow-up; `to-issues` can sequence the adapters.
