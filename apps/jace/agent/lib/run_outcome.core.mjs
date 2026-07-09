// Pure, dependency-free core for Jace's OUTBOUND run-outcome channel.
//
// The AgentRail console (the DB/secret holder) hands Jace a TERMINAL run outcome
// over HTTP; Jace delivers it into the connected platform channel in a repliable
// thread (the bidirectional round-trip that is the whole point of routing
// outbound through Jace instead of the fire-and-forget legacy console senders).
//
// This module is ONLY the validation + normalization of that inbound payload. It
// imports no Eve runtime and touches no network, so it is unit-testable with
// `node --test`. The thin Eve wrapper (`agent/channels/run-outcome.ts`) holds the
// map of channel id -> Eve channel module and calls
// `args.receive(module, normalized)` — this file decides WHAT to hand it.
//
// Lives under agent/lib/ which Eve treats as a recognized lib directory: helper
// .mjs modules here are NOT loaded as tools/channels.

/**
 * Channels this route understands. `telegram`/`discord`/`slack` each map to a
 * native Eve channel module (`eve/channels/<id>`) that the wrapper actually
 * wires. `imessage` is RECOGNIZED here (valid channel + target key) but has NO
 * native Eve module yet, so the wrapper deliberately leaves it unwired: a push
 * for it validates and then gets a clear 400 ("not wired") rather than a
 * confusing "unknown channel", until an iMessage bridge lands.
 */
export const RUN_OUTCOME_CHANNELS = ["telegram", "discord", "slack", "imessage"];

/**
 * The NON-SECRET destination key each channel's `target` must carry. The console
 * supplies this from its per-workspace DB (a chat/channel id / handle is a display
 * value, not a credential); the shared bot token lives in Jace's env, never on the
 * wire. Shapes follow Eve's proactive-`receive` target: Telegram `{ chatId }`,
 * Slack / Discord `{ channelId }`, iMessage `{ handle }` (phone/email address).
 */
export const TARGET_KEY = Object.freeze({
  telegram: "chatId",
  discord: "channelId",
  slack: "channelId",
  imessage: "handle",
});

/**
 * Validate + normalize a run-outcome push into the exact `{ message, target,
 * auth }` shape `args.receive(channel, …)` expects. Throws a precise Error on any
 * malformed field so the route can answer `400` with a useful message (the
 * console's payload is a contract, not user input — a bad shape is a wiring bug
 * we want surfaced, not swallowed).
 *
 * - `channel` must be one of {@link RUN_OUTCOME_CHANNELS}.
 * - `message` must be a non-empty string (the built outcome line).
 * - `target` must be an object carrying a non-empty {@link TARGET_KEY} value for
 *   the channel; the normalized target is MINIMAL (only that key) so no extra /
 *   secret field leaks into the session.
 * - `auth`, when present, must be an object (forwarded to `session.auth.initiator`
 *   so Jace's tools can identify the initiating workspace); absent is allowed.
 *
 * @param {unknown} raw parsed JSON body from the console
 * @returns {{ channel: string, message: string, target: Record<string,string>, auth?: object }}
 */
export function normalizeRunOutcome(raw) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("run-outcome: payload must be a JSON object.");
  }
  const channel = String(raw.channel ?? "").trim();
  if (!RUN_OUTCOME_CHANNELS.includes(channel)) {
    throw new Error(
      `run-outcome: unknown channel '${channel}'. Expected one of: ${RUN_OUTCOME_CHANNELS.join(", ")}.`,
    );
  }

  const message = typeof raw.message === "string" ? raw.message.trim() : "";
  if (!message) {
    throw new Error("run-outcome: `message` is required (non-empty string).");
  }

  const target = raw.target;
  if (target == null || typeof target !== "object" || Array.isArray(target)) {
    throw new Error("run-outcome: `target` must be an object.");
  }
  const key = TARGET_KEY[channel];
  const dest = target[key];
  if (dest == null || String(dest).trim() === "") {
    throw new Error(
      `run-outcome: ${channel} target requires a non-empty '${key}'.`,
    );
  }

  let auth;
  if (raw.auth != null) {
    if (typeof raw.auth !== "object" || Array.isArray(raw.auth)) {
      throw new Error("run-outcome: `auth`, when present, must be an object.");
    }
    auth = raw.auth;
  }

  // Minimal, channel-correct target — drop any extra / secret fields the caller
  // may have included so only the non-secret destination reaches the session.
  const normalized = {
    channel,
    message,
    target: { [key]: String(dest).trim() },
  };
  if (auth) normalized.auth = auth;
  return normalized;
}
