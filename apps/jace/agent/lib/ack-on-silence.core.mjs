// Post a short acknowledgement when a turn runs long enough to look dead.
//
// A message that triggers real work (a PR review, a codebase query, a subagent
// delegation) produces nothing in chat for 30s-2min. The typing indicator
// (typing-keepalive.core.mjs) is the only in-flight signal today, and on a
// phone it is easy to miss entirely — the user's experience is "I sent a
// message and got nothing".
//
// This is a ONE-SHOT timer, not a keep-alive: it fires at most once per turn.
// Armed from each channel's `turn.started`, disarmed when a real reply lands.
// A turn that answers fast never acks, so small talk stays clean; only turns
// that actually go quiet get "On it.".
//
// Deliberately says nothing about WHAT it is doing. At 4s the model has not
// necessarily decided anything, and inventing progress detail we cannot
// substantiate is the failure mode this is trying not to build.
//
// Pure + injected timers so it is unit-testable without real time or a
// network. Keyed by conversation so two concurrent chats never cross acks.
//
// NOT stopped on `turn.failed` / `session.failed`: eve@0.19.0 does not publicly
// export `defaultEvents` (the telegram entrypoint re-exports only
// `defaultTelegramAuth`), and its default failure handlers build their message
// from `#internal/logging.js` helpers that are equally unreachable — overriding
// them would clobber eve's error text and drop the error id. The residual race
// (a turn failing inside the window, so the ack lands just after eve's error
// message) is accepted and documented in the design spec.

export const ACK_AFTER_MS = 4000; // long enough that fast turns never ack
export const ACK_TEXT = "On it.";

/**
 * The `auth.attributes` key run-outcome.ts stamps onto a hand-off it starts
 * itself (a terminal run outcome, or the #1289 goal-loop's synthetic
 * message) to mark that turn as Jace-initiated — no human message behind
 * it. See {@link isProactiveTurn}'s doc comment for the full rationale.
 */
export const JACE_PROACTIVE_ATTRIBUTE = "jaceProactive";

/**
 * Whether a turn was started proactively by Jace itself
 * (agent/channels/run-outcome.ts's terminal-outcome / goal-loop hand-off via
 * `args.receive`) rather than by a real human message. ALL of Jace's hosted
 * inbound — the Discord Gateway listener, the console's dispatcher, a
 * workspace member's console chat message — is ALSO `receive()`-started, so
 * "started via receive()" cannot be the signal; the actual distinguishing
 * fact is that run-outcome.ts is the only starter with no human message
 * behind it, and it alone marks its hand-off with this attribute.
 *
 * Composing a real turn (an LLM call, possibly with tool use) routinely
 * exceeds the ack's 4s window, so without this guard a Jace-initiated
 * "PR #1470 merged" notification would be preceded by an unsolicited
 * "On it." acknowledging a message the user never sent.
 *
 * Reads `auth` the SAME way eve's own session-auth shape is read everywhere
 * else in this codebase — `current` first (refreshed on every subsequent
 * turn), falling back to `initiator` (set once, at session start) — see
 * `resolveSessionAuthAttributes` in agent/lib/discord-followup.core.mjs for
 * the verified-against-the-compiled-runtime rationale for that precedence.
 * This is the ONE place the "is this turn proactive?" decision is made; each
 * channel's `turn.started` calls it before `ack.start` rather than
 * re-deriving the attribute lookup itself.
 *
 * @param {{ current?: { attributes?: Record<string, unknown> | null } | null, initiator?: { attributes?: Record<string, unknown> | null } | null } | null | undefined} auth
 * @returns {boolean}
 */
export function isProactiveTurn(auth) {
  const attributes = auth?.current?.attributes ?? auth?.initiator?.attributes;
  return attributes?.[JACE_PROACTIVE_ATTRIBUTE] === true;
}

export function createAckOnSilence(deps = {}) {
  const setTo = deps.setTimeout ?? setTimeout;
  const clearTo = deps.clearTimeout ?? clearTimeout;
  const afterMs = deps.afterMs ?? ACK_AFTER_MS;

  const pending = new Map(); // convoKey -> timeout id

  function start(key, postAck) {
    stop(key); // idempotent: a re-armed turn replaces its own timer
    const id = setTo(() => {
      // Clear BEFORE posting so a slow/throwing post can never leave a stale
      // entry behind, and so the turn can only ever ack once.
      pending.delete(key);
      safe(postAck);
    }, afterMs);
    pending.set(key, id);
  }

  function stop(key) {
    const id = pending.get(key);
    if (id === undefined) return;
    clearTo(id);
    pending.delete(key);
  }

  return { start, stop, pendingCount: () => pending.size };
}

function safe(fn) {
  // An acknowledgement must never throw into the turn: a failed ack is strictly
  // less bad than a failed reply. Covers both a synchronous throw and a
  // rejected promise from an async poster.
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      result.then(undefined, () => {});
    }
  } catch {
    /* swallow */
  }
}
