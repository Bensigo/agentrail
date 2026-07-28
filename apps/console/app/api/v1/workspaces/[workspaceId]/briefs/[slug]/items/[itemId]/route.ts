import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  briefAreaEnum,
  briefItemKindEnum,
  briefItemResolutionEnum,
  briefItemStateEnum,
  deleteBriefItem,
  getBriefBySlug,
  getWorkspaceMembership,
  updateBriefItemAsHuman,
} from "@agentrail/db-postgres";

const ADMIN_ROLES = ["owner", "admin"] as const;
const AREA_VALUES = briefAreaEnum.enumValues;
const KIND_VALUES = briefItemKindEnum.enumValues;
const STATE_VALUES = briefItemStateEnum.enumValues;
const RESOLUTION_VALUES = briefItemResolutionEnum.enumValues;

const STATEMENT_MAX = 2000;
const EVIDENCE_MAX = 2000;

interface RawBody {
  area?: unknown;
  statement?: unknown;
  evidence?: unknown;
  kind?: unknown;
  state?: unknown;
  resolution?: unknown;
}

async function requireManage(workspaceId: string) {
  const session = await auth();
  if (!session?.user?.id) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const;
  }
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) } as const;
  }
  if (!ADMIN_ROLES.includes(membership.role as (typeof ADMIN_ROLES)[number])) {
    return {
      error: NextResponse.json({ error: "Owner or admin role required" }, { status: 403 }),
    } as const;
  }
  return { error: null } as const;
}

/**
 * PATCH /api/v1/workspaces/:workspaceId/briefs/:slug/items/:itemId
 *
 * The console's human-edit write path — calls `updateBriefItemAsHuman`, NOT
 * `patchBriefItems`. This distinction is the entire reason that function
 * exists: `patchBriefItems` is Jace's write path and silently skips any
 * item already `authority: 'human'`, so routing a human's SECOND correction
 * to the same item through it would silently drop the edit. This route is
 * the one place in the console entitled to assert `authority: 'human'`.
 *
 * A partial patch — only the fields present in the JSON body are forwarded
 * to the store (`"x" in body`, not `!== undefined`, mirroring
 * `updateBriefItemAsHuman`'s own merge semantics, including an explicit
 * `resolution: null`). An omitted field is left exactly as stored; this
 * route must not paper over that by defaulting anything itself.
 *
 * Two failure shapes map to two different statuses: `item: null,
 * refusedUnknownResolved: false` means the (briefId, itemId) pair didn't
 * resolve to a real row → 404. `refusedUnknownResolved: true` means the
 * EFFECTIVE post-patch value would be `kind: 'unknown'` + `state:
 * 'resolved'` → 400 with an explanation (re-kind it first).
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; slug: string; itemId: string }> }
) {
  const { workspaceId, slug, itemId } = await params;
  const gate = await requireManage(workspaceId);
  if (gate.error) return gate.error;

  const brief = await getBriefBySlug(workspaceId, slug);
  if (!brief) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as RawBody;
  const errors: Record<string, string> = {};
  const fields: Parameters<typeof updateBriefItemAsHuman>[2] = {};

  if ("area" in body) {
    if (typeof body.area !== "string" || !AREA_VALUES.includes(body.area as (typeof AREA_VALUES)[number])) {
      errors.area = `area must be one of: ${AREA_VALUES.join(", ")}`;
    } else {
      fields.area = body.area as (typeof AREA_VALUES)[number];
    }
  }

  if ("statement" in body) {
    const statement = typeof body.statement === "string" ? body.statement.trim() : "";
    if (!statement) {
      errors.statement = "statement cannot be empty";
    } else if (statement.length > STATEMENT_MAX) {
      errors.statement = `statement exceeds ${STATEMENT_MAX} characters`;
    } else {
      fields.statement = statement;
    }
  }

  if ("evidence" in body) {
    if (typeof body.evidence !== "string" || body.evidence.length > EVIDENCE_MAX) {
      errors.evidence = `evidence must be a string of at most ${EVIDENCE_MAX} characters`;
    } else {
      fields.evidence = body.evidence;
    }
  }

  if ("kind" in body) {
    if (typeof body.kind !== "string" || !KIND_VALUES.includes(body.kind as (typeof KIND_VALUES)[number])) {
      errors.kind = `kind must be one of: ${KIND_VALUES.join(", ")}`;
    } else {
      fields.kind = body.kind as (typeof KIND_VALUES)[number];
    }
  }

  if ("state" in body) {
    if (typeof body.state !== "string" || !STATE_VALUES.includes(body.state as (typeof STATE_VALUES)[number])) {
      errors.state = `state must be one of: ${STATE_VALUES.join(", ")}`;
    } else {
      fields.state = body.state as (typeof STATE_VALUES)[number];
    }
  }

  if ("resolution" in body) {
    if (
      body.resolution !== null &&
      (typeof body.resolution !== "string" ||
        !RESOLUTION_VALUES.includes(body.resolution as (typeof RESOLUTION_VALUES)[number]))
    ) {
      errors.resolution = `resolution must be null or one of: ${RESOLUTION_VALUES.join(", ")}`;
    } else {
      fields.resolution = body.resolution as (typeof RESOLUTION_VALUES)[number] | null;
    }
  }

  if (Object.keys(errors).length > 0) {
    return NextResponse.json({ errors }, { status: 400 });
  }

  const result = await updateBriefItemAsHuman(brief.id, itemId, fields);

  if (result.refusedUnknownResolved) {
    return NextResponse.json(
      {
        error:
          "an 'unknown' item cannot be resolved — answer it first (kind: required/optional) or mark it out-of-scope",
      },
      { status: 400 }
    );
  }
  if (!result.item) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ item: result.item });
}

/**
 * DELETE /api/v1/workspaces/:workspaceId/briefs/:slug/items/:itemId
 *
 * The one visible bypass the design spec names for the readiness gate
 * ("Deleting the item is the only bypass, and it is visible", design spec
 * "Readiness gate") — and, more generally, how a human removes an item Jace
 * was simply wrong to add (as opposed to `kind: 'out-of-scope'`, which keeps
 * the item as a recorded decision). Works regardless of the item's
 * `authority` — see `deleteBriefItem`'s own doc-comment for why deletion
 * isn't restricted the way a content-overwrite is.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; slug: string; itemId: string }> }
) {
  const { workspaceId, slug, itemId } = await params;
  const gate = await requireManage(workspaceId);
  if (gate.error) return gate.error;

  const brief = await getBriefBySlug(workspaceId, slug);
  if (!brief) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const deleted = await deleteBriefItem(brief.id, itemId);
  if (!deleted) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
