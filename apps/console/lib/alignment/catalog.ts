/**
 * Task-type -> coding-model catalog for the alignment brief (#1275).
 *
 * Slugs use the AI-gateway "provider/model" format, matching
 * `deploy/runner/agentrail-config.hosted.json`'s `runners.claude.models.*`
 * shape (e.g. `"anthropic/claude-sonnet-5"`). Rates are USD per million
 * tokens, MIRRORED from the single canonical Python price table,
 * `agentrail/context/pricing.py::PRICE_TABLE` — this file must never invent a
 * rate of its own. `catalog.test.ts` is the cross-language drift guard: it
 * reads `pricing.py`'s source text at test time and asserts every rate below
 * still matches what is actually there. A future edit to PRICE_TABLE that
 * changes a mirrored rate without updating this file fails that test loudly
 * — the estimate math in `estimate.ts` never falls back to treating an
 * unmatched model as a silent $0 (recon annex §3's "$0 hazard").
 *
 * ---------------------------------------------------------------------------
 * Slug format vs. PRICE_TABLE key format (why the mapping is not mechanical)
 * ---------------------------------------------------------------------------
 * OpenRouter versions Anthropic slugs with DOTS (`anthropic/claude-opus-4.8`,
 * `anthropic/claude-haiku-4.5`) while the Python table's canonical keys use
 * DASHES (`claude-opus-4-8`, `claude-haiku-4-5`). The dash-form slugs are
 * NOT valid OpenRouter ids — a `model_override` sent to the gateway as
 * `anthropic/claude-opus-4-8` would fail the run outright. Since #1334,
 * `agentrail/run/pricing.py::_resolve_rates` normalizes exactly this
 * relationship at cost-metering time (provider-prefix strip, then dot->dash
 * swap: `anthropic/claude-opus-4.8` -> `claude-opus-4-8`), so the two sides
 * of the wire now document — and depend on — the same transform: this
 * catalog emits the gateway's dot-form slugs, the Python side folds them
 * back onto the dash-form canonical keys. `CATALOG_PRICE_TABLE_MAPPING`
 * below writes that correspondence out explicitly per entry so the drift
 * guard never re-implements the normalization to know which PRICE_TABLE
 * entry backs which slug. (`claude-sonnet-5` has no dot in its version, so
 * its slug and key differ only by the provider prefix.)
 *
 * Pricing nuance carried over from PRICE_TABLE's own `claude-sonnet-5` entry
 * comment (#1334): the entry holds STICKER rates ($3/$15 per MTok) even
 * though OpenRouter bills an introductory $2/$10 through 2026-08-31 —
 * deliberately, so ledgers never silently understate spend when the promo
 * lapses. This catalog mirrors the canonical entry, so brief estimates for
 * the ui/general seats carry the same small, conservative overstatement
 * until then.
 * ---------------------------------------------------------------------------
 */

import type { TaskType } from "./classifier";

export interface ModelSeat {
  /** AI-gateway "provider/model" slug — the wire format the runner/CLI expect. */
  slug: string;
  /** Human-readable name for brief rendering. */
  displayName: string;
  inUsdPerMTok: number;
  outUsdPerMTok: number;
}

/**
 * Documented slug -> canonical `PRICE_TABLE` key mapping. This is NOT a
 * trivial "strip the provider/ prefix" transform — OpenRouter's dot-form
 * version separators must also fold to the table's dash form (see the
 * slug-format note in the module doc above; `run/pricing.py::_resolve_rates`
 * applies the same prefix-strip + dot->dash normalization on the Python side
 * since #1334) — so each mapping is an explicit, reviewable decision.
 * `catalog.test.ts` reads this map directly to drive the drift guard.
 */
export const CATALOG_PRICE_TABLE_MAPPING: Record<string, string> = {
  "anthropic/claude-opus-4.8": "claude-opus-4-8", // prefix strip + dot->dash
  "anthropic/claude-haiku-4.5": "claude-haiku-4-5", // prefix strip + dot->dash
  "anthropic/claude-sonnet-5": "claude-sonnet-5", // prefix strip only (no dot in version)
};

/**
 * Three seats + a default, keyed by {@link TaskType} (locked design point 3):
 *   - ui         -> frontend-strong model
 *   - refactor   -> strongest reasoner
 *   - mechanical -> cheapest
 *   - general    -> same as ui (the safe, capable default)
 *
 * Rates mirrored from `PRICE_TABLE` per {@link CATALOG_PRICE_TABLE_MAPPING}
 * above (opus-4-8 $5.00/$25.00, haiku-4-5 $1.00/$5.00, sonnet-5 $3.00/$15.00
 * sticker — all $/MTok; sonnet-5's intro-pricing nuance is in the module doc).
 */
export const MODEL_CATALOG: Record<TaskType, ModelSeat> = {
  ui: {
    slug: "anthropic/claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    inUsdPerMTok: 3.0,
    outUsdPerMTok: 15.0,
  },
  refactor: {
    slug: "anthropic/claude-opus-4.8",
    displayName: "Claude Opus 4.8",
    inUsdPerMTok: 5.0,
    outUsdPerMTok: 25.0,
  },
  mechanical: {
    slug: "anthropic/claude-haiku-4.5",
    displayName: "Claude Haiku 4.5",
    inUsdPerMTok: 1.0,
    outUsdPerMTok: 5.0,
  },
  general: {
    slug: "anthropic/claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    inUsdPerMTok: 3.0,
    outUsdPerMTok: 15.0,
  },
};
