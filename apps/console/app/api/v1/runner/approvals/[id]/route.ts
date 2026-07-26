import { NextRequest, NextResponse } from "next/server";
import { getApprovalById } from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../lib/jace-console-auth";

/**
 * GET /api/v1/runner/approvals/[id]
 *
 * The poller's own surface (issue #1273, PR ②'s approval function polls this
 * on a backoff until a terminal status or its own TTL). Authenticated via the
 * central Jace-coordinator secret (`requireJaceConsoleSecret` — replaced a
 * per-workspace bearer, `requireBearer`, once prod's api_keys table went to
 * zero rows; see that helper's own doc-comment).
 *
 * CROSS-TENANT SCOPING (issue #1295, PR ③ — resolves the #1273 PR① review
 * item: "returns {status, resolvedAt} to ANY valid bearer that learns an
 * approval id — no cross-tenant check"). `JACE_CONSOLE_TOKEN` is ONE shared
 * secret for the whole deployment (settled by #1295's own "per-workspace or
 * shared" question — see `jace-console-auth.ts`), so there is no per-caller
 * `workspaceId` to compare a bearer against, unlike `requireBearer`'s
 * `auth.workspaceId !== workspaceId` pattern (`runner/claim/route.ts`) — that
 * sibling convention doesn't transplant here because the identity it needs
 * doesn't exist under this auth model. What DOES exist, same as this route's
 * siblings `POST /approvals` and `POST /approvals/[id]/published`: the
 * caller-supplied `eveSessionId`, which those routes already treat as the
 * REAL identity (resolved server-side, never trusted from a bearer). This
 * route now requires the poller to supply that same `eveSessionId` as a
 * query param and checks it against the approval's OWN stored
 * `eveSessionId` (`jaceApprovals.eve_session_id`, set once at
 * `recordApprovalRequest` time and never caller-overridable afterwards) — a
 * plain equality check, no extra query needed. A caller who only knows the
 * (guessed, leaked, or otherwise learned) approval id, but not the exact
 * `eveSessionId` that created it, gets the SAME 404 as an unknown id: this
 * closes the "id alone is a sufficient capability" gap down to "id AND its
 * owning session," while preserving the existing unguessable-uuid defense
 * as a second, independent layer (see `getApprovalById`'s own doc-comment).
 *
 * Poller-side counterpart: `apps/jace/agent/lib/console_gated_approval.core.mjs`
 * now threads its own `eveSessionId` (already in scope from the POST call
 * that minted this approval) through to every GET poll.
 *
 * Response is narrow ON PURPOSE: `{ status, resolvedAt }` only — never
 * `toolName`/`toolInput`/`callbackToken`, which the poller has no need to
 * see again (it already sent them). 404-indistinguishable for an unknown id
 * OR a mismatched `eveSessionId` (same anti-enumeration posture as the POST
 * route and connect-link — a mismatch must never be distinguishable from
 * "no such approval," or the endpoint would still confirm cross-tenant
 * existence via a different signal).
 *
 * No expiry is enforced here: this PR carries no server-side TTL flip to
 * `expired` — the poller owns its own timeout and treats it as an honest
 * denial when reached (PR ②).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) {
    return authError;
  }

  const eveSessionId = new URL(request.url).searchParams.get("eveSessionId")?.trim();
  if (!eveSessionId) {
    return NextResponse.json(
      { error: "eveSessionId query param is required" },
      { status: 400 }
    );
  }

  const { id } = await params;
  const approval = await getApprovalById(id);
  // Same indistinguishable 404 for "no such approval" and "approval exists
  // but belongs to a different session" — see the doc-comment above for why
  // this must not be a distinguishable 403: a distinguishable status would
  // let a caller confirm a cross-tenant approval id exists even though it
  // can't read its contents.
  if (!approval || approval.eveSessionId !== eveSessionId) {
    return NextResponse.json({ error: "Approval not found" }, { status: 404 });
  }

  return NextResponse.json(
    { status: approval.status, resolvedAt: approval.resolvedAt },
    { status: 200 }
  );
}
