import { clickhouse } from "./client";
import type { RunEvent, ContextEvent, FailureEvent } from "./schema";

export async function getRunEvents(
  workspaceId: string,
  runId: string
): Promise<RunEvent[]> {
  const result = await clickhouse.query({
    query: `
      SELECT *
      FROM run_events
      WHERE workspace_id = {workspaceId:String}
        AND run_id = {runId:String}
      ORDER BY occurred_at ASC
    `,
    query_params: { workspaceId, runId },
    format: "JSONEachRow",
  });

  return result.json<RunEvent>();
}

export async function getContextPacks(
  workspaceId: string,
  runId: string
): Promise<ContextEvent[]> {
  const result = await clickhouse.query({
    query: `
      SELECT *
      FROM context_events
      WHERE workspace_id = {workspaceId:String}
        AND run_id = {runId:String}
      ORDER BY context_pack_id, score DESC
    `,
    query_params: { workspaceId, runId },
    format: "JSONEachRow",
  });

  return result.json<ContextEvent>();
}

export async function getFailureEvents(
  workspaceId: string,
  filters?: { runId?: string; severity?: string; failureType?: string }
): Promise<FailureEvent[]> {
  let query = `
    SELECT *
    FROM failure_events
    WHERE workspace_id = {workspaceId:String}
  `;
  const params: Record<string, string> = { workspaceId };

  if (filters?.runId) {
    query += ` AND run_id = {runId:String}`;
    params.runId = filters.runId;
  }
  if (filters?.severity) {
    query += ` AND severity = {severity:String}`;
    params.severity = filters.severity;
  }
  if (filters?.failureType) {
    query += ` AND failure_type = {failureType:String}`;
    params.failureType = filters.failureType;
  }

  query += ` ORDER BY occurred_at DESC LIMIT 200`;

  const result = await clickhouse.query({
    query,
    query_params: params,
    format: "JSONEachRow",
  });

  return result.json<FailureEvent>();
}

export interface CostAggRow {
  entity: string;
  total_tokens: number;
  total_cost_usd: number;
  model_call_tokens: number;
  model_call_cost: number;
  embedding_tokens: number;
  embedding_cost: number;
  reranking_tokens: number;
  reranking_cost: number;
  storage_tokens: number;
  storage_cost: number;
}

const groupByColumns: Record<string, string> = {
  team: "team_id",
  repo: "repository_id",
  api_key: "api_key_id",
  run: "run_id",
};

export async function getCostAggregation(
  workspaceId: string,
  filters?: { groupBy?: string; timeFrom?: string; timeTo?: string }
): Promise<CostAggRow[]> {
  const col = groupByColumns[filters?.groupBy ?? "run"] ?? "run_id";
  let query = `
    SELECT
      ${col} AS entity,
      sum(tokens) AS total_tokens,
      sum(cost_usd) AS total_cost_usd,
      sumIf(tokens, cost_type = 'model_call') AS model_call_tokens,
      sumIf(cost_usd, cost_type = 'model_call') AS model_call_cost,
      sumIf(tokens, cost_type = 'embedding') AS embedding_tokens,
      sumIf(cost_usd, cost_type = 'embedding') AS embedding_cost,
      sumIf(tokens, cost_type = 'reranking') AS reranking_tokens,
      sumIf(cost_usd, cost_type = 'reranking') AS reranking_cost,
      sumIf(tokens, cost_type = 'storage') AS storage_tokens,
      sumIf(cost_usd, cost_type = 'storage') AS storage_cost
    FROM cost_events
    WHERE workspace_id = {workspaceId:String}
  `;
  const params: Record<string, string> = { workspaceId };

  if (filters?.timeFrom) {
    query += ` AND occurred_at >= {timeFrom:String}`;
    params.timeFrom = filters.timeFrom;
  }
  if (filters?.timeTo) {
    query += ` AND occurred_at <= {timeTo:String}`;
    params.timeTo = filters.timeTo;
  }

  query += ` GROUP BY entity ORDER BY total_cost_usd DESC LIMIT 200`;

  const result = await clickhouse.query({
    query,
    query_params: params,
    format: "JSONEachRow",
  });

  return result.json<CostAggRow>();
}

export interface LatestIndexRow {
  repository_id: string;
  commit_sha: string;
  indexed_at: string;
  source_count: number;
  graph_edge_count: number;
}

export async function getLatestIndexSnapshots(
  workspaceId: string
): Promise<LatestIndexRow[]> {
  const result = await clickhouse.query({
    query: `
      SELECT
        repository_id,
        argMax(commit_sha, indexed_at) AS commit_sha,
        max(indexed_at) AS indexed_at,
        argMax(source_count, indexed_at) AS source_count,
        argMax(graph_edge_count, indexed_at) AS graph_edge_count
      FROM index_snapshots
      WHERE workspace_id = {workspaceId:String}
      GROUP BY repository_id
      ORDER BY indexed_at DESC
    `,
    query_params: { workspaceId },
    format: "JSONEachRow",
  });

  return result.json<LatestIndexRow>();
}
