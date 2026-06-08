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
