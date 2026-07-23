import { NextRequest, NextResponse } from "next/server";
import { recordRunnerLiveness, touchApiKeyLastUsed } from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";

/**
 * Runner execution-liveness ping (#1388). Bearer-authenticated with the runner
 * token, exactly like `POST /api/v1/runner/claim` and `/result` — the fleet
 * worker calls this (~every 60s) while a claim is executing so the backend's
 * stale-run reclaim can tell a still-alive long run from a silently-dead runner.
 *
 * Naming: the house term *Heartbeat* (CONTEXT.md) is the dispatch-trigger layer;
 * this is execution *liveness* — a distinct signal, distinct word.
 *
 * This is a SIGNAL only: it stamps `last_liveness_at` on the run/queue entry and
 * changes NO state and opens no terminal Run Outcome. `recordRunnerLiveness`
 * only stamps rows still `running`, so a ping that races a just-finished run
 * never resurrects it. Idempotent and cheap by design.
 */
export async function POST(request: NextRequest) {
  const auth = await requireBearer(request);
  if (auth instanceof NextResponse) {
    return auth;
  }

  const body = (await request.json().catch(() => ({}))) as {
    id?: string;
    workspace_id?: string;
  };

  const { id, workspace_id } = body;
  if (!id || !workspace_id) {
    return NextResponse.json(
      { error: "id and workspace_id are required" },
      { status: 400 }
    );
  }

  if (auth.workspaceId !== workspace_id) {
    return NextResponse.json(
      { error: "API key does not belong to the specified workspace" },
      { status: 403 }
    );
  }

  await touchApiKeyLastUsed(auth.apiKeyId);

  const { updated } = await recordRunnerLiveness({ id, workspaceId: workspace_id });
  if (!updated) {
    // No running run with that id in this workspace — already terminal, or an
    // unknown id. A best-effort ping; the runner swallows this, so a 404 here is
    // informational, never fatal to the run.
    return NextResponse.json(
      { error: "No running run found for this id in the workspace" },
      { status: 404 }
    );
  }

  return NextResponse.json({ ok: true }, { status: 202 });
}
