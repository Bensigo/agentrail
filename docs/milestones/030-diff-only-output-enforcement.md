# Milestone 030: Diff-Only Output Enforcement

## Source PRD

[agentrail#767](https://github.com/Bensigo/agentrail/issues/767) — Verification-contract loop.

## Required Context

- `CONTEXT.md`: output is billed 5–15× input; the current "prefer a unified diff" line in the execute prompt is advisory only (`agentrail/run/prompts.py`). This milestone makes it enforced. New deep module: **Output Format Enforcer** in `agentrail/run`.
- `TASTE.md`: No console surface in this milestone; screenshot evidence not required.

## Outcome

When the agent edits an existing file, AgentRail enforces a diff/patch and rejects full-file rewrites (a full rewrite is accepted only for a new file or a rename). Output tokens per run drop measurably, and a rejected rewrite is recorded as a run event.

## Users

- Startup engineer paying per token (output is the dominant cost driver).

## Vertical Scope

- Domain logic: Output Format Enforcer (accept patch / reject full-file with reason).
- API/routes: wire the enforcer into the execute phase of the run pipeline.
- Tests: enforcer unit tests.
- Docs/config: remove the advisory "prefer diffs" prompt line, replaced by enforcement.

## Acceptance Criteria

- [ ] AC1: A full-file rewrite of an existing file is rejected with a structured reason.
- [ ] AC2: A diff/patch edit is accepted.
- [ ] AC3: Full content is accepted for a new file or a rename.
- [ ] AC4: A run records lower output tokens than the pre-enforcement baseline on a representative edit.
- [ ] AC5: A rejection is emitted as a run event (visible later in the console).

## Test Plan

- Unit: Output Format Enforcer — full-file rejected, diff accepted, new-file/rename allowed.
- Integration: a sample edit run shows reduced output tokens vs baseline.

## Likely Issue Slices

- Output Format Enforcer module + unit tests.
- Wire enforcer into execute phase; emit rejection run event.
- Remove the advisory diff prompt line.

## Blocked By

None.
