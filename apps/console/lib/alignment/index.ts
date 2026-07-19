/**
 * Public surface of the alignment estimate + suggestion lib (#1275 PR ①).
 *
 * Pure TypeScript, no db/routes/render — this is the contract later PRs
 * (the alignment brief render, #1274) build on top of.
 */

export { classifyTaskType } from "./classifier";
export type { TaskType, TaskInput } from "./classifier";

export { MODEL_CATALOG, CATALOG_PRICE_TABLE_MAPPING } from "./catalog";
export type { ModelSeat } from "./catalog";

export { bucketVolume, estimateBrief } from "./estimate";
export type { VolumeBucket, BriefEstimate } from "./estimate";

// The gateway catalog substrate (#1337) — the full 400+-model OpenRouter
// list, snapshot-served (see gateway-catalog.ts's module doc). #1338/#1339
// build model selection on top of this; MODEL_CATALOG above stays the
// alignment brief's own curated 3-seat default and is unaffected.
export { getModelFromCatalog, isKnownModelSlug, getSnapshotMeta } from "./gateway-catalog";
export type { GatewayCatalogEntry, SnapshotMeta } from "./gateway-catalog";

export { validateOverride } from "./validator";
export type { OverrideValidation } from "./validator";
