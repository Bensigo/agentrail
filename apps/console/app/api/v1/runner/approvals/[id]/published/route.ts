import { NextRequest, NextResponse } from "next/server";
import {
  getApprovalById,
  getJaceSessionByEveSessionId,
  stampPublishedIssueUrl,
} from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../../../lib/bearer-auth";

/**
 * POST /api/v1/runner/approvals/[id]/published
 *
 * #1274 PR ② — the chat-born one-confirm collapse's own write: stamps the
 * REAL GitHub issue URL a `create_issue` tool call produced onto its own
 * (already-approved) approval row. This is what lets
 * `enqueueGithubIssue`'s confirmed-brief lookup (`@agentrail/db-postgres`)
 * recognize the SAME issue arriving later via the label webhook and admit
 * it straight to `queued` with the sanctioned budget/model, instead of
 * parking it for a second, redundant alignment confirm (issue #1274 AC2,
 * "exactly one confirm from idea to queued").
 *
 * Called from `apps/jace/agent/lib/create_issue.core.mjs`, BEST-EFFORT,
 * AFTER the CLI has actually created the issue — see that file for the "a
 * failed stamp must never fail the tool result" fail-safe direction. A
 * stamp that never lands just means the label webhook parks the entry for
 * a second confirm later — safe, only redundant.
 *
 * AUTH mirrors POST /api/v1/runner/approvals' own resolution chain (this
 * route's sibling, the ONLY other route in this seam that resolves tenant
 * via an eveSessionId rather than trusting an opaque id alone): bearer ->
 * `bearerWorkspaceId`, PLUS the target approval's OWN `eveSessionId`
 * resolved through the `jace_sessions` ledger and cross-checked against
 * that workspace — collapsed to the SAME indistinguishable 404 that route
 * uses (an unknown id, and an id whose owning session has no anchor or
 * belongs to a different workspace, all read identically to the caller).
 * Unlike `GET .../approvals/[id]` (which trusts the opaque uuid ALONE,
 * documented there as sufficient for a READ), this is a WRITE — `id` alone
 * is not treated as a sufficient security boundary here.
 *
 * Body: `{ url }`. `url` MUST match the EXACT shape
 * `githubIssueUrl()` (`@agentrail/db-postgres`) produces —
 * `https://github.com/<owner>/<repo>/issues/<n>` — validated by regex
 * BEFORE any write, never trusted as opaque caller text. This is the
 * "tighten if needed" the #1274 PR② brief calls for: the confirmed-brief
 * lookup this stamp feeds is an EXACT STRING match against
 * `published_issue_url` (see `findConfirmedAlignmentBriefApproval` in
 * `github_intake.ts`) — that lookup was already safe against a
 * title-forged match (it compares a value computed ONLY from
 * repoFullName+number, never from title/body text), but this endpoint adds
 * a second, independent belt-and-suspenders check on the WRITE side: an
 * off-shape `url` can never even be written, regardless of what produced
 * it.
 *
 * ONLY an APPROVED approval can be stamped. Idempotent: re-stamping the
 * SAME value is a no-op 200 (a retried tool-side call, or a network blip
 * after a stamp that actually landed). A DIFFERENT already-stamped value,
 * or an approval that isn't approved, is a 409 conflict, logged loudly —
 * one approval produces at most one issue, so either case is treated as
 * suspicious rather than silently overwritten or silently accepted.
 */

const GITHUB_ISSUE_URL_RE = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+$/;

interface RawBody {
  url: string;
}

function isRawBody(value: unknown): value is RawBody {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return typeof body["url"] === "string" && body["url"].length > 0;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireBearer(request);
  if (auth instanceof NextResponse) {
    return auth;
  }
  const { workspaceId: bearerWorkspaceId } = auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!isRawBody(body)) {
    return NextResponse.json(
      { error: "Body must have url (non-empty string)" },
      { status: 400 }
    );
  }
  if (!GITHUB_ISSUE_URL_RE.test(body.url)) {
    return NextResponse.json(
      {
        error:
          "url must be a canonical GitHub issue URL (https://github.com/<owner>/<repo>/issues/<n>)",
      },
      { status: 400 }
    );
  }

  const { id } = await params;
  const approval = await getApprovalById(id);
  if (!approval) {
    return NextResponse.json({ error: "Approval not found" }, { status: 404 });
  }

  // Same resolution chain as POST /api/v1/runner/approvals — sourced from
  // the approval's OWN stored eveSessionId (already known once fetched by
  // id) rather than a caller-supplied one, since `id` plus this row-owned
  // value is enough to reproduce that exact bearer+session cross-check.
  const session = await getJaceSessionByEveSessionId(approval.eveSessionId);
  const hasNoAnchor =
    !session || (session.workspaceId == null && session.chatIdentityId == null);
  const crossTenant =
    !!session && session.workspaceId != null && session.workspaceId !== bearerWorkspaceId;
  if (hasNoAnchor || crossTenant) {
    return NextResponse.json({ error: "Approval not found" }, { status: 404 });
  }

  const outcome = await stampPublishedIssueUrl(id, body.url);
  switch (outcome) {
    case "stamped":
      return NextResponse.json({ ok: true }, { status: 200 });
    case "not_approved":
      console.error(
        `[runner/approvals/published] approval ${id} is not approved (status=${approval.status}); refusing to stamp published_issue_url`
      );
      return NextResponse.json({ error: "Approval is not approved" }, { status: 409 });
    case "conflict":
      console.error(
        `[runner/approvals/published] approval ${id} is already stamped with a DIFFERENT published_issue_url (existing=${approval.publishedIssueUrl ?? "null"}, incoming=${body.url}); refusing to overwrite`
      );
      return NextResponse.json(
        { error: "Already stamped with a different url" },
        { status: 409 }
      );
  }
}
