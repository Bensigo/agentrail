export const CREATE_CONTEXT_PACKS_TABLE = `
CREATE TABLE IF NOT EXISTS context_packs (
  workspace_id        String,
  run_id              String,
  context_pack_id     String,
  token_budget        UInt32,
  tokens_used         UInt32,
  anchors_extracted   UInt32,
  sources_considered  UInt32,
  occurred_at         DateTime64(3, 'UTC')
)
ENGINE = MergeTree()
PARTITION BY (workspace_id, toYYYYMM(occurred_at))
ORDER BY (workspace_id, run_id, context_pack_id)
`;

export interface ContextPackRecord {
  workspace_id: string;
  run_id: string;
  context_pack_id: string;
  token_budget: number;
  tokens_used: number;
  anchors_extracted: number;
  sources_considered: number;
  occurred_at: Date;
}

export const CREATE_CONTEXT_EVENTS_TABLE = `
CREATE TABLE IF NOT EXISTS context_events (
  workspace_id     String,
  run_id           String,
  context_pack_id  String,
  item_path        String,
  item_hash        String,
  included         UInt8,
  citation         String,
  reason           String,
  score            Float64,
  occurred_at      DateTime64(3, 'UTC')
)
ENGINE = MergeTree()
PARTITION BY (workspace_id, toYYYYMM(occurred_at))
ORDER BY (workspace_id, run_id, context_pack_id, occurred_at)
`;

export interface ContextEventRecord {
  workspace_id: string;
  run_id: string;
  context_pack_id: string;
  item_path: string;
  item_hash: string;
  /** 1 = included, 0 = excluded */
  included: number;
  citation: string;
  reason: string;
  score: number;
  occurred_at: Date;
}

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

export const CREATE_FAILURE_EVENTS_TABLE = `
CREATE TABLE IF NOT EXISTS failure_events (
  workspace_id  String,
  run_id        String,
  repository_id String,
  failure_type  String,
  message       String,
  evidence      String,
  phase         String,
  severity      String,
  occurred_at   DateTime64(3, 'UTC'),
  event_id      String
)
ENGINE = MergeTree()
PARTITION BY (workspace_id, toYYYYMM(occurred_at))
ORDER BY (workspace_id, occurred_at, event_id)
`;

export interface FailureEventRecord {
  workspace_id: string;
  run_id: string;
  repository_id: string;
  failure_type: string;
  message: string;
  /** JSON-encoded evidence string */
  evidence: string;
  phase: string;
  severity: string;
  occurred_at: Date;
  event_id: string;
}

export const CREATE_INDEX_SNAPSHOTS_TABLE = `
CREATE TABLE IF NOT EXISTS index_snapshots (
  workspace_id    String,
  repository_id   String,
  commit_sha      String,
  indexed_at      DateTime64(3, 'UTC'),
  source_count    UInt32,
  graph_edge_count UInt32,
  event_id        String
)
ENGINE = MergeTree()
PARTITION BY (workspace_id, toYYYYMM(indexed_at))
ORDER BY (workspace_id, repository_id, indexed_at)
`;

export interface IndexSnapshotRecord {
  workspace_id: string;
  repository_id: string;
  commit_sha: string;
  indexed_at: Date | string;
  source_count: number;
  graph_edge_count: number;
  event_id: string;
}

export const CREATE_COST_EVENTS_TABLE = `
CREATE TABLE IF NOT EXISTS cost_events (
  workspace_id  String,
  run_id        String,
  repository_id String,
  team_id       String,
  api_key_id    String,
  cost_type     String,
  tokens        UInt64,
  cost_usd      Float64,
  model         String,
  occurred_at   DateTime64(3, 'UTC'),
  event_id      String
)
ENGINE = MergeTree()
PARTITION BY (workspace_id, toYYYYMM(occurred_at))
ORDER BY (workspace_id, occurred_at, event_id)
`;

export interface CostEventRecord {
  workspace_id: string;
  run_id: string;
  repository_id: string;
  team_id: string;
  api_key_id: string;
  /** model_call | embedding | reranking | storage */
  cost_type: string;
  tokens: number;
  cost_usd: number;
  model: string;
  occurred_at: Date;
  event_id: string;
}
