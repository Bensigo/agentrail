import { NextRequest, NextResponse } from "next/server";
import { resolveInboundChatIdentity, enqueueChannelMessage } from "@agentrail/db-postgres";
import { dispatchQueuedChannelMessages } from "../../../../../../lib/channel-dispatch";
import {
  verifyDiscordSignature,
  DISCORD_INTERACTION_RESPONSE,
  DISCORD_INTERACTION_TYPE,
} from "../../../../../../lib/discord-bot";

/**
 * Shared Discord webhook — the Discord half of the hosted Jace door (#1284,
 * same shared-bot model Telegram got in #1262 + chat_identities resolution
 * from #1261). ONE hosted bot/application multiplexes every workspace, so
 * this route never looks up a workspace-scoped secret: it verifies the ONE
 * shared app's Ed25519 public key, then branches on interaction type.
 *
 * WHY THIS IS AN INTERACTIONS ENDPOINT, NOT A "message webhook": Discord has
 * no HTTP delivery for plain DM/channel text — only for INTERACTIONS (slash
 * commands, message components), verified via `X-Signature-Ed25519` /
 * `X-Signature-Timestamp` over the raw body (see discord-bot.ts's
 * doc-comment and Discord's own "Interactions overview" docs). A stranger
 * "DMs the bot" (AC1) by invoking the bot's registered `/jace` slash command
 * in a DM with it — Discord explicitly supports bot-DM-context commands —
 * which arrives here as a normal APPLICATION_COMMAND interaction. This keeps
 * the console's inbound door stateless/serverless like every other channel's
 * webhook; no Gateway websocket is opened here (Eve's own self-host discord
 * channel, apps/jace/agent/channels/discord.ts, is the same interactions-only
 * model — see that file's header comment).
 *
 * `PING` (type 1): required handshake Discord sends when the Interactions
 * Endpoint URL is first configured — must ack with `{ type: 1 }` (PONG) or
 * the URL fails validation.
 *
 * `APPLICATION_COMMAND` (type 2): ensures the sender's chat identity (issue
 * #1261), enqueues into `channel_inbox` (PR ①), kicks the dispatcher
 * (`lib/channel-dispatch.ts`) fire-and-forget, and immediately ACKs with a
 * visible `CHANNEL_MESSAGE_WITH_SOURCE` placeholder — Discord requires SOME
 * response within 3 seconds. This route never awaits the Eve turn.
 *
 * PROD BUG FIX (root-caused 2026-07-25, see
 * .superpowers/sdd/discord-followup/): Jace's real reply used to ALWAYS land
 * as a SEPARATE message posted via the bot token through Jace's native
 * discord channel (`args.receive`'s `{ channelId }` target, see
 * hosted-inbound.ts) once the Eve turn completed — which needs the shared
 * bot to have View Channel + Send Messages on that specific channel. A
 * private channel that hasn't granted the bot's role that permission (or a
 * user-install where the bot isn't in the guild at all) rejected the post
 * with `50001 Missing Access`, silently — the user's own slash-command
 * invocation still "worked" because invocation is authorized by the USER's
 * permissions, not the bot's, so the reply just vanished. This route now
 * also captures the interaction's OWN `token`/`application_id` (every
 * Discord interaction carries both — see `DiscordInteraction` below) into
 * the enqueued payload, so the dispatcher can carry them into the session
 * Jace's discord channel reads, and reply through Discord's interaction
 * FOLLOWUP webhook instead — no channel permission needed, no auth header
 * (the token IS the credential), valid for 15 minutes. When no token is
 * available (or the followup fails), Jace falls back to the original
 * bot-post path unchanged. SECRET: the token is a short-lived credential —
 * it is enqueued into `channel_inbox.payload` (jsonb) and forwarded to
 * Jace's dispatch POST, but never logged and never present in this route's
 * own HTTP response.
 *
 * Any other interaction type (e.g. `MESSAGE_COMPONENT` — button taps; no
 * approvals flow exists on this door yet, unlike Telegram's `ar:` callback
 * seam) gets a minimal ephemeral ack so Discord never shows "This
 * interaction failed" — never a crash, never left unanswered.
 *
 * FAIL CLOSED: a missing `DISCORD_PUBLIC_KEY` means every request is
 * rejected (401) — this bot is reachable by any stranger on the internet, so
 * "key unset" must never mean "open". Mirrors the Telegram webhook's own
 * FAIL CLOSED posture (`connectors/telegram/webhook/route.ts`).
 */

const SIGNATURE_HEADER = "x-signature-ed25519";
const TIMESTAMP_HEADER = "x-signature-timestamp";

function verifyRequest(
  rawBody: string,
  signature: string | null,
  timestamp: string | null
): boolean {
  const publicKeyHex = process.env["DISCORD_PUBLIC_KEY"];
  if (!publicKeyHex || !signature || !timestamp) return false;
  return verifyDiscordSignature({
    publicKeyHex,
    signatureHex: signature,
    timestamp,
    rawBody,
  });
}

interface DiscordUser {
  id: string;
  username?: string;
  global_name?: string;
}

interface DiscordCommandOption {
  name: string;
  value?: unknown;
}

interface DiscordInteraction {
  id: string;
  type: number;
  /**
   * Prod bug fix (private-channel replies vanish — root-caused 2026-07-25,
   * see .superpowers/sdd/discord-followup/): Discord sends `token` and
   * `application_id` on EVERY interaction (PING included), the credential
   * pair needed to reply through the interaction followup webhook instead
   * of a bot-API channel post that needs channel permissions the shared
   * hosted bot may not have. Required here (not optional) so both are read
   * type-safely below, never via a cast.
   */
  token: string;
  application_id: string;
  channel_id?: string;
  data?: { name?: string; options?: DiscordCommandOption[] };
  member?: { user?: DiscordUser };
  user?: DiscordUser;
}

function isDiscordInteraction(value: unknown): value is DiscordInteraction {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["id"] === "string" &&
    typeof v["type"] === "number" &&
    typeof v["token"] === "string" &&
    typeof v["application_id"] === "string"
  );
}

/** Guild interactions carry the invoking user under `member.user`; DM (and group-DM) interactions carry it directly under `user`. Checking both, in this order, covers every context without depending on the newer/optional `context` field. */
function discordUserFor(interaction: DiscordInteraction): DiscordUser | null {
  return interaction.member?.user ?? interaction.user ?? null;
}

function displayNameFor(user: DiscordUser): string {
  return user.global_name ?? user.username ?? user.id;
}

/** The command's first string option value — v1's `/jace` command takes exactly one `message` option. */
function textFromOptions(options: DiscordCommandOption[] | undefined): string | undefined {
  const value = options?.[0]?.value;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status });
}

export async function POST(request: NextRequest) {
  const raw = await request.text();

  // Verify BEFORE parsing — mirrors the Telegram webhook's fail-closed order.
  if (
    !verifyRequest(
      raw,
      request.headers.get(SIGNATURE_HEADER),
      request.headers.get(TIMESTAMP_HEADER)
    )
  ) {
    return json({ error: "invalid request signature" }, 401);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  if (!isDiscordInteraction(body)) {
    return json({ error: "invalid interaction shape" }, 400);
  }

  if (body.type === DISCORD_INTERACTION_TYPE.PING) {
    return json({ type: DISCORD_INTERACTION_RESPONSE.PONG });
  }

  if (body.type !== DISCORD_INTERACTION_TYPE.APPLICATION_COMMAND) {
    // MESSAGE_COMPONENT (button taps) or any future type this door doesn't
    // process yet — no approvals flow on this door (unlike Telegram's `ar:`
    // seam). Ack minimally so Discord never shows "This interaction failed".
    return json({
      type: DISCORD_INTERACTION_RESPONSE.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "That's not supported here yet.", flags: 64 },
    });
  }

  const channelId = body.channel_id;
  const discordUser = discordUserFor(body);
  const text = textFromOptions(body.data?.options);

  if (!channelId || !discordUser || !text) {
    // A well-formed interaction (e.g. a different slash command, or one
    // invoked with no text) — ack politely rather than enqueue garbage.
    return json({
      type: DISCORD_INTERACTION_RESPONSE.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "Tell me what you'd like help with, e.g. `/jace message: fix the login bug`.", flags: 64 },
    });
  }

  const displayName = displayNameFor(discordUser);
  const { identity } = await resolveInboundChatIdentity({
    platform: "discord",
    platformUserId: discordUser.id,
    displayName,
  });

  // The anchor is EITHER workspaceId (identity already bound) OR
  // chatIdentityId (intro sender, no resolved workspace yet) — mirrors the
  // Telegram webhook's identical anchor convention.
  const anchor = identity.workspaceId
    ? { workspaceId: identity.workspaceId }
    : { chatIdentityId: identity.id };

  // The interaction's ack content is static regardless of dedup (unlike
  // Telegram's webhook, which reports `deduped` in its JSON body) — Discord
  // interactions are not provider-redelivered the way Telegram's Bot API
  // retries a slow-ACKed webhook, so there is no dedup-specific UX to show.
  await enqueueChannelMessage({
    ...anchor,
    channel: "discord",
    conversationKey: String(channelId),
    kind: "message",
    senderId: discordUser.id,
    senderDisplay: displayName,
    // Discord interaction ids are globally unique, but namespacing by
    // channel keeps the shape consistent with every other channel's
    // (channel, provider_message_id) unique — never actually collides.
    providerMessageId: `${channelId}:${body.id}`,
    payload: {
      // Reuses the SAME field name channel-dispatch.ts's (Telegram-authored)
      // extractPayload already reads — see channel-dispatch.ts's doc-comment
      // on why this door deliberately does not fork that function.
      chatId: channelId,
      text,
      fromId: discordUser.id,
      fromUsername: discordUser.username ?? null,
      // Prod bug fix (private-channel replies vanish — see
      // .superpowers/sdd/discord-followup/): captured here so
      // channel-dispatch.ts can carry it into the session's auth attributes,
      // which Jace's discord channel reads to reply through the interaction
      // followup webhook instead of a bot-API channel post. SECRET: this
      // travels only inbound body -> channel_inbox.payload (jsonb) -> the
      // dispatch POST to Jace — never logged, never echoed in this route's
      // own response (see the response-building code below, which never
      // reads `body.token`/`body.application_id`).
      interactionToken: body.token,
      applicationId: body.application_id,
    },
  });

  // Fire-and-forget kick (mirrors the Telegram webhook's identical pattern):
  // never awaited, never allowed to affect this route's response.
  void dispatchQueuedChannelMessages().catch((err) => {
    console.error("[discord/webhook] dispatch kick failed:", err);
  });

  return json({
    type: DISCORD_INTERACTION_RESPONSE.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: "On it — thinking..." },
  });
}
