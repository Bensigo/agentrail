import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  claimLessonPromotion,
  getInvestigationBySlug,
  getWorkspaceMembership,
  insertMemoryItems,
  unclaimLessonPromotion,
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
 * Jace-side write").
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
 * **CLAIM-THEN-INSERT (Task 13 Fix round 1 — this arc's third check-then-act
 * bug):** the original shape read `data.promotedAt`, then wrote the memory
 * item, then marked `promotedAt` — a classic TOCTOU: two concurrent POSTs
 * for the same item could both pass the read-check and both insert a memory
 * row. The guard now lives on the WRITE itself:
 *
 *   1. authz (unchanged).
 *   2. Resolve `item` via the already-workspace-scoped `getInvestigationBySlug`
 *      fetch — belongs-to-investigation and `kind` are checked HERE, for
 *      honest 400s. This read is NOT the concurrency guard (see step 3); it
 *      only exists to distinguish "this itemId is garbage" from "this item
 *      raced".
 *   3. `claimLessonPromotion(itemId)` — ONE atomic conditional UPDATE
 *      (`kind = 'lesson_candidate' AND data->>'promotedAt' IS NULL`). Two
 *      concurrent callers both reaching this line race the SAME database
 *      predicate; only one can win. `claimed: false` here (after step 2
 *      already confirmed the item exists and is the right kind) means this
 *      request lost the race — 409, same status a stale-read retry would
 *      have produced, just now actually correct under concurrency.
 *   4. `insertMemoryItems` — only the WINNER of the claim ever reaches this.
 *   5. On insert failure: best-effort `unclaimLessonPromotion` (clears
 *      `promotedAt` so a retry is not permanently locked out) then 502
 *      (retryable). NAMED CRASH WINDOW: if the process dies between the
 *      claim commit (step 3) and either the insert or the unclaim, the item
 *      is left claimed with no memory row behind it — a human sees
 *      "Promoted" with nothing to show for it. Accepted for v1: the failure
 *      mode is a STUCK CLAIM (silent under-promotion), never a duplicate
 *      memory item (silent over-promotion) — the atomicity fix's whole
 *      point was closing the latter, strictly worse failure mode.
 *
 * 400 — missing/blank `itemId`, `itemId` not found on THIS investigation, or
 * found but not `kind: 'lesson_candidate'`. 401/403 — auth/role. 404 — no
 * investigation at that slug. 409 — the claim lost the race (already
 * promoted, concurrently or on a prior call). 502 — the memory insert
 * failed (the claim is rolled back best-effort first, so a retry is not
 * stuck behind a phantom 409). 200 — `{ item }`, the item with
 * `data.promotedAt` set (returned by the winning claim itself, not a
 * second read).
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
  // route gives). This is an HONEST-400 read, not the concurrency guard —
  // see this route's own doc-comment ("CLAIM-THEN-INSERT").
  const item = found.items.find((i) => i.id === itemId);
  if (!item) {
    return NextResponse.json({ error: "Item not found on this investigation" }, { status: 400 });
  }
  if (item.kind !== "lesson_candidate") {
    return NextResponse.json({ error: "Only a lesson_candidate item can be promoted" }, { status: 400 });
  }

  const claim = await claimLessonPromotion(itemId);
  if (!claim.claimed) {
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
    console.error("[investigations/promote] memory insert failed, rolling back claim:", err);
    try {
      await unclaimLessonPromotion(itemId);
    } catch (unclaimErr) {
      // Best-effort — see this route's own doc-comment ("NAMED CRASH
      // WINDOW"). The insert already failed; do not let a SECOND failure
      // here mask the original 502 with an unrelated 500.
      console.error("[investigations/promote] rollback (unclaim) also failed:", unclaimErr);
    }
    return NextResponse.json({ error: "Upstream storage error" }, { status: 502 });
  }

  return NextResponse.json({ item: claim.item });
}
