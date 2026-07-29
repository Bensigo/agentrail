import { NextRequest, NextResponse } from "next/server";
import { requireJaceConsoleSecret } from "../../../../../lib/jace-console-auth";
import { admitDiscordChannelMessage } from "../../../../../lib/discord-inbound";

const MAX_TEXT_LENGTH = 4000;

/**
 * POST /api/v1/runner/discord-inbound
 *   { channelId, messageId, senderId, senderDisplay, senderUsername, text,
 *     threadId, mentionsBot, mentionsOtherUsers, repliesToMessageId,
 *     repliesToBot }
 *
 * The Gateway listener's console-facing half (docs/superpowers/specs/
 * 2026-07-26-discord-gateway-listener-design.md). The jace service holds the
 * actual Discord Gateway WebSocket (apps/jace/agent/lib/discord-gateway.mjs)
 * and, on an admitted MESSAGE_CREATE (a mention, a DM, or any message inside
 * a known thread — never the bot's own messages, other bots, or empty
 * content; see apps/jace/agent/lib/discord_gateway.core.mjs's
 * `screenMessage`), POSTs here, along with the mention/thread/reply facts
 * the console's thread-engagement rule needs (spec: docs/superpowers/specs/
 * 2026-07-28-thread-native-jace-design.md) — `screenMessage` itself no
 * longer decides whether Jace answers a thread message, only whether the
 * message is transport-level noise. Jace has no direct Postgres access
 * (apps/jace is deliberately excluded from this repo's pnpm workspace), so
 * this route is how a Gateway-observed message becomes a `channel_inbox`
 * row — the SAME pipeline the interactions webhook
 * (`app/api/v1/connectors/discord/webhook/route.ts`) already uses for the
 * `/jace` slash command, via the shared `admitDiscordChannelMessage`
 * (`lib/discord-inbound.ts` — see that file's own header comment for the
 * engagement gate this route's fields feed). One pipeline, two doors — see
 * that route's own header comment for why two doors are unavoidable
 * (different auth models: Discord signs interactions with its own Ed25519
 * key; this door is server-to-server, authenticated with the shared
 * `JACE_CONSOLE_TOKEN` bearer via `requireJaceConsoleSecret` instead, the
 * same central-secret seam every other Jace-coordinator route uses).
 *
 * The caller (the Gateway listener) already ran admission — this route does
 * not re-derive "is this a mention" or re-check the sender is not a bot; it
 * trusts the pre-shaped body from an authenticated internal caller, exactly
 * like `runner/chat-reply` trusts its `workspaceId`/`conversationKey` body
 * fields from Jace's console channel.
 *
 * 400 — malformed body. 401 — bad/missing secret. 502 — the backing store
 * (identity resolution or enqueue) errored. 200 — `{ ok: true, deduped }`,
 * or `{ ok: true, skipped: true }` when the engagement gate dropped the
 * message (not an error — see `admitDiscordChannelMessage`'s header doc).
 */
export async function POST(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) {
    return authError;
  }

  const body = (await request.json().catch(() => null)) as
    | {
        channelId?: unknown;
        messageId?: unknown;
        senderId?: unknown;
        senderDisplay?: unknown;
        senderUsername?: unknown;
        text?: unknown;
        threadId?: unknown;
        mentionsBot?: unknown;
        mentionsOtherUsers?: unknown;
        repliesToMessageId?: unknown;
        repliesToBot?: unknown;
      }
    | null;

  const channelId = typeof body?.channelId === "string" ? body.channelId.trim() : "";
  const messageId = typeof body?.messageId === "string" ? body.messageId.trim() : "";
  const senderId = typeof body?.senderId === "string" ? body.senderId.trim() : "";
  const senderDisplay =
    typeof body?.senderDisplay === "string" && body.senderDisplay.trim()
      ? body.senderDisplay.trim()
      : senderId;
  const senderUsername = typeof body?.senderUsername === "string" ? body.senderUsername : null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  // The engagement envelope (spec: docs/superpowers/specs/2026-07-28-thread-
  // native-jace-design.md). Read defensively — an absent/malformed field
  // degrades to the SAFE default (not a thread, no mention, no reply),
  // never to a cast, since this route already trusts the caller for
  // admission but should never crash on a shape it does not recognize.
  const threadId = typeof body?.threadId === "string" ? body.threadId.trim() || null : null;
  const mentionsBot = body?.mentionsBot === true;
  const mentionsOtherUsers = body?.mentionsOtherUsers === true;
  const repliesToMessageId =
    typeof body?.repliesToMessageId === "string" ? body.repliesToMessageId.trim() || null : null;
  const repliesToBot = body?.repliesToBot === true;

  if (!channelId) {
    return NextResponse.json({ error: "channelId is required" }, { status: 400 });
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
    const result = await admitDiscordChannelMessage({
      channelId,
      providerMessageId: `${channelId}:${messageId}`,
      senderId,
      senderDisplay,
      senderUsername,
      text,
      threadId,
      mentionsBot,
      mentionsOtherUsers,
      repliesToMessageId,
      repliesToBot,
      // The real Gateway message id — see DiscordInboundMessage.messageId's
      // own doc-comment. Always present here: this route already 400s above
      // when `messageId` is missing/blank, unlike every other envelope field.
      messageId,
    });
    if (result.skipped) {
      // The engagement gate dropped this message before it ever became a
      // channel_inbox row — not an error, see admitDiscordChannelMessage's
      // header doc. No `deduped` key: dedupe never happened.
      return NextResponse.json({ ok: true, skipped: true }, { status: 200 });
    }
    return NextResponse.json({ ok: true, deduped: result.deduped }, { status: 200 });
  } catch (err) {
    console.error("[runner/discord-inbound] failed:", err);
    return NextResponse.json({ error: "Upstream storage error" }, { status: 502 });
  }
}
