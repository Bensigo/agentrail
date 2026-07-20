/**
 * Public surface of the alignment estimate + suggestion lib (#1275 PR ①).
 *
 * Pure TypeScript, no db/routes/render — this is the contract later PRs
 * (the alignment brief render, #1274) build on top of.
 *
 * DELIBERATELY DB-FREE (#1338 PR② constraint, learned the hard way):
 * `selector.ts`'s `selectExecuteModel` imports `getModelOutcomeStats` from
 * `@agentrail/db-postgres`, which transitively pulls in Node builtins
 * (`node:crypto`, `net`, `tls`, `fs`, ...) via `db.ts`'s `postgres` client —
 * see `approvals-helpers.ts`'s own doc-comment for the first time this bit a
 * client bundle. This barrel is imported by at least one CLIENT-rendered
 * marketing page (`app/(marketing)/_conversation-demo-data.ts` ->
 * `_scroll-narrative.tsx`, which only needs the pure `estimateBrief`), so
 * `selector.ts` (and its `SelectionReason`/`ModelSelection` types) is
 * DELIBERATELY NOT re-exported here — importing it from this barrel breaks
 * `next build` with an UnhandledSchemeError on `node:crypto` (confirmed:
 * this is not a hypothetical). Server-only code that needs the selector
 * (`alignment-brief.ts`'s `resolveModelSelectionForBrief` — the ONE place
 * it's wired in) imports `./alignment/selector` DIRECTLY, bypassing this
 * barrel entirely. `eligibility.ts`/`seeds.ts`/`feature-flags.ts` stay here
 * because none of them import `@agentrail/db-postgres` (or anything else
 * DB-touching) — verify this invariant before adding a new export here.
 */

export { classifyTaskType } from "./classifier";
export type { TaskType, TaskInput } from "./classifier";

export { MODEL_CATALOG, CATALOG_PRICE_TABLE_MAPPING } from "./catalog";
export type { ModelSeat } from "./catalog";

export { bucketVolume, estimateBrief } from "./estimate";
export type { VolumeBucket, BriefEstimate, EstimateBriefOptions } from "./estimate";

// Model-selection learning loop (#1338 PR②, pool widened PR③) — candidates +
// eligibility + seeds layers only (DB-free — see module doc above for why
// selector.ts stays OUT of this barrel). candidates.ts's module doc explains
// the widened, mostly-non-Claude per-task pool and why it's separate from
// MODEL_CATALOG; eligibility.ts's module doc has the HARD OWNER RULE (ui
// never gets haiku); seeds.ts documents today's per-task seed.
export { CANDIDATES, MODEL_SEATS } from "./candidates";

export {
  ALL_TASK_TYPES,
  eligibleModelsForTaskType,
  isModelEligibleForTaskType,
  allEligibleModelSlugs,
} from "./eligibility";

export { seedModel } from "./seeds";

export { isModelSelectionLearningEnabled } from "./feature-flags";
export type { FeatureFlagEnv } from "./feature-flags";

// The gateway catalog substrate (#1337) — the full 400+-model OpenRouter
// list, live-fetched and cached for the process lifetime (see
// gateway-catalog.ts's module doc). #1338/#1339 build model selection on top
// of this; MODEL_CATALOG above stays the alignment brief's own curated
// 3-seat default and is unaffected.
export { getModelFromCatalog, isKnownModelSlug } from "./gateway-catalog";
export type { GatewayCatalogEntry } from "./gateway-catalog";

// Gateway-first / PRICE_TABLE-fallback pricing policy (#1337 PR ②) —
// estimate.ts's own pricing now goes through this; exported so future
// consumers (#1338/#1339) share the same source-of-truth ordering.
export { resolveModelPrice } from "./resolve-price";
export type { PriceSource, ResolvedPrice } from "./resolve-price";

export { validateOverride } from "./validator";
export type { OverrideValidation } from "./validator";
