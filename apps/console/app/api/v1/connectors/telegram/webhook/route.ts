import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  resolveInboundChatIdentity,
  enqueueChannelMessage,
  getApprovalByCallbackToken,
  getChatIdentityById,
  resolveApproval,
} from "@agentrail/db-postgres";
import { dispatchQueuedChannelMessages } from "../../../../../../lib/channel-dispatch";
import { renderApprovalMessage } from "../../../../../../lib/approval-message";
import {
  answerCallbackQuery,
  editMessageText,
  parseApprovalCallbackData,
  APPROVAL_CALLBACK_PREFIX,
} from "../../../workspaces/[workspaceId]/connectors/secret/telegram";

/**
 * Shared Telegram webhook — the ingestion half of the hosted Jace door
 * (issue #1262, spec §4.1) AND (issue #1273) the console-gated approval
 * seam's callback handler. ONE hosted bot multiplexes every workspace, so
 * unlike a per-workspace connector this route never looks up a
 * workspace-scoped secret: it verifies the ONE shared-bot secret, then
 * branches on update kind.
 *
 * `message`/`edited_message`: ensures the sender's chat identity (issue
 * #1261), and enqueues into `channel_inbox` (PR ①) — then (PR ②) fires a
 * fire-and-forget kick at the dispatcher (`lib/channel-dispatch.ts`) before
 * returning 200. The route itself still does no Eve call and no reply
 * inline; the kick only asks the dispatcher to drain, and never affects this
 * route's response (`.catch`-swallowed — a drain failure is not this
 * request's failure). Byte-unchanged by #1273.
 *
 * `callback_query` (issue #1273 — previously silently ignored, see
 * `deploy/telegram-shared-bot-cutover.md`'s former "Before you cut over"
 * gate, now closed by this handling): `data` starting with `ar:` is THIS
 * seam's own button (`handleApprovalCallback` below) — looked up by its
 * opaque callback token, sender-checked against the approval's own chat
 * identity, atomically flipped, and answered/edited in place. ANY other
 * callback_query (including Eve's own `eve:`-prefixed native HITL buttons)
 * is forwarded VERBATIM to the Jace sidecar's real `/eve/v1/telegram`
 * channel — this is the cutover bridge: Eve-native approval buttons keep
 * working on the console's webhook exactly as they did on the sidecar's own,
 * so a workspace can cut over to the shared bot without losing them.
 *
 * FAIL CLOSED: unlike the github webhook route (`../github/webhook/route.ts`,
 * flagged as a defect for skipping verification when its secret env is
 * unset), a missing TELEGRAM_WEBHOOK_SECRET_TOKEN here means every request is
 * rejected — this bot is reachable by any stranger on the internet (the
 * landing page deep-links it), so "secret unset" must never mean "open".
 * Mirrors Eve's own native /eve/v1/telegram verify idiom (the self-host path,
 * apps/jace/agent/channels/telegram.ts) so both doors share one bar.
 */

const SECRET_HEADER = "x-telegram-bot-api-secret-token";

function verifySecret(headerValue: string | null): boolean {
  const secret = process.env["TELEGRAM_WEBHOOK_SECRET_TOKEN"];
  if (!secret || !headerValue) return false;
  const expected = Buffer.from(secret);
  const actual = Buffer.from(headerValue);
  return (
    expected.length === actual.length && timingSafeEqual(expected, actual)
  );
}

interface TelegramFrom {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TelegramChat {
  id: number;
  type: string;
}

interface TelegramMessage {
  message_id: number;
  from: TelegramFrom;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
}

function isTelegramMessage(value: unknown): value is TelegramMessage {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  const chat = m["chat"];
  const from = m["from"];
  return (
    typeof m["message_id"] === "number" &&
    !!chat &&
    typeof chat === "object" &&
    typeof (chat as Record<string, unknown>)["id"] !== "undefined" &&
    !!from &&
    typeof from === "object" &&
    typeof (from as Record<string, unknown>)["id"] !== "undefined"
  );
}

// Display name convention (annex-1262-recon.md): username, else
// "first_name last_name" trimmed — Array#join treats a missing last_name as
// "" rather than the string "undefined".
function displayNameFor(from: TelegramFrom): string {
  return from.username ?? [from.first_name, from.last_name].join(" ").trim();
}

// --- callback_query (issue #1273) -------------------------------------------

interface TelegramCallbackQuery {
  id: string;
  from: TelegramFrom;
  data?: string;
  message?: { chat: { id: number }; message_id: number };
}

function isTelegramCallbackQuery(
  value: unknown
): value is TelegramCallbackQuery {
  if (!value || typeof value !== "object") return false;
  const cq = value as Record<string, unknown>;
  const from = cq["from"];
  return (
    typeof cq["id"] === "string" &&
    !!from &&
    typeof from === "object" &&
    typeof (from as Record<string, unknown>)["id"] !== "undefined"
  );
}

/** The live tapper's display name for the "Approved/Denied by <name>" edit — straight off the callback_query, never the (possibly stale) stored chat_identities.display_name. */
function callbackFromName(from: TelegramFrom): string {
  return from.first_name ?? from.username ?? String(from.id);
}

const EVE_HOST = process.env["EVE_HOST"] || "http://127.0.0.1:2000";

/**
 * The real Eve native Telegram channel (`apps/jace/agent/channels/telegram.ts`
 * -> `/eve/v1/telegram`, self-host verify idiom this route's own doc-comment
 * references). Overridable for tests / non-default topologies, mirroring
 * `channel-dispatch.ts`'s `HOSTED_INBOUND_URL` convention.
 */
const EVE_TELEGRAM_URL =
  process.env["JACE_TELEGRAM_URL"] || `${EVE_HOST}/eve/v1/telegram`;

// Mirrors channel-dispatch.ts's own fetchWithTimeout: bound the forward so an
// unreachable/hanging sidecar can never wedge this request past Telegram's
// own patience for a webhook response.
const FORWARD_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(
  url: string,
  init: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Forward a callback_query update this door doesn't own (anything NOT
 * `ar:`-prefixed — Eve's own `eve:`-prefixed native HITL buttons, or any
 * other kind) to the sidecar's real `/eve/v1/telegram` channel, VERBATIM
 * (the original raw body, the same secret-token header Telegram sent us —
 * already verified by the time this is called). Mirrors the sidecar's
 * response status/content-type back to Telegram.
 *
 * Unreachable sidecar -> 200 `{ ok: true, forwarded: false }`, deliberately
 * NOT mirroring a non-2xx/502 the way the generic
 * `connectors/jace/inbound/[workspaceId]/route.ts` forwarder does: THAT route
 * isn't fielding Telegram's own webhook contract, but this one is — Telegram
 * retry-storms a webhook URL that keeps returning non-2xx, and every retry
 * would just hit the same unreachable sidecar again. Acking 200 here accepts
 * "this specific update's Eve-native reply silently doesn't happen" as the
 * degraded outcome, rather than compounding an outage with a retry storm.
 */
async function forwardCallbackQueryToEve(
  raw: string,
  secretHeaderValue: string | null
): Promise<NextResponse> {
  try {
    const upstream = await fetchWithTimeout(EVE_TELEGRAM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [SECRET_HEADER]: secretHeaderValue ?? "",
      },
      body: raw,
    });
    const payload = await upstream.text();
    return new NextResponse(payload, {
      status: upstream.status,
      headers: {
        "Content-Type":
          upstream.headers.get("content-type") ?? "application/json",
      },
    });
  } catch {
    return NextResponse.json({ ok: true, forwarded: false });
  }
}

/**
 * Handle an `ar:`-prefixed callback_query — this seam's own Approve/Deny
 * button (issue #1273). Every branch answers the callback_query (Telegram
 * requires SOME response or the tapper's client shows a permanent loading
 * spinner) and returns 200; none of them ever throw past this function.
 */
async function handleApprovalCallback(
  cq: TelegramCallbackQuery,
  token: string
): Promise<NextResponse> {
  const parsed = parseApprovalCallbackData(cq.data ?? "");
  if (!parsed) {
    await answerCallbackQuery(token, cq.id, "This approval link looks invalid.");
    return NextResponse.json({ ok: true });
  }

  const approval = await getApprovalByCallbackToken(parsed.callbackToken);
  if (!approval) {
    await answerCallbackQuery(token, cq.id, "This approval could not be found.");
    return NextResponse.json({ ok: true });
  }

  // SENDER CHECK (v1 rule, annex-1273-recon.md CONTROLLER DESIGN point 6): the
  // tap must come from the conversation's own chat identity. Never broadened
  // to "any workspace member" in this PR — a future PR may loosen this once a
  // session graduates to a workspace.
  const identity = approval.chatIdentityId
    ? await getChatIdentityById(approval.chatIdentityId)
    : null;
  const senderOk = !!identity && identity.platformUserId === String(cq.from.id);
  if (!senderOk) {
    await answerCallbackQuery(token, cq.id, "This isn't yours to approve.");
    return NextResponse.json({ ok: true });
  }

  const flipped = await resolveApproval(approval.id, parsed.decision);
  if (!flipped) {
    // Duplicate tap (a redelivered callback_query, or two taps racing each
    // other): resolveApproval's atomic pending->resolved guard already
    // matched zero rows, so this is a no-op — the FIRST resolution already
    // answered and edited the message; do not do either again.
    await answerCallbackQuery(token, cq.id, "Already resolved.");
    return NextResponse.json({ ok: true });
  }

  const label = parsed.decision === "approved" ? "✅ Approved" : "❌ Denied";
  const who = callbackFromName(cq.from);
  await answerCallbackQuery(token, cq.id, label);

  if (cq.message) {
    // Re-render from the SAME (toolName, toolInput) the original send used —
    // renderApprovalMessage is pure, so this reproduces byte-identical text
    // without needing to have stored the composed message anywhere. v1 keeps
    // no message_id storage at all (annex-1273-recon.md CONTROLLER DESIGN
    // point 4): editing uses callback_query.message.{chat.id, message_id}
    // straight off THIS update.
    const originalText = renderApprovalMessage(
      approval.toolName,
      approval.toolInput
    );
    await editMessageText(
      token,
      cq.message.chat.id,
      cq.message.message_id,
      `${originalText}\n\n${label} by ${who}`
    );
  }

  return NextResponse.json({ ok: true });
}

/**
 * Route a callback_query to this seam's own `ar:` handler or forward it —
 * the branch point issue #1273 adds in place of the former blanket
 * silent-ignore.
 */
async function handleCallbackQuery(
  cq: TelegramCallbackQuery,
  raw: string,
  secretHeaderValue: string | null
): Promise<NextResponse> {
  const data = cq.data ?? "";
  if (!data.startsWith(APPROVAL_CALLBACK_PREFIX)) {
    return forwardCallbackQueryToEve(raw, secretHeaderValue);
  }

  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) {
    console.error(
      "[telegram/webhook] callback_query is 'ar:'-prefixed but TELEGRAM_BOT_TOKEN is unset; cannot answer/edit"
    );
    return NextResponse.json({ ok: true });
  }
  return handleApprovalCallback(cq, token);
}

export async function POST(request: NextRequest) {
  // Verify BEFORE the body is even read off the request stream.
  if (!verifySecret(request.headers.get(SECRET_HEADER))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const raw = await request.text();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json(
      { error: "invalid update shape" },
      { status: 400 }
    );
  }

  const update = body as Record<string, unknown>;

  // callback_query (issue #1273): handled BEFORE the message-shape check
  // below — a real Telegram callback_query update carries no top-level
  // `message`/`edited_message` key at all (only nested inside
  // `callback_query.message`), so it always fell into the final
  // `{ok:true, ignored:true}` branch until this PR.
  if (isTelegramCallbackQuery(update["callback_query"])) {
    return handleCallbackQuery(
      update["callback_query"],
      raw,
      request.headers.get(SECRET_HEADER)
    );
  }

  const carriesMessageKey =
    update["message"] !== undefined || update["edited_message"] !== undefined;
  const message = update["message"] ?? update["edited_message"];

  if (!isTelegramMessage(message)) {
    if (carriesMessageKey) {
      // Claims to be a message/edited_message but fails the minimal shape
      // check (missing chat/from/message_id) — reject rather than risk a
      // crash further down or a garbage enqueue.
      return NextResponse.json(
        { error: "invalid message shape" },
        { status: 400 }
      );
    }
    // A real Telegram update kind this door doesn't process (my_chat_member,
    // channel_post, etc. — not conversational turns and not callback_query,
    // handled above).
    return NextResponse.json({ ok: true, ignored: true });
  }

  const text = message.text ?? message.caption;
  if (text === undefined) {
    // A well-formed message/edited_message that carries neither (e.g. a bare
    // photo, sticker, location) — not "carrying text ?? caption", so ignored.
    return NextResponse.json({ ok: true, ignored: true });
  }

  const displayName = displayNameFor(message.from);
  const { identity } = await resolveInboundChatIdentity({
    platform: "telegram",
    platformUserId: String(message.from.id),
    displayName,
  });

  // The anchor is EITHER workspaceId (identity already bound) OR
  // chatIdentityId (intro sender, no resolved workspace yet) — never both.
  const anchor = identity.workspaceId
    ? { workspaceId: identity.workspaceId }
    : { chatIdentityId: identity.id };

  const result = await enqueueChannelMessage({
    ...anchor,
    channel: "telegram",
    conversationKey: String(message.chat.id),
    kind: "message",
    senderId: String(message.from.id),
    senderDisplay: displayName,
    // Telegram message ids are PER-CHAT — bare message_id would collide
    // across chats under the (channel, provider_message_id) unique.
    providerMessageId: `${message.chat.id}:${message.message_id}`,
    payload: {
      chatId: message.chat.id,
      chatType: message.chat.type,
      fromId: message.from.id,
      fromUsername: message.from.username ?? null,
      text,
      messageId: message.message_id,
      date: message.date,
    },
  });

  // Fire-and-forget kick (issue #1262 PR ②): ask the dispatcher to drain
  // channel_inbox. Never awaited, never allowed to affect this route's
  // response — a drain failure is the dispatcher's problem, not this
  // webhook delivery's; Telegram only cares that we ACKed the update.
  // A real worker process replaces this kick in Wave 2 (see
  // lib/channel-dispatch.ts's header comment).
  void dispatchQueuedChannelMessages().catch((err) => {
    console.error("[telegram/webhook] dispatch kick failed:", err);
  });

  if (result.deduped) {
    return NextResponse.json({ ok: true, deduped: true });
  }
  return NextResponse.json({ ok: true });
}
