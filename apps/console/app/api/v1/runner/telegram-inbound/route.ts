import { NextRequest, NextResponse } from "next/server";
import { resolveInboundChatIdentity, enqueueChannelMessage } from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../lib/jace-console-auth";
import { dispatchQueuedChannelMessages } from "../../../../../lib/channel-dispatch";

// Telegram's own documented text-message cap (sendMessage/message.text) is
// 4096 chars, NOT Discord's 2000 — unlike `runner/discord-inbound`'s
// `MAX_TEXT_LENGTH = 4000` (a cap already above Discord's own limit and thus
// unreachable there), 4000 here is BELOW Telegram's real cap and would 400 +
// silently drop any legal 4001-4096 char message (final-branch review
// Finding 3; see Finding 2's in-channel notice for what "silently" used to
// mean before this route existed).
const MAX_TEXT_LENGTH = 4096;

/**
 * POST /api/v1/runner/telegram-inbound
 *   { chatId, messageId, senderId, senderDisplay, senderUsername, text }
 *
 * The console-side counterpart to `runner/discord-inbound` (see that route's
 * own header comment for the full "transport shim, not resolver" background)
 * — but for Telegram. Jace mounts a native Telegram channel
 * (`apps/jace/agent/channels/telegram.ts` -> `/eve/v1/telegram`) that used to
 * turn a raw webhook Update straight into an Eve turn, bypassing the
 * console's workspace resolution entirely — every workspace-scoped tool
 * 404'd, because the conversation was never registered in the session
 * ledger. `apps/jace/agent/lib/telegram_forward.core.mjs` (the fix) shapes an
 * admitted Update into a normalized body and POSTs it here instead; this
 * route is that intake.
 *
 * Unlike Discord — which factors its identity-resolve/enqueue/dispatch-kick
 * sequence into a shared `lib/discord-inbound.ts` because TWO doors
 * (the interactions webhook and this Gateway-listener route) call it
 * identically — Telegram's own connectors webhook
 * (`app/api/v1/connectors/telegram/webhook/route.ts`) has never had that
 * extracted: it calls `resolveInboundChatIdentity` / `enqueueChannelMessage`
 * / `dispatchQueuedChannelMessages` inline. This route mirrors THAT call
 * shape directly (see its "identity, anchor, enqueue" block below, deliberately
 * byte-similar to the webhook route's own) rather than inventing a new shared
 * lib purely for a second Telegram caller.
 *
 * (channel, senderId) invariant (channel-dispatch.ts's own doc-comment):
 * `channel_inbox`'s `(channel, senderId)` MUST equal the `(platform,
 * platformUserId)` a `chat_identities` row was created under, or
 * `getChatIdentity(row.channel, row.senderId)` finds nothing at dispatch time
 * and the row dead-letters silently. This route satisfies it the SAME way the
 * connectors webhook does: the identical raw `senderId` string (Telegram's
 * numeric `from.id`, already stringified by the shim before it ever reaches
 * this route) feeds BOTH `resolveInboundChatIdentity`'s `platformUserId` and
 * `enqueueChannelMessage`'s `senderId` — never re-derived, never a second
 * source of truth for "who sent this."
 *
 * The caller (Jace's Telegram shim) already ran admission — this route does
 * not re-derive "is this a real conversational turn"; it trusts the
 * pre-shaped body from an authenticated internal caller, exactly like
 * `runner/discord-inbound` trusts its own.
 *
 * No `messageThreadId` field: the shim
 * (`telegram_forward.core.mjs#shapeTelegramInbound`) never shapes one, and
 * `runner/discord-inbound`'s own sibling body has no thread-equivalent field
 * either — there is nothing to carry through today. A future PR can add it
 * to both the shim and this route's body together if forum-topic threading
 * needs to survive this door.
 *
 * 400 — malformed body. 401 — bad/missing secret. 502 — the backing store
 * (identity resolution or enqueue) errored. 200 — `{ ok: true, deduped }`.
 */
export async function POST(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) {
    return authError;
  }

  const body = (await request.json().catch(() => null)) as
    | {
        chatId?: unknown;
        messageId?: unknown;
        senderId?: unknown;
        senderDisplay?: unknown;
        senderUsername?: unknown;
        text?: unknown;
      }
    | null;

  const chatId = typeof body?.chatId === "string" ? body.chatId.trim() : "";
  const messageId = typeof body?.messageId === "string" ? body.messageId.trim() : "";
  const senderId = typeof body?.senderId === "string" ? body.senderId.trim() : "";
  const senderDisplay =
    typeof body?.senderDisplay === "string" && body.senderDisplay.trim()
      ? body.senderDisplay.trim()
      : senderId;
  const senderUsername = typeof body?.senderUsername === "string" ? body.senderUsername : null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";

  if (!chatId) {
    return NextResponse.json({ error: "chatId is required" }, { status: 400 });
  }
  if (!messageId) {
    return NextResponse.json({ error: "messageId is required" }, { status: 400 });
  }
  if (!senderId) {
    return NextResponse.json({ error: "senderId is required" }, { status: 400 });
  }
  if (!text) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return NextResponse.json(
      { error: `text exceeds ${MAX_TEXT_LENGTH} characters` },
      { status: 400 }
    );
  }

  try {
    // Identity, anchor, enqueue — mirrors connectors/telegram/webhook/route.ts's
    // own inline sequence (see this file's header comment on why this stays
    // inline rather than factoring into a shared lib).
    const { identity } = await resolveInboundChatIdentity({
      platform: "telegram",
      platformUserId: senderId,
      displayName: senderDisplay,
    });

    // The anchor is EITHER workspaceId (identity already bound) OR
    // chatIdentityId (intro sender, no resolved workspace yet) — never both,
    // same convention as both the webhook route and discord-inbound.ts.
    const anchor = identity.workspaceId
      ? { workspaceId: identity.workspaceId }
      : { chatIdentityId: identity.id };

    const result = await enqueueChannelMessage({
      ...anchor,
      channel: "telegram",
      conversationKey: chatId,
      kind: "message",
      senderId,
      senderDisplay,
      // Telegram message ids are PER-CHAT — bare messageId would collide
      // across chats under the (channel, provider_message_id) unique, same
      // reasoning as the webhook route's own `message.chat.id}:${message_id}`.
      providerMessageId: `${chatId}:${messageId}`,
      payload: {
        chatId,
        text,
        fromId: senderId,
        fromUsername: senderUsername,
      },
    });

    // Fire-and-forget kick — mirrors every other channel's identical pattern.
    // Never awaited, never allowed to affect the caller's own response.
    void dispatchQueuedChannelMessages().catch((err) => {
      console.error("[telegram-inbound] dispatch kick failed:", err);
    });

    return NextResponse.json({ ok: true, deduped: result.deduped }, { status: 200 });
  } catch (err) {
    console.error("[runner/telegram-inbound] failed:", err);
    return NextResponse.json({ error: "Upstream storage error" }, { status: 502 });
  }
}
