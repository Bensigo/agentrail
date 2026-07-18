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

export { validateOverride } from "./validator";
export type { OverrideValidation } from "./validator";
