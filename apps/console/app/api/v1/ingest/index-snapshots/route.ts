/**
 * POST /api/v1/ingest/index-snapshots
 *
 * Accepts a single index snapshot or an array of up to 100.
 * Authenticates via bearer API key (see lib/bearer-auth.ts).
 * workspace_id comes from the API key; repository_id is validated to belong
 * to that workspace. Source is never sent — only snapshot metadata.
 *
 * Returns: 202 { accepted: N }
 */
import { NextRequest, NextResponse } from "next/server";
import { insertIndexSnapshots } from "@agentrail/db-clickhouse";
import { getRepository } from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";

interface RawSnapshot {
  repository_id: string;
  commit_sha: string;
  indexed_at: string;
  source_count: number;
  graph_edge_count: number;
}

function isRawSnapshot(v: unknown): v is RawSnapshot {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.repository_id === "string" &&
    typeof o.commit_sha === "string" &&
    typeof o.indexed_at === "string" &&
    typeof o.source_count === "number" &&
    typeof o.graph_edge_count === "number"
  );
}

export async function POST(req: NextRequest) {
  const auth = await requireBearer(req);
  if (auth instanceof NextResponse) return auth;
  const { workspaceId } = auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const raw: unknown[] = Array.isArray(body) ? body : [body];
  if (raw.length === 0 || raw.length > 100) {
    return NextResponse.json(
      { error: "Batch must contain 1–100 snapshots" },
      { status: 400 }
    );
  }

  const valid: RawSnapshot[] = [];
  for (const item of raw) {
    if (!isRawSnapshot(item)) {
      return NextResponse.json(
        {
          error:
            "Each snapshot must have repository_id (string), commit_sha (string), indexed_at (string), source_count (number), graph_edge_count (number)",
        },
        { status: 400 }
      );
    }
    valid.push(item);
  }

  for (const s of valid) {
    const repo = await getRepository(workspaceId, s.repository_id);
    if (!repo) {
      return NextResponse.json(
        { error: `Repository ${s.repository_id} not found in this workspace` },
        { status: 404 }
      );
    }
  }

  const inputs = valid.map((s) => ({
    workspace_id: workspaceId,
    repository_id: s.repository_id,
    commit_sha: s.commit_sha,
    indexed_at: s.indexed_at,
    source_count: s.source_count,
    graph_edge_count: s.graph_edge_count,
  }));

  let accepted = 0;
  try {
    accepted = await insertIndexSnapshots(inputs);
  } catch (err) {
    console.error("[ingest/index-snapshots] ClickHouse insert failed:", err);
    return NextResponse.json({ error: "Upstream storage error" }, { status: 502 });
  }

  return NextResponse.json({ accepted }, { status: 202 });
}
