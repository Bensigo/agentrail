/**
 * Read-only lookup over the committed OpenRouter model catalog snapshot
 * (#1337 — "we have 400+ models behind OpenRouter — selection should use the
 * catalog, not a hardcoded 3-seat list"; this module is the substrate #1338
 * (tiers) and #1339 (chat routing) build on).
 *
 * There is no `fetch` call anywhere in this file, by construction: every
 * export below is a pure in-memory `Map` read over
 * `openrouter-catalog.snapshot.json`, imported once at module load via
 * TypeScript's `resolveJsonModule`. That is what makes AC2 ("the catalog
 * refresh survives OpenRouter being down") hold trivially — a stale snapshot
 * serves exactly as well as a fresh one, and its age is always available via
 * `fetchedAt`/`snapshotAgeMs` on every successful lookup and via
 * {@link getSnapshotMeta}. The snapshot itself is refreshed OFFLINE, on
 * demand, by `apps/console/scripts/refresh-openrouter-catalog.ts` — there is
 * deliberately no request-hot-path network fetch anywhere in this substrate
 * (see that script's module doc for the refresh cadence).
 *
 * Unknown slug -> `null` / `false`, never a silent $0. This is the same
 * discipline `catalog.ts`/`catalog.test.ts` already apply to the 3-seat
 * mirror (recon annex's "$0 hazard"), now applied to the full 400+-model
 * live list: a caller that looks up an invalid or retired slug gets an
 * explicit, checkable `null` — never a fabricated rate, never a gateway
 * 404 discovered only at run time.
 */
import snapshotJson from "./openrouter-catalog.snapshot.json";
import type { NormalizedCatalogModel, NormalizedTopProvider } from "./openrouter-normalize";

interface CatalogSnapshot {
  schemaVersion: number;
  sourceUrl: string;
  fetchedAt: string;
  modelCount: number;
  models: NormalizedCatalogModel[];
}

// Cast once at module load rather than let TS infer (and re-check) a
// structural literal type across 300+ JSON entries on every import site.
const snapshot = snapshotJson as CatalogSnapshot;

const modelsBySlug: Map<string, NormalizedCatalogModel> = new Map(
  snapshot.models.map((model) => [model.id, model])
);

export interface GatewayCatalogEntry {
  /** The looked-up slug, verbatim (== the map key that resolved). */
  slug: string;
  inUsdPerMTok: number;
  outUsdPerMTok: number;
  contextLength: number;
  topProvider: NormalizedTopProvider;
  /** ISO timestamp the snapshot was fetched at (AC2: age must be surfaced). */
  fetchedAt: string;
  /** `Date.now() - fetchedAt`, in milliseconds, computed fresh on every call. */
  snapshotAgeMs: number;
}

/**
 * Look up a gateway model slug (e.g. `"anthropic/claude-sonnet-5"`) in the
 * committed snapshot.
 *
 * Returns `null` for any slug not present. Callers must treat `null` as a
 * hard failure — fail loud (throw, refuse the run, surface an error to the
 * user) — never substitute a $0 rate or a guessed fallback here; that
 * decision belongs to the caller (e.g. the PRICE_TABLE fallback layer in
 * `agentrail/run/pricing.py::_resolve_rates`), not to this lookup.
 */
export function getModelFromCatalog(slug: string): GatewayCatalogEntry | null {
  const model = modelsBySlug.get(slug);
  if (!model) return null;
  return {
    slug: model.id,
    inUsdPerMTok: model.inUsdPerMTok,
    outUsdPerMTok: model.outUsdPerMTok,
    contextLength: model.contextLength,
    topProvider: model.topProvider,
    fetchedAt: snapshot.fetchedAt,
    snapshotAgeMs: Date.now() - Date.parse(snapshot.fetchedAt),
  };
}

/** `true` iff `slug` is present in the committed snapshot — the slug-validation primitive (AC3). */
export function isKnownModelSlug(slug: string): boolean {
  return modelsBySlug.has(slug);
}

export interface SnapshotMeta {
  sourceUrl: string;
  fetchedAt: string;
  modelCount: number;
  snapshotAgeMs: number;
}

/** Snapshot-level metadata, independent of any single slug — for surfacing staleness in UI/logs (AC2). */
export function getSnapshotMeta(): SnapshotMeta {
  return {
    sourceUrl: snapshot.sourceUrl,
    fetchedAt: snapshot.fetchedAt,
    modelCount: snapshot.modelCount,
    snapshotAgeMs: Date.now() - Date.parse(snapshot.fetchedAt),
  };
}
