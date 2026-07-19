import { NextRequest, NextResponse } from "next/server";
import { retrieveMemory, getJaceSessionByEveSessionId } from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../lib/jace-console-auth";

// Max ranked results returned before the pinned-decision core is layered on
// (retrieveMemory itself caps the total response at k+3 — see its JSDoc).
const MEMORY_RESULT_K = 8;

/**
 * GET /api/v1/runner/workspace-memory?query=<text>&eveSessionId=<id>
 *
 * Exists so the Jace coordinator can read a ranked, budget-capped slice of a
 * workspace's memory to help answer a question.
 *
 * AUTH + TENANT (updated for the central-secret fix, 2026-07-20): the central
 * `JACE_CONSOLE_TOKEN` secret via `requireJaceConsoleSecret` gates WHO may
 * call this route; it carries no per-caller `workspaceId` the way the old
 * per-workspace bearer (`requireBearer`) did, so WHICH workspace is resolved
 * the same way every other Jace-coordinator route resolves it: server-side,
 * from the caller-supplied `eveSessionId` through the `jace_sessions` ledger
 * (`getJaceSessionByEveSessionId`) — never trusted as a caller-supplied
 * `workspaceId` directly, and never guessable (`eveSessionId` is Eve's own
 * opaque session id, `ctx.session.id`, read server-side by the tool wrapper —
 * see `apps/jace/agent/tools/fetch_workspace_memory.ts`). A session with no
 * anchor at all, or an intro (chat-identity-only) session with no
 * `workspaceId` yet — there is no workspace memory to read before a
 * workspace exists — both collapse into the same 404, matching this seam's
 * anti-enumeration posture elsewhere (`runner/approvals`, `connect-link`).
 *
 * Read-only. `query` is a short natural-language description of what the
 * caller is looking for, used by `retrieveMemory` to rank + trim the result
 * (FTS -> BM25 -> heuristic rerank -> pinned decisions -> content trim). A
 * missing/empty query is passed through as "" — `retrieveMemory` falls back
 * to its pinned-decision/recency default rather than throwing.
 *
 * 400 — missing `eveSessionId`. 401 — bad/missing secret. 404 — no session,
 * or a session with no resolvable workspace yet. 502 — the backing store
 * errored. 200 — `{ items: [...] }`.
 */
export async function GET(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) {
    return authError;
  }

  const eveSessionId = request.nextUrl.searchParams.get("eveSessionId")?.trim() ?? "";
  if (!eveSessionId) {
    return NextResponse.json({ error: "eveSessionId is required" }, { status: 400 });
  }

  const session = await getJaceSessionByEveSessionId(eveSessionId);
  const workspaceId = session?.workspaceId ?? null;
  if (!workspaceId) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

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
