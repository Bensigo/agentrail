import { NextRequest, NextResponse } from "next/server";
import {
  resolveInboundChatIdentity,
  enqueueChannelMessage,
  getThreadEngagement,
  getSlackInstallation,
} from "@agentrail/db-postgres";
import { dispatchQueuedChannelMessages } from "../../../../../../lib/channel-dispatch";
import { verifySlackSignature } from "../../../../../../lib/slack-bot";
import { resolveSlackThread } from "../../../../../../lib/slack-thread";
// Final whole-branch review, finding #3: `/connect` must reach the
// dispatcher's own command interception (channel-dispatch.ts's `processRow`)
// even from a dormant or never-engaged thread — reusing the SAME recognizer
// the dispatcher uses rather than hand-rolling a second, driftable definition
// of what `/connect` looks like.
import { parseConnectCommand } from "../../../../../../lib/connect-command";

/**
 * Shared Slack Events API webhook — the Slack half of the multi-workspace
 * Jace door (Task 3, docs/superpowers/specs/2026-07-29-slack-multi-workspace-
 * design.md §3, same shared-app model Telegram (#1262) and Discord (#1284)
 * got + chat_identities resolution from #1261). ONE Slack **app** receives
 * every workspace's events over this single URL, but each workspace has its
 * OWN install (its own bot token, its own bot user id) — this route resolves
 * that per-team installation before doing anything else, and fails closed
 * when it can't.
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
 * (issue #1261, team-scoped per Task 3 — see the `platformUserId` comment
 * below), enqueues into `channel_inbox` (PR ①), kicks the dispatcher
 * fire-and-forget, then ACKs 200 immediately — Slack requires a response
 * within 3 seconds and does not need a visible placeholder reply the way
 * Discord's interaction contract does (see discord's webhook route's
 * comment): the real reply lands later as a separate message posted by the
 * console with that team's own bot token, this route never awaits the Eve
 * turn.
 *
 * Bot-loop / noise guard: an event carrying `bot_id` (this bot's own posts,
 * or any other bot) or any `subtype` (edits, deletes, channel-join system
 * messages, etc.) is ignored — only a genuine fresh human message is
 * enqueued.
 *
 * FAIL CLOSED (signature): a missing `SLACK_SIGNING_SECRET` means every
 * request is rejected (401) — mirrors the Telegram/Discord webhooks'
 * identical fail-closed posture. The signing secret is per-APP, not
 * per-install, so this check needs no per-team knowledge.
 *
 * FAIL CLOSED (installation, Task 3): every `event_callback` carries the
 * workspace's `team_id` at the envelope's top level. This route looks up
 * `getSlackInstallation(team_id)` and, if it returns `null` — never
 * installed, uninstalled, OR revoked; the query layer collapses all three to
 * the same `null` so callers never have to remember `revoked_at` separately
 * — ignores the event with a log line and acks 200 without enqueuing. There
 * is no bot token to reply with in that state, so admitting the event could
 * only end in a failed send or (far worse) a fallback to some OTHER team's
 * token. Do not enqueue and hope.
 *
 * THE ENGAGEMENT GATE (spec: docs/superpowers/specs/2026-07-28-thread-
 * native-jace-design.md) — one indexed lookup that keeps junk out of
 * `channel_inbox`, NOT the real decision (`channel-dispatch.ts`'s
 * `decideEngagement` makes that one, on a claimed row):
 *
 *   enqueue if mentionsBot OR isDM OR (a session row exists for this
 *   conversation AND its dormant latch is clear).
 *
 * `mentionsBot` = the text contains `<@${installation.botUserId}>` —
 * per-install (Task 3), replacing the old shared `SLACK_BOT_USER_ID` env var,
 * which could never be correct for more than one workspace at a time.
 * `mentionsOtherUsers` = it contains some OTHER `<@U…>` token;
 * `repliesToMessageId` is always null (Slack has no in-channel reply
 * primitive — a Slack reply IS a thread, already captured by `threadTs`
 * above). `isDM` is `event.channel_type === "im"`, the same signal
 * `resolveSlackThread` already uses. Because the bot id now always comes
 * from the resolved installation (never an optional env var), this envelope
 * is computed unconditionally for every event that reaches this point — the
 * old "SLACK_BOT_USER_ID unset" fallback state no longer exists.
 *
 * `/connect` IS THE ONE EXCEPTION (final whole-branch review, finding #3): it
 * is admitted regardless of mention/DM/engagement state, exactly like a
 * mention would be — see `connect-command.ts`'s own doc-comment, which
 * promises `/connect` "never leaves a user with silence". A user typing it in
 * a dormant or never-engaged thread must still reach `channel-dispatch.ts`'s
 * command interception, which runs BEFORE workspace resolution and consumes
 * the command without ever forwarding it to Jace. Recognition reuses
 * `parseConnectCommand` verbatim (no second definition of what `/connect`
 * looks like), so this gate and the dispatcher's own interception can never
 * drift apart on what counts as the command.
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
  /** The Slack workspace this event belongs to — present on every
   * `event_callback` envelope. Used to resolve the per-team installation
   * (Task 3); never trusted for anything beyond that lookup. */
  team_id?: string;
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

  // FAIL CLOSED on an unknown team (Task 3) — see this file's header doc.
  // `getSlackInstallation` returns `null` for BOTH "never installed" and
  // "revoked" (`revoked_at` set), so this one check covers both without this
  // route needing to know about `revoked_at` at all. No credential means no
  // safe way to process this event: ack Slack so it stops retrying, but
  // never enqueue, never touch identity, never kick the dispatcher.
  const teamId = body.team_id;
  const installation = teamId ? await getSlackInstallation(teamId) : null;
  if (!installation) {
    console.warn(
      `[slack/events] no active Slack installation for team ${teamId ?? "(missing team_id)"} — ` +
        "ignoring event (never installed, uninstalled, or revoked); not enqueued."
    );
    return json({ ok: true, ignored: true });
  }

  // Thread-scoped conversation key + the thread eve must reply in. A channel
  // message is its own conversation per THREAD (see lib/slack-thread.ts); a
  // DM is exempt and byte-unchanged. Computed after the installation check
  // (pure, no I/O) so the engagement gate below — and its one indexed
  // lookup — can run BEFORE any identity resolution or enqueue, same "cheap
  // gate first" shape the Discord doors use (lib/discord-inbound.ts).
  const thread = resolveSlackThread({
    channel: event.channel,
    ts: event.ts,
    thread_ts: event.thread_ts,
    channel_type: event.channel_type,
  });

  // THE ENGAGEMENT GATE — see this file's header doc. `installation.botUserId`
  // is per-team (Task 3), so mention detection is always resolvable once an
  // installation exists — there is no more "unconfigured" fallback state.
  const mentionedIds = extractMentionedUserIds(event.text);
  const mentionsBot = mentionedIds.includes(installation.botUserId);
  const mentionsOtherUsers = mentionedIds.some((id) => id !== installation.botUserId);
  const isDM = event.channel_type === "im";

  // /connect always gets through — see this file's header doc.
  if (!mentionsBot && !isDM && !parseConnectCommand(event.text).isCommand) {
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

  // No display name: the Events API's message event carries only the raw
  // user id (`event.user`, e.g. "U061F7AUR") — resolving a real display name
  // needs a separate `users.info` Web API call, out of scope for v1's
  // inbound door. Passing it through as displayName would show a raw
  // platform id as primary UI text; leaving it undefined keeps the identity
  // row's display_name genuinely absent rather than misleading.
  //
  // TEAM-SCOPED IDENTITY (Task 3 — this is a cross-tenant data-leak fix, not
  // a feature): Slack user ids are unique only WITHIN a workspace, and
  // `chat_identities` is uniquely keyed `(platform, platform_user_id)`. Two
  // different people at two different companies can carry the same
  // `event.user` — without the team prefix they would collide onto the SAME
  // identity row, and identity is what binds a conversation to an AgentRail
  // workspace. `platformUserId` below is therefore the composite
  // `"${team_id}:${event.user}"`. This string is OPAQUE to everything
  // downstream: it is only ever compared for equality, never parsed apart.
  const platformUserId = `${teamId}:${event.user}`;
  const { identity } = await resolveInboundChatIdentity({
    platform: "slack",
    platformUserId,
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
      // Task 4 (docs/superpowers/specs/2026-07-29-slack-multi-workspace-
      // design.md §4): the team this row's installation was resolved
      // against, ALREADY VERIFIED above (`getSlackInstallation` returned
      // non-null) — never the raw, unverified `body.team_id`. This is what
      // lets `channel-dispatch.ts` carry an explicit team id into
      // `auth.attributes`, which is the ONLY thing that later lets a reply
      // choose the right customer's bot token. Always present at this point
      // (the installation check above returns early otherwise), but read via
      // `installation.teamId` rather than the outer `teamId` local so this
      // never depends on that local's control-flow-derived narrowing.
      teamId: installation.teamId,
      // Slack-only; omitted (never written as `undefined`) for a DM, so a DM
      // payload stays byte-identical to today's. Task 3 reads this back to
      // know which thread to reply in.
      ...(thread.threadTs !== undefined ? { threadTs: thread.threadTs } : {}),
      // The engagement envelope — always present now (Task 3: the bot id is
      // always known once an installation resolves, so mention detection is
      // never "unconfigured").
      mentionsBot,
      mentionsOtherUsers,
      // Slack has no in-channel reply primitive — a Slack reply IS a
      // thread, already captured by `threadTs` above.
      repliesToMessageId: null,
      repliesToBot: false,
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
