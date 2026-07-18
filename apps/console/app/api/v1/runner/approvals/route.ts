import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  getJaceSessionByEveSessionId,
  recordApprovalRequest,
} from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";
import { renderApprovalMessage } from "../../../../../lib/approval-message";
import {
  sendTelegramMessage,
  buildApprovalKeyboard,
} from "../../workspaces/[workspaceId]/connectors/secret/telegram";

/**
 * POST /api/v1/runner/approvals
 *
 * The console-owned approval seam (issue #1273, CONTROLLER DESIGN): a gated
 * Jace tool's approval function (`apps/jace/agent/lib`, PR ② — not this PR)
 * POSTs here instead of going through Eve's stock HITL renderer, then polls
 * `GET .../approvals/[id]` for a decision. This route records the request,
 * composes the RICH per-tool message (`renderApprovalMessage`), and sends it
 * with an Approve/Deny inline keyboard to the requesting conversation.
 *
 * Auth mirrors `POST /api/v1/runner/connect-link` (issue #1263 PR ②, the
 * "#1264 route auth idiom"): a bearer AgentRail API key via `requireBearer`
 * resolves `bearerWorkspaceId`, but the REAL tenant is resolved server-side
 * from `eveSessionId` through the `jace_sessions` ledger
 * (`getJaceSessionByEveSessionId`) — never from caller input. The bearer's
 * own workspace is used only as a cross-tenant SAFETY NET (refuse when the
 * ledgered session already belongs to a DIFFERENT workspace), with the same
 * accepted residual connect-link documents: an intro (workspace-less)
 * session — the create_workspace cold-start case this seam exists for — has
 * no tenant yet, so it is mintable by any valid bearer. Whether
 * `JACE_CONSOLE_TOKEN` (this route's caller) is per-workspace or one bearer
 * shared across the whole hosted deployment is the SAME open, unconfirmed
 * question connect-link's doc-comment tracks under #1295 — this route
 * inherits that posture rather than re-litigating it.
 *
 * Body: `{ eveSessionId, toolName, toolInput }`. Every failure to resolve a
 * usable session — absent, or a defensive (unreachable in practice) row with
 * neither anchor, or a cross-tenant mismatch — collapses into the SAME 404
 * body (house anti-enumeration posture, matching connect-link): a caller
 * cannot distinguish "no such session" from "wrong tenant" from a data
 * anomaly by reading the response.
 *
 * `chatIdentityId`/`workspaceId` are both passed through to
 * `recordApprovalRequest` whenever the session has them (NOT an either/or
 * choice — see that function's own doc-comment): `chatIdentityId` is what
 * the Telegram webhook's SENDER CHECK verifies against later, and a
 * graduated session still needs it even though it also has a `workspaceId`.
 *
 * `requestId` is freshly minted here (`randomUUID()`) rather than carrying
 * any real Eve inputRequest id — the whole point of this seam (CONTROLLER
 * DESIGN point 1) is that the gated tools' approval function bypasses Eve's
 * HITL/inputRequest machinery entirely, so no such id exists to reuse. It
 * exists solely to satisfy `jace_approvals`'s `(eveSessionId, requestId)`
 * uniqueness — as vestigial as the literal "approve"/"deny" option ids below.
 *
 * The Telegram send is BEST-EFFORT (mirrors `notifyRunOutcome`'s posture
 * elsewhere in this app): the approval row is the durable source of truth,
 * so a transport blip, a missing `TELEGRAM_BOT_TOKEN`, or a non-Telegram
 * channel never fails this response — the poller (PR ②) keeps waiting and
 * owns its own TTL either way. Expiry is not enforced here at all: no
 * server-side timeout flips a `pending` approval to `expired` in this PR —
 * that "the poller's TTL times out to an honest denial" flow is PR ②'s deny
 * path, not this route's.
 */

interface RawBody {
  eveSessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

function isRawBody(value: unknown): value is RawBody {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return (
    typeof body["eveSessionId"] === "string" &&
    body["eveSessionId"].length > 0 &&
    typeof body["toolName"] === "string" &&
    body["toolName"].length > 0 &&
    !!body["toolInput"] &&
    typeof body["toolInput"] === "object" &&
    !Array.isArray(body["toolInput"])
  );
}

/**
 * Best-effort: render + send the rich approval message with its Approve/Deny
 * keyboard to the session's conversation. Telegram-only for v1 (spec scope —
 * Slack/Discord are out of this issue); any other channel, a missing bot
 * token, a send rejection, or an unexpected throw is logged and swallowed —
 * never surfaced to the caller, since the approval row is already recorded.
 */
async function sendApprovalMessage(
  session: { channel: string; conversationKey: string },
  callbackToken: string,
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<void> {
  if (session.channel !== "telegram") return;

  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) {
    console.error(
      "[runner/approvals] TELEGRAM_BOT_TOKEN is not configured; approval recorded but no message was sent"
    );
    return;
  }

  try {
    const text = renderApprovalMessage(toolName, toolInput);
    const keyboard = buildApprovalKeyboard(callbackToken);
    const result = await sendTelegramMessage(
      token,
      session.conversationKey,
      text,
      keyboard
    );
    if (!result.ok) {
      console.error("[runner/approvals] Telegram send failed:", result.error);
    }
  } catch (err) {
    console.error(
      "[runner/approvals] unexpected error sending approval message:",
      err
    );
  }
}

export async function POST(request: NextRequest) {
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
      {
        error:
          "Body must have eveSessionId (string), toolName (string) and toolInput (object)",
      },
      { status: 400 }
    );
  }

  const session = await getJaceSessionByEveSessionId(body.eveSessionId);
  const hasNoAnchor =
    !session || (session.workspaceId == null && session.chatIdentityId == null);
  const crossTenant =
    !!session &&
    session.workspaceId != null &&
    session.workspaceId !== bearerWorkspaceId;
  if (hasNoAnchor || crossTenant) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const approval = await recordApprovalRequest({
    workspaceId: session.workspaceId ?? undefined,
    chatIdentityId: session.chatIdentityId ?? undefined,
    sessionId: session.id,
    eveSessionId: body.eveSessionId,
    requestId: randomUUID(),
    toolName: body.toolName,
    toolInput: body.toolInput,
    approveOptionId: "approve",
    denyOptionId: "deny",
  });

  await sendApprovalMessage(
    session,
    approval.callbackToken,
    body.toolName,
    body.toolInput
  );

  return NextResponse.json(
    { approvalId: approval.id, status: "pending" },
    { status: 201 }
  );
}
