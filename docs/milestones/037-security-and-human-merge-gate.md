# Milestone 037: Security Guardrails + Human Merge Gate

## Source PRD

[agentrail#767](https://github.com/Bensigo/agentrail/issues/767) — Verification-contract loop.

## Required Context

- `CONTEXT.md`: security actions and **Audit Event**s; the **Review Gate** policy checkpoint. Irreversible actions must be gateable behind human approval.
- Code area: `agentrail/run` security guardrail; merge/approval gate; `apps/console` approval surface.
- `TASTE.md`: approval surface follows console patterns; screenshot evidence required.

## Outcome

The agent is blocked from committing secrets or pushing to production, and irreversible actions (merge/deploy) can be gated behind human approval; every block or approval emits an audit event.

## Users

- Security-conscious lead enabling unattended runs without incident risk.

## Vertical Scope

- Domain logic: secret/prod-push guardrail; human-approval gate for irreversible actions.
- API/routes: gate merge/deploy on approval (configurable).
- UI: approval surface on the console.
- Integrations: audit events.
- Tests: guardrail unit tests.

## Acceptance Criteria

- [ ] AC1: A commit/push containing a detected secret is blocked.
- [ ] AC2: A push to a protected/production target is blocked.
- [ ] AC3: An irreversible action requires human approval when the policy is enabled.
- [ ] AC4: Every block and approval emits an audit event.
- [ ] AC5: Console screenshots of the approval surface (desktop + mobile).

## Test Plan

- Unit: guardrail — secret detected → blocked; protected path → blocked.
- Manual: a demo merge waits for approval; a secret commit is blocked.

## Likely Issue Slices

- Secret/prod-push guardrail + tests.
- Human merge-approval gate + audit events.
- Console approval surface.

## Blocked By

Milestone 031.
