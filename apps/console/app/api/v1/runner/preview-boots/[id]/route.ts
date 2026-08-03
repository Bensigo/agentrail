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
 * ORDER OF CHECKS (Fix round 1, review Finding 1 — CRITICAL, fixed): the
 * caller's own session/workspace is resolved via `resolveWorkspaceId`
 * BEFORE `getPreviewBoot` ever runs. `eveSessionId` presence (400) is still
 * checked first of all (cheapest possible validation, same "cheapest/safest
 * first" posture `review-evidence/route.ts`'s own doc-comment states for its
 * POST handler), but the row is now the LAST thing looked up, not the
 * first.
 *
 * WHY THIS ORDER MATTERS (the bug this fixes): the original version called
 * `getPreviewBoot(id)` first and only resolved the session afterward. That
 * meant row-existence was confirmed or denied independent of whether the
 * caller had proven anything about who they are: an existing row + an
 * eveSessionId that fails to resolve returned 404 `{error:"Session not
 * found"}`, while a NONEXISTENT row + that SAME unresolvable eveSessionId
 * short-circuited one step earlier to a DIFFERENT body, 404
 * `{error:"boot not found"}` — and if the garbage session happened to
 * resolve to a real, merely workspace-less identity, an existing row
 * produced a 409 while a nonexistent one still produced a 404. Three
 * distinguishable outcomes for the same non-fact ("I have not proven I own
 * this row") is a live existence oracle: any holder of the shared
 * `JACE_CONSOLE_TOKEN` could confirm whether a preview-boot row for a
 * guessed/targeted workspace exists, without ever presenting a session
 * bound to that workspace. Resolving the session FIRST closes this
 * entirely — every session-resolution failure now returns identically
 * regardless of whether `id` denotes a real row, because the row is never
 * looked up until AFTER a valid, workspace-bound session is already
 * established.
 *
 * TENANT SCOPING: once `resolveWorkspaceId(eveSessionId)` (`../shared.ts`,
 * the same helper the POST route uses) has resolved the CALLING session's
 * real workspaceId, `getPreviewBoot(id)` runs and its result is checked in
 * ONE condition: `!row || row.workspaceId !== resolved.workspaceId`. "row
 * absent" and "row exists but belongs to someone else" are DELIBERATELY the
 * same branch, not two — both call the same `notFoundResponse()`, so the
 * two are byte-identical by construction, not just by convention. Same
 * anti-enumeration posture `runner/approvals/[id]/route.ts` uses ("a
 * distinguishable status would let a caller confirm a cross-tenant [row] id
 * exists even though it can't read its contents") — this route now honors
 * that same rule for its OWN resource, not just for the session lookup.
 *
 * RESPONSE: 200 `{status, url, reason, bootLogKey}` only — never `workerId`,
 * `attempts`, `expiresAt`, or any other internal scheduling field a poller
 * has no use for. `bootLogKey` is nullable until the worker's best-effort
 * artifact upload completes.
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

  // Resolve the CALLER's own session/workspace FIRST — see this file's own
  // doc-comment ("ORDER OF CHECKS"/"WHY THIS ORDER MATTERS"). Own-session
  // failures (no such session / no workspace yet) are about the caller, not
  // about whether the requested row exists, so they return exactly as
  // resolveWorkspaceId shapes them, unconditionally — the row is not looked
  // up at all until this has already succeeded.
  const resolved = await resolveWorkspaceId(eveSessionId);
  if (!resolved.ok) return resolved.response;

  const { id } = await params;
  const row = await getPreviewBoot(id);

  // Row absent AND row exists-but-wrong-tenant are the SAME branch — no
  // oracle for either existence or ownership once a valid session is
  // established.
  if (!row || row.workspaceId !== resolved.workspaceId) {
    return notFoundResponse();
  }

  return NextResponse.json(
    {
      status: row.status,
      url: row.url ?? null,
      reason: row.reason ?? null,
      bootLogKey: row.bootLogKey ?? null,
    },
    { status: 200 }
  );
}
