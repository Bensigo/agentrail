import { NextRequest, NextResponse } from "next/server";
import { claimQueueEntry, touchApiKeyLastUsed } from "@agentrail/db-postgres";
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

  return NextResponse.json(item);
}
