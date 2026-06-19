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

/** ALTER TABLE statements for context_packs columns added after initial table creation. */
export const ALTER_CONTEXT_PACKS_ADD_TOKENS_SAVED = `
ALTER TABLE context_packs ADD COLUMN IF NOT EXISTS tokens_saved UInt64 DEFAULT 0
`;

export const ALTER_CONTEXT_PACKS_ADD_PRECISION_AT_BUDGET = `
ALTER TABLE context_packs ADD COLUMN IF NOT EXISTS precision_at_budget Float32 DEFAULT 0
`;

export const ALTER_CONTEXT_PACKS_ADD_CITATION_COVERAGE = `
ALTER TABLE context_packs ADD COLUMN IF NOT EXISTS citation_coverage Float32 DEFAULT 0
`;

export const ALTER_CONTEXT_PACKS_ADD_STALE_COUNT = `
ALTER TABLE context_packs ADD COLUMN IF NOT EXISTS stale_count UInt16 DEFAULT 0
`;

export const ALTER_CONTEXT_PACKS_ADD_DENIED_COUNT = `
ALTER TABLE context_packs ADD COLUMN IF NOT EXISTS denied_count UInt16 DEFAULT 0
`;

export const ALTER_CONTEXT_PACKS_ADD_SOURCE_HASH_LIST = `
ALTER TABLE context_packs ADD COLUMN IF NOT EXISTS source_hash_list Array(String) DEFAULT []
`;

// Repository the pack belongs to. The producer already sends repository_id on
// every pack; previously it was used only for ingest access-control and dropped.
// Storing it lets Context Quality filter by repo directly (the old run_events
// subquery returned nothing because run_events.repository_id is empty in prod).
// Historical rows default to '' and won't match a specific-repo filter.
export const ALTER_CONTEXT_PACKS_ADD_REPOSITORY_ID = `
ALTER TABLE context_packs ADD COLUMN IF NOT EXISTS repository_id String DEFAULT ''
`;

export interface ContextPackRecord {
  workspace_id: string;
  /** Repository this pack belongs to (enables per-repo Context Quality filtering). */
  repository_id?: string;
  run_id: string;
  context_pack_id: string;
  token_budget: number;
  tokens_used: number;
  /** Estimated tokens saved by bounded retrieval vs reading the full files. */
  tokens_saved: number;
  anchors_extracted: number;
  sources_considered: number;
  /** Fraction of token budget filled by required sources (0.0–1.0). */
  precision_at_budget: number;
  /** Fraction of included items that carry a citation (0.0–1.0). */
  citation_coverage: number;
  /** Number of included items whose source hash is older than the current index snapshot. */
  stale_count: number;
  /** Number of candidate items excluded by source custody policy. */
  denied_count: number;
  /** Ordered list of SHA hashes for every included source item. */
  source_hash_list: string[];
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
  payload       String,
  session_id    String DEFAULT '',
  seq           Int64  DEFAULT 0,
  files_read_count UInt32 DEFAULT 0,
  full_file_read UInt8 DEFAULT 0,
  tool_loop_count UInt16 DEFAULT 0,
  edit_without_context UInt8 DEFAULT 0,
  verification_skip UInt8 DEFAULT 0
)
ENGINE = MergeTree()
PARTITION BY (workspace_id, toYYYYMM(occurred_at))
ORDER BY (workspace_id, occurred_at, event_id)
`;

/** ALTER TABLE statements for columns added after initial table creation. */
export const ALTER_RUN_EVENTS_ADD_SESSION_ID = `
ALTER TABLE run_events ADD COLUMN IF NOT EXISTS session_id String DEFAULT ''
`;

export const ALTER_RUN_EVENTS_ADD_SEQ = `
ALTER TABLE run_events ADD COLUMN IF NOT EXISTS seq Int64 DEFAULT 0
`;

export const ALTER_RUN_EVENTS_ADD_FILES_READ_COUNT = `
ALTER TABLE run_events ADD COLUMN IF NOT EXISTS files_read_count UInt32 DEFAULT 0
`;

export const ALTER_RUN_EVENTS_ADD_FULL_FILE_READ = `
ALTER TABLE run_events ADD COLUMN IF NOT EXISTS full_file_read UInt8 DEFAULT 0
`;

export const ALTER_RUN_EVENTS_ADD_TOOL_LOOP_COUNT = `
ALTER TABLE run_events ADD COLUMN IF NOT EXISTS tool_loop_count UInt16 DEFAULT 0
`;

export const ALTER_RUN_EVENTS_ADD_EDIT_WITHOUT_CONTEXT = `
ALTER TABLE run_events ADD COLUMN IF NOT EXISTS edit_without_context UInt8 DEFAULT 0
`;

export const ALTER_RUN_EVENTS_ADD_VERIFICATION_SKIP = `
ALTER TABLE run_events ADD COLUMN IF NOT EXISTS verification_skip UInt8 DEFAULT 0
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
  session_id: string;
  seq: number;
  files_read_count?: number;
  full_file_read?: number;
  tool_loop_count?: number;
  edit_without_context?: number;
  verification_skip?: number;
}

export const CREATE_FAILURE_EVENTS_TABLE = `
CREATE TABLE IF NOT EXISTS failure_events (
  workspace_id  String,
  run_id        String,
  repository_id String,
  failure_type  String,
  message       String,
  normalized_error String DEFAULT '',
  fingerprint String DEFAULT '',
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

/** ALTER TABLE statements for failure_events columns added after initial table creation. */
export const ALTER_FAILURE_EVENTS_ADD_NORMALIZED_ERROR = `
ALTER TABLE failure_events ADD COLUMN IF NOT EXISTS normalized_error String DEFAULT ''
`;

export const ALTER_FAILURE_EVENTS_ADD_FINGERPRINT = `
ALTER TABLE failure_events ADD COLUMN IF NOT EXISTS fingerprint String DEFAULT ''
`;

export interface FailureEventRecord {
  workspace_id: string;
  run_id: string;
  repository_id: string;
  failure_type: string;
  message: string;
  normalized_error: string;
  fingerprint: string;
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

/** ALTER TABLE statements for cost_events columns added after initial table creation. */
export const ALTER_COST_EVENTS_ADD_PHASE = `
ALTER TABLE cost_events ADD COLUMN IF NOT EXISTS phase String DEFAULT ''
`;

export const ALTER_COST_EVENTS_ADD_INPUT_TOKENS = `
ALTER TABLE cost_events ADD COLUMN IF NOT EXISTS input_tokens UInt64 DEFAULT 0
`;

export const ALTER_COST_EVENTS_ADD_OUTPUT_TOKENS = `
ALTER TABLE cost_events ADD COLUMN IF NOT EXISTS output_tokens UInt64 DEFAULT 0
`;

export const ALTER_COST_EVENTS_ADD_CACHE_TOKENS = `
ALTER TABLE cost_events ADD COLUMN IF NOT EXISTS cache_tokens UInt64 DEFAULT 0
`;

export const ALTER_COST_EVENTS_ADD_CACHE_CREATION_TOKENS = `
ALTER TABLE cost_events ADD COLUMN IF NOT EXISTS cache_creation_tokens UInt64 DEFAULT 0
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
  phase: string;
  input_tokens: number;
  output_tokens: number;
  /** cache-READ tokens (priced at cached_read rate). */
  cache_tokens: number;
  /** cache-WRITE / cache-creation tokens (priced at cached_write rate). */
  cache_creation_tokens: number;
  occurred_at: Date;
  event_id: string;
}

export const CREATE_AFK_RUN_EVENTS_TABLE = `
CREATE TABLE IF NOT EXISTS afk_run_events (
  run_id       String,
  workspace_id String,
  slot         UInt8,
  event_type   LowCardinality(String),
  ts           DateTime64(3, 'UTC'),
  payload_json String,
  digest       String
)
ENGINE = ReplacingMergeTree()
PARTITION BY (workspace_id, toYYYYMM(ts))
ORDER BY (run_id, ts, slot)
`;

export interface AfkRunEventRecord {
  run_id: string;
  workspace_id: string;
  slot: number;
  event_type: string;
  ts: string;
  payload_json: string;
  digest: string;
}
