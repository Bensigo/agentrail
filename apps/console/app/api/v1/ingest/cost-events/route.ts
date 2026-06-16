/**
 * POST /api/v1/ingest/cost-events
 *
 * Accepts a single cost event or an array of up to 100.
 * Authenticates via bearer API key (see lib/bearer-auth.ts).
 * workspace_id, api_key_id, and team_id come from the API key; repository_id is
 * validated to belong to that workspace.
 *
 * Returns: 202 { accepted: N }
 */
import { NextRequest, NextResponse } from "next/server";
import { insertCostEvents, CostEventInput } from "@agentrail/db-clickhouse";
import { getRepository } from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";

interface RawCostEvent {
  repository_id: string;
  run_id: string;
  cost_type: string;
  tokens: number;
  cost_usd: number;
  model: string;
  occurred_at: string;
  phase?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_tokens?: number;
  cache_creation_tokens?: number;
}

function isRawCostEvent(v: unknown): v is RawCostEvent {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.repository_id === "string" &&
    typeof o.run_id === "string" &&
    typeof o.cost_type === "string" &&
    typeof o.tokens === "number" &&
    typeof o.cost_usd === "number" &&
    typeof o.model === "string" &&
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

  const valid: RawCostEvent[] = [];
  for (const item of raw) {
    if (!isRawCostEvent(item)) {
      return NextResponse.json(
        {
          error:
            "Each event must have repository_id (string), run_id (string), cost_type (string), tokens (number), cost_usd (number), model (string), occurred_at (string)",
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

  const inputs: CostEventInput[] = valid.map((e) => ({
    workspace_id: workspaceId,
    api_key_id: apiKeyId,
    team_id: teamId ?? "",
    repository_id: e.repository_id,
    run_id: e.run_id,
    cost_type: e.cost_type,
    tokens: e.tokens,
    cost_usd: e.cost_usd,
    model: e.model,
    occurred_at: e.occurred_at,
    phase: e.phase ?? "",
    input_tokens: e.input_tokens ?? 0,
    output_tokens: e.output_tokens ?? 0,
    cache_tokens: e.cache_tokens ?? 0,
    cache_creation_tokens: e.cache_creation_tokens ?? 0,
  }));

  let accepted = 0;
  try {
    accepted = await insertCostEvents(inputs);
  } catch (err) {
    console.error("[ingest/cost-events] ClickHouse insert failed:", err);
    return NextResponse.json({ error: "Upstream storage error" }, { status: 502 });
  }

  return NextResponse.json({ accepted }, { status: 202 });
}
