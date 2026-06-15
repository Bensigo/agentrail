# Milestone 026: Cost Optimization — Reduce Spend, Not Just Measure It

## Source PRD

Cost-wedge arc (M022-M025) is all *measurement* — it prices, reports, attributes, and displays cost but never *reduces* it. M026 is the optimizer: techniques that actually cut the bill, pricing through the same M022 engine so the savings are auditable. This turns the wedge from "we show you the bill" into "we lower it."

## Required Context

- `CONTEXT.md`: pricing engine is `agentrail/run/pricing.py` (`PRICES` table, `cost_usd(usage)`); token usage incl. cache is captured in `agentrail/run/usage_capture.py` (`Usage` dataclass with `input_tokens`/`output_tokens`/`cache_tokens`, reads `cache_read_input_tokens` at `usage_capture.py:94`). Context packs build via `agentrail/context/packs.py` with `retrievalBudget = {maxItems, maxTokens}` (`packs.py:383`, default `RETRIEVAL_MAX_TOKENS=6000` from `retrieval.py:170`); `compute_tokens_saved` at `retrieval.py:173`. Per-phase model resolution is `resolve_model_from_config`/`resolve_model_for_phase` in `agentrail/cli/commands/run.py:208-225` (precedence `runners.<agent>.models[phase] > runners.<agent>.model`). Per-run cost comes from M024 `agentrail cost` (#697). M022 `cost_for` is #693.
- `TASTE.md`: Evidence over claims — every "saved $X" must be auditable (show the baseline, the technique, tokens before/after, model + rate). No vanity savings: a recommendation must be actionable and quantified, never "consider optimizing." Estimate-flag when the model is unknown.

## Outcome

Five additive optimizers, each pricing through M022: (1) prompt-cache exploitation + cache-hit/cached-$ reporting; (2) cost-aware model routing/recommendation across AFK phases; (3) price-aware context-pack budgeting (trim to a dollar budget); (4) cost-saving recommendations from per-run cost; (5) redundant-retrieval dedup across phases. No existing contract changes — new flags/commands and opt-in behavior only.

## Users

- Operator paying for agent runs who wants the bill to go *down*, with proof
- Coding agent whose context packs and model choices are right-sized automatically
- Developer tuning cost/quality tradeoffs per phase

## Vertical Scope

- Domain logic:
  - **Prompt-cache exploitation**: order context-pack contents so the stable prefix is cache-eligible; surface cache-hit rate and cached-$ saved (cached-read priced via M022) in `agentrail cost`/`savings`.
  - **Cost-aware model routing**: a recommender that, given phase + per-run cost, flags when a cheaper model in `PRICES` would have cleared the bar (e.g. Opus used where Sonnet sufficed → $X) and can suggest/apply a config change.
  - **Price-aware context budgeting**: a `--budget-usd` option (and/or config) that trims the pack to a dollar budget by dropping lowest-value chunks first, priced via M022; reported alongside the token budget.
  - **Cost-saving recommendations**: `agentrail cost --recommend` emits concrete "do X, save ~$Y" advice (enable caching / downgrade phase / tighten pack) derived from M024 per-run cost.
  - **Redundant-retrieval dedup**: detect identical context re-fetched across phases of a run and reuse it, reporting the avoided tokens/$.
  - **Reduce output-token waste**: output tokens cost ~5× input, so measure the output:input ratio per run, flag wasteful/verbose runs, and steer agents toward terse, structured output; report output-$ saved.
  - **Diffs over full-file rewrites**: in the AFK execute phase, steer agents to emit unified diffs/patches instead of rewriting whole files; measure the output tokens (and $) saved vs the full-file baseline.
- Data/storage: no destructive schema changes (reads existing telemetry/journal; optional config keys for budgets/routing).
- Integrations/jobs: recommendations/cache stats consumable by the console cost surface (M025).
- Tests: per-technique unit tests (cache-hit accounting; routing flag fires when cheaper model suffices; pack trimmed to dollar budget; recommendation text + quantified savings; dedup avoids re-fetch).
- Docs/config: document new flags + any config keys.

## Acceptance Criteria

- [ ] AC1: Context packs emit a cache-eligible stable prefix; `agentrail cost`/`savings` report cache-hit rate and cached-$ saved, priced via M022 cached-read rate.
- [ ] AC2: A cost-aware routing check flags when a cheaper `PRICES` model would have sufficed for a phase, quantifying the overspend in dollars; opt-in apply writes the config change idempotently.
- [ ] AC3: `--budget-usd N` (CLI/config) trims a context pack to a dollar budget by dropping lowest-value chunks first; the resulting pack cost ≤ budget, priced via M022.
- [ ] AC4: `agentrail cost --recommend` emits actionable, quantified "do X, save ~$Y" recommendations derived from M024 per-run cost; no vague advice.
- [ ] AC5: Redundant-retrieval dedup detects identical context re-fetched across phases and reuses it, reporting avoided tokens/$.
- [ ] AC6: Output-token waste is measured per run (output:input ratio, priced at the output rate via M022), wasteful runs flagged, and output-$ saved reported.
- [ ] AC7: AFK execute steers agents to emit diffs/patches over full-file rewrites; the output tokens (and $) saved vs the full-file baseline are measured and reported.
- [ ] AC8: All dollar math routes through M022 `cost_for`/`cost_usd`; every technique's savings is auditable (baseline + after); all prior suites stay green.

## Likely Issue Slices

- Prompt-cache exploitation: cache-eligible pack prefix + cache-hit / cached-$ reporting.
- Cost-aware model routing: cheaper-model recommendation + overspend flag (+ opt-in apply).
- Price-aware context budgeting: `--budget-usd` pack trim by cost-ranked drop.
- Cost-saving recommendations: `agentrail cost --recommend` quantified advice.
- Redundant-retrieval dedup: detect + reuse identical cross-phase context.
- Reduce output-token waste: measure output:input ratio + flag wasteful runs (output priced ~5× via M022).
- Diffs over full-file rewrites: steer AFK execute to patch-style edits; measure output tokens/$ saved.

## Blocked By

#693 (M022 cost engine). Recommendations (`--recommend`) additionally build on #697 (M024 per-run cost). Cache reporting builds on M022 cached pricing. Console surfacing of cache/recommendation stats relates to M025 (#699) but is not required.
