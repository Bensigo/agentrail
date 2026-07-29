import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getInvestigationBySlug,
  getWorkspaceMembership,
  insertMemoryItems,
  updateInvestigationItemAsHuman,
} from "@agentrail/db-postgres";

const ADMIN_ROLES = ["owner", "admin"] as const;

interface RawBody {
  itemId?: unknown;
}

/**
 * POST /api/v1/workspaces/:workspaceId/investigations/:slug/promote
 *
 * The console-only promotion gate (Task 13 — "Jace never writes memory; the
 * promotion is CONSOLE-ONLY — this task builds that gate"). Body
 * `{ itemId }` names a `kind: 'lesson_candidate'` item belonging to THIS
 * investigation; on success, copies its body into workspace memory via the
 * SAME server-side insert path onboarding/review memory uses
 * (`insertMemoryItems` — see `ingest/memory-items/route.ts` for its other
 * caller; deliberately NOT a new writer, per the brief: "do NOT add a
 * Jace-side write"), then marks `data.promotedAt` (ISO) on the item via the
 * human-edit path (`updateInvestigationItemAsHuman`) so a second promote of
 * the same item 409s instead of creating a duplicate memory row.
 *
 * Provenance travels through the memory schema's OWN attribution columns —
 * `source: "investigation"`, `writtenBy: "investigation:<slug>"`, and a
 * `tags` entry — rather than inventing a new jsonb metadata column the
 * `memory_items` schema doesn't have (Task 13 brief: "follow what the
 * memory schema supports, do not invent columns"). Mirrors
 * `ingest/memory-items/route.ts`'s own `run:<id>` tag convention for
 * threading a source id through the one column that supports it.
 *
 * Role-gated owner/admin, same posture as the sibling `confirm/route.ts`.
 *
 * Ordering: the memory item is inserted BEFORE `data.promotedAt` is marked.
 * If the mark step fails after a successful insert, a retry could in
 * principle create a second memory row — an accepted v1 tradeoff (this is a
 * single human clicking a button, not a high-concurrency writer), not a
 * cross-table transaction (`memory_items` and `investigation_items` are
 * different modules with no shared transaction handle exposed here).
 *
 * 400 — missing/blank `itemId`, `itemId` not found on THIS investigation, or
 * found but not `kind: 'lesson_candidate'`. 401/403 — auth/role. 404 — no
 * investigation at that slug, or (defensive) the item vanished between the
 * lookup above and the mark-as-promoted write. 409 — this item was already
 * promoted (`data.promotedAt` already set). 502 — the memory insert failed.
 * 200 — `{ item }`, the item with `data.promotedAt` set.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; slug: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId, slug } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!ADMIN_ROLES.includes(membership.role as (typeof ADMIN_ROLES)[number])) {
    return NextResponse.json({ error: "Owner or admin role required" }, { status: 403 });
  }

  const found = await getInvestigationBySlug(workspaceId, slug);
  if (!found) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as RawBody;
  const itemId = typeof body.itemId === "string" ? body.itemId.trim() : "";
  if (!itemId) {
    return NextResponse.json({ error: "itemId is required" }, { status: 400 });
  }

  // Item must belong to THIS investigation — resolved from the already
  // workspace-scoped fetch above, never a bare id lookup (the same "the
  // slug's workspace scope IS the tenancy boundary" reasoning every sibling
  // route gives).
  const item = found.items.find((i) => i.id === itemId);
  if (!item) {
    return NextResponse.json({ error: "Item not found on this investigation" }, { status: 400 });
  }
  if (item.kind !== "lesson_candidate") {
    return NextResponse.json({ error: "Only a lesson_candidate item can be promoted" }, { status: 400 });
  }

  const data = (item.data ?? {}) as Record<string, unknown>;
  if (typeof data.promotedAt === "string" && data.promotedAt) {
    return NextResponse.json({ error: "This lesson has already been promoted" }, { status: 409 });
  }

  try {
    await insertMemoryItems({
      workspaceId,
      repositoryId: found.investigation.repositoryId,
      source: "investigation",
      writtenBy: `investigation:${slug}`,
      items: [
        {
          content: item.body,
          tags: ["investigation", `investigation:${slug}`, "lesson_candidate"],
          type: "fact",
        },
      ],
    });
  } catch (err) {
    console.error("[investigations/promote] memory insert failed:", err);
    return NextResponse.json({ error: "Upstream storage error" }, { status: 502 });
  }

  const promotedAt = new Date().toISOString();
  const result = await updateInvestigationItemAsHuman(itemId, {
    data: { ...data, promotedAt },
  });
  if (!result.item) {
    return NextResponse.json({ error: "Item not found on this investigation" }, { status: 404 });
  }

  return NextResponse.json({ item: result.item });
}
