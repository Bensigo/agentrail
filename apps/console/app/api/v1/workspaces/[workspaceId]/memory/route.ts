import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, listMemoryItems } from "@agentrail/db-postgres";

// Roles allowed to read the FULL, unmasked memory content (#1032, AC4).
// Memory content can contain sensitive operational notes and is the same text
// that gets injected into agent prompts, so full bodies are gated to elevated
// roles. Ordinary members/viewers get a bounded preview only — enough to see
// what memory exists without exposing every full note to every member.
const FULL_CONTENT_ROLES = new Set(["owner", "admin"]);
const PREVIEW_LEN = 200;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const canSeeFullContent = FULL_CONTENT_ROLES.has(membership.role);

  try {
    const items = await listMemoryItems(workspaceId);
    const serialized = items.map((item) => {
      const preview = item.content.slice(0, PREVIEW_LEN);
      const truncated = item.content.length > PREVIEW_LEN;
      return {
        id: item.id,
        source: item.source,
        // Writer attribution surfaced from memory_items v2 (#1032).
        type: item.type,
        written_by: item.writtenBy,
        repository_name: item.repositoryName,
        // Preview is always safe to show (bounded). When the caller isn't
        // allowed full content we still send `content` so the UI shape is
        // unchanged, but it carries only the preview (with an ellipsis marker
        // when truncated) — never the full body — and content_masked flags it.
        content_preview: preview,
        content: canSeeFullContent
          ? item.content
          : truncated
            ? `${preview}…`
            : preview,
        content_masked: !canSeeFullContent,
        tags: item.tags,
        created_at: item.createdAt.toISOString(),
        last_used_at: item.lastUsedAt ? item.lastUsedAt.toISOString() : null,
      };
    });
    return NextResponse.json({ items: serialized });
  } catch (err) {
    console.error("[workspaces/memory] Postgres query failed:", err);
    return NextResponse.json(
      { error: "Failed to load memory items" },
      { status: 500 }
    );
  }
}
