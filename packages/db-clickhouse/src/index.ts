export { client } from "./client";
export {
  CREATE_RUN_EVENTS_TABLE,
  CREATE_FAILURE_EVENTS_TABLE,
  CREATE_CONTEXT_PACKS_TABLE,
  CREATE_CONTEXT_EVENTS_TABLE,
  CREATE_INDEX_SNAPSHOTS_TABLE,
  CREATE_COST_EVENTS_TABLE,
  ALTER_RUN_EVENTS_ADD_SESSION_ID,
  ALTER_RUN_EVENTS_ADD_SEQ,
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
  insertAfkRunEvents,
  insertIndexSnapshots,
  deriveSnapshotEventId,
  insertCostEvents,
  deriveCostEventId,
  getRunEventsByRunId,
  insertContextPacks,
  deriveContextPackId,
  getWorkspaceTelemetryCounts,
} from "./queries";
export type {
  RunEventSummary,
  ListWorkspaceFailuresOptions,
  CostGroupBy,
  CostAggregateRow,
  AggregateCostsOptions,
  AfkRunEventInput,
  IndexSnapshotInput,
  CostEventInput,
  ContextPackInput,
  WorkspaceTelemetryCounts,
} from "./queries";
export {
  getContextPacksForRun,
  getContextPackItems,
  getWorkspaceContextPacks,
  insertContextEvents,
} from "./context-queries";
export type { ContextEventInput } from "./context-queries";
