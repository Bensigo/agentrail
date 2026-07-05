/**
 * GET /api/v1/context/memory-items?repository_id=<uuid>
 *
 * Machine-rail read endpoint for the factory's memory-lane snapshot producer
 * (issue #1071, the missing write half of #1039). The CLI's
 * `agentrail/context/memory_fetch.py` calls this before every pack build and
 * writes the rows to the local snapshot that `memory_lane.py` reads.
 *
 * Rows are returned UNMASKED by design: bearer auth means machine trust (the
 * same trust level that pushes index snapshots and run results), and the
 * factory needs full content to build a useful lane. This is deliberately a
 * separate route from the session-authed, viewer-role-MASKED
 * `workspaces/[workspaceId]/memory` endpoint — that human-facing route and its
 * masking are untouched (AC3); do not merge the two.
 *
 * Rows with a null repositoryId are included for every repository: they are
 * workspace-wide memories (repo deletion sets repositoryId null, and the
 * coordinator may write workspace-level entries with no repo at all).
 */
import { NextRequest, NextResponse } from "next/server";
import {
  getRepository,
  listMemoryItems,
  touchApiKeyLastUsed,
} from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";

// Hard response cap; the lane's 4096-byte budget uses far fewer anyway.
const MAX_ITEMS = 500;

export async function GET(request: NextRequest) {
  const auth = await requireBearer(request);
  if (auth instanceof NextResponse) return auth;

  const repositoryId = new URL(request.url).searchParams.get("repository_id");
  if (!repositoryId) {
    return NextResponse.json(
      { error: "repository_id query parameter is required" },
      { status: 400 }
    );
  }

  try {
    // Scope check: the key's workspace must own the repository. getRepository
    // filters by workspaceId, so a foreign repo id looks identical to a
    // missing one (no cross-workspace existence oracle).
    const repo = await getRepository(auth.workspaceId, repositoryId);
    if (!repo) {
      return NextResponse.json(
        { error: `Repository ${repositoryId} not found in this workspace` },
        { status: 404 }
      );
    }

    const all = await listMemoryItems(auth.workspaceId);
    const items = all
      .filter(
        (item) =>
          item.repositoryId === repositoryId || item.repositoryId === null
      )
      .slice(0, MAX_ITEMS)
      .map((item) => ({
        // snake_case keys match _normalize_memory_item in memory_lane.py.
        id: item.id,
        type: item.type,
        written_by: item.writtenBy,
        source: item.source,
        content: item.content,
        tags: item.tags,
        created_at: item.createdAt.toISOString(),
      }));

    await touchApiKeyLastUsed(auth.apiKeyId);
    return NextResponse.json({ items });
  } catch (err) {
    console.error("[context/memory-items] failed:", err);
    return NextResponse.json(
      { error: "Failed to load memory items" },
      { status: 500 }
    );
  }
}
