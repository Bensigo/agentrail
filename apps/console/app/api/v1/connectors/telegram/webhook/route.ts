import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  resolveInboundChatIdentity,
  enqueueChannelMessage,
} from "@agentrail/db-postgres";
import { dispatchQueuedChannelMessages } from "../../../../../../lib/channel-dispatch";

/**
 * Shared Telegram webhook — the ingestion half of the hosted Jace door
 * (issue #1262, spec §4.1). ONE hosted bot multiplexes every workspace, so
 * unlike a per-workspace connector this route never looks up a
 * workspace-scoped secret: it verifies the ONE shared-bot secret, ensures the
 * sender's chat identity (issue #1261), and enqueues into `channel_inbox`
 * (PR ①) — then (PR ②) fires a fire-and-forget kick at the dispatcher
 * (`lib/channel-dispatch.ts`) before returning 200. The route itself still
 * does no Eve call and no reply inline; the kick only asks the dispatcher to
 * drain, and never affects this route's response (`.catch`-swallowed — a
 * drain failure is not this request's failure).
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
    // A real Telegram update kind this door doesn't process — callback_query
    // rides the Eve-native approvals path today; my_chat_member, channel_post,
    // etc. are simply not conversational turns.
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
