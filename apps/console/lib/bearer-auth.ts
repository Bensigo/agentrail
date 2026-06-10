/**
 * Shared bearer-token authentication helper for API routes that accept
 * AgentRail API keys (e.g. ingest endpoints called by the CLI).
 *
 * Usage:
 *   const auth = await requireBearer(req);
 *   if (auth instanceof NextResponse) return auth; // 401
 *   const { workspaceId, teamId } = auth;
 */
import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { lookupApiKeyByHash } from "@agentrail/db-postgres";

export interface BearerAuthResult {
  apiKeyId: string;
  workspaceId: string;
  teamId: string | null;
}

/**
 * Validate the ``Authorization: Bearer <key>`` header.
 * Returns a {@link BearerAuthResult} on success, or a 401 NextResponse to
 * return immediately on failure.
 */
export async function requireBearer(
  req: NextRequest
): Promise<BearerAuthResult | NextResponse> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rawKey = authHeader.slice(7).trim();
  if (!rawKey) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const keyHash = createHash("sha256").update(rawKey).digest("hex");

  let row: Awaited<ReturnType<typeof lookupApiKeyByHash>>;
  try {
    row = await lookupApiKeyByHash(keyHash);
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }

  if (!row) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return {
    apiKeyId: row.id,
    workspaceId: row.workspaceId,
    teamId: row.teamId ?? null,
  };
}
