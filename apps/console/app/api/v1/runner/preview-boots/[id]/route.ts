import { NextRequest, NextResponse } from "next/server";
import { getPreviewBoot } from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../lib/jace-console-auth";
import { previewBootsDisabled, previewBootsDisabledResponse, resolveWorkspaceId } from "../shared";

/**
 * GET /api/v1/runner/preview-boots/[id]
 *
 * B2b Task 3 (plan docs/superpowers/plans/2026-08-02-b2b-sandbox-boot.md;
 * spec docs/superpowers/specs/2026-08-02-b2-behavioral-evidence-design.md
 * §B2b §4-5). Jace's poll seam: a thin, read-only status check against one
 * `preview_boots` row (`getPreviewBoot`, `@agentrail/db-postgres`), narrowed
 * to exactly what a poller needs — same "narrow response, never leak
 * internal fields" posture `runner/approvals/[id]/route.ts` uses for its own
 * poll surface.
 *
 * AUTH: `requireJaceConsoleSecret`, checked first — same as every
 * Jace-coordinator route.
 *
 * FLAG (immediately after auth): `PREVIEW_BOOTS_ENABLED !== "1"` — 503
 * (`../shared.ts`).
 *
 * ORDER OF CHECKS (deliberate: cheap input validation before any DB call —
 * same "cheapest/safest first" posture `review-evidence/route.ts`'s own
 * doc-comment states for its POST handler, and the same order
 * `runner/approvals/[id]/route.ts` uses for its own `eveSessionId` query
 * param): `eveSessionId` presence (400) is checked BEFORE `getPreviewBoot`
 * runs, so a malformed poll never costs a database read.
 *
 * TENANT SCOPING: `resolveWorkspaceId(eveSessionId)` (`../shared.ts`, the
 * same helper the POST route uses) resolves the CALLING session's real
 * workspaceId, then that is compared against the loaded row's own
 * `workspaceId`. A mismatch is hidden as the SAME 404 the "no such id" case
 * returns (`notFoundResponse()`, used by both branches so the two are
 * byte-identical) — same anti-enumeration posture
 * `runner/approvals/[id]/route.ts` uses ("a distinguishable status would
 * let a caller confirm a cross-tenant [row] id exists even though it can't
 * read its contents").
 *
 * RESPONSE: 200 `{status, url, reason}` only — never `workerId`,
 * `attempts`, `expiresAt`, or any other internal scheduling field a poller
 * has no use for.
 */

function notFoundResponse(): NextResponse {
  return NextResponse.json({ error: "boot not found" }, { status: 404 });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;

  if (previewBootsDisabled()) {
    return previewBootsDisabledResponse();
  }

  const eveSessionId = new URL(request.url).searchParams.get("eveSessionId")?.trim();
  if (!eveSessionId) {
    return NextResponse.json({ error: "eveSessionId is required" }, { status: 400 });
  }

  const { id } = await params;
  const row = await getPreviewBoot(id);
  if (!row) {
    return notFoundResponse();
  }

  const resolved = await resolveWorkspaceId(eveSessionId);
  if (!resolved.ok) return resolved.response;

  if (row.workspaceId !== resolved.workspaceId) {
    // Cross-tenant hidden as not-found — see this file's own doc-comment.
    return notFoundResponse();
  }

  return NextResponse.json(
    { status: row.status, url: row.url ?? null, reason: row.reason ?? null },
    { status: 200 }
  );
}
