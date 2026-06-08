export { client } from "./client";
export { CREATE_RUN_EVENTS_TABLE, CREATE_FAILURE_EVENTS_TABLE } from "./schema";
export type { TelemetryEventRecord, FailureEventRecord } from "./schema";
export {
  getRunEvents,
  getRunEventSummaries,
  getFailuresForRun,
  listWorkspaceFailures,
  getFailureById,
} from "./queries";
export type { RunEventSummary, ListWorkspaceFailuresOptions } from "./queries";
