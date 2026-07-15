import { NextRequest, NextResponse } from "next/server";
import { retrieveMemory } from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";

// Max ranked results returned before the pinned-decision core is layered on
// (retrieveMemory itself caps the total response at k+3 — see its JSDoc).
const MEMORY_RESULT_K = 8;

/**
 * GET /api/v1/runner/workspace-memory?query=<text>
 *
 * Exists so the Jace coordinator, carrying a bearer/runner token, can read a
 * ranked, budget-capped slice of its workspace's memory to help answer a
 * question. The workspace is derived from the token server-side (via
 * `requireBearer`), NEVER from input, so a token can only ever read its own
 * workspace's memory.
 *
 * Read-only. `query` is a short natural-language description of what the
 * caller is looking for, used by `retrieveMemory` to rank + trim the result
 * (FTS -> BM25 -> heuristic rerank -> pinned decisions -> content trim). A
 * missing/empty query is passed through as "" — `retrieveMemory` falls back
 * to its pinned-decision/recency default rather than throwing.
 *
 * 401 — bad/missing bearer. 502 — the backing store errored. 200 —
 * `{ items: [...] }`.
 */
export async function GET(request: NextRequest) {
  const auth = await requireBearer(request);
  if (auth instanceof NextResponse) {
    return auth;
  }
  const { workspaceId } = auth;

  const query = request.nextUrl.searchParams.get("query")?.trim() ?? "";

  let items;
  try {
    items = await retrieveMemory(workspaceId, query, { k: MEMORY_RESULT_K });
  } catch (err) {
    console.error("[runner/workspace-memory] read failed:", err);
    return NextResponse.json({ error: "Upstream storage error" }, { status: 502 });
  }

  return NextResponse.json({ items }, { status: 200 });
}
