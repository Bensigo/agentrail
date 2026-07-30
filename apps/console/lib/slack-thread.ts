/**
 * Pure Slack thread resolution for the inbound door (spec
 * docs/superpowers/specs/2026-07-28-thread-native-jace-design.md).
 *
 * Two values fall out of one Slack message event:
 *
 *   - `conversationKey` — the STABLE per-conversation id `jace_sessions` and
 *     `channel_inbox` key on. For a channel message this is the THREAD, not
 *     the channel, so a thread is its own conversation. `ts` is unique per
 *     channel, not globally, so the key is compounded with the channel id.
 *   - `threadTs` — what eve's `slackChannel().receive` needs. Verified against
 *     the compiled runtime (apps/jace/.output/server/_libs/eve.mjs): the Slack
 *     continuation token IS `slackContinuationToken(channelId, threadTs)`, and
 *     with no `threadTs` receive falls back to `crypto.randomUUID()` — a fresh
 *     session every turn (#1479's Slack half). It doubles as the thread the
 *     reply posts into, so rooting it at the USER's message is what makes Jace
 *     answer in a thread instead of flat in the channel.
 *
 * TEAM-SCOPED (final whole-branch review, finding #2 — a cross-tenant fix,
 * not a feature): every `conversationKey` this function returns is prefixed
 * with the Slack `teamId` the event was resolved against. Slack channel ids
 * are unique only WITHIN a workspace, exactly like the user ids Task 3's
 * identity fix already had to account for (see the events route's own
 * `platformUserId` comment) — an unprefixed key from two different
 * workspaces can collide onto the SAME `jace_sessions`/`channel_inbox` row.
 * `resolveConversationWorkspace`'s `pinned` branch matches on (channel,
 * conversationKey) with NO identity filter (see its own doc-comment: a
 * colliding key "rides that conversation's existing pin straight into a
 * foreign workspace") — so an unscoped key here is a second, worse-payoff
 * version of the identity bug: it resolves the OTHER tenant's AgentRail
 * workspace, not just their chat identity. These keys are persisted in
 * `jace_sessions` and cannot be re-keyed after the fact, so this must be
 * correct before any real (non-HeyJace) install lands.
 *
 * DMs are deliberately EXEMPT from the thread-vs-channel distinction (still
 * keyed on the channel, no `threadTs`) but are NOT exempt from team-scoping —
 * a DM's `channel` id is just as workspace-local as a public channel's.
 * Because eve ties continuity to threading, a stable DM session would mean
 * threading every DM reply under one anchor message — pure downside in a DM,
 * where there is no channel to keep clean. DM continuity needs its own
 * design; see the spec's Out of scope.
 */

/** The subset of a Slack `message` event this resolution reads. */
export interface SlackThreadEvent {
  channel: string;
  ts?: string;
  thread_ts?: string;
  channel_type?: string;
}

export interface SlackThreadTarget {
  conversationKey: string;
  /** Omitted entirely (never `undefined`-valued) when this turn is unthreaded. */
  threadTs?: string;
}

/** Slack marks a direct message with `channel_type: "im"`. */
function isDirectMessage(event: SlackThreadEvent): boolean {
  return event.channel_type === "im";
}

function trimmed(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * @param teamId The Slack workspace this event was resolved against (the
 *   events route's already-verified `installation.teamId` — never the raw,
 *   unverified `body.team_id`). Prefixed onto every `conversationKey` this
 *   function returns — see this file's header doc for why an unscoped key is
 *   a cross-tenant leak, not merely a cosmetic gap.
 */
export function resolveSlackThread(event: SlackThreadEvent, teamId: string): SlackThreadTarget {
  if (isDirectMessage(event)) {
    return { conversationKey: `${teamId}:${event.channel}` };
  }
  // An in-thread reply carries the ROOT's ts in `thread_ts`; a top-level
  // message carries none, and roots a new thread at itself.
  const threadTs = trimmed(event.thread_ts) || trimmed(event.ts);
  if (!threadTs) {
    // No ts at all — a shape this door should never see. Degrade to today's
    // channel-keyed behavior rather than invent a key.
    return { conversationKey: `${teamId}:${event.channel}` };
  }
  return { conversationKey: `${teamId}:${event.channel}:${threadTs}`, threadTs };
}
