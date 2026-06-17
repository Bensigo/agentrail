import { NextRequest, NextResponse } from "next/server";
import {
  claimQueueEntry,
  touchApiKeyLastUsed,
  getMcpConnectorKeys,
} from "@agentrail/db-postgres";
import { recordRunLifecycleEvent } from "@agentrail/db-clickhouse";
import { requireBearer } from "../../../../../lib/bearer-auth";

/**
 * Runner work-claim. Bearer-authenticated with the runner token (an api_key).
 * Atomically claims the oldest `queued` queue entry for the workspace and flips
 * it to `running`, returning it as a WorkItem. 204 (empty) when nothing queued.
 */
export async function GET(request: NextRequest) {
  const auth = await requireBearer(request);
  if (auth instanceof NextResponse) {
    return auth;
  }

  const workspaceId = new URL(request.url).searchParams.get("workspace_id");
  if (!workspaceId) {
    return NextResponse.json(
      { error: "workspace_id is required" },
      { status: 400 }
    );
  }

  if (auth.workspaceId !== workspaceId) {
    return NextResponse.json(
      { error: "API key does not belong to the specified workspace" },
      { status: 403 }
    );
  }

  await touchApiKeyLastUsed(auth.apiKeyId);

  const item = await claimQueueEntry(workspaceId);
  if (!item) {
    return new NextResponse(null, { status: 204 });
  }

  // Timeline state marker: the run has started (best-effort).
  await recordRunLifecycleEvent(
    workspaceId,
    item.id,
    "run_started",
    `Claimed ${item.external_id} — running locally`
  );

  // Hand the run its connected MCP keys (decrypted here, over the authenticated
  // link) so the runner can write the agent's MCP config into the cloned repo —
  // the codebase-level half of MCP connectors. Empty {} when none are connected.
  // Best-effort: a key-fetch hiccup must not block dispatching the work.
  let mcpKeys: Record<string, string> = {};
  try {
    mcpKeys = await getMcpConnectorKeys(workspaceId);
  } catch (err) {
    console.error("[runner/claim] failed to load MCP keys:", err);
  }

  return NextResponse.json({ ...item, mcp_keys: mcpKeys });
}
