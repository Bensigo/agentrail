/**
 * Pure normalizer: one raw OpenRouter `GET /api/v1/models` list entry ->
 * one normalized catalog row (#1337 — the gateway catalog substrate
 * #1338/#1339 build on). Consumed by `gateway-catalog.ts`'s live
 * fetch-once-and-cache loader (owner-directed simplification, 2026-07-20,
 * replacing #1337's original committed-snapshot + refresh-script design —
 * this normalizer's own field mapping is unchanged, it now runs against the
 * live response directly instead of a file written by an offline script).
 *
 * Field mapping, pinned against a real captured response
 * (`GET https://openrouter.ai/api/v1/models`, verified 2026-07-20, no auth
 * required for the list — see `openrouter-normalize.test.ts` for literal
 * fixtures copied from that response):
 *
 *   id                        -> id            (verbatim; the AI-gateway
 *                                                "provider/model" slug, e.g.
 *                                                "anthropic/claude-sonnet-5")
 *   pricing.prompt             -> inUsdPerMTok  (USD PER TOKEN as a decimal
 *                                                string -> USD per MILLION
 *                                                tokens: Number(...) * 1e6)
 *   pricing.completion         -> outUsdPerMTok (same conversion)
 *   context_length              -> contextLength (model-level max; this can
 *                                                differ from top_provider's
 *                                                own figure below — e.g. a
 *                                                model advertising 1,048,576
 *                                                tokens where the currently
 *                                                routed top provider only
 *                                                offers 524,288 — so both are
 *                                                kept, not collapsed to one)
 *   top_provider.context_length      -> topProvider.contextLength
 *   top_provider.max_completion_tokens -> topProvider.maxCompletionTokens (nullable)
 *   top_provider.is_moderated         -> topProvider.isModerated
 *
 * Every other field OpenRouter returns (name, description, architecture,
 * supported_parameters, benchmarks, reasoning, canonical_slug, ...) is
 * deliberately NOT read — "pin the exact fields you depend on" (task brief).
 *
 * `null` in, `null` out: a raw entry missing/unparseable on any field this
 * module depends on returns `null` rather than inventing a rate —
 * `normalizeOpenRouterModelsResponse` below skips it and counts it via
 * `skippedCount`, it never becomes a silent $0 entry in the cached catalog
 * (the same "$0 hazard" discipline `catalog.ts`/`catalog.test.ts` already
 * apply to the 3-seat mirror). A genuinely free model (OpenRouter really does list
 * some at "0" per-token) is NOT rejected — `0` is a value, only a
 * missing/non-numeric field is a rejection. Those are different failure
 * modes and this function tells them apart on purpose.
 */

const USD_PER_TOKEN_TO_USD_PER_MTOK = 1_000_000;

/** The subset of one OpenRouter `/api/v1/models` list entry this module reads. */
export interface RawOpenRouterModel {
  id?: unknown;
  pricing?: {
    prompt?: unknown;
    completion?: unknown;
    [otherRateKind: string]: unknown;
  };
  context_length?: unknown;
  top_provider?: {
    context_length?: unknown;
    max_completion_tokens?: unknown;
    is_moderated?: unknown;
  };
  // OpenRouter's response carries many more fields (name, description,
  // architecture, supported_parameters, benchmarks, reasoning, ...) that this
  // module intentionally never reads — see module doc above.
  [otherField: string]: unknown;
}

/** The full envelope `GET /api/v1/models` returns: `{ data, total_count, links }`. */
export interface RawOpenRouterModelsResponse {
  data?: unknown;
}

export interface NormalizedTopProvider {
  contextLength: number;
  maxCompletionTokens: number | null;
  isModerated: boolean;
}

export interface NormalizedCatalogModel {
  id: string;
  inUsdPerMTok: number;
  outUsdPerMTok: number;
  contextLength: number;
  topProvider: NormalizedTopProvider;
}

/** Rounds to 6 decimal places — clears IEEE754 noise from the *1e6 conversion
 * without losing precision (source strings carry at most ~10 decimal digits
 * per token, so *1e6 needs at most ~4 decimal digits per MTok; 6 is headroom). */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Normalize one raw `/api/v1/models` entry, or return `null` if it is
 * missing/unparseable on any field this catalog depends on (see module doc).
 */
export function normalizeOpenRouterModel(raw: RawOpenRouterModel): NormalizedCatalogModel | null {
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;

  const promptUsdPerToken = Number(raw.pricing?.prompt);
  const completionUsdPerToken = Number(raw.pricing?.completion);
  if (!Number.isFinite(promptUsdPerToken) || !Number.isFinite(completionUsdPerToken)) return null;

  const contextLength = raw.context_length;
  if (typeof contextLength !== "number" || !Number.isFinite(contextLength)) return null;

  const topProviderRaw = raw.top_provider;
  if (typeof topProviderRaw !== "object" || topProviderRaw === null) return null;
  const topProviderContextLength = topProviderRaw.context_length;
  if (typeof topProviderContextLength !== "number" || !Number.isFinite(topProviderContextLength)) {
    return null;
  }
  const maxCompletionTokensRaw = topProviderRaw.max_completion_tokens;
  const maxCompletionTokens =
    typeof maxCompletionTokensRaw === "number" && Number.isFinite(maxCompletionTokensRaw)
      ? maxCompletionTokensRaw
      : null;

  return {
    id: raw.id,
    inUsdPerMTok: round6(promptUsdPerToken * USD_PER_TOKEN_TO_USD_PER_MTOK),
    outUsdPerMTok: round6(completionUsdPerToken * USD_PER_TOKEN_TO_USD_PER_MTOK),
    contextLength,
    topProvider: {
      contextLength: topProviderContextLength,
      maxCompletionTokens,
      isModerated: Boolean(topProviderRaw.is_moderated),
    },
  };
}

/**
 * Normalize a full `/api/v1/models` response body: extracts `data`, drops
 * (and counts) entries `normalizeOpenRouterModel` rejects, and sorts the
 * survivors by `id` so the resulting list (and any test/log built on it) is
 * deterministic regardless of the order OpenRouter happens to return.
 */
export function normalizeOpenRouterModelsResponse(body: RawOpenRouterModelsResponse): {
  models: NormalizedCatalogModel[];
  skippedCount: number;
} {
  const rawModels = Array.isArray(body.data) ? (body.data as RawOpenRouterModel[]) : [];
  const models: NormalizedCatalogModel[] = [];
  let skippedCount = 0;
  for (const raw of rawModels) {
    const normalized = normalizeOpenRouterModel(raw);
    if (normalized === null) {
      skippedCount += 1;
      continue;
    }
    models.push(normalized);
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  return { models, skippedCount };
}
