# Milestone 008 — CLI cost capture and pipeline wiring

Source: PRD #451 (Agent cost capture → cost_events). Parent: #398.

## Outcome

Every `agentrail run` or `agentrail afk` invocation with Claude or Codex pushes at least one `cost_event` per phase to the server. The dashboard Costs view shows non-zero cost rows attributed to the correct run, repo, and model. A transcript-parsing failure or push failure never changes the run exit code.

## Why this is next

Requires M007 (the ingest endpoint) to exist as the push target. Closes the full loop: capture → compute → push → dashboard. Capture is per-agent by necessity, so both Claude and Codex extractors ship here (the agents actually in use); future agents (hermes/cursor/custom) are additive — capture returns nothing for them, non-fatal.

## Testable proof

- `agentrail run` with Claude on a linked repo → exit 0 → ClickHouse `cost_events` has rows with the correct `model` and a non-zero `cost_usd`.
- Same with Codex (`gpt-*` model, non-zero `cost_usd`).
- Server unreachable → run still exits 0, no user-visible error.
- Dashboard Costs view shows the run's cost after a time-range filter.
- `pytest tests/run/test_usage_capture.py tests/run/test_pricing.py -v` passes.

## Likely issue slices

- `agentrail/run/usage_capture.py` — `Usage` dataclass + `capture_usage(agent, target, since_ts)`; Claude extractor (`~/.claude/projects/<cwd>/*.jsonl`, sum per-turn `message.usage`, model from `message.model`) + Codex extractor (`~/.codex/sessions/**/rollout-*.jsonl` where `session_meta.cwd == target` and modified since `since_ts`, last `token_count.info.total_token_usage`, model from `turn_context.model`); unknown agent → `None`.
- `agentrail/run/pricing.py` — per-model rate table covering claude-* and OpenAI/codex models ($/MTok); `cost_usd(usage)`; unknown model → `0.0` + warning.
- `agentrail/run/cost_push.py` — build `cost_event` payload + `POST /api/v1/ingest/cost-events` (reuses the linked `server.json` loader); swallow all exceptions (non-fatal).
- Modify `agentrail/run/pipeline.py` — record `phase_start_ts` before each phase; after each phase (plan/execute/review) call capture + push inside a broad try/except that never alters the run exit code.
- `tests/run/test_usage_capture.py` — fixture JSONL for Claude + Codex; edge cases (empty dir, malformed lines, `since_ts` exclusion, `cwd` mismatch, unknown agent → None).
- `tests/run/test_pricing.py` — parametric over all rate-table models + unknown-model warning path.

## Blocked by

Milestone 007 (the `cost-events` ingest endpoint must exist as the push target).
