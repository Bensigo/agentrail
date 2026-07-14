// Keep a Telegram "typing…" indicator alive for the whole length of a slow turn.
//
// Eve's default `turn.started` fires ONE `startTyping()` chat action. Telegram
// expires a typing indicator after ~5s, so on a slow model (a local qwen3 turn
// can run 30s–2min) the indicator vanishes and the chat looks dead while Jace is
// still working — the "I sent a message and got nothing" experience. This
// re-sends the action on an interval until the turn ends, so the user always
// sees "typing…" while a reply is coming.
//
// Pure + injected timers so it is unit-testable without real time or Telegram.
// Keyed by conversation so two concurrent chats never cross typing streams.
//
// Stop is driven by the caller on `message.completed` / `turn.completed` (the
// success paths Jace owns). The failure path (`turn.failed` / `session.failed`)
// is left to Eve's default error handlers — which we must not clobber and cannot
// chain (Eve does not export `defaultEvents`) — so `maxMs` is the backstop that
// guarantees a loop can never outlive a turn even if no stop signal arrives.

export const TYPING_REFRESH_MS = 4000; // < Telegram's ~5s chat-action expiry
export const TYPING_MAX_MS = 120000; // hard cap: never keep typing past 2 min

export function createTypingKeepalive(deps = {}) {
  const setInt = deps.setInterval ?? setInterval;
  const clearInt = deps.clearInterval ?? clearInterval;
  const setTo = deps.setTimeout ?? setTimeout;
  const clearTo = deps.clearTimeout ?? clearTimeout;
  const refreshMs = deps.refreshMs ?? TYPING_REFRESH_MS;
  const maxMs = deps.maxMs ?? TYPING_MAX_MS;

  const active = new Map(); // convoKey -> { interval, timeout }

  function start(key, sendTyping) {
    stop(key); // idempotent: a re-started turn replaces its own loop
    safe(sendTyping); // immediate acknowledgement, don't wait a full interval
    const interval = setInt(() => safe(sendTyping), refreshMs);
    const timeout = setTo(() => stop(key), maxMs);
    active.set(key, { interval, timeout });
  }

  function stop(key) {
    const entry = active.get(key);
    if (!entry) return;
    clearInt(entry.interval);
    clearTo(entry.timeout);
    active.delete(key);
  }

  return { start, stop, activeCount: () => active.size };
}

function safe(fn) {
  // A typing refresh must never throw into the turn. startTyping already
  // swallows its own failures, but a synchronous throw here would too.
  try {
    void fn();
  } catch {
    /* swallow */
  }
}
