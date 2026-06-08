export const CREATE_RUN_EVENTS_TABLE = `
CREATE TABLE IF NOT EXISTS run_events (
  workspace_id  String,
  repository_id String,
  run_id        String,
  agent         String,
  phase         String,
  event_type    String,
  severity      String,
  occurred_at   DateTime64(3, 'UTC'),
  event_id      String,
  submission_kind String,
  payload       String
)
ENGINE = MergeTree()
PARTITION BY (workspace_id, toYYYYMM(occurred_at))
ORDER BY (workspace_id, occurred_at, event_id)
`;

export interface TelemetryEventRecord {
  workspace_id: string;
  repository_id: string;
  run_id: string;
  agent: string;
  phase: string;
  event_type: string;
  severity: string;
  occurred_at: Date;
  event_id: string;
  submission_kind: string;
  /** JSON-encoded payload string */
  payload: string;
}
