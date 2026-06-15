# Milestone 032: Anti-False-Green Roles (Test-Author / Implementer / Verifier)

## Source PRD

[agentrail#767](https://github.com/Bensigo/agentrail/issues/767) — Verification-contract loop.

## Required Context

- `CONTEXT.md`: **Test-Author / Implementer / Verifier** roles; **Independent Verification** is blocking, narrow, and performed by a *different model* than the implementer; **Quality** definition. See ADR 0008.
- Code area: `agentrail/run` + `agentrail/afk` role orchestration over the Objective Gate (M031).
- `TASTE.md`: No new console surface required beyond M031's run surface.

## Outcome

The acceptance test is authored by a separate role from the implementer: a **Test-Author** writes a failing test from the issue's acceptance criteria, the **Implementer** turns it green, and a **Verifier** running a different model confirms the solution and tests satisfy the AC. This defeats false-green (the maker cannot write a tautological test in its own favour).

## Users

- Startup engineer who saw "tests pass but the change still misses things."

## Vertical Scope

- Domain logic: role orchestration; different-model verifier contract.
- API/routes: pipeline routes test authorship and verification to distinct roles/models.
- Tests: verifier contract test (catches a gamed test); role orchestration integration.

## Acceptance Criteria

- [ ] AC1: The Test-Author produces a failing acceptance test from the AC before any implementation.
- [ ] AC2: The Implementer's change turns that test green.
- [ ] AC3: The Verifier uses a different model than the Implementer.
- [ ] AC4: A tautological/gamed test is rejected by the Verifier on a fixture.
- [ ] AC5: The Verifier verdict blocks "done" when it rejects.

## Test Plan

- Unit/contract: Verifier rejects a gamed test; accepts a genuine one.
- Integration: full Test-Author → Implementer → Verifier pass on a fixture issue.

## Likely Issue Slices

- Role orchestration wiring (Test-Author, Implementer, Verifier).
- Different-model Verifier with AC-satisfaction + scope check.
- Gamed-test rejection fixture + test.

## Blocked By

Milestone 031.
