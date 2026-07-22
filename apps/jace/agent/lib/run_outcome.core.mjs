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
 * Channels this route understands. Each maps to an Eve channel module the wrapper
 * wires: `telegram`/`discord`/`slack` to their native `eve/channels/<id>` and
 * `imessage` to Jace's hand-rolled LoopMessage channel (#1100).
 */
export const RUN_OUTCOME_CHANNELS = ["telegram", "discord", "slack", "imessage"];

/**
 * The NON-SECRET destination key each channel's `target` may carry. The console
 * supplies this from its per-workspace DB (a chat/channel id is a display value,
 * not a credential); the shared bot token lives in Jace's env, never on the wire.
 * Shapes follow Eve's proactive-`receive` target: Telegram `{ chatId }`,
 * Slack / Discord `{ channelId }`, iMessage `{ handle }` (phone/email).
 *
 * iMessage is the one exception where the key is OPTIONAL: it has no non-secret
 * "channel id" the console can send (see notifyIMessageViaJace, which posts an
 * empty target), so its recipient handle is resolved Jace-side (from the channel's
 * LOOPMESSAGE_DEFAULT_RECIPIENT env / the last inbound contact). Every other
 * channel still requires its key present and non-blank.
 */
export const TARGET_KEY = Object.freeze({
  telegram: "chatId",
  discord: "channelId",
  slack: "channelId",
  imessage: "handle",
});

/** Channels whose destination is resolved Jace-side, so an empty target is OK. */
const HANDLE_OPTIONAL_CHANNELS = Object.freeze(["imessage"]);

/**
 * The terminal outcome vocabulary the console's `notify.ts` sends as its
 * `outcome` field (`NotifyOutcome`, `apps/console/lib/outcome-format.ts`) —
 * the queue state-machine's own terminal states, NOT the `run_outcomes`
 * table's separate "success"|"human_review"|"failed" vocabulary (see
 * `queries/run_outcomes.ts::mapTerminalStateToRunOutcome` for that mapping,
 * which is a DIFFERENT, analytics-facing concern). #1289's goal loop reuses
 * THIS vocabulary because it's what's actually on the wire here.
 */
export const GOAL_OUTCOME_VALUES = Object.freeze(["green", "escalated-to-human", "blocked"]);

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
 * @returns {{ channel: string, message: string, target: Record<string,string>, auth?: object,
 *             workspaceId?: string, issueExternalId?: string, outcome?: string, costUsd?: number }}
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
  const destGiven = dest != null && String(dest).trim() !== "";
  if (!destGiven && !HANDLE_OPTIONAL_CHANNELS.includes(channel)) {
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
  // may have included so only the non-secret destination reaches the session. A
  // handle-optional channel with no destination normalizes to an empty target
  // (its recipient is resolved Jace-side).
  const normalized = {
    channel,
    message,
    target: destGiven ? { [key]: String(dest).trim() } : {},
  };
  if (auth) normalized.auth = auth;

  // #1289 (Jace goal loop) — OPTIONAL enrichment fields. The console's
  // `notify.ts::notifyViaJace` has sent `workspaceId`/`outcome`/`issueNumber`/
  // `costUsd` in this exact POST body since #1338's own capture-fuel work,
  // long before this feature existed; this is the first CONSUMER of them.
  // Every one of these is additive and best-effort: a missing or malformed
  // value is simply OMITTED from the normalized result (never throws, never
  // blocks the existing platform-notify path this function's callers already
  // depend on) — so a payload with none of these fields (every pre-#1289
  // caller and test) normalizes BYTE-IDENTICALLY to before this change.
  const workspaceId = typeof raw.workspaceId === "string" ? raw.workspaceId.trim() : "";
  if (workspaceId) normalized.workspaceId = workspaceId;

  const issueExternalId =
    typeof raw.issueNumber === "string" || typeof raw.issueNumber === "number"
      ? String(raw.issueNumber).trim()
      : "";
  if (issueExternalId) normalized.issueExternalId = issueExternalId;

  if (GOAL_OUTCOME_VALUES.includes(raw.outcome)) {
    normalized.outcome = raw.outcome;
  }

  if (typeof raw.costUsd === "number" && Number.isFinite(raw.costUsd)) {
    normalized.costUsd = raw.costUsd;
  }

  return normalized;
}
