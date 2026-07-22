import { NextRequest, NextResponse } from "next/server";
import { resolveInboundChatIdentity, enqueueChannelMessage } from "@agentrail/db-postgres";
import { dispatchQueuedChannelMessages } from "../../../../../../lib/channel-dispatch";
import { verifySlackSignature } from "../../../../../../lib/slack-bot";

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
 */

const SIGNATURE_HEADER = "x-slack-signature";
const TIMESTAMP_HEADER = "x-slack-request-timestamp";

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
    event.subtype ||
    !event.channel ||
    !event.user ||
    typeof event.text !== "string" ||
    !event.text.trim()
  ) {
    // Not a genuine fresh human message this door understands (a
    // non-"message" event, this bot's/another bot's own post, an edit/join/
    // other subtype, or missing fields) — ack, never enqueue.
    return json({ ok: true, ignored: true });
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
    conversationKey: event.channel,
    kind: "message",
    senderId: event.user,
    // No senderDisplay: see the displayName comment above — event.user is a
    // raw platform id, not a name; left absent (defaults to "") rather than
    // populated with a misleading id.
    // Slack redelivers on a slow ack using the SAME event_id (carried via
    // X-Slack-Retry-Num) — namespaced by channel for consistency with every
    // other channel's (channel, provider_message_id) unique, though event_id
    // is already globally unique on its own.
    providerMessageId: `${event.channel}:${body.event_id ?? event.ts}`,
    payload: {
      // Reuses the SAME field name channel-dispatch.ts's extractPayload
      // already reads (see that file's HOSTED_INBOUND_TARGET_KEY doc-comment)
      // — this door deliberately does not fork that function.
      chatId: event.channel,
      text: event.text,
      fromId: event.user,
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
