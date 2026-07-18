import { NextRequest, NextResponse } from "next/server";
import { getApprovalById } from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../../lib/bearer-auth";

/**
 * GET /api/v1/runner/approvals/[id]
 *
 * The poller's own surface (issue #1273, PR ②'s approval function polls this
 * on a backoff until a terminal status or its own TTL). Bearer-authenticated
 * the same as `POST .../approvals` (`requireBearer`), but deliberately
 * carries NO further tenant cross-check here: `id` is a uuid this console
 * itself minted at record time and handed back in the POST response, never
 * caller-guessable — see `getApprovalById`'s own doc-comment.
 *
 * Response is narrow ON PURPOSE: `{ status, resolvedAt }` only — never
 * `toolName`/`toolInput`/`callbackToken`, which the poller has no need to
 * see again (it already sent them). 404-indistinguishable for an unknown id
 * (same anti-enumeration posture as the POST route and connect-link).
 *
 * No expiry is enforced here: this PR carries no server-side TTL flip to
 * `expired` — the poller owns its own timeout and treats it as an honest
 * denial when reached (PR ②).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireBearer(request);
  if (auth instanceof NextResponse) {
    return auth;
  }

  const { id } = await params;
  const approval = await getApprovalById(id);
  if (!approval) {
    return NextResponse.json({ error: "Approval not found" }, { status: 404 });
  }

  return NextResponse.json(
    { status: approval.status, resolvedAt: approval.resolvedAt },
    { status: 200 }
  );
}
