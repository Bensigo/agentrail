# Milestone 039: Intent Compounding (Lessons Pre-Target Retrieval)

## Source PRD

[agentrail#767](https://github.com/Bensigo/agentrail/issues/767) — Verification-contract loop.

## Required Context

- `CONTEXT.md`: **Context Memory** is advisory and must not outrank current code/docs; **Context Compiler** generates the smallest useful context pack. Retrieval stays lexical+graph (no embedding change).
- Code area: context engine + memory integration (`agentrail/context`).
- `TASTE.md`: No console surface required in this milestone.

## Outcome

Accumulated lessons (prior decisions, where things live) pre-target the context engine so that a repeat task on the same area sends fewer tokens and reaches the required source faster — while memory remains advisory and never outranks current code.

## Users

- Engineer running repeat work whose token cost should drop as the system learns the repo.

## Vertical Scope

- Domain logic: feed lessons/memory into retrieval targeting.
- Tests: before/after retrieval token comparison on a repeat task.

## Acceptance Criteria

- [ ] AC1: Lessons/memory bias retrieval toward the right area on a repeat task.
- [ ] AC2: A repeat task sends measurably fewer tokens or reaches the required source faster than the cold baseline.
- [ ] AC3: Memory remains advisory — it does not outrank current code/docs (verified by a stale-lesson fixture).

## Test Plan

- Fixture: retrieval token/precision comparison with vs without compounded lessons on the same task.
- Fixture: a stale lesson does not override current code.

## Likely Issue Slices

- Lessons → retrieval targeting integration.
- Token/precision measurement harness.
- Advisory-authority guard (stale lesson cannot outrank code).

## Blocked By

None.
