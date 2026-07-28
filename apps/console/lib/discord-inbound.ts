import {
  resolveInboundChatIdentity,
  enqueueChannelMessage,
  getThreadEngagement,
} from "@agentrail/db-postgres";
import { dispatchQueuedChannelMessages } from "./channel-dispatch";
// Final whole-branch review, finding #3: `/connect` must reach the
// dispatcher's own command interception (channel-dispatch.ts's `processRow`)
// even from a dormant or never-engaged thread — reusing the SAME recognizer
// the dispatcher uses rather than hand-rolling a second, driftable definition
// of what `/connect` looks like. See `admitsPastEngagementGate` below.
import { parseConnectCommand } from "./connect-command";

/**
 * The ONE Discord inbound pipeline (issue — discord Gateway listener,
 * docs/superpowers/specs/2026-07-26-discord-gateway-listener-design.md):
 * gate cheaply on thread engagement, resolve the sender's chat identity,
 * enqueue into `channel_inbox`, kick the dispatcher. Extracted out of the
 * interactions webhook route (`app/api/v1/connectors/discord/webhook/route.ts`)
 * so a SECOND Discord door — the Gateway listener's `runner/discord-inbound`
 * route, for plain @mention/DM/thread messages the interactions webhook
 * never sees — can reuse it verbatim rather than re-implementing the same
 * calls. Two HTTP entrypoints are unavoidable (Discord signs interaction
 * requests with its own Ed25519 key; the Gateway listener runs inside the
 * jace service and authenticates with the shared `JACE_CONSOLE_TOKEN` bearer
 * instead — fundamentally different callers, so they cannot share one
 * route), but there is only ONE pipeline behind them, here.
 *
 * `providerMessageId` is the (channel, provider_message_id) dedupe key
 * `enqueueChannelMessage` uniques on: `${channelId}:${interactionId}` for a
 * slash command, `${channelId}:${messageId}` for a Gateway MESSAGE_CREATE —
 * each caller builds its own, since the id namespace differs per source.
 * NEVER re-keyed by thread — it is a redelivery dedupe key over a globally
 * unique event id, not a conversation key, and re-keying it would let one
 * event enqueue twice.
 *
 * THE DOOR GATE (spec: docs/superpowers/specs/2026-07-28-thread-native-jace-
 * design.md): this function is NOT the real engagement decision — that is
 * `channel-dispatch.ts`'s `decideEngagement` call, which runs on a CLAIMED
 * row and has the full pure state machine (`lib/thread-engagement.ts`)
 * available. This gate exists only to keep junk out of `channel_inbox`:
 *
 *   enqueue if mentionsBot OR outside a thread OR (a session row exists for
 *   this conversation AND its dormant latch is clear).
 *
 * "Outside a thread" (`threadId === null`) stands in for "is a DM" here,
 * deliberately: both doors that call this function only ever produce a
 * `threadId === null` payload for a message that was already admitted by
 * its own upstream check without a thread being involved — the interactions
 * webhook always sets `mentionsBot: true` (an explicit `/jace` invocation IS
 * addressing Jace), and the Gateway listener's `screenMessage`
 * (apps/jace/agent/lib/discord_gateway.core.mjs) only ever forwards a
 * non-thread message here when it is a DM or a mention — a plain unmentioned
 * guild message never reaches this route at all. So a `threadId === null`
 * message reaching this function is always safe to enqueue; the ONLY case
 * this gate has to actually filter is an un-mentioned message INSIDE a
 * thread, which is exactly the new engagement behavior this feature adds.
 * A dormant thread's un-mentioned messages are dropped here and never
 * become rows; the one row that DOES get written on a bow-out is the
 * message that causes the engaged->dormant transition (its `dormantSince`
 * is still null at read time), so the dispatcher can observe and persist
 * that transition — one skipped row per dormancy episode, not one per
 * ignored message thereafter.
 *
 * `/connect` is the one exception to all of the above (final whole-branch
 * review, finding #3): it is admitted regardless of mention/thread/dormancy
 * state, same as a mention would be. `/connect`'s own doc-comment
 * (connect-command.ts) promises it "never leaves a user with silence" — a
 * user typing it in a thread Jace has gone quiet in (or never spoke in) must
 * still reach `channel-dispatch.ts`'s command interception, which runs
 * BEFORE workspace resolution and consumes the command without ever
 * forwarding it to Jace. Recognition reuses `parseConnectCommand` verbatim
 * (no second definition of what `/connect` looks like), so this gate and the
 * dispatcher's own interception can never drift apart on what counts as the
 * command.
 */
export interface DiscordInboundMessage {
  channelId: string;
  providerMessageId: string;
  senderId: string;
  senderDisplay: string;
  senderUsername: string | null;
  text: string;
  /** Null outside a known thread (see this file's header doc for why that
   * doubles as "already safe to enqueue" at this specific door). */
  threadId: string | null;
  mentionsBot: boolean;
  mentionsOtherUsers: boolean;
  repliesToMessageId: string | null;
  repliesToBot: boolean;
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
  /** True when the engagement gate dropped the message before it ever
   * reached identity resolution or `channel_inbox` — not an error. */
  skipped: boolean;
}

/**
 * The gate described in this file's header doc. Deliberately does the
 * cheapest check first (no DB call at all for a mention or a non-thread
 * message) and only reaches for `getThreadEngagement`'s one indexed lookup
 * when the message is inside a thread and does not mention the bot.
 */
async function admitsPastEngagementGate(args: {
  threadId: string | null;
  mentionsBot: boolean;
  text: string;
}): Promise<boolean> {
  if (args.mentionsBot) return true;
  if (args.threadId === null) return true;
  // /connect always gets through — see this file's header doc.
  if (parseConnectCommand(args.text).isCommand) return true;
  const state = await getThreadEngagement({ channel: "discord", conversationKey: args.threadId });
  return state !== null && state.dormantSince === null;
}

export async function admitDiscordChannelMessage(
  message: DiscordInboundMessage
): Promise<DiscordInboundResult> {
  const admitted = await admitsPastEngagementGate({
    threadId: message.threadId,
    mentionsBot: message.mentionsBot,
    text: message.text,
  });
  if (!admitted) {
    return { deduped: false, skipped: true };
  }

  // A thread is its own conversation, keyed on the thread id, not the parent
  // channel — same "reply target IS the conversation key" convention
  // resolveSlackThread already established for Slack in PR 1. Outside a
  // thread this is unchanged: `message.channelId`.
  const conversationKey = message.threadId ?? message.channelId;

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
    conversationKey,
    kind: "message",
    senderId: message.senderId,
    senderDisplay: message.senderDisplay,
    providerMessageId: message.providerMessageId,
    payload: {
      // Reuses the SAME field name channel-dispatch.ts's (Telegram-authored)
      // extractPayload already reads — see channel-dispatch.ts's doc-comment
      // on why callers into this door deliberately do not fork that function.
      // The reply target IS the conversation key: the thread id when in a
      // thread, else the channel id — unchanged for every non-thread message.
      chatId: conversationKey,
      text: message.text,
      fromId: message.senderId,
      fromUsername: message.senderUsername,
      // The engagement envelope (spec: docs/superpowers/specs/2026-07-28-
      // thread-native-jace-design.md) — channel-dispatch.ts's dispatcher
      // (Task 6) reads these to build `ThreadInbound` and run
      // `decideEngagement`. Always present, never conditionally omitted —
      // unlike the interactionToken/applicationId pair below.
      threadId: message.threadId,
      mentionsBot: message.mentionsBot,
      mentionsOtherUsers: message.mentionsOtherUsers,
      repliesToMessageId: message.repliesToMessageId,
      repliesToBot: message.repliesToBot,
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

  return { deduped: enqueued.deduped, skipped: false };
}
