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
