# Milestone 023: Real-Dollar Savings Surface

## Source PRD

Cost-wedge arc (M022-M025). M023 turns the token-savings story into a **real-dollar** story: the `savings` and `benchmark` surfaces report money saved, priced through M022's engine, in machine-parseable and human-readable form — these numbers power the landing-page claims.

## Required Context

- `CONTEXT.md`: `agentrail context savings` reads cumulative `tokensSaved` from `retrieval.py:1612` runMetadata + pack telemetry (`packs.py:424`); `agentrail context benchmark FIXTURE --compare-grep` already prints grep-vs-engine token columns (`benchmark.py:149`, `format_benchmark_summary` at `benchmark.py:261`). M022 provides `cost_for(model, ...)` pricing.
- `TASTE.md`: Evidence over claims — dollar figures must be auditable (show the model, token counts, and rate used). No vanity metrics: savings must be a non-negative real number; when the model is unknown, label the figure `estimate: true`. Output must be copy-pasteable into a PR body or landing page.

## Outcome

`agentrail context savings [--model M] [--json]` returns cumulative tokens **and dollars** saved, priced via M022, with the model and rate shown. `agentrail context benchmark FIXTURE --compare-grep` gains a real-dollar cost column alongside the token columns. Both surfaces are honest (estimate-flagged when model unknown) and produce a publishable table.

## Users

- Operator justifying the context-first policy with a dollar figure
- Marketing/landing page consuming the benchmark + savings dollar numbers
- Coding agent that wants to know the dollar impact of a query

## Vertical Scope

- Domain logic: extend `agentrail context savings` to price `tokensSaved` via M022 `cost_for`, defaulting to a representative model, accepting `--model`; extend `benchmark.py` `run_benchmark`/`format_benchmark_summary` with a real-dollar column when `--compare-grep` is set.
- Data/storage: no schema changes (reads existing telemetry).
- Integrations/jobs: none.
- Tests: `test_savings.py` dollar-figure + estimate-flag assertions; `test_benchmark.py` dollar-column assertion.
- Docs/config: none required beyond help text.

## Acceptance Criteria

- [ ] AC1: `agentrail context savings [--json]` returns cumulative `tokensSaved` AND `dollarsSaved` (non-negative), with `model` and per-Mtok `rate` shown.
- [ ] AC2: `--model M` reprices against model M; unknown model returns `estimate: true` with `chars/4` fallback note.
- [ ] AC3: `agentrail context benchmark FIXTURE --compare-grep` prints a real-dollar cost column (grep-and-read $ vs engine $) next to the existing token columns; output stays machine-parseable.
- [ ] AC4: All dollar math routes through M022 `cost_for` (no second pricing path); output and cached tokens priced distinctly.
- [ ] AC5: `tests/context/test_savings.py` and `tests/context/test_benchmark.py` updated and green; all prior suites stay green.

## Likely Issue Slices

- Price `agentrail context savings` in real dollars via M022 `cost_for` (+ `--model`, estimate flag, JSON schema).
- Add real-dollar cost column to `agentrail context benchmark --compare-grep`.
- Tests: dollar-figure + estimate-flag assertions in `test_savings.py` and `test_benchmark.py`.

## Blocked By

#693 (M022 cost engine — `cost_for` pricing function).
