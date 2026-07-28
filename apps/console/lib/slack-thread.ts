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
 * DMs are deliberately EXEMPT and byte-unchanged: keyed on the channel, no
 * `threadTs`. Because eve ties continuity to threading, a stable DM session
 * would mean threading every DM reply under one anchor message — pure downside
 * in a DM, where there is no channel to keep clean. DM continuity needs its own
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

export function resolveSlackThread(event: SlackThreadEvent): SlackThreadTarget {
  if (isDirectMessage(event)) {
    return { conversationKey: event.channel };
  }
  // An in-thread reply carries the ROOT's ts in `thread_ts`; a top-level
  // message carries none, and roots a new thread at itself.
  const threadTs = trimmed(event.thread_ts) || trimmed(event.ts);
  if (!threadTs) {
    // No ts at all — a shape this door should never see. Degrade to today's
    // channel-keyed behavior rather than invent a key.
    return { conversationKey: event.channel };
  }
  return { conversationKey: `${event.channel}:${threadTs}`, threadTs };
}
