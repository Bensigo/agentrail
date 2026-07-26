import { resolveInboundChatIdentity, enqueueChannelMessage } from "@agentrail/db-postgres";
import { dispatchQueuedChannelMessages } from "./channel-dispatch";

/**
 * The ONE Discord inbound pipeline (issue — discord Gateway listener,
 * docs/superpowers/specs/2026-07-26-discord-gateway-listener-design.md):
 * resolve the sender's chat identity, enqueue into `channel_inbox`, kick the
 * dispatcher. Extracted out of the interactions webhook route
 * (`app/api/v1/connectors/discord/webhook/route.ts`) so a SECOND Discord
 * door — the Gateway listener's `runner/discord-inbound` route, for plain
 * @mention/DM messages the interactions webhook never sees — can reuse it
 * verbatim rather than re-implementing the same three calls. Two HTTP
 * entrypoints are unavoidable (Discord signs interaction requests with its
 * own Ed25519 key; the Gateway listener runs inside the jace service and
 * authenticates with the shared `JACE_CONSOLE_TOKEN` instead — fundamentally
 * different callers, so they cannot share one route), but there is only ONE
 * pipeline behind them, here.
 *
 * `providerMessageId` is the (channel, provider_message_id) dedupe key
 * `enqueueChannelMessage` uniques on: `${channelId}:${interactionId}` for a
 * slash command, `${channelId}:${messageId}` for a Gateway MESSAGE_CREATE —
 * each caller builds its own, since the id namespace differs per source.
 */
export interface DiscordInboundMessage {
  channelId: string;
  providerMessageId: string;
  senderId: string;
  senderDisplay: string;
  senderUsername: string | null;
  text: string;
  /**
   * The originating interaction's own short-lived credential, present ONLY for
   * the slash-command door — a plain @mention arriving over the Gateway has no
   * interaction to follow up on, so the Gateway caller passes neither. When
   * both are present they are carried into `channel_inbox.payload` so
   * `channel-dispatch.ts` can hand them to Jace, which replies through
   * Discord's interaction followup webhook instead of a permission-bound
   * bot-API channel post (the 2026-07-25 private-channel bug — see
   * `.superpowers/sdd/discord-followup/`).
   *
   * SECRET: never logged, never returned in any HTTP response. Both-or-neither
   * — a half-formed pair is treated as no credential at all, and the keys are
   * omitted from the stored jsonb rather than written as `undefined`.
   */
  interactionToken?: string;
  applicationId?: string;
}

export interface DiscordInboundResult {
  deduped: boolean;
}

export async function admitDiscordChannelMessage(
  message: DiscordInboundMessage
): Promise<DiscordInboundResult> {
  const { identity } = await resolveInboundChatIdentity({
    platform: "discord",
    platformUserId: message.senderId,
    displayName: message.senderDisplay,
  });

  // The anchor is EITHER workspaceId (identity already bound) OR
  // chatIdentityId (intro sender, no resolved workspace yet) — mirrors the
  // interactions webhook's identical anchor convention.
  const anchor = identity.workspaceId
    ? { workspaceId: identity.workspaceId }
    : { chatIdentityId: identity.id };

  const enqueued = await enqueueChannelMessage({
    ...anchor,
    channel: "discord",
    conversationKey: message.channelId,
    kind: "message",
    senderId: message.senderId,
    senderDisplay: message.senderDisplay,
    providerMessageId: message.providerMessageId,
    payload: {
      // Reuses the SAME field name channel-dispatch.ts's (Telegram-authored)
      // extractPayload already reads — see channel-dispatch.ts's doc-comment
      // on why callers into this door deliberately do not fork that function.
      chatId: message.channelId,
      text: message.text,
      fromId: message.senderId,
      fromUsername: message.senderUsername,
      // Both-or-neither (see DiscordInboundMessage.interactionToken): omit the
      // keys entirely rather than storing a half-formed credential.
      ...(message.interactionToken !== undefined &&
      message.applicationId !== undefined
        ? {
            interactionToken: message.interactionToken,
            applicationId: message.applicationId,
          }
        : {}),
    },
  });

  // Fire-and-forget kick — mirrors every other channel's identical pattern.
  // Never awaited, never allowed to affect the caller's own response.
  void dispatchQueuedChannelMessages().catch((err) => {
    console.error("[discord-inbound] dispatch kick failed:", err);
  });

  return { deduped: enqueued.deduped };
}
