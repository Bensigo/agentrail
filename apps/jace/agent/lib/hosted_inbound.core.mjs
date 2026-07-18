// Pure, dependency-free core for Jace's hosted-inbound door channel (#1262 PR
// ②) — the AgentRail console's dispatcher hands every claimed `channel_inbox`
// row here so it becomes a real Eve turn via `args.receive(telegram, ...)`.
//
// This module is ONLY the validation + normalization of the console's POST
// body. It imports no Eve runtime and touches no network, so it is
// unit-testable with `node --test`, mirroring run_outcome.core.mjs's split.
// The thin Eve wrapper (`agent/channels/hosted-inbound.ts`) calls
// `args.receive(telegram, normalizeHostedInbound(raw))` and returns the
// session id/continuation token — this file decides WHAT to hand it and
// rejects garbage before that call, since Eve's own telegram `receive` hook
// throws (rather than returning a clean 400) on a missing `target.chatId`
// (see annex-eve-internals.md).
//
// Lives under agent/lib/ which Eve treats as a recognized lib directory:
// helper .mjs modules here are NOT loaded as tools/channels.

/**
 * Validate + normalize the dispatcher's POST body into the exact
 * `{ message, target, auth }` shape `args.receive(telegram, …)` expects.
 * Throws a precise Error on any malformed field so the route can answer
 * `400` with a useful message (the console's payload is a contract, not user
 * input — a bad shape is a wiring bug we want surfaced, not swallowed).
 *
 * - `message` must be a non-empty string (trimmed).
 * - `target` must be an object carrying a non-blank `chatId` (number or
 *   string — Eve's `TelegramReceiveTarget` accepts either). The normalized
 *   target is MINIMAL: only `chatId` plus `conversationId`/`messageThreadId`
 *   when present, so no stray/secret field leaks into the session (same
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

  const message = typeof raw.message === "string" ? raw.message.trim() : "";
  if (!message) {
    throw new Error("hosted-inbound: `message` is required (non-empty string).");
  }

  const target = raw.target;
  if (target == null || typeof target !== "object" || Array.isArray(target)) {
    throw new Error("hosted-inbound: `target` must be an object.");
  }
  const chatId = target.chatId;
  const chatIdGiven = chatId != null && String(chatId).trim() !== "";
  if (!chatIdGiven) {
    throw new Error("hosted-inbound: `target.chatId` is required.");
  }

  const normalizedTarget = { chatId };
  if (target.conversationId != null) {
    normalizedTarget.conversationId = target.conversationId;
  }
  if (target.messageThreadId != null) {
    normalizedTarget.messageThreadId = target.messageThreadId;
  }

  const auth = raw.auth;
  if (auth == null || typeof auth !== "object" || Array.isArray(auth)) {
    throw new Error("hosted-inbound: `auth` is required and must be an object.");
  }

  return { message, target: normalizedTarget, auth };
}
