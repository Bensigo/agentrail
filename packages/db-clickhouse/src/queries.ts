import { clickhouse } from "./client";
import type { RunEvent, ContextEvent } from "./schema";

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
