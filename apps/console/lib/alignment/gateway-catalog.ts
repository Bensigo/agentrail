/**
 * Live-fetched, in-memory-cached lookup over the OpenRouter model catalog
 * (#1337 — "we have 400+ models behind OpenRouter — selection should use the
 * catalog, not a hardcoded 3-seat list"; this module is the substrate #1338
 * (tiers) and #1339 (chat routing) build on).
 *
 * #1337 originally shipped this as a committed JSON snapshot mirrored into
 * TWO byte-identical copies (one here, one under `agentrail/context/` for the
 * Python runner image), a manual refresh script, and a CI test keeping the
 * two copies in parity. Owner-directed simplification (2026-07-20): no
 * measured latency ever justified serving a stale committed file over a live
 * call, and the two-copy/parity machinery existed ONLY to prop up that file
 * — so this drops all of it and fetches the live catalog instead, once per
 * process, from `GET https://openrouter.ai/api/v1/models` (no auth required).
 *
 * `getModelFromCatalog`/`isKnownModelSlug` stay SYNCHRONOUS — the contract
 * every caller up the chain already depends on (`resolveModelPrice`,
 * `estimateBrief`, `composeAlignmentBrief`/`composeChatBornBrief`; none of
 * those are async, and `estimate.ts`'s own module doc commits to "no network
 * I/O" for that pure chain). To keep that contract while sourcing from a
 * network call, loading is FIRE-AND-FORGET: the first call in a process's
 * lifetime kicks off the fetch in the background and returns based on
 * whatever the cache holds right now (empty, the first time). Every call
 * before that fetch resolves, and every call ever made if it fails, sees an
 * empty catalog and returns `null`/`false` — indistinguishable from each
 * other, and both routed to the SAME PRICE_TABLE-fallback path a real "this
 * slug isn't in the catalog" miss would take (`resolve-price.ts`'s
 * `resolveModelPrice`). Never a silent $0, never a thrown exception on this
 * path. Once the fetch resolves successfully, every subsequent call in that
 * process sees the real, live-priced catalog. There is no TTL and no retry
 * after a failure — a console/fleet restart on deploy is the only refresh
 * mechanism, same as the old design's manual `catalog:refresh` + redeploy.
 */
import { normalizeOpenRouterModelsResponse } from "./openrouter-normalize";
import type { NormalizedCatalogModel, NormalizedTopProvider, RawOpenRouterModelsResponse } from "./openrouter-normalize";
import { MODEL_CATALOG } from "./catalog";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

export interface GatewayCatalogEntry {
  /** The looked-up slug, verbatim (== the map key that resolved). */
  slug: string;
  inUsdPerMTok: number;
  outUsdPerMTok: number;
  contextLength: number;
  topProvider: NormalizedTopProvider;
}

let modelsBySlug: Map<string, NormalizedCatalogModel> = new Map();
let loadPromise: Promise<void> | null = null;

/**
 * AC3 slug safety, SIMPLIFIED (owner-directed 2026-07-20) — NOT the elaborate
 * committed-snapshot CI gate #1337 originally shipped (a hard-failing test
 * asserting every shipped slug against a committed file). The real safety
 * net is, and stays, {@link getModelFromCatalog}'s null-on-unknown +
 * `resolveModelPrice`'s PRICE_TABLE fallback — never a silent $0. This is
 * just an operator signal, non-fatal by construction: once the live catalog
 * first loads, warn (never throw) if one of the 4 alignment-brief seats this
 * repo ships (`catalog.ts`'s {@link MODEL_CATALOG}) isn't in it.
 *
 * The hosted-runner config (`deploy/runner/agentrail-config.hosted.json`) is
 * checked the same way, but from `slug-validation.test.ts` rather than here:
 * that file is never copied into the console's Docker build context (see
 * `apps/console/Dockerfile`'s COPY list — it copies `apps/console` and
 * `packages/*`, never `deploy/`), so a runtime read of it would always
 * ENOENT in production. A test running against the full repo checkout is
 * the only place it can be read at all.
 */
function warnUnknownSeatSlugs(): void {
  const unknown = Object.entries(MODEL_CATALOG).filter(([, seat]) => !modelsBySlug.has(seat.slug));
  if (unknown.length === 0) return;
  console.warn(
    `[gateway-catalog] ${unknown.length} shipped MODEL_CATALOG seat(s) not found in the live OpenRouter ` +
      `catalog: ${unknown.map(([taskType, seat]) => `${taskType}="${seat.slug}"`).join(", ")} — pricing for ` +
      "these falls back to their own PRICE_TABLE-mirrored constants (never a silent $0), but check whether " +
      "the slug moved or was retired on OpenRouter."
  );
}

/** Kick off the live fetch exactly once per process; every caller shares the same in-flight/settled promise. */
function ensureCatalogLoading(): Promise<void> {
  if (!loadPromise) {
    loadPromise = fetch(OPENROUTER_MODELS_URL)
      .then(async (res) => {
        if (!res.ok) {
          console.warn(
            `[gateway-catalog] OpenRouter ${OPENROUTER_MODELS_URL} returned ${res.status} ${res.statusText} — ` +
              "every pricing lookup this process makes falls back to PRICE_TABLE."
          );
          return;
        }
        const body = (await res.json()) as RawOpenRouterModelsResponse;
        const { models } = normalizeOpenRouterModelsResponse(body);
        modelsBySlug = new Map(models.map((model) => [model.id, model]));
        warnUnknownSeatSlugs();
      })
      .catch((err: unknown) => {
        // Network error, non-2xx already handled above, or a malformed body
        // that made res.json()/normalize throw — ALL land here. Never
        // rethrown: an empty catalog is the correct, non-fatal degradation.
        console.warn(
          `[gateway-catalog] fetching the OpenRouter catalog failed (${String(err)}) — every pricing lookup ` +
            "this process makes falls back to PRICE_TABLE."
        );
      });
  }
  return loadPromise;
}

/**
 * Look up a gateway model slug (e.g. `"anthropic/claude-sonnet-5"`) in the
 * live-fetched catalog (see module doc for the fire-and-forget load timing).
 *
 * Returns `null` for any slug not present — including "catalog hasn't loaded
 * yet" and "catalog failed to load," which are indistinguishable to a caller
 * and treated identically on purpose (see module doc). Callers must treat
 * `null` as a hard miss and use their own fallback (e.g. the PRICE_TABLE
 * branch in `resolve-price.ts`'s `resolveModelPrice`) — never substitute a
 * $0 rate or a guessed fallback here; that decision belongs to the caller.
 */
export function getModelFromCatalog(slug: string): GatewayCatalogEntry | null {
  void ensureCatalogLoading();
  const model = modelsBySlug.get(slug);
  if (!model) return null;
  return {
    slug: model.id,
    inUsdPerMTok: model.inUsdPerMTok,
    outUsdPerMTok: model.outUsdPerMTok,
    contextLength: model.contextLength,
    topProvider: model.topProvider,
  };
}

/** `true` iff `slug` is present in the live-fetched catalog right now (see module doc on load timing) — the slug-validation primitive (AC3). */
export function isKnownModelSlug(slug: string): boolean {
  void ensureCatalogLoading();
  return modelsBySlug.has(slug);
}

// ---------------------------------------------------------------------------
// TEST-ONLY seams. Production code never calls these — every real caller
// (resolveModelPrice, estimateBrief, ...) only ever uses the two exports
// above, synchronously, exactly as before. Tests need to (a) force-and-await
// a load so assertions run against a deterministic, fully-settled cache
// instead of racing the background fetch, and (b) reset between cases so one
// test's mocked fetch/response doesn't leak into the next (module state here
// is a process-lifetime singleton by design — see module doc).
// ---------------------------------------------------------------------------

/** Await the in-flight (or already-settled) catalog load. Test-only. */
export function _awaitCatalogLoadForTests(): Promise<void> {
  return ensureCatalogLoading();
}

/** Clear the module-level cache so the next lookup starts a fresh load. Test-only. */
export function _resetCatalogForTests(): void {
  modelsBySlug = new Map();
  loadPromise = null;
}
