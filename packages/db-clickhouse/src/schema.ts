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

export const FAILURE_EVENTS_TABLE = "failure_events";

export const CREATE_FAILURE_EVENTS = `
CREATE TABLE IF NOT EXISTS ${FAILURE_EVENTS_TABLE} (
  workspace_id String,
  run_id String,
  repository_id String,
  failure_type String,
  message String,
  evidence String,
  phase String,
  severity String,
  occurred_at DateTime64(3, 'UTC'),
  event_id String
)
ENGINE = MergeTree
PARTITION BY (workspace_id, toYYYYMM(occurred_at))
ORDER BY (workspace_id, occurred_at, event_id)
`;

export interface FailureEvent {
  workspace_id: string;
  run_id: string;
  repository_id: string;
  failure_type: string;
  message: string;
  evidence: string;
  phase: string;
  severity: string;
  occurred_at: string;
  event_id: string;
}

export const COST_EVENTS_TABLE = "cost_events";

export const CREATE_COST_EVENTS = `
CREATE TABLE IF NOT EXISTS ${COST_EVENTS_TABLE} (
  workspace_id String,
  run_id String,
  repository_id String,
  team_id String,
  api_key_id String,
  cost_type String,
  tokens UInt64,
  cost_usd Float64,
  model String,
  occurred_at DateTime64(3, 'UTC'),
  event_id String
)
ENGINE = MergeTree
PARTITION BY (workspace_id, toYYYYMM(occurred_at))
ORDER BY (workspace_id, occurred_at, event_id)
`;

export interface CostEvent {
  workspace_id: string;
  run_id: string;
  repository_id: string;
  team_id: string;
  api_key_id: string;
  cost_type: string;
  tokens: number;
  cost_usd: number;
  model: string;
  occurred_at: string;
  event_id: string;
}

export const INDEX_SNAPSHOTS_TABLE = "index_snapshots";

export const CREATE_INDEX_SNAPSHOTS = `
CREATE TABLE IF NOT EXISTS ${INDEX_SNAPSHOTS_TABLE} (
  workspace_id String,
  repository_id String,
  commit_sha String,
  indexed_at DateTime64(3, 'UTC'),
  source_count UInt32,
  graph_edge_count UInt32,
  event_id String
)
ENGINE = MergeTree
PARTITION BY (workspace_id, toYYYYMM(indexed_at))
ORDER BY (workspace_id, repository_id, indexed_at)
`;

export interface IndexSnapshot {
  workspace_id: string;
  repository_id: string;
  commit_sha: string;
  indexed_at: string;
  source_count: number;
  graph_edge_count: number;
  event_id: string;
}
