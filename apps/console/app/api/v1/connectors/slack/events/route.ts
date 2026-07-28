import { NextRequest, NextResponse } from "next/server";
import {
  resolveInboundChatIdentity,
  enqueueChannelMessage,
  getThreadEngagement,
} from "@agentrail/db-postgres";
import { dispatchQueuedChannelMessages } from "../../../../../../lib/channel-dispatch";
import { verifySlackSignature } from "../../../../../../lib/slack-bot";
import { resolveSlackThread } from "../../../../../../lib/slack-thread";

/**
 * Shared Slack Events API webhook — the Slack half of the hosted Jace door
 * (#1285, same shared-app model Telegram (#1262) and Discord (#1284) got +
 * chat_identities resolution from #1261). ONE hosted Slack app multiplexes
 * every workspace, so this route never looks up a workspace-scoped secret:
 * it verifies the ONE shared app's signing secret, then branches on the
 * event envelope's `type`.
 *
 * `url_verification`: Slack's one-time handshake when the Events API
 * Request URL is first configured — must echo back the `challenge` value
 * (plain JSON `{ challenge }`, per Slack's documented contract) or the URL
 * fails validation.
 *
 * `event_callback` with `event.type === "message"`: a stranger "installs the
 * Slack app and holds a conversation" (AC1) by DMing it — a DM delivers as
 * `event.channel_type === "im"`, with `event.channel` directly usable as the
 * `chat.postMessage` target for any reply (no separate "open a DM" step
 * needed, unlike some other platforms). Ensures the sender's chat identity
 * (issue #1261), enqueues into `channel_inbox` (PR ①), kicks the dispatcher
 * fire-and-forget, then ACKs 200 immediately — Slack requires a response
 * within 3 seconds and does not need a visible placeholder reply the way
 * Discord's interaction contract does (see discord's webhook route's
 * comment): the real reply lands later as a separate message via
 * Jace's native slack channel, this route never awaits the Eve turn.
 *
 * Bot-loop / noise guard: an event carrying `bot_id` (this bot's own posts,
 * or any other bot) or any `subtype` (edits, deletes, channel-join system
 * messages, etc.) is ignored — only a genuine fresh human message is
 * enqueued.
 *
 * FAIL CLOSED: a missing `SLACK_SIGNING_SECRET` means every request is
 * rejected (401) — mirrors the Telegram/Discord webhooks' identical
 * fail-closed posture.
 *
 * THE ENGAGEMENT GATE (spec: docs/superpowers/specs/2026-07-28-thread-
 * native-jace-design.md) — one indexed lookup that keeps junk out of
 * `channel_inbox`, NOT the real decision (`channel-dispatch.ts`'s
 * `decideEngagement` makes that one, on a claimed row):
 *
 *   enqueue if mentionsBot OR isDM OR (a session row exists for this
 *   conversation AND its dormant latch is clear).
 *
 * Needs a Slack bot user id this console does not otherwise have — read from
 * `SLACK_BOT_USER_ID`. `mentionsBot` = the text contains `<@SLACK_BOT_USER_ID>`;
 * `mentionsOtherUsers` = it contains some OTHER `<@U…>` token;
 * `repliesToMessageId` is always null (Slack has no in-channel reply
 * primitive — a Slack reply IS a thread, already captured by `threadTs`
 * above). `isDM` is `event.channel_type === "im"`, the same signal
 * `resolveSlackThread` already uses.
 *
 * FAIL TOWARD TODAY'S BEHAVIOR, NOT TOWARD SILENCE, when `SLACK_BOT_USER_ID`
 * is unset: verified 2026-07-28, production has NO Slack environment
 * variables at all on either service (this door already fails closed on a
 * missing signing secret, so Slack is entirely dark in prod today) — gating
 * on an unresolvable mention would make Jace mute on Slack the instant
 * someone turns Slack on without also setting this var. So an unset var
 * enqueues UNCONDITIONALLY, exactly as before this feature existed: no
 * engagement lookup, no new payload keys, logged once per process (see
 * `loggedMissingSlackBotUserId` below, styled after
 * `lib/guardrails/moderation.ts`'s missing-key notice).
 */

const SIGNATURE_HEADER = "x-slack-signature";
const TIMESTAMP_HEADER = "x-slack-request-timestamp";

/** Every `<@U…>` token in a Slack message's raw text — Slack's own mention
 * syntax, the same shape for a user or (usually) a bot. */
const SLACK_MENTION_PATTERN = /<@([A-Z0-9]+)>/g;

function extractMentionedUserIds(text: string): string[] {
  const ids: string[] = [];
  for (const match of text.matchAll(SLACK_MENTION_PATTERN)) {
    if (match[1]) ids.push(match[1]);
  }
  return ids;
}

/** Trimmed, `undefined`/blank-safe read of `SLACK_BOT_USER_ID` — `null` when
 * not configured, mirroring `moderation.ts`'s `resolveApiKey` shape. */
function resolveSlackBotUserId(): string | null {
  const raw = process.env["SLACK_BOT_USER_ID"];
  const value = typeof raw === "string" ? raw.trim() : "";
  return value.length > 0 ? value : null;
}

/** Logged at most once per process — see the module doc's "FAIL TOWARD
 * TODAY'S BEHAVIOR" section on why a missing var is a log-once, not a
 * log-per-message, condition (mirrors moderation.ts's `loggedMissingKey`). */
let loggedMissingSlackBotUserId = false;

function warnMissingSlackBotUserIdOnce(): void {
  if (loggedMissingSlackBotUserId) return;
  loggedMissingSlackBotUserId = true;
  console.warn(
    "[slack/events] SLACK_BOT_USER_ID not configured — thread engagement is disabled for this " +
      "process; every Slack message enqueues unconditionally, matching pre-engagement behavior. " +
      "Set the var on the console service to enable it."
  );
}

function verifyRequest(rawBody: string, signature: string | null, timestamp: string | null): boolean {
  return verifySlackSignature({
    signingSecret: process.env["SLACK_SIGNING_SECRET"],
    signature,
    timestamp,
    rawBody,
  });
}

interface SlackMessageEvent {
  type: string;
  channel?: string;
  user?: string;
  text?: string;
  channel_type?: string;
  bot_id?: string;
  subtype?: string;
  ts?: string;
  thread_ts?: string;
}

interface SlackEventEnvelope {
  type: string;
  challenge?: string;
  event_id?: string;
  event?: SlackMessageEvent;
}

function isSlackEventEnvelope(value: unknown): value is SlackEventEnvelope {
  return !!value && typeof value === "object" && typeof (value as Record<string, unknown>)["type"] === "string";
}

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status });
}

export async function POST(request: NextRequest) {
  const raw = await request.text();

  // Verify BEFORE parsing — mirrors the Telegram/Discord webhooks' fail-closed order.
  if (!verifyRequest(raw, request.headers.get(SIGNATURE_HEADER), request.headers.get(TIMESTAMP_HEADER))) {
    return json({ error: "invalid request signature" }, 401);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  if (!isSlackEventEnvelope(body)) {
    return json({ error: "invalid event shape" }, 400);
  }

  if (body.type === "url_verification") {
    if (typeof body.challenge !== "string") {
      return json({ error: "url_verification missing challenge" }, 400);
    }
    return json({ challenge: body.challenge });
  }

  if (body.type !== "event_callback" || !body.event) {
    // Any other top-level type this door doesn't process yet (e.g.
    // app_rate_limited) — ack so Slack doesn't retry, but do nothing.
    return json({ ok: true, ignored: true });
  }

  const event = body.event;
  if (
    event.type !== "message" ||
    event.bot_id ||
    (event.subtype && event.subtype !== "thread_broadcast") ||
    !event.channel ||
    !event.user ||
    typeof event.text !== "string" ||
    !event.text.trim()
  ) {
    // Not a genuine fresh human message this door understands (a
    // non-"message" event, this bot's/another bot's own post, an edit/join/
    // other subtype, or missing fields) — ack, never enqueue.
    //
    // `subtype === "thread_broadcast"` is the one exception (final
    // whole-branch review, finding #2): a thread reply sent with Slack's
    // "Also send to channel" checkbox carries that subtype but is a genuine
    // human turn — it has the same text/user/channel/ts/thread_ts shape as
    // any other in-thread reply, so admitting it here is enough for it to
    // flow through the existing path unchanged. Every other subtype (edits,
    // deletes, joins, ...) and any bot_id stay rejected.
    return json({ ok: true, ignored: true });
  }

  // Thread-scoped conversation key + the thread eve must reply in. A channel
  // message is its own conversation per THREAD (see lib/slack-thread.ts); a
  // DM is exempt and byte-unchanged. Computed early (pure, no I/O) so the
  // engagement gate below — and its one indexed lookup — can run BEFORE any
  // identity resolution or enqueue, same "cheap gate first" shape the
  // Discord doors use (lib/discord-inbound.ts).
  const thread = resolveSlackThread({
    channel: event.channel,
    ts: event.ts,
    thread_ts: event.thread_ts,
    channel_type: event.channel_type,
  });

  // THE ENGAGEMENT GATE — see this file's header doc. `slackBotUserId` is
  // `null` in every describe block above (SLACK_BOT_USER_ID unset in this
  // process today, prod verified 2026-07-28): `engagement` stays `null`,
  // every field below is skipped, and the payload/gate stay byte-identical
  // to pre-engagement behavior.
  const slackBotUserId = resolveSlackBotUserId();
  let engagement: { mentionsBot: boolean; mentionsOtherUsers: boolean } | null = null;

  if (slackBotUserId) {
    const mentionedIds = extractMentionedUserIds(event.text);
    const mentionsBot = mentionedIds.includes(slackBotUserId);
    const mentionsOtherUsers = mentionedIds.some((id) => id !== slackBotUserId);
    const isDM = event.channel_type === "im";
    engagement = { mentionsBot, mentionsOtherUsers };

    if (!mentionsBot && !isDM) {
      const state = await getThreadEngagement({
        channel: "slack",
        conversationKey: thread.conversationKey,
      });
      const admitted = state !== null && state.dormantSince === null;
      if (!admitted) {
        // Dropped before any identity resolution or `channel_inbox` row —
        // not an error, see this file's header doc.
        return json({ ok: true, skipped: true });
      }
    }
  } else {
    warnMissingSlackBotUserIdOnce();
  }

  // No display name: the Events API's message event carries only the raw
  // user id (`event.user`, e.g. "U061F7AUR") — resolving a real display name
  // needs a separate `users.info` Web API call, out of scope for v1's
  // inbound door. Passing it through as displayName would show a raw
  // platform id as primary UI text; leaving it undefined keeps the identity
  // row's display_name genuinely absent rather than misleading.
  const { identity } = await resolveInboundChatIdentity({
    platform: "slack",
    platformUserId: event.user,
  });

  // The anchor is EITHER workspaceId (identity already bound) OR
  // chatIdentityId (intro sender, no resolved workspace yet) — mirrors the
  // Telegram/Discord webhooks' identical anchor convention.
  const anchor = identity.workspaceId
    ? { workspaceId: identity.workspaceId }
    : { chatIdentityId: identity.id };

  const result = await enqueueChannelMessage({
    ...anchor,
    channel: "slack",
    conversationKey: thread.conversationKey,
    kind: "message",
    senderId: event.user,
    // No senderDisplay: see the displayName comment above — event.user is a
    // raw platform id, not a name; left absent (defaults to "") rather than
    // populated with a misleading id.
    // Slack redelivers on a slow ack using the SAME event_id (carried via
    // X-Slack-Retry-Num) — namespaced by channel for consistency with every
    // other channel's (channel, provider_message_id) unique, though event_id
    // is already globally unique on its own. Deliberately still keyed on
    // event.channel (not thread.conversationKey): this is a redelivery
    // dedupe key over Slack's globally-unique event_id, not a conversation
    // key — re-keying it on the thread would let one Slack event enqueue
    // twice for two different threads.
    providerMessageId: `${event.channel}:${body.event_id ?? event.ts}`,
    payload: {
      // Reuses the SAME field name channel-dispatch.ts's extractPayload
      // already reads (see that file's HOSTED_INBOUND_TARGET_KEY doc-comment)
      // — this door deliberately does not fork that function.
      chatId: event.channel,
      text: event.text,
      fromId: event.user,
      // Slack-only; omitted (never written as `undefined`) for a DM, so a DM
      // payload stays byte-identical to today's. Task 3 reads this back to
      // know which thread to reply in.
      ...(thread.threadTs !== undefined ? { threadTs: thread.threadTs } : {}),
      // The engagement envelope — omitted ENTIRELY (never written as
      // `undefined`) when SLACK_BOT_USER_ID is unset, so the payload stays
      // byte-identical to pre-engagement behavior (see this file's header
      // doc's "FAIL TOWARD TODAY'S BEHAVIOR" section).
      ...(engagement !== null
        ? {
            mentionsBot: engagement.mentionsBot,
            mentionsOtherUsers: engagement.mentionsOtherUsers,
            // Slack has no in-channel reply primitive — a Slack reply IS a
            // thread, already captured by `threadTs` above.
            repliesToMessageId: null,
            repliesToBot: false,
          }
        : {}),
    },
  });

  // Fire-and-forget kick (mirrors the Telegram/Discord webhooks' identical pattern).
  void dispatchQueuedChannelMessages().catch((err) => {
    console.error("[slack/events] dispatch kick failed:", err);
  });

  if (result.deduped) {
    return json({ ok: true, deduped: true });
  }
  return json({ ok: true });
}
