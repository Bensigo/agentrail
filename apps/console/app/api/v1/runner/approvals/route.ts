import { NextRequest, NextResponse } from "next/server";
import {
  getJaceSessionByEveSessionId,
  recordApprovalRequest,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../lib/jace-console-auth";
import { renderApprovalMessage } from "../../../../../lib/approval-message";
import {
  composeChatBornBrief,
  resolveModelSelectionForBrief,
} from "../../../../../lib/alignment-brief";
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
 * AUTH (updated for the central-secret fix, 2026-07-20): authenticated via
 * the shared `JACE_CONSOLE_TOKEN` secret (`requireJaceConsoleSecret` — see
 * that helper's own doc-comment) rather than a per-workspace bearer AgentRail
 * API key. The REAL tenant is resolved server-side from `eveSessionId`
 * through the `jace_sessions` ledger (`getJaceSessionByEveSessionId`) —
 * never from caller input, unchanged. What DID change: the old
 * `requireBearer`-based guard additionally cross-checked the bearer's OWN
 * `workspaceId` against the ledgered session's as a defense-in-depth safety
 * net; that check is gone because there is no longer a caller-specific
 * workspace to compare against — `JACE_CONSOLE_TOKEN` is ONE shared secret
 * for the whole deployment (settling #1295's "per-workspace or shared"
 * question: shared, exactly mirroring `FLEET_CONSOLE_TOKEN`), held only by
 * Jace's own shared coordinator, which legitimately serves every workspace's
 * conversations. The invariant that survives is the one that actually
 * matters: a caller can never DIRECT this route at an arbitrary workspace —
 * it only ever supplies an opaque `eveSessionId`, and the workspace used
 * below is whatever the session ledger already resolved it to server-side,
 * same as before.
 *
 * Body: `{ eveSessionId, toolName, toolInput, idempotencyKey }`. Every
 * failure to resolve a usable session — absent, or a defensive (unreachable
 * in practice) row with neither anchor (no `workspaceId` AND no
 * `chatIdentityId`) — collapses into the SAME 404 body (house
 * anti-enumeration posture, matching connect-link): a caller cannot
 * distinguish "no such session" from a data anomaly by reading the response.
 *
 * `chatIdentityId`/`workspaceId` are both passed through to
 * `recordApprovalRequest` whenever the session has them (NOT an either/or
 * choice — see that function's own doc-comment): `chatIdentityId` is what
 * the Telegram webhook's SENDER CHECK verifies against later, and a
 * graduated session still needs it even though it also has a `workspaceId`.
 *
 * `idempotencyKey` (issue #1273 PR ②, REQUIRED) is composed by the caller —
 * Jace's `consoleGatedApproval` approval fn, `apps/jace/agent/lib/
 * console_gated_approval.core.mjs` — and used VERBATIM as `requestId`: no
 * hashing, no reshaping. It rides through `recordApprovalRequest`'s
 * `(eveSessionId, requestId)` uniqueness (issue #1273 PR ①'s vestigial-id
 * slot, now load-bearing), which is now idempotent-on-conflict rather than
 * throwing: a retried POST with the same `(eveSessionId, idempotencyKey)`
 * returns the EXISTING approval's `{ approvalId, status }` with 200 —
 * `created: false` on the query result — instead of minting a second row or
 * sending the channel message a second time. A fresh request (`created:
 * true`) still responds 201, unchanged from PR ①. The replay response's
 * `status` reflects the EXISTING row's actual (possibly already-terminal)
 * status, never a hardcoded `"pending"` — a caller that retries after a
 * human already answered gets the real answer back immediately.
 *
 * The Telegram send is BEST-EFFORT (mirrors `notifyRunOutcome`'s posture
 * elsewhere in this app): the approval row is the durable source of truth,
 * so a transport blip, a missing `TELEGRAM_BOT_TOKEN`, or a non-Telegram
 * channel never fails this response — the poller (PR ②) keeps waiting and
 * owns its own TTL either way. It fires ONLY on `created: true` — a replay
 * must never send a second message for the same request. Expiry is not
 * enforced here at all: no server-side timeout flips a `pending` approval to
 * `expired` in this PR — that "the poller's TTL times out to an honest
 * denial" flow is PR ②'s deny path, not this route's.
 */

/**
 * #1274 PR ②, locked design point 1 — chat-born one-confirm collapse: when
 * `toolName === "create_issue"`, this route enriches the STORED `toolInput`
 * with a reserved `_brief` key (`composeChatBornBrief`, computed from
 * fields ALREADY on create_issue's own toolInput — title/whatToBuild/
 * acceptanceCriteria) BEFORE `recordApprovalRequest`. `renderCreateIssue`
 * (`../../../../../lib/approval-message.ts`) then upgrades to the full
 * alignment-brief render whenever `_brief` is present, and
 * `enqueueGithubIssue`'s confirmed-brief lookup (`@agentrail/db-postgres`)
 * reads the sanctioned budget/model back out of it once the label webhook
 * redelivers the same issue — collapsing what would otherwise be TWO
 * confirms (approve creating the issue, then a second alignment confirm)
 * into ONE.
 *
 * INJECTION GUARD (locked design, non-negotiable): any incoming `_brief`
 * key is unconditionally stripped/overwritten — Jace/the model can never
 * author brief fields; only this server-computed value may ever occupy
 * that key. This holds EVEN IF the enrichment computation below fails: the
 * catch branch still returns the STRIPPED `rest`, never the caller's own
 * `_brief`.
 *
 * Defensive against a malformed create_issue payload (this route accepts
 * `toolInput` as an arbitrary object for every tool, not specifically
 * validated against create_issue's own zod schema): a missing/wrong-typed
 * title/whatToBuild/acceptanceCriteria degrades to `""`/`[]` rather than
 * throwing, and `composeChatBornBrief` itself is wrapped so ANY unexpected
 * throw still records the approval — just without `_brief` — rather than
 * failing the whole POST. This is the SAME fail-safe direction the whole
 * alignment gate always takes: a create_issue approval with no `_brief`
 * falls back to the pre-#1274-PR② render, and the label webhook will later
 * park it for a separate (redundant, but safe) alignment confirm.
 *
 * `workspaceId` (#1338 PR②, new param): threaded through to
 * `resolveModelSelectionForBrief` so the model-selection learning loop's
 * selector can be scoped to this session's workspace when the feature flag
 * is on for it. `undefined` for a session that hasn't graduated to a
 * workspace yet (an intro/chat-identity-only session) — that function
 * treats a missing workspaceId as "flag off" (there is no workspace to
 * scope `run_outcomes` stats to anyway), falling back to
 * `MODEL_CATALOG[taskType]` exactly as before #1338. This function is now
 * async purely because of that one awaited call — `composeChatBornBrief`
 * itself remains synchronous.
 */
async function enrichCreateIssueToolInput(
  toolInput: Record<string, unknown>,
  workspaceId: string | null | undefined
): Promise<Record<string, unknown>> {
  const { _brief: _ignoredCallerSuppliedBrief, ...rest } = toolInput;

  try {
    const title = typeof rest["title"] === "string" ? rest["title"] : "";
    const whatToBuild =
      typeof rest["whatToBuild"] === "string" ? rest["whatToBuild"] : "";
    const rawCriteria = rest["acceptanceCriteria"];
    const acceptanceCriteria = Array.isArray(rawCriteria)
      ? rawCriteria.filter((c): c is string => typeof c === "string")
      : [];

    const modelSelection = await resolveModelSelectionForBrief(
      { title, whatToBuild, acceptanceCriteria },
      workspaceId
    );
    const brief = composeChatBornBrief({
      title,
      whatToBuild,
      acceptanceCriteria,
      ...(modelSelection ? { modelSelection } : {}),
    });
    return { ...rest, _brief: brief };
  } catch (err) {
    console.error(
      "[runner/approvals] composeChatBornBrief failed; recording this create_issue approval WITHOUT an alignment brief (falls back to the pre-#1274-PR② render + a later redundant alignment confirm):",
      err
    );
    return rest;
  }
}

interface RawBody {
  eveSessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  idempotencyKey: string;
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
    !Array.isArray(body["toolInput"]) &&
    typeof body["idempotencyKey"] === "string" &&
    body["idempotencyKey"].length > 0
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
  const authError = requireJaceConsoleSecret(request);
  if (authError) {
    return authError;
  }

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
          "Body must have eveSessionId (string), toolName (string), toolInput (object), and idempotencyKey (string)",
      },
      { status: 400 }
    );
  }

  const session = await getJaceSessionByEveSessionId(body.eveSessionId);
  const hasNoAnchor =
    !session || (session.workspaceId == null && session.chatIdentityId == null);
  if (hasNoAnchor) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  // #1274 PR②: enrich create_issue's toolInput into the alignment brief
  // BEFORE recording — see enrichCreateIssueToolInput's own doc-comment.
  // Every other tool's toolInput passes through completely unchanged.
  // session.workspaceId (#1338 PR②) may be null for an intro/chat-identity
  // -only session — enrichCreateIssueToolInput/resolveModelSelectionForBrief
  // both treat that as "no workspace to scope model-selection learning to."
  const toolInput =
    body.toolName === "create_issue"
      ? await enrichCreateIssueToolInput(body.toolInput, session.workspaceId ?? undefined)
      : body.toolInput;

  const { approval, created } = await recordApprovalRequest({
    workspaceId: session.workspaceId ?? undefined,
    chatIdentityId: session.chatIdentityId ?? undefined,
    sessionId: session.id,
    eveSessionId: body.eveSessionId,
    requestId: body.idempotencyKey,
    toolName: body.toolName,
    toolInput,
    approveOptionId: "approve",
    denyOptionId: "deny",
  });

  if (created) {
    await sendApprovalMessage(
      session,
      approval.callbackToken,
      body.toolName,
      toolInput
    );
  }

  return NextResponse.json(
    { approvalId: approval.id, status: approval.status },
    { status: created ? 201 : 200 }
  );
}
