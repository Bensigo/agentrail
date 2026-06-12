/**
 * POST /api/v1/ingest/runs
 *
 * Upserts a run record in Postgres so the CLI can register a run at start and
 * update it at finish. Authenticates via bearer API key (see lib/bearer-auth.ts).
 * workspace_id comes from the API key; repository_id is validated to belong to
 * that workspace.
 *
 * Returns: 202 { ok: true }
 */
import { NextRequest, NextResponse } from "next/server";
import { getRepository, upsertRun } from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";

const VALID_STATUSES = ["queued", "running", "success", "failed"] as const;
type RunStatus = (typeof VALID_STATUSES)[number];

interface RawRun {
  id: string;
  repository_id: string;
  agent: string;
  branch: string;
  status: RunStatus;
  title?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
}

function isRawRun(v: unknown): v is RawRun {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.repository_id === "string" &&
    typeof o.agent === "string" &&
    typeof o.branch === "string" &&
    typeof o.status === "string" &&
    (VALID_STATUSES as readonly string[]).includes(o.status)
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

  if (!isRawRun(body)) {
    return NextResponse.json(
      {
        error:
          "Body must have id (string), repository_id (string), agent (string), branch (string), status (queued|running|success|failed)",
      },
      { status: 400 }
    );
  }

  const run = body;

  const repo = await getRepository(workspaceId, run.repository_id);
  if (!repo) {
    return NextResponse.json(
      { error: `Repository ${run.repository_id} not found in this workspace` },
      { status: 404 }
    );
  }

  try {
    await upsertRun({
      id: run.id,
      workspaceId,
      repositoryId: run.repository_id,
      agent: run.agent,
      branch: run.branch,
      title: run.title ?? null,
      status: run.status,
      startedAt: run.started_at ?? null,
      finishedAt: run.finished_at ?? null,
    });
  } catch (err) {
    console.error("[ingest/runs] Postgres upsert failed:", err);
    return NextResponse.json({ error: "Upstream storage error" }, { status: 502 });
  }

  return NextResponse.json({ ok: true }, { status: 202 });
}
