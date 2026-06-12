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
