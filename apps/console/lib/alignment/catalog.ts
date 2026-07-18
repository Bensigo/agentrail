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
 * KNOWN GAP — read before touching the "ui"/"general" seat's rate
 * ---------------------------------------------------------------------------
 * The locked catalog design (controller decision) assigns "ui" and "general"
 * to `anthropic/claude-sonnet-5`. That slug is real and live —
 * `deploy/runner/agentrail-config.hosted.json` uses it as the hosted fleet's
 * default execute model, and `deploy/runner/README.md:130` confirms it is
 * "verified against OpenRouter's live public model catalog... this is also
 * the exact model this session itself runs on." But as of this PR,
 * `agentrail/context/pricing.py::PRICE_TABLE` has NO entry literally named
 * `claude-sonnet-5` — the newest Sonnet entry it has is `claude-sonnet-4-6`.
 * This is a real, pre-existing gap in the canonical price table, not a typo
 * in this catalog, and it is out of this PR's scope to fix (PR① is
 * console/TS-only; `pricing.py` is Python).
 *
 * Resolution taken here: mirror the "ui"/"general" rate against
 * `claude-sonnet-4-6` (the newest Sonnet PRICE_TABLE actually prices) rather
 * than inventing a number. This is a well-supported stand-in, not a wild
 * guess — every Sonnet generation ever added to PRICE_TABLE
 * (`claude-sonnet-3-5`, `claude-sonnet-3-7`, `claude-sonnet-4-5`,
 * `claude-sonnet-4-6`) shares the IDENTICAL rate ($3.00 in / $15.00 out /
 * $0.30 cached-read / $3.75 cached-write per MTok), so treating
 * `claude-sonnet-5` as continuing that same tier is the best-available
 * inference, not fabrication. `catalog.test.ts` encodes a canary for this:
 * it asserts the literal string `claude-sonnet-5` is STILL ABSENT from
 * PRICE_TABLE today. The day someone adds a dedicated entry, that canary
 * starts failing — a forcing function to come back here, delete the
 * stand-in mapping, and mirror the real entry instead. Flagged loudly in the
 * PR① report; not something to fix silently in this task.
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
 * trivial "strip the provider/ prefix" transform — OpenRouter slugs and the
 * Python table's internal names don't always correspond 1:1 (see the KNOWN
 * GAP note above), so each mapping is an explicit, reviewable decision.
 * `catalog.test.ts` reads this map directly to drive the drift guard.
 */
export const CATALOG_PRICE_TABLE_MAPPING: Record<string, string> = {
  "anthropic/claude-opus-4-8": "claude-opus-4-8", // exact match
  "anthropic/claude-haiku-4-5": "claude-haiku-4-5", // exact match
  "anthropic/claude-sonnet-5": "claude-sonnet-4-6", // stand-in — see KNOWN GAP above
};

/**
 * Three seats + a default, keyed by {@link TaskType} (locked design point 3):
 *   - ui         -> frontend-strong model
 *   - refactor   -> strongest reasoner
 *   - mechanical -> cheapest
 *   - general    -> same as ui (the safe, capable default)
 *
 * Rates mirrored from `PRICE_TABLE` per {@link CATALOG_PRICE_TABLE_MAPPING}
 * above (opus-4-8 $5.00/$25.00, haiku-4-5 $1.00/$5.00, sonnet stand-in
 * $3.00/$15.00 — all $/MTok, verified against pricing.py 2026-06-15 per that
 * file's own header).
 */
export const MODEL_CATALOG: Record<TaskType, ModelSeat> = {
  ui: {
    slug: "anthropic/claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    inUsdPerMTok: 3.0,
    outUsdPerMTok: 15.0,
  },
  refactor: {
    slug: "anthropic/claude-opus-4-8",
    displayName: "Claude Opus 4.8",
    inUsdPerMTok: 5.0,
    outUsdPerMTok: 25.0,
  },
  mechanical: {
    slug: "anthropic/claude-haiku-4-5",
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
