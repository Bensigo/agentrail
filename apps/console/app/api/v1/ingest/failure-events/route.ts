/**
 * POST /api/v1/ingest/failure-events
 *
 * Accepts a single failure event or an array of up to 100.
 * Authenticates via bearer API key (see lib/bearer-auth.ts).
 * workspace_id, api_key_id, and team_id come from the API key; repository_id is
 * validated to belong to that workspace.
 *
 * Returns: 202 { accepted: N }
 */
import { NextRequest, NextResponse } from "next/server";
import { insertFailureEvents, FailureEventInput } from "@agentrail/db-clickhouse";
import { getRepository } from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";

interface RawFailureEvent {
  repository_id: string;
  run_id: string;
  failure_type: string;
  message: string;
  evidence?: string;
  phase: string;
  severity?: string;
  occurred_at: string;
}

function isRawFailureEvent(v: unknown): v is RawFailureEvent {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.repository_id === "string" &&
    typeof o.run_id === "string" &&
    typeof o.failure_type === "string" &&
    typeof o.message === "string" &&
    typeof o.phase === "string" &&
    typeof o.occurred_at === "string"
  );
}

export async function POST(req: NextRequest) {
  const auth = await requireBearer(req);
  if (auth instanceof NextResponse) return auth;
  const { workspaceId, apiKeyId, teamId } = auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const raw: unknown[] = Array.isArray(body) ? body : [body];
  if (raw.length === 0 || raw.length > 100) {
    return NextResponse.json(
      { error: "Batch must contain 1–100 events" },
      { status: 400 }
    );
  }

  const valid: RawFailureEvent[] = [];
  for (const item of raw) {
    if (!isRawFailureEvent(item)) {
      return NextResponse.json(
        {
          error:
            "Each event must have repository_id (string), run_id (string), failure_type (string), message (string), phase (string), occurred_at (string)",
        },
        { status: 400 }
      );
    }
    valid.push(item);
  }

  for (const e of valid) {
    const repo = await getRepository(workspaceId, e.repository_id);
    if (!repo) {
      return NextResponse.json(
        { error: `Repository ${e.repository_id} not found in this workspace` },
        { status: 404 }
      );
    }
  }

  const inputs: FailureEventInput[] = valid.map((e) => ({
    workspace_id: workspaceId,
    run_id: e.run_id,
    repository_id: e.repository_id,
    failure_type: e.failure_type,
    message: e.message,
    evidence: e.evidence ?? "",
    phase: e.phase,
    severity: e.severity ?? "error",
    occurred_at: e.occurred_at,
  }));

  let accepted = 0;
  try {
    accepted = await insertFailureEvents(inputs);
  } catch (err) {
    console.error("[ingest/failure-events] ClickHouse insert failed:", err);
    return NextResponse.json({ error: "Upstream storage error" }, { status: 502 });
  }

  return NextResponse.json({ accepted }, { status: 202 });
}
