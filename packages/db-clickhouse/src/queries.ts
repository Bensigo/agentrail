import { client } from "./client";
import type { TelemetryEventRecord } from "./schema";

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
