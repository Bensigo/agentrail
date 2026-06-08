export const RUN_EVENTS_TABLE = "run_events";

export const CREATE_RUN_EVENTS = `
CREATE TABLE IF NOT EXISTS ${RUN_EVENTS_TABLE} (
  workspace_id String,
  repository_id String,
  run_id String,
  agent String,
  phase String,
  event_type String,
  severity String,
  occurred_at DateTime64(3, 'UTC'),
  event_id String,
  submission_kind String,
  payload String
)
ENGINE = MergeTree
PARTITION BY (workspace_id, toYYYYMM(occurred_at))
ORDER BY (workspace_id, occurred_at, event_id)
`;

export interface RunEvent {
  workspace_id: string;
  repository_id: string;
  run_id: string;
  agent: string;
  phase: string;
  event_type: string;
  severity: string;
  occurred_at: string;
  event_id: string;
  submission_kind: string;
  payload: string;
}
