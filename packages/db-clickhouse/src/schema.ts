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

export const CONTEXT_EVENTS_TABLE = "context_events";

export const CREATE_CONTEXT_EVENTS = `
CREATE TABLE IF NOT EXISTS ${CONTEXT_EVENTS_TABLE} (
  workspace_id String,
  run_id String,
  context_pack_id String,
  item_path String,
  item_hash String,
  included UInt8,
  citation String,
  reason String,
  score Float32,
  token_budget UInt32,
  tokens_used UInt32,
  anchors_extracted UInt32,
  sources_considered UInt32,
  occurred_at DateTime64(3, 'UTC')
)
ENGINE = MergeTree
PARTITION BY (workspace_id, toYYYYMM(occurred_at))
ORDER BY (workspace_id, run_id, context_pack_id, occurred_at)
`;

export interface ContextEvent {
  workspace_id: string;
  run_id: string;
  context_pack_id: string;
  item_path: string;
  item_hash: string;
  included: number;
  citation: string;
  reason: string;
  score: number;
  token_budget: number;
  tokens_used: number;
  anchors_extracted: number;
  sources_considered: number;
  occurred_at: string;
}
