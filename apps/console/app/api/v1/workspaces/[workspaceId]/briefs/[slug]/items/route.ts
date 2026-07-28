import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  briefAreaEnum,
  briefItemKindEnum,
  briefItemResolutionEnum,
  briefItemStateEnum,
  createBriefItemAsHuman,
  getBriefBySlug,
  getWorkspaceMembership,
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

/**
 * POST /api/v1/workspaces/:workspaceId/briefs/:slug/items
 *
 * Create a brand-new, human-authored brief item straight from the console —
 * the "add a constraint Jace never asked about" case (see
 * `createBriefItemAsHuman`'s own doc-comment in `@agentrail/db-postgres` for
 * why this is a separate store function from the human-edit path, not a
 * third mode on it). Every new item this route creates carries
 * `authority: 'human'` unconditionally — there is no field in the request
 * body that can override that, matching the invariant that only a human
 * console edit is ever entitled to assert it.
 *
 * Role-gated owner/admin, `slug`-resolved brief id, same posture as the
 * sibling `status/route.ts` — see that route's doc-comment for the
 * precedent both follow (`goals/route.ts`'s `ADMIN_ROLES`).
 *
 * The unknown-may-never-resolve invariant is enforced two layers down, in
 * `createBriefItemAsHuman` itself (not re-implemented here) — this route
 * just needs to turn `refusedUnknownResolved: true` into a 400 with an
 * explanation, since a human filling out this form needs to know WHY their
 * submission was rejected, not just that it silently did nothing.
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

  const brief = await getBriefBySlug(workspaceId, slug);
  if (!brief) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as RawBody;
  const errors: Record<string, string> = {};

  const area = typeof body.area === "string" ? body.area : "";
  if (!AREA_VALUES.includes(area as (typeof AREA_VALUES)[number])) {
    errors.area = `area must be one of: ${AREA_VALUES.join(", ")}`;
  }

  const statement = typeof body.statement === "string" ? body.statement.trim() : "";
  if (!statement) {
    errors.statement = "statement is required";
  } else if (statement.length > STATEMENT_MAX) {
    errors.statement = `statement exceeds ${STATEMENT_MAX} characters`;
  }

  const kind = typeof body.kind === "string" ? body.kind : "";
  if (!KIND_VALUES.includes(kind as (typeof KIND_VALUES)[number])) {
    errors.kind = `kind must be one of: ${KIND_VALUES.join(", ")}`;
  }

  let evidence: string | undefined;
  if (body.evidence !== undefined) {
    if (typeof body.evidence !== "string" || body.evidence.length > EVIDENCE_MAX) {
      errors.evidence = `evidence must be a string of at most ${EVIDENCE_MAX} characters`;
    } else {
      evidence = body.evidence;
    }
  }

  let state: (typeof STATE_VALUES)[number] | undefined;
  if (body.state !== undefined) {
    if (typeof body.state !== "string" || !STATE_VALUES.includes(body.state as (typeof STATE_VALUES)[number])) {
      errors.state = `state must be one of: ${STATE_VALUES.join(", ")}`;
    } else {
      state = body.state as (typeof STATE_VALUES)[number];
    }
  }

  let resolution: (typeof RESOLUTION_VALUES)[number] | null | undefined;
  if (body.resolution !== undefined) {
    if (
      body.resolution !== null &&
      (typeof body.resolution !== "string" ||
        !RESOLUTION_VALUES.includes(body.resolution as (typeof RESOLUTION_VALUES)[number]))
    ) {
      errors.resolution = `resolution must be null or one of: ${RESOLUTION_VALUES.join(", ")}`;
    } else {
      resolution = body.resolution as (typeof RESOLUTION_VALUES)[number] | null;
    }
  }

  if (Object.keys(errors).length > 0) {
    return NextResponse.json({ errors }, { status: 400 });
  }

  const result = await createBriefItemAsHuman(brief.id, {
    area: area as (typeof AREA_VALUES)[number],
    statement,
    evidence,
    kind: kind as (typeof KIND_VALUES)[number],
    state,
    resolution,
  });

  if (result.refusedUnknownResolved) {
    return NextResponse.json(
      {
        error:
          "an 'unknown' item cannot be created already resolved — answer it first (kind: required/optional) or mark it out-of-scope",
      },
      { status: 400 }
    );
  }

  return NextResponse.json({ item: result.item }, { status: 201 });
}
