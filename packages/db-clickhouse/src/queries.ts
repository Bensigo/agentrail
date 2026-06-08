import { client } from "./client";
import type { TelemetryEventRecord, FailureEventRecord } from "./schema";

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
  const { repositoryId, severity, failureType, timeFrom, timeTo, limit = 50, cursor } = opts;

  const conditions: string[] = ["workspace_id = {workspaceId: String}"];
  const queryParams: Record<string, unknown> = { workspaceId };

  if (repositoryId) {
    conditions.push("repository_id = {repositoryId: String}");
    queryParams.repositoryId = repositoryId;
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
    conditions.push("occurred_at < {cursor: DateTime64(3)}");
    queryParams.cursor = cursor;
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
  const nextCursor = hasMore ? String(failures[failures.length - 1].occurred_at) : null;

  return { failures, nextCursor };
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
