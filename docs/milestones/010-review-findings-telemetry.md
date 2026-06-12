# Milestone 010 — Review findings + gates telemetry

Source: spec M010.

## Outcome
A run's detail shows review gate pass/fail per round and the blocking findings (bugs): title, severity, file, suggested fix. `review_gates` + findings populated, linked to the run.

## Testable proof
- An afk run that goes through review produces `review_gates` rows + findings for the run; the Review Gates page and run-detail section render them.

## Likely issue slices
- Server: review-gate ingest endpoint upserting Postgres `review_gates` + findings payload.
- db: insert/upsert helpers.
- CLI: `afk/runner.py` `_review_loop` pushes the `ReviewOutcome` (gate result + `blocking` findings) keyed by the canonical run id, each round. Non-fatal. + tests.

## Blocked by
M009 (shared ingest patterns land first; not strictly required but keeps the rail consistent).
