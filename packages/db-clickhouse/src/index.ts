export { client } from "./client";
export {
  CREATE_RUN_EVENTS_TABLE,
  CREATE_FAILURE_EVENTS_TABLE,
  CREATE_CONTEXT_PACKS_TABLE,
  CREATE_CONTEXT_EVENTS_TABLE,
  CREATE_INDEX_SNAPSHOTS_TABLE,
  CREATE_COST_EVENTS_TABLE,
} from "./schema";
export type {
  TelemetryEventRecord,
  FailureEventRecord,
  ContextPackRecord,
  ContextEventRecord,
  IndexSnapshotRecord,
  CostEventRecord,
} from "./schema";
export {
  getRunEvents,
  getRunEventSummaries,
  getFailuresForRun,
  listWorkspaceFailures,
  getFailureById,
  aggregateWorkspaceCosts,
  getLatestIndexSnapshotsForWorkspace,
} from "./queries";
export type {
  RunEventSummary,
  ListWorkspaceFailuresOptions,
  CostGroupBy,
  CostAggregateRow,
  AggregateCostsOptions,
} from "./queries";
export { getContextPacksForRun, getContextPackItems } from "./context-queries";
