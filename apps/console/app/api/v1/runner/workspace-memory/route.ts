import { NextRequest, NextResponse } from "next/server";
import { listMemoryItems } from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";

/**
 * GET /api/v1/runner/workspace-memory
 *
 * Exists so the Jace coordinator, carrying a bearer/runner token, can read its
 * workspace's memory items to answer questions. The workspace is derived from
 * the token server-side (via `requireBearer`), never from input, so a token can
 * only ever read its own workspace's memory.
 *
 * Read-only; takes no query params. 401 — bad/missing bearer. 502 — the backing
 * store errored. 200 — `{ items: [...] }`.
 */
export async function GET(request: NextRequest) {
  const auth = await requireBearer(request);
  if (auth instanceof NextResponse) {
    return auth;
  }
  const { workspaceId } = auth;

  let items;
  try {
    items = await listMemoryItems(workspaceId);
  } catch (err) {
    console.error("[runner/workspace-memory] read failed:", err);
    return NextResponse.json({ error: "Upstream storage error" }, { status: 502 });
  }

  return NextResponse.json({ items }, { status: 200 });
}
