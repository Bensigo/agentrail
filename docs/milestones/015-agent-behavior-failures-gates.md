# Milestone 015: Agent Behavior, Failures & Gates

## Source PRD

GitHub issue #542 — (https://github.com/Bensigo/agentrail/issues/542)

## Required Context

- `CONTEXT.md`: Review Gate is a policy checkpoint that decides whether a run or PR has enough evidence, verification, and context provenance to continue — not a generic checklist. Run Events are append-only. Failure events must surface what failed and why, traceable to underlying run events. Audit events record who or what performed a sensitive action.
- `TASTE.md`: Evidence over claims — every status, failure, or decision must link to underlying events or artifacts. Dense tables with 32–36px row height, monospace for IDs/paths, status badges (red=failed, orange=warning). Browser screenshot evidence required for any UI change. Destructive/hard-to-reverse actions need confirmation.

## Outcome

An operator inspecting a run sees a **Behavior Linter** panel listing exactly which rules fired (excessive full-file reads, tool loops, context-blind edits, verification skips) with a link to the specific run event that triggered each finding. The **Failures** page groups repeated errors by normalized fingerprint with occurrence counts and first/last seen dates — each cluster expandable to show contributing run IDs and context packs. A failing **Review Gate** detail page shows a structured **Gate Explainer** listing which evidence categories (tests, visual, citations, AC, blocked findings) are present and which are missing, so agents and reviewers know exactly what to supply.

## Users

- AgentRail operators auditing agent behavior on a run
- AgentRail operators diagnosing recurring failure patterns across runs and repositories
- Agents and human reviewers acting on a failing review gate

## Vertical Scope

This milestone touches:

- UI: Behavior Linter findings panel on `runs/[runId]` detail page; Failure Clusters table enhancements on existing `failures/` route; Gate Explainer panel on `review-gates/[gateId]` detail page
- API/routes: New tRPC procedures `runs.behaviorLint`, `failures.clusters`, `reviewGates.explainer`
- Domain logic: `Agent Behavior Linter` module — accepts run_id, reads agent_activity run_events, evaluates 5 rules, returns `LintFinding[]{ rule, severity, evidence_event_id }`; `Failure Fingerprinter` module — accepts failure_events list, normalizes error messages, groups by fingerprint + phase + file_path, returns clusters with occurrence counts and run ID lists
- Data/storage: ClickHouse `failure_events` — add columns `normalized_error String`, `fingerprint String`; ClickHouse `run_events` agent_activity payload — extend with `files_read_count UInt32`, `full_file_read Bool`, `tool_loop_count UInt16`, `edit_without_context Bool`, `verification_skip Bool`; ClickHouse/Postgres `review_gates` findings JSON — add `category Enum('tests','visual','citations','ac','blocked')` to each finding item
- Integrations/jobs: `agentrail/run/activity_push.py` — extend agent_activity payload with 5 new fields; `agentrail/run/failure_push.py` — compute and populate normalized_error and fingerprint before push; `agentrail/afk/review_push.py` — tag each finding with category enum value
- Tests: Unit tests for Agent Behavior Linter (each rule independently and in combination); unit tests for Failure Fingerprinter (same error → same fingerprint, distinct errors → distinct fingerprints)
- Docs/config: Document the 5 linter rules and their default thresholds (e.g. files_read_count threshold configurable per workspace)

## Acceptance Criteria

- [ ] `failure_events` ClickHouse table has `normalized_error` and `fingerprint` columns + migration
- [ ] `run_events` agent_activity payload schema extended with 5 new fields + migration
- [ ] `review_gates` findings items include `category` field + migration
- [ ] `agentrail/run/activity_push.py` emits all 5 new behavior fields
- [ ] `agentrail/run/failure_push.py` emits `normalized_error` and `fingerprint`
- [ ] `agentrail/afk/review_push.py` emits `category` on each finding
- [ ] Agent Behavior Linter returns correct `LintFinding[]` for each rule (unit test passes)
- [ ] Failure Fingerprinter produces identical fingerprints for semantically-same errors and distinct fingerprints for distinct errors (unit test passes)
- [ ] Run detail page shows Behavior Linter panel; each finding links to its `evidence_event_id` run event
- [ ] Failures page shows clusters table with fingerprint, phase, file_path, occurrence count, first_seen, last_seen; expanding a row shows contributing run IDs
- [ ] Review gate detail page shows Gate Explainer panel listing each evidence category as present (green) or missing (red)
- [ ] Browser screenshots of all three surfaces with seeded fixture data attached to the PR

## Test Plan

- `pytest packages/db-clickhouse/src/__tests__/test_agent_behavior_linter.py`
- `pytest packages/db-clickhouse/src/__tests__/test_failure_fingerprinter.py`
- Manual: seed fixture failure events and activity events, open run detail and failures pages, verify linter findings and clusters render with correct data

## Likely Issue Slices

- Extend `failure_events` ClickHouse schema + migration
- Extend `run_events` agent_activity payload schema + migration
- Extend `review_gates` findings schema + migration
- Extend `activity_push.py` with 5 new behavior fields
- Extend `failure_push.py` with normalized_error + fingerprint
- Extend `review_push.py` with finding category enum
- Implement Agent Behavior Linter module + unit tests
- Implement Failure Fingerprinter module + unit tests
- Add tRPC procedures `runs.behaviorLint`, `failures.clusters`, `reviewGates.explainer`
- Build Behavior Linter panel on run detail page
- Build Failure Clusters table enhancements on failures page
- Build Gate Explainer panel on review gate detail page
- Write fixture seed script for end-to-end verification

## Blocked By

[[014-context-quality-rot-watch]] — schema migration infrastructure pattern must be established; otherwise no blocking dependency.

## Notes

Fingerprint normalization strips memory addresses, line numbers, and run IDs from raw error messages using regex. The normalization pattern should be tested with at least: Python tracebacks, Go panics, and generic string errors. The gate explainer categories (`tests`, `visual`, `citations`, `ac`, `blocked`) are an enum at the DB level to keep them machine-readable and reportable across runs.
