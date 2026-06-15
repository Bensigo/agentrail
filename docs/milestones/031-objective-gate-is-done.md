# Milestone 031: Objective Gate Is "Done"

## Source PRD

[agentrail#767](https://github.com/Bensigo/agentrail/issues/767) — Verification-contract loop.

## Required Context

- `CONTEXT.md`: **Objective Gate** is the sole definition of done (tests/build/lint + acceptance criteria), requiring a **Red-Green Proof** trail; advisory **Code Review** does not define done. See ADR 0007, ADR 0008.
- Code area: `agentrail/run/pipeline.py`; new deep modules **Objective Gate** and **Red-Green Proof recorder** in `agentrail/run`.
- `TASTE.md`: a run surface shows the gate verdict + evidence; apply console patterns + screenshot evidence to that surface.

## Outcome

A run is marked done only when tests/build/lint pass and acceptance criteria are met, evidenced by a Red-Green Proof (the acceptance test observed failing before implementation and passing after). LLM review is recorded as advisory and does not gate completion.

## Users

- Startup engineer who needs merges backed by objective evidence, not an opinion.

## Vertical Scope

- Domain logic: Objective Gate (green/red + evidence); Red-Green Proof recorder.
- API/routes: pipeline marks done on the gate, not on review; review output stored as advisory.
- UI: run surface shows gate result + Red-Green evidence.
- Tests: gate + recorder unit tests with fixtures.

## Acceptance Criteria

- [ ] AC1: The gate returns green only when tests, build, and lint pass and AC coverage is satisfied.
- [ ] AC2: A run with no Red-Green Proof trail is not accepted, even if the final test run is green.
- [ ] AC3: A never-failed (tautological) acceptance test is rejected by the recorder.
- [ ] AC4: LLM review output is stored as advisory and does not block done.
- [ ] AC5: The run surface shows the gate verdict and evidence trail.

## Test Plan

- Unit: Objective Gate over fixture repos (green/red, AC coverage); Red-Green recorder (fail→pass accepted, never-failed rejected).
- Manual: a demo issue reaches done only with a valid trail.

## Likely Issue Slices

- Objective Gate module + tests.
- Red-Green Proof recorder + tests.
- Demote LLM review to advisory in the pipeline.
- Run surface shows gate verdict + evidence.

## Blocked By

None.
