import { createHash } from "crypto";
import { client } from "./client";
import type { TelemetryEventRecord, FailureEventRecord, IndexSnapshotRecord } from "./schema";

export type CostGroupBy = "team" | "repo" | "api_key" | "run";

export interface CostAggregateRow {
  entity_id: string;
  total_tokens: number;
  total_cost_usd: number;
  model_call_tokens: number;
  model_call_cost_usd: number;
  embedding_tokens: number;
  embedding_cost_usd: number;
  reranking_tokens: number;
  reranking_cost_usd: number;
  storage_tokens: number;
  storage_cost_usd: number;
  event_count: number;
}

export interface AggregateCostsOptions {
  groupBy?: CostGroupBy;
  timeFrom?: Date;
  timeTo?: Date;
}

const GROUP_BY_COLUMN: Record<CostGroupBy, string> = {
  team: "team_id",
  repo: "repository_id",
  api_key: "api_key_id",
  run: "run_id",
};

export async function aggregateWorkspaceCosts(
  workspaceId: string,
  opts: AggregateCostsOptions = {}
): Promise<CostAggregateRow[]> {
  const { groupBy = "repo", timeFrom, timeTo } = opts;
  const groupCol = GROUP_BY_COLUMN[groupBy];

  const conditions: string[] = ["workspace_id = {workspaceId: String}"];
  const queryParams: Record<string, unknown> = { workspaceId };

  if (timeFrom) {
    conditions.push("occurred_at >= {timeFrom: DateTime64(3)}");
    queryParams.timeFrom = timeFrom.toISOString().replace("T", " ").replace("Z", "");
  }
  if (timeTo) {
    conditions.push("occurred_at <= {timeTo: DateTime64(3)}");
    queryParams.timeTo = timeTo.toISOString().replace("T", " ").replace("Z", "");
  }

  const result = await client.query({
    query: `
      SELECT
        ${groupCol} AS entity_id,
        sum(tokens)                                        AS total_tokens,
        sum(cost_usd)                                      AS total_cost_usd,
        sumIf(tokens,  cost_type = 'model_call')           AS model_call_tokens,
        sumIf(cost_usd, cost_type = 'model_call')          AS model_call_cost_usd,
        sumIf(tokens,  cost_type = 'embedding')            AS embedding_tokens,
        sumIf(cost_usd, cost_type = 'embedding')           AS embedding_cost_usd,
        sumIf(tokens,  cost_type = 'reranking')            AS reranking_tokens,
        sumIf(cost_usd, cost_type = 'reranking')           AS reranking_cost_usd,
        sumIf(tokens,  cost_type = 'storage')              AS storage_tokens,
        sumIf(cost_usd, cost_type = 'storage')             AS storage_cost_usd,
        count()                                            AS event_count
      FROM cost_events
      WHERE ${conditions.join(" AND ")}
      GROUP BY entity_id
      ORDER BY total_cost_usd DESC
    `,
    query_params: queryParams,
    format: "JSONEachRow",
  });

  const rows = await result.json<Record<string, unknown>>();
  return rows.map((r) => ({
    entity_id: String(r.entity_id),
    total_tokens: Number(r.total_tokens),
    total_cost_usd: Number(r.total_cost_usd),
    model_call_tokens: Number(r.model_call_tokens),
    model_call_cost_usd: Number(r.model_call_cost_usd),
    embedding_tokens: Number(r.embedding_tokens),
    embedding_cost_usd: Number(r.embedding_cost_usd),
    reranking_tokens: Number(r.reranking_tokens),
    reranking_cost_usd: Number(r.reranking_cost_usd),
    storage_tokens: Number(r.storage_tokens),
    storage_cost_usd: Number(r.storage_cost_usd),
    event_count: Number(r.event_count),
  }));
}

export async function getRunEvents(
  workspaceId: string,
  runId: string
): Promise<TelemetryEventRecord[]> {
  const result = await client.query({
    query: `
      SELECT
        workspace_id,
        repository_id,
        run_id,
        agent,
        phase,
        event_type,
        severity,
        occurred_at,
        event_id,
        submission_kind,
        payload
      FROM run_events
      WHERE workspace_id = {workspaceId: String}
        AND run_id = {runId: String}
      ORDER BY occurred_at ASC
    `,
    query_params: { workspaceId, runId },
    format: "JSONEachRow",
  });
  return result.json<TelemetryEventRecord>();
}

export interface RunEventSummary {
  run_id: string;
  failure_count: number;
  event_count: number;
}

export async function getRunEventSummaries(
  workspaceId: string,
  runIds: string[]
): Promise<RunEventSummary[]> {
  if (runIds.length === 0) return [];

  const result = await client.query({
    query: `
      SELECT
        run_id,
        countIf(severity = 'error') AS failure_count,
        count(*) AS event_count
      FROM run_events
      WHERE workspace_id = {workspaceId:String}
        AND run_id IN ({runIds:Array(String)})
      GROUP BY run_id
    `,
    query_params: { workspaceId, runIds },
    format: "JSONEachRow",
  });

  const rows = await result.json<{
    run_id: string;
    failure_count: string | number;
    event_count: string | number;
  }>();

  return rows.map((r) => ({
    run_id: r.run_id,
    failure_count: Number(r.failure_count),
    event_count: Number(r.event_count),
  }));
}

export async function getFailuresForRun(
  workspaceId: string,
  runId: string
): Promise<FailureEventRecord[]> {
  const result = await client.query({
    query: `
      SELECT
        workspace_id,
        run_id,
        repository_id,
        failure_type,
        message,
        evidence,
        phase,
        severity,
        occurred_at,
        event_id
      FROM failure_events
      WHERE workspace_id = {workspaceId: String}
        AND run_id = {runId: String}
      ORDER BY occurred_at ASC
    `,
    query_params: { workspaceId, runId },
    format: "JSONEachRow",
  });
  return result.json<FailureEventRecord>();
}

export interface ListWorkspaceFailuresOptions {
  repositoryId?: string;
  runId?: string;
  severity?: string;
  failureType?: string;
  timeFrom?: Date;
  timeTo?: Date;
  limit?: number;
  cursor?: string;
}

export async function listWorkspaceFailures(
  workspaceId: string,
  opts: ListWorkspaceFailuresOptions = {}
): Promise<{ failures: FailureEventRecord[]; nextCursor: string | null }> {
  const { repositoryId, runId, severity, failureType, timeFrom, timeTo, limit = 50, cursor } = opts;

  const conditions: string[] = ["workspace_id = {workspaceId: String}"];
  const queryParams: Record<string, unknown> = { workspaceId };

  if (repositoryId) {
    conditions.push("repository_id = {repositoryId: String}");
    queryParams.repositoryId = repositoryId;
  }
  if (runId) {
    conditions.push("run_id = {runId: String}");
    queryParams.runId = runId;
  }
  if (severity) {
    conditions.push("severity = {severity: String}");
    queryParams.severity = severity;
  }
  if (failureType) {
    conditions.push("failure_type = {failureType: String}");
    queryParams.failureType = failureType;
  }
  if (timeFrom) {
    conditions.push("occurred_at >= {timeFrom: DateTime64(3)}");
    queryParams.timeFrom = timeFrom.toISOString().replace("T", " ").replace("Z", "");
  }
  if (timeTo) {
    conditions.push("occurred_at <= {timeTo: DateTime64(3)}");
    queryParams.timeTo = timeTo.toISOString().replace("T", " ").replace("Z", "");
  }
  if (cursor) {
    const separatorIndex = cursor.indexOf("|");
    if (separatorIndex !== -1) {
      // Composite cursor: "<occurred_at_iso>|<event_id>"
      const cursorTs = cursor.slice(0, separatorIndex).replace("T", " ").replace("Z", "");
      const cursorId = cursor.slice(separatorIndex + 1);
      conditions.push(
        "(occurred_at, event_id) < ({cursorTs: DateTime64(3)}, {cursorId: String})"
      );
      queryParams.cursorTs = cursorTs;
      queryParams.cursorId = cursorId;
    } else {
      // Legacy timestamp-only cursor: backward compat for in-flight requests
      conditions.push("occurred_at < {cursor: DateTime64(3)}");
      queryParams.cursor = cursor;
    }
  }

  const fetchLimit = limit + 1;
  const result = await client.query({
    query: `
      SELECT
        workspace_id,
        run_id,
        repository_id,
        failure_type,
        message,
        evidence,
        phase,
        severity,
        occurred_at,
        event_id
      FROM failure_events
      WHERE ${conditions.join(" AND ")}
      ORDER BY occurred_at DESC
      LIMIT ${fetchLimit}
    `,
    query_params: queryParams,
    format: "JSONEachRow",
  });

  const rows = await result.json<FailureEventRecord>();
  const hasMore = rows.length > limit;
  const failures = hasMore ? rows.slice(0, limit) : rows;
  const lastRow = failures[failures.length - 1];
  const nextCursor = hasMore
    ? `${String(lastRow.occurred_at)}|${lastRow.event_id}`
    : null;

  return { failures, nextCursor };
}

export async function getLatestIndexSnapshotsForWorkspace(
  workspaceId: string,
  repositoryIds: string[]
): Promise<IndexSnapshotRecord[]> {
  if (repositoryIds.length === 0) return [];

  const result = await client.query({
    query: `
      SELECT
        workspace_id,
        repository_id,
        commit_sha,
        indexed_at,
        source_count,
        graph_edge_count,
        event_id
      FROM index_snapshots
      WHERE workspace_id = {workspaceId: String}
        AND repository_id IN ({repositoryIds: Array(String)})
        AND (repository_id, indexed_at) IN (
          SELECT repository_id, max(indexed_at)
          FROM index_snapshots
          WHERE workspace_id = {workspaceId: String}
            AND repository_id IN ({repositoryIds: Array(String)})
          GROUP BY repository_id
        )
    `,
    query_params: { workspaceId, repositoryIds },
    format: "JSONEachRow",
  });

  const rows = await result.json<{
    workspace_id: string;
    repository_id: string;
    commit_sha: string;
    indexed_at: string;
    source_count: string | number;
    graph_edge_count: string | number;
    event_id: string;
  }>();

  return rows.map((r) => ({
    workspace_id: r.workspace_id,
    repository_id: r.repository_id,
    commit_sha: r.commit_sha,
    indexed_at: r.indexed_at,
    source_count: Number(r.source_count),
    graph_edge_count: Number(r.graph_edge_count),
    event_id: r.event_id,
  }));
}

export async function getFailureById(
  workspaceId: string,
  eventId: string
): Promise<FailureEventRecord | null> {
  const result = await client.query({
    query: `
      SELECT
        workspace_id,
        run_id,
        repository_id,
        failure_type,
        message,
        evidence,
        phase,
        severity,
        occurred_at,
        event_id
      FROM failure_events
      WHERE workspace_id = {workspaceId: String}
        AND event_id = {eventId: String}
      LIMIT 1
    `,
    query_params: { workspaceId, eventId },
    format: "JSONEachRow",
  });
  const rows = await result.json<FailureEventRecord>();
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Index snapshot ingestion
// ---------------------------------------------------------------------------

export interface IndexSnapshotInput {
  workspace_id: string;
  repository_id: string;
  commit_sha: string;
  indexed_at: string; // ISO 8601
  source_count: number;
  graph_edge_count: number;
}

export function deriveSnapshotEventId(
  workspaceId: string,
  repositoryId: string,
  commitSha: string,
  indexedAt: string
): string {
  return createHash("sha1")
    .update(`${workspaceId}:${repositoryId}:${commitSha}:${indexedAt}`)
    .digest("hex");
}

/**
 * Insert index snapshots into ClickHouse, deduplicating on
 * (workspace_id, repository_id, commit_sha, indexed_at) via a pre-existence check.
 * Returns the number of rows actually inserted.
 */
export async function insertIndexSnapshots(
  snapshots: IndexSnapshotInput[]
): Promise<number> {
  if (snapshots.length === 0) return 0;

  const candidates = snapshots.map((s) => ({
    s,
    event_id: deriveSnapshotEventId(
      s.workspace_id,
      s.repository_id,
      s.commit_sha,
      s.indexed_at
    ),
  }));

  const eventIds = candidates.map((c) => c.event_id);
  const checkResult = await client.query({
    query: `
      SELECT event_id
      FROM index_snapshots
      WHERE event_id IN ({eventIds: Array(String)})
    `,
    query_params: { eventIds },
    format: "JSONEachRow",
  });
  const existing = new Set(
    (await checkResult.json<{ event_id: string }>()).map((r) => r.event_id)
  );

  const toInsert = candidates.filter((c) => !existing.has(c.event_id));
  if (toInsert.length === 0) return 0;

  const rows = toInsert.map(({ s, event_id }) => ({
    workspace_id: s.workspace_id,
    repository_id: s.repository_id,
    commit_sha: s.commit_sha,
    indexed_at: new Date(s.indexed_at)
      .toISOString()
      .replace("T", " ")
      .replace("Z", ""),
    source_count: s.source_count,
    graph_edge_count: s.graph_edge_count,
    event_id,
  }));

  await client.insert({
    table: "index_snapshots",
    values: rows,
    format: "JSONEachRow",
  });

  return toInsert.length;
}

// ---------------------------------------------------------------------------
// Cost event ingestion
// ---------------------------------------------------------------------------

export interface CostEventInput {
  /** Set server-side from bearer key — never from request body. */
  workspace_id: string;
  run_id: string;
  repository_id: string;
  /** Set server-side from bearer key — never from request body. */
  team_id: string;
  /** Set server-side from bearer key — never from request body. */
  api_key_id: string;
  cost_type: string;
  tokens: number;
  cost_usd: number;
  model: string;
  occurred_at: string; // ISO 8601
  phase?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_tokens?: number;
}

export function deriveCostEventId(
  workspaceId: string,
  runId: string,
  repositoryId: string,
  costType: string,
  occurredAt: string
): string {
  return createHash("sha1")
    .update(`${workspaceId}:${runId}:${repositoryId}:${costType}:${occurredAt}`)
    .digest("hex");
}

/**
 * Insert cost events into ClickHouse, deduplicating on
 * (workspace_id, run_id, repository_id, cost_type, occurred_at) via a pre-existence check.
 * Returns the number of rows actually inserted.
 */
export async function insertCostEvents(events: CostEventInput[]): Promise<number> {
  if (events.length === 0) return 0;

  const candidates = events.map((e) => ({
    e,
    event_id: deriveCostEventId(
      e.workspace_id,
      e.run_id,
      e.repository_id,
      e.cost_type,
      e.occurred_at
    ),
  }));

  const eventIds = candidates.map((c) => c.event_id);
  const checkResult = await client.query({
    query: `
      SELECT event_id
      FROM cost_events
      WHERE event_id IN ({eventIds: Array(String)})
    `,
    query_params: { eventIds },
    format: "JSONEachRow",
  });
  const existing = new Set(
    (await checkResult.json<{ event_id: string }>()).map((r) => r.event_id)
  );

  const toInsert = candidates.filter((c) => !existing.has(c.event_id));
  if (toInsert.length === 0) return 0;

  const rows = toInsert.map(({ e, event_id }) => ({
    workspace_id: e.workspace_id,
    run_id: e.run_id,
    repository_id: e.repository_id,
    team_id: e.team_id,
    api_key_id: e.api_key_id,
    cost_type: e.cost_type,
    tokens: e.tokens,
    cost_usd: e.cost_usd,
    model: e.model,
    phase: e.phase ?? "",
    input_tokens: e.input_tokens ?? 0,
    output_tokens: e.output_tokens ?? 0,
    cache_tokens: e.cache_tokens ?? 0,
    occurred_at: new Date(e.occurred_at)
      .toISOString()
      .replace("T", " ")
      .replace("Z", ""),
    event_id,
  }));

  await client.insert({
    table: "cost_events",
    values: rows,
    format: "JSONEachRow",
  });

  return toInsert.length;
}

// ---------------------------------------------------------------------------
// Context pack ingestion
// ---------------------------------------------------------------------------

export interface ContextPackInput {
  workspace_id: string;
  run_id: string;
  token_budget: number;
  tokens_used: number;
  anchors_extracted: number;
  sources_considered: number;
  occurred_at: string; // ISO 8601
}

export function deriveContextPackId(
  workspaceId: string,
  runId: string,
  occurredAt: string
): string {
  return createHash("sha1")
    .update(`${workspaceId}:${runId}:${occurredAt}`)
    .digest("hex");
}

/**
 * Insert context packs into ClickHouse, deduplicating on
 * (workspace_id, run_id, occurred_at) via a pre-existence check on context_pack_id.
 * Returns the number of rows actually inserted.
 */
export async function insertContextPacks(packs: ContextPackInput[]): Promise<number> {
  if (packs.length === 0) return 0;

  const candidates = packs.map((p) => ({
    p,
    context_pack_id: deriveContextPackId(p.workspace_id, p.run_id, p.occurred_at),
  }));

  const packIds = candidates.map((c) => c.context_pack_id);
  const checkResult = await client.query({
    query: `
      SELECT context_pack_id
      FROM context_packs
      WHERE context_pack_id IN ({packIds: Array(String)})
    `,
    query_params: { packIds },
    format: "JSONEachRow",
  });
  const existing = new Set(
    (await checkResult.json<{ context_pack_id: string }>()).map((r) => r.context_pack_id)
  );

  const toInsert = candidates.filter((c) => !existing.has(c.context_pack_id));
  if (toInsert.length === 0) return 0;

  const rows = toInsert.map(({ p, context_pack_id }) => ({
    workspace_id: p.workspace_id,
    run_id: p.run_id,
    context_pack_id,
    token_budget: p.token_budget,
    tokens_used: p.tokens_used,
    anchors_extracted: p.anchors_extracted,
    sources_considered: p.sources_considered,
    occurred_at: new Date(p.occurred_at)
      .toISOString()
      .replace("T", " ")
      .replace("Z", ""),
  }));

  await client.insert({
    table: "context_packs",
    values: rows,
    format: "JSONEachRow",
  });

  return toInsert.length;
}

export interface ContextEventInput {
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
  occurred_at: string; // ISO 8601
}

/**
 * Insert context-pack items into ClickHouse. A pack's items are written once
 * with the pack, so dedupe is per context_pack_id: packs that already have
 * any rows in context_events are skipped wholesale.
 * Returns the number of rows actually inserted.
 */
export async function insertContextEvents(events: ContextEventInput[]): Promise<number> {
  if (events.length === 0) return 0;

  const packIds = [...new Set(events.map((e) => e.context_pack_id))];
  const checkResult = await client.query({
    query: `
      SELECT DISTINCT context_pack_id
      FROM context_events
      WHERE context_pack_id IN ({packIds: Array(String)})
    `,
    query_params: { packIds },
    format: "JSONEachRow",
  });
  const existing = new Set(
    (await checkResult.json<{ context_pack_id: string }>()).map((r) => r.context_pack_id)
  );

  const toInsert = events.filter((e) => !existing.has(e.context_pack_id));
  if (toInsert.length === 0) return 0;

  const rows = toInsert.map((e) => ({
    workspace_id: e.workspace_id,
    run_id: e.run_id,
    context_pack_id: e.context_pack_id,
    item_path: e.item_path,
    item_hash: e.item_hash,
    included: e.included,
    citation: e.citation,
    reason: e.reason,
    score: e.score,
    occurred_at: new Date(e.occurred_at)
      .toISOString()
      .replace("T", " ")
      .replace("Z", ""),
  }));

  await client.insert({
    table: "context_events",
    values: rows,
    format: "JSONEachRow",
  });

  return toInsert.length;
}

// ---------------------------------------------------------------------------
// AFK run-event ingestion
// ---------------------------------------------------------------------------

export interface AfkRunEventInput {
  /** Derived from bearer-key context — never from request body. */
  workspace_id: string;
  repository_id: string;
  session_id: string;
  seq: number;
  ts: string;
  /** "action" | "init" */
  kind: string;
  /** Serialised action dict including action.type */
  action: Record<string, unknown>;
  digest: string;
}

function deriveEventId(workspaceId: string, sessionId: string, seq: number): string {
  return createHash("sha1")
    .update(`${workspaceId}:${sessionId}:${seq}`)
    .digest("hex");
}

/**
 * Insert AFK run events into ClickHouse, deduplicating on
 * (workspace_id, session_id, seq) via a pre-existence check.
 * Returns the number of rows actually inserted.
 */
export async function insertAfkRunEvents(events: AfkRunEventInput[]): Promise<number> {
  if (events.length === 0) return 0;

  // Compute deterministic event_ids.
  const candidates = events.map((ev) => ({
    ev,
    event_id: deriveEventId(ev.workspace_id, ev.session_id, ev.seq),
  }));

  // Filter out already-inserted event_ids.
  const eventIds = candidates.map((c) => c.event_id);
  const checkResult = await client.query({
    query: `
      SELECT event_id
      FROM run_events
      WHERE workspace_id = {workspaceId: String}
        AND event_id IN ({eventIds: Array(String)})
    `,
    query_params: {
      workspaceId: events[0].workspace_id,
      eventIds,
    },
    format: "JSONEachRow",
  });
  const existing = new Set(
    (await checkResult.json<{ event_id: string }>()).map((r) => r.event_id)
  );

  const toInsert = candidates.filter((c) => !existing.has(c.event_id));
  if (toInsert.length === 0) return 0;

  const rows = toInsert.map(({ ev, event_id }) => ({
    workspace_id: ev.workspace_id,
    repository_id: ev.repository_id,
    run_id: ev.session_id,
    agent: "",
    phase: ev.kind,
    event_type: String(ev.action?.type ?? ev.kind),
    severity: "info",
    occurred_at: new Date(ev.ts).toISOString().replace("T", " ").replace("Z", ""),
    event_id,
    submission_kind: "afk",
    payload: JSON.stringify(ev.action),
    session_id: ev.session_id,
    seq: ev.seq,
  }));

  await client.insert({
    table: "run_events",
    values: rows,
    format: "JSONEachRow",
  });

  return toInsert.length;
}

/**
 * Fetch run events for a session (AFK or regular run).
 * ``runId`` is either a Postgres UUID or an AFK session_id.
 */
export async function getRunEventsByRunId(
  workspaceId: string,
  runId: string,
  afterSeq?: number
): Promise<TelemetryEventRecord[]> {
  const conditions: string[] = [
    "workspace_id = {workspaceId: String}",
    "run_id = {runId: String}",
  ];
  const queryParams: Record<string, unknown> = { workspaceId, runId };

  if (afterSeq !== undefined) {
    conditions.push("seq > {afterSeq: Int64}");
    queryParams.afterSeq = afterSeq;
  }

  const result = await client.query({
    query: `
      SELECT
        workspace_id,
        repository_id,
        run_id,
        agent,
        phase,
        event_type,
        severity,
        occurred_at,
        event_id,
        submission_kind,
        payload,
        session_id,
        seq
      FROM run_events
      WHERE ${conditions.join(" AND ")}
      ORDER BY occurred_at ASC, seq ASC
    `,
    query_params: queryParams,
    format: "JSONEachRow",
  });

  const rows = await result.json<Record<string, unknown>>();
  return rows.map((r) => ({
    workspace_id: String(r.workspace_id ?? ""),
    repository_id: String(r.repository_id ?? ""),
    run_id: String(r.run_id ?? ""),
    agent: String(r.agent ?? ""),
    phase: String(r.phase ?? ""),
    event_type: String(r.event_type ?? ""),
    severity: String(r.severity ?? ""),
    occurred_at: new Date(String(r.occurred_at)),
    event_id: String(r.event_id ?? ""),
    submission_kind: String(r.submission_kind ?? ""),
    payload: String(r.payload ?? ""),
    session_id: String(r.session_id ?? ""),
    seq: Number(r.seq ?? 0),
  }));
}

// ---------------------------------------------------------------------------
// Per-run cost rows
// ---------------------------------------------------------------------------

export interface RunCostRow {
  phase: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_tokens: number;
  tokens: number;
  cost_usd: number;
  occurred_at: string;
}

export async function getRunCosts(
  workspaceId: string,
  runId: string
): Promise<RunCostRow[]> {
  const result = await client.query({
    query: `
      SELECT
        phase,
        model,
        input_tokens,
        output_tokens,
        cache_tokens,
        tokens,
        cost_usd,
        occurred_at
      FROM cost_events
      WHERE workspace_id = {workspaceId: String}
        AND run_id = {runId: String}
      ORDER BY occurred_at ASC
    `,
    query_params: { workspaceId, runId },
    format: "JSONEachRow",
  });

  const rows = await result.json<Record<string, unknown>>();
  return rows.map((r) => ({
    phase: String(r.phase ?? ""),
    model: String(r.model ?? ""),
    input_tokens: Number(r.input_tokens ?? 0),
    output_tokens: Number(r.output_tokens ?? 0),
    cache_tokens: Number(r.cache_tokens ?? 0),
    tokens: Number(r.tokens ?? 0),
    cost_usd: Number(r.cost_usd ?? 0),
    occurred_at: String(r.occurred_at ?? ""),
  }));
}

export interface WorkspaceTelemetryCounts {
  contextPacks: number;
  failures: number;
  totalCostUsd: number;
  totalTokens: number;
}

/** Scalar counts for the workspace Overview cards, fetched in one query. */
export async function getWorkspaceTelemetryCounts(
  workspaceId: string
): Promise<WorkspaceTelemetryCounts> {
  const result = await client.query({
    query: `
      SELECT
        (SELECT count() FROM context_packs WHERE workspace_id = {workspaceId: String}) AS context_packs,
        (SELECT count() FROM failure_events WHERE workspace_id = {workspaceId: String}) AS failures,
        (SELECT sum(cost_usd) FROM cost_events WHERE workspace_id = {workspaceId: String}) AS total_cost_usd,
        (SELECT sum(tokens) FROM cost_events WHERE workspace_id = {workspaceId: String}) AS total_tokens
    `,
    query_params: { workspaceId },
    format: "JSONEachRow",
  });
  const rows = await result.json<{
    context_packs: string | number;
    failures: string | number;
    total_cost_usd: string | number | null;
    total_tokens: string | number | null;
  }>();
  const row = rows[0];
  return {
    contextPacks: Number(row?.context_packs ?? 0),
    failures: Number(row?.failures ?? 0),
    totalCostUsd: Number(row?.total_cost_usd ?? 0),
    totalTokens: Number(row?.total_tokens ?? 0),
  };
}
