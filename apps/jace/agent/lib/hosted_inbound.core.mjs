// Pure, dependency-free core for Jace's hosted-inbound door channel (#1262 PR
// ②; generalized beyond Telegram by #1284/#1285) — the AgentRail console's
// dispatcher hands every claimed `channel_inbox` row here so it becomes a
// real Eve turn via `args.receive(<channel module>, ...)`.
//
// This module is ONLY the validation + normalization of the console's POST
// body. It imports no Eve runtime and touches no network, so it is
// unit-testable with `node --test`, mirroring run_outcome.core.mjs's split.
// The thin Eve wrapper (`agent/channels/hosted-inbound.ts`) picks the right
// channel module by `normalized.channel` and calls
// `args.receive(module, normalizeHostedInbound(raw))` — this file decides
// WHAT to hand it and rejects garbage before that call, since Eve's own
// receive hooks throw (rather than returning a clean 400) on a missing
// target field (see annex-eve-internals.md).
//
// Lives under agent/lib/ which Eve treats as a recognized lib directory:
// helper .mjs modules here are NOT loaded as tools/channels.

/**
 * The NON-SECRET destination key each channel's `target` carries — the SAME
 * mapping run_outcome.core.mjs already uses for the OUTBOUND direction
 * (re-exported from there so the two doors can never drift apart). Telegram
 * `{ chatId }`, Slack / Discord `{ channelId }` — see that module's own
 * doc-comment for the full rationale.
 */
export { TARGET_KEY } from "./run_outcome.core.mjs";
import { TARGET_KEY as _TARGET_KEY } from "./run_outcome.core.mjs";

/**
 * Console (#1288) is inbound-only through this door and deliberately does
 * NOT ride the shared single-key `TARGET_KEY` map above: its destination is
 * a COMPOUND key (`workspaceId` + `conversationKey`), not one platform id,
 * because console chat has no external platform identity to key on — see
 * `normalizeHostedInbound`'s console branch below for the validation this
 * implies. `run_outcome.core.mjs` (the OUTBOUND direction) stays completely
 * untouched by this: console chat has no outbound run-outcome-push use case
 * today, so extending that shared map here would be speculative.
 */
const CONSOLE_CHANNEL = "console";

/** Channels this door understands. Unlisted channel ids fall back to "telegram" — see normalizeHostedInbound's `channel` handling below. */
export const HOSTED_INBOUND_CHANNELS = Object.freeze([
  ...Object.keys(_TARGET_KEY),
  CONSOLE_CHANNEL,
]);

/**
 * Validate + normalize the dispatcher's POST body into the exact
 * `{ channel, message, target, auth }` shape `args.receive(<module>, …)`
 * expects. Throws a precise Error on any malformed field so the route can
 * answer `400` with a useful message (the console's payload is a contract,
 * not user input — a bad shape is a wiring bug we want surfaced, not
 * swallowed).
 *
 * - `channel`, when present, must be one of {@link HOSTED_INBOUND_CHANNELS};
 *   ABSENT defaults to `"telegram"` — every caller before #1284 never sent
 *   this field, so this default keeps every existing Telegram request
 *   byte-identical in behavior.
 * - `message` must be a non-empty string (trimmed).
 * - `target` must be an object carrying a non-blank value under that
 *   channel's {@link TARGET_KEY} (number or string). The normalized target is
 *   MINIMAL: only that key plus `conversationId`/`messageThreadId` when
 *   present, so no stray/secret field leaks into the session (same
 *   convention as run_outcome.core.mjs's target normalization).
 * - `auth` is REQUIRED (unlike run-outcome's optional auth) and must be an
 *   object — the door's whole point is carrying `chatIdentityId`/
 *   `workspaceId` attribution into the session's `auth.initiator`, so a
 *   turn with no auth would be unattributable. Forwarded through UNCHANGED;
 *   this file does not interpret its contents.
 *
 * @param {unknown} raw parsed JSON body from the console dispatcher
 */
export function normalizeHostedInbound(raw) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("hosted-inbound: payload must be a JSON object.");
  }

  const channel = raw.channel == null ? "telegram" : String(raw.channel).trim();
  if (!HOSTED_INBOUND_CHANNELS.includes(channel)) {
    throw new Error(
      `hosted-inbound: unknown channel '${channel}'. Expected one of: ${HOSTED_INBOUND_CHANNELS.join(", ")}.`,
    );
  }

  const message = typeof raw.message === "string" ? raw.message.trim() : "";
  if (!message) {
    throw new Error("hosted-inbound: `message` is required (non-empty string).");
  }

  const target = raw.target;
  if (target == null || typeof target !== "object" || Array.isArray(target)) {
    throw new Error("hosted-inbound: `target` must be an object.");
  }

  let normalizedTarget;
  if (channel === CONSOLE_CHANNEL) {
    // Console's destination is a COMPOUND key — see the CONSOLE_CHANNEL
    // doc-comment above. Both fields are required; neither rides the shared
    // single-key TARGET_KEY convention the other channels use below.
    const workspaceId = typeof target.workspaceId === "string" ? target.workspaceId.trim() : "";
    if (!workspaceId) {
      throw new Error("hosted-inbound: `target.workspaceId` is required.");
    }
    const conversationKey =
      typeof target.conversationKey === "string" ? target.conversationKey.trim() : "";
    if (!conversationKey) {
      throw new Error("hosted-inbound: `target.conversationKey` is required.");
    }
    normalizedTarget = { workspaceId, conversationKey };
  } else {
    const key = _TARGET_KEY[channel];
    const dest = target[key];
    const destGiven = dest != null && String(dest).trim() !== "";
    if (!destGiven) {
      throw new Error(`hosted-inbound: \`target.${key}\` is required.`);
    }

    normalizedTarget = { [key]: dest };
    if (target.conversationId != null) {
      normalizedTarget.conversationId = target.conversationId;
    }
    if (target.messageThreadId != null) {
      normalizedTarget.messageThreadId = target.messageThreadId;
    }
  }

  const auth = raw.auth;
  if (auth == null || typeof auth !== "object" || Array.isArray(auth)) {
    throw new Error("hosted-inbound: `auth` is required and must be an object.");
  }

  // Console (#1288) may carry the gateway model id the sender picked, a
  // top-level sibling of `target` (NOT inside it — the console target stays
  // exactly `{ workspaceId, conversationKey }`). It rides through so the
  // console channel can observe which model was requested; the actual model a
  // turn runs on is whatever THIS Jace instance was booted with (Eve has no
  // per-turn model override — the console dispatcher does the real switch by
  // routing to a differently-pinned Jace host). Included only when a non-empty
  // string; absent for every other channel.
  const model = typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : undefined;

  const normalized = { channel, message, target: normalizedTarget, auth };
  if (model) normalized.model = model;
  return normalized;
}
