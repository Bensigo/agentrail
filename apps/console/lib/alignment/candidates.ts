/**
 * Widened per-task EXECUTE-model candidate pool for the model-selection
 * learning loop (#1338 PR③ — "the loop must GENUINELY diversify: cheap-strong
 * non-Claude models are first-class candidates, Claude tiers are baselines
 * not defaults").
 *
 * This is layer 0, upstream of eligibility -> seeds -> selector
 * (`eligibility.ts` / `seeds.ts` / `selector.ts`): the raw per-{@link TaskType}
 * candidate list, SEED FIRST, before `eligibility.ts`'s curated exclusions are
 * applied. Before this PR, `eligibility.ts`'s `candidateModelSlugs()` read
 * `MODEL_CATALOG`'s three seats directly (the SAME 3 Claude slugs for every
 * task type); {@link CANDIDATES} below replaces that with a real, per-task,
 * mostly-non-Claude pool, priced via {@link MODEL_SEATS}.
 *
 * DELIBERATELY SEPARATE from `catalog.ts`'s `MODEL_CATALOG`: that table is the
 * flag-OFF static default `estimate.ts`/`alignment-brief.ts` fall back to
 * when the model-selection-learning flag is off for a workspace (or absent
 * entirely) — it MUST stay byte-identical to its pre-#1338 values so merging
 * this PR changes nothing at runtime until the flag is later turned on (see
 * `feature-flags.ts`). `seedModel()` (`seeds.ts`) and `eligibleModelsForTaskType()`
 * (`eligibility.ts`) are reached ONLY from the flag-gated `selector.ts` path —
 * `alignment-brief.ts`'s `resolveModelSelectionForBrief` never calls into
 * either of them when the flag is off — so widening what THEY read from is
 * invisible at runtime until someone opts a workspace in.
 *
 * PRICING NOTE — why `anthropic/claude-sonnet-5` appears here at a DIFFERENT
 * rate ($2.00/$10.00) than `MODEL_CATALOG.ui`'s own sonnet-5 seat
 * ($3.00/$15.00): `catalog.ts`'s module doc already documents that
 * MODEL_CATALOG deliberately mirrors PRICE_TABLE's STICKER rate rather than
 * OpenRouter's introductory $2/$10 rate (through 2026-08-31), so brief
 * estimates never silently understate spend once the promo lapses. This
 * registry is a DIFFERENT consumer with a different purpose — the learning
 * loop's candidate pool + the console observe view (#1338 PR③) — and uses the
 * live/current OpenRouter rate instead, same as `resolveModelPrice`'s
 * "gateway" tier would resolve today. The two numbers are not drift; they are
 * two different, individually-documented snapshots for two different
 * call sites. Actual run-cost METERING never depends on either constant here:
 * it resolves gateway-first at runtime, independent of this file (#1337/#1368
 * — see `resolve-price.ts` and `agentrail/run/pricing.py::_resolve_rates`).
 *
 * The OPPOSITE case — `anthropic/claude-opus-4.8` and `anthropic/claude-haiku-4.5`
 * — reuse `MODEL_CATALOG`'s own seat objects verbatim below: their rates here
 * happen to equal the sticker/PRICE_TABLE rate already, so there is nothing to
 * duplicate or let drift apart.
 *
 * `z-ai/glm-5.2` carries a THIRD independent static number in this codebase:
 * `agentrail/context/pricing.py::PRICE_TABLE`'s own `'glm-5.2'` entry
 * ($0.30/$0.94) prices the hosted fleet's VERIFY seat
 * (`deploy/runner/agentrail-config.hosted.json`) and is pinned by
 * `agentrail/tests/run/test_pricing.py` + `agentrail/tests/conftest.py` — a
 * real, already-shipped, unrelated call site. This registry's $0.98/$3.07
 * entry is this PR's EXECUTE-candidate snapshot and intentionally does NOT
 * touch that Python entry: they price the same model for two different roles
 * (verify vs. execute-candidate) that this codebase's own pricing.py comment
 * already acknowledges can legitimately differ ("rates vary by upstream
 * provider"). Forcing both through one drift guard would either overwrite a
 * pinned, unrelated production price or silently under-price this pool — see
 * `candidates.test.ts`'s own module doc for how this pool's prices are
 * guarded instead (structural "never $0" + AC3 known-slug checks, not a
 * cross-language mirror against PRICE_TABLE).
 */

import type { ModelSeat } from "./catalog";
import { MODEL_CATALOG } from "./catalog";
import type { TaskType } from "./classifier";

/**
 * Every distinct EXECUTE-candidate slug this pool can offer, keyed by slug —
 * the ONE place a slug's display name + $/MTok rates are defined for the
 * widened pool. `selector.ts`'s `seatForSlug` and the console observe-view API
 * route (#1338 PR③) both resolve a slug to a {@link ModelSeat} through this
 * map; `eligibility.ts`/`seeds.ts` never construct a `ModelSeat` themselves.
 *
 * Rates are live OpenRouter $/MTok figures as supplied by the owner,
 * 2026-07-20 — see this module's own doc comment for why a couple of these
 * deliberately differ from another static number elsewhere in the repo for
 * the SAME slug (sonnet-5, glm-5.2).
 */
export const MODEL_SEATS: Record<string, ModelSeat> = {
  "moonshotai/kimi-k2.7-code": {
    slug: "moonshotai/kimi-k2.7-code",
    displayName: "Kimi K2.7 Code",
    inUsdPerMTok: 0.85,
    outUsdPerMTok: 3.8,
  },
  "z-ai/glm-5.2": {
    slug: "z-ai/glm-5.2",
    displayName: "GLM 5.2",
    inUsdPerMTok: 0.98,
    outUsdPerMTok: 3.07,
  },
  "moonshotai/kimi-k3": {
    slug: "moonshotai/kimi-k3",
    displayName: "Kimi K3",
    inUsdPerMTok: 3.0,
    outUsdPerMTok: 15.0,
  },
  // Deliberately NOT MODEL_CATALOG.ui — see module doc's "PRICING NOTE".
  "anthropic/claude-sonnet-5": {
    slug: "anthropic/claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    inUsdPerMTok: 2.0,
    outUsdPerMTok: 10.0,
  },
  // Same rate as MODEL_CATALOG.refactor — reused verbatim, nothing to drift.
  "anthropic/claude-opus-4.8": MODEL_CATALOG.refactor,
  "deepseek/deepseek-v4-pro": {
    slug: "deepseek/deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro",
    inUsdPerMTok: 0.43,
    outUsdPerMTok: 0.87,
  },
  "z-ai/glm-4.7": {
    slug: "z-ai/glm-4.7",
    displayName: "GLM 4.7",
    inUsdPerMTok: 0.4,
    outUsdPerMTok: 1.75,
  },
  "qwen/qwen3-coder-plus": {
    slug: "qwen/qwen3-coder-plus",
    displayName: "Qwen3 Coder Plus",
    inUsdPerMTok: 0.65,
    outUsdPerMTok: 3.25,
  },
  // Same rate as MODEL_CATALOG.mechanical — reused verbatim, nothing to drift.
  "anthropic/claude-haiku-4.5": MODEL_CATALOG.mechanical,
  "openai/gpt-5.1-codex": {
    slug: "openai/gpt-5.1-codex",
    displayName: "GPT-5.1 Codex",
    inUsdPerMTok: 1.25,
    outUsdPerMTok: 10.0,
  },
};

/**
 * Per-task-type candidate slugs, SEED FIRST (index 0 is the seed —
 * {@link seedModel} in `seeds.ts` returns `MODEL_SEATS[CANDIDATES[taskType][0]]`).
 * `eligibility.ts`'s `eligibleModelsForTaskType` filters this list through
 * {@link EXCLUDED_MODELS} (that module's own curated allow/deny layer); this
 * table is the pool BEFORE that filter, not the final eligible set.
 *
 * Owner-confirmed spread (#1338 PR③), live OpenRouter $/MTok in/out inline for
 * review — see {@link MODEL_SEATS} for the values actually used:
 *   - ui:         seed moonshotai/kimi-k2.7-code (0.85/3.80); + z-ai/glm-5.2
 *     (0.98/3.07), moonshotai/kimi-k3 (3.00/15.00), anthropic/claude-sonnet-5
 *     (2.00/10.00). `anthropic/claude-haiku-4.5` is NOT a ui candidate at all
 *     (never mind excluded — it isn't offered); `eligibility.ts`'s
 *     `EXCLUDED_MODELS.ui` keeps the HARD OWNER RULE as a defense-in-depth
 *     backstop regardless.
 *   - refactor:   seed anthropic/claude-opus-4.8 (5.00/25.00); + z-ai/glm-5.2,
 *     deepseek/deepseek-v4-pro (0.43/0.87), moonshotai/kimi-k2.7-code,
 *     anthropic/claude-sonnet-5.
 *   - mechanical: seed z-ai/glm-4.7 (0.40/1.75); + z-ai/glm-5.2,
 *     deepseek/deepseek-v4-pro, qwen/qwen3-coder-plus (0.65/3.25),
 *     anthropic/claude-haiku-4.5 (1.00/5.00).
 *   - general:    seed z-ai/glm-5.2 (0.98/3.07); + moonshotai/kimi-k2.7-code,
 *     deepseek/deepseek-v4-pro, openai/gpt-5.1-codex (1.25/10.00),
 *     anthropic/claude-sonnet-5.
 *
 * `candidates.test.ts` pins this exact shape (per task: eligible set ==
 * intended pool, seed == first entry, seed is eligible).
 */
export const CANDIDATES: Record<TaskType, readonly string[]> = {
  ui: [
    "moonshotai/kimi-k2.7-code",
    "z-ai/glm-5.2",
    "moonshotai/kimi-k3",
    "anthropic/claude-sonnet-5",
  ],
  refactor: [
    "anthropic/claude-opus-4.8",
    "z-ai/glm-5.2",
    "deepseek/deepseek-v4-pro",
    "moonshotai/kimi-k2.7-code",
    "anthropic/claude-sonnet-5",
  ],
  mechanical: [
    "z-ai/glm-4.7",
    "z-ai/glm-5.2",
    "deepseek/deepseek-v4-pro",
    "qwen/qwen3-coder-plus",
    "anthropic/claude-haiku-4.5",
  ],
  general: [
    "z-ai/glm-5.2",
    "moonshotai/kimi-k2.7-code",
    "deepseek/deepseek-v4-pro",
    "openai/gpt-5.1-codex",
    "anthropic/claude-sonnet-5",
  ],
};
