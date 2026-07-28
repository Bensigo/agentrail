/**
 * The ONE engagement rule, shared by Discord and Slack (spec:
 * docs/superpowers/specs/2026-07-28-thread-native-jace-design.md).
 *
 * Engagement is CONVERSATION STATE, not per-message classification. The
 * heuristic answers only one question: *has this conversation stopped being
 * about Jace?* Deterministic, no network, no model call — the same posture as
 * `apps/jace/agent/lib/intent-classifier.core.mjs`, and for the same reason:
 * a rule a test can pin beats a rule that is merely clever.
 *
 * Transports differ in what evidence they can supply (Slack has no in-channel
 * reply primitive, so `repliesToMessageId` is always null there) but NOT in
 * semantics — every channel runs this exact table, so Discord and Slack can
 * never drift into different conversational behavior.
 *
 * FAILS TOWARD SILENCE. An un-mentioned message we are unsure about is not
 * answered. A wrong bow-out costs the user one `@Jace`; a wrong engagement
 * spams a human conversation that asked Jace to stay out.
 */

export interface ThreadInbound {
  channel: "discord" | "slack";
  /** DMs are exempt from engagement entirely — always a turn. */
  isDM: boolean;
  /** Null when the message is in the channel proper, not a thread. */
  threadId: string | null;
  senderId: string;
  mentionsBot: boolean;
  /** True when the message @-mentions a human/role that is not Jace. */
  mentionsOtherUsers: boolean;
  /** Discord `message_reference`; ALWAYS null on Slack, which has no
   * in-channel reply primitive (a Slack reply IS a thread). */
  repliesToMessageId: string | null;
  repliesToBot: boolean;
}

export interface EngagementState {
  dormantSince: Date | null;
  engagedSpeakerId: string | null;
}

export interface EngagementDecision {
  turn: boolean;
  nextState: EngagementState;
  reason: string;
}

/** Engaged = a session row exists, the latch is clear, and we know who Jace
 * was talking to. A row with no `engagedSpeakerId` predates this feature, so
 * it needs a mention to (re-)establish who owns the thread. */
function isEngaged(state: EngagementState | null): state is EngagementState & {
  engagedSpeakerId: string;
} {
  return (
    state !== null && state.dormantSince === null && state.engagedSpeakerId !== null
  );
}

export function decideEngagement(args: {
  inbound: ThreadInbound;
  state: EngagementState | null;
  now: Date;
}): EngagementDecision {
  const { inbound, state, now } = args;

  // A DM is one conversation with one person — there is no channel to keep
  // clean and nobody else to bow out for.
  if (inbound.isDM) {
    return {
      turn: true,
      nextState: { dormantSince: null, engagedSpeakerId: inbound.senderId },
      reason: "direct message",
    };
  }

  // An explicit mention always wins, from anyone, in any state. It is the one
  // unambiguous signal that this message is FOR Jace, and it is how a dormant
  // thread is brought back.
  if (inbound.mentionsBot) {
    return {
      turn: true,
      nextState: { dormantSince: null, engagedSpeakerId: inbound.senderId },
      reason: "mentions the bot",
    };
  }

  const keep = (reason: string): EngagementDecision => ({
    turn: false,
    nextState: state ?? { dormantSince: null, engagedSpeakerId: null },
    reason,
  });

  // Outside a thread, or in a thread Jace has never spoken in, a mention is
  // required — and there wasn't one.
  if (inbound.threadId === null) {
    return keep("channel message without a mention of the bot");
  }
  if (!isEngaged(state)) {
    return keep(
      state?.dormantSince
        ? "thread is dormant and this message does not mention the bot"
        : "no engaged session for this thread"
    );
  }

  const bowOut = (reason: string): EngagementDecision => ({
    turn: false,
    nextState: { dormantSince: now, engagedSpeakerId: state.engagedSpeakerId },
    reason,
  });

  // A thread is one-on-one by default: somebody else is talking now.
  if (inbound.senderId !== state.engagedSpeakerId) {
    return bowOut("another participant posted without mentioning the bot");
  }
  // The engaged speaker has turned to address someone else.
  if (inbound.mentionsOtherUsers) {
    return bowOut("mentions another user");
  }
  // ...or is replying to a human, not to Jace.
  if (inbound.repliesToMessageId !== null && !inbound.repliesToBot) {
    return bowOut("replies to a non-bot message");
  }

  return {
    turn: true,
    nextState: { dormantSince: null, engagedSpeakerId: state.engagedSpeakerId },
    reason: "engaged thread, no bow-out signal",
  };
}
