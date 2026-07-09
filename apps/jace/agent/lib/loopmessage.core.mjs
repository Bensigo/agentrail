// Pure, dependency-free core for Jace's native iMessage channel (#1100).
//
// Eve has no first-party iMessage integration, so `agent/channels/imessage.ts`
// is a hand-rolled `defineChannel` over LoopMessage (https://docs.loopmessage.com),
// an Apple-registered iMessage bridge with an HTTP Send API + inbound webhooks.
// This module is ONLY the pure pieces of that channel — request/response shaping
// and the inbound authorization check. It imports no Eve runtime and performs no
// network I/O (the `fetch` lives in the `.ts` wrapper), so it is unit-testable
// with `node --test`, exactly like run_outcome.core.mjs / chat-split.core.mjs.
//
// Lives under agent/lib/, which Eve does not load as a tool/channel.

import { createHash, timingSafeEqual } from "node:crypto";

/** LoopMessage Send API endpoint (verified against the LoopMessage docs). */
export const LOOPMESSAGE_SEND_URL = "https://a.loopmessage.com/api/v1/message/send/";

/**
 * Headers for a LoopMessage Send request. Authorization is the RAW API key value
 * — LoopMessage does NOT use a `Bearer ` prefix (verified against the docs).
 *
 * @param {string} apiKey the LOOPMESSAGE_API_KEY value
 * @returns {Record<string,string>}
 */
export function loopMessageSendHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    Authorization: String(apiKey ?? ""),
  };
}

/**
 * Build the JSON body for a LoopMessage Send request.
 *
 * LoopMessage addresses a message one of two mutually exclusive ways:
 *  - 1:1     → `{ recipient, text, sender_name }` (which registered sender to
 *              send from is required for a direct message).
 *  - group   → `{ group, text }` (the group id from an inbound event already
 *              carries its sender context, so no `sender_name`).
 *
 * @param {{ recipient?: string, group?: string, text?: string, senderName?: string }} [args]
 * @returns {Record<string, string>}
 */
export function buildSendBody({ recipient, group, text, senderName } = {}) {
  const body = { text: String(text ?? "") };
  if (group != null && String(group).trim() !== "") {
    body.group = String(group).trim();
    return body;
  }
  body.recipient = String(recipient ?? "").trim();
  if (senderName != null && String(senderName).trim() !== "") {
    body.sender_name = String(senderName).trim();
  }
  return body;
}

/**
 * Normalize a raw LoopMessage inbound webhook payload into the minimal shape the
 * channel needs. LoopMessage sends many event types over the SAME endpoint
 * (`message_inbound`, `message_scheduled`, `message_failed`, `message_delivered`,
 * `message_reaction`, …) and "may contain additional fields not shown"; this
 * keeps only what a conversational turn requires and lets the caller gate on
 * `event`. Returns `null` for a non-object payload.
 *
 * @param {unknown} raw parsed JSON body of the inbound POST
 * @returns {{ event: string, text: string, contact: string, group: string|null, messageId: string|null }|null}
 */
export function parseLoopInbound(raw) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const event = typeof raw.event === "string" ? raw.event.trim() : "";
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  const contact = typeof raw.contact === "string" ? raw.contact.trim() : "";
  const groupRaw = typeof raw.group === "string" ? raw.group.trim() : "";
  const group = groupRaw !== "" ? groupRaw : null;
  const messageId =
    typeof raw.message_id === "string" && raw.message_id.trim() !== ""
      ? raw.message_id.trim()
      : null;
  return { event, text, contact, group, messageId };
}

/**
 * Whether a parsed inbound event is a real, actionable inbound TEXT message
 * (i.e. should drive a Jace turn). Every other event type — and any empty /
 * addressless payload — is ACKed and ignored by the caller.
 *
 * @param {ReturnType<typeof parseLoopInbound>} parsed
 * @returns {boolean}
 */
export function isActionableInbound(parsed) {
  return (
    !!parsed &&
    parsed.event === "message_inbound" &&
    parsed.text !== "" &&
    (parsed.contact !== "" || parsed.group !== null)
  );
}

/**
 * Parse the LOOPMESSAGE_ALLOWED_HANDLES env into a normalized allowlist Set.
 *
 * A comma-separated list of iMessage senders permitted to drive a Jace turn —
 * 1:1 contact handles (phone/email) and/or group ids. Each entry is trimmed and
 * lowercased so the compare is case-insensitive (email casing, group id casing).
 * An empty / unset / non-string value yields an empty Set, which
 * {@link isAllowedSender} treats as "no allowlist configured" (open).
 *
 * @param {string|null|undefined} raw the LOOPMESSAGE_ALLOWED_HANDLES value
 * @returns {Set<string>}
 */
export function parseAllowedHandles(raw) {
  if (typeof raw !== "string") return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s !== ""),
  );
}

/**
 * Whether a parsed inbound's sender is permitted to drive a Jace turn, given the
 * configured allowlist (#1100 AC4).
 *
 * FAIL OPEN when the allowlist is empty (env unset ⇒ no restriction — the prior
 * behavior; LoopMessage's sandbox already caps to ≤5 approved contacts) and
 * CLOSED to any unlisted sender once it is set. A 1:1 message is matched on its
 * `contact` handle; a group message on the group id (a group is addressed by its
 * id — its individual members are not enumerated on the inbound event). The
 * compare is case-insensitive, mirroring `parseAllowedHandles`.
 *
 * @param {ReturnType<typeof parseLoopInbound>} parsed
 * @param {Set<string>} allowed the allowlist from {@link parseAllowedHandles}
 * @returns {boolean}
 */
export function isAllowedSender(parsed, allowed) {
  if (!parsed) return false;
  if (!allowed || allowed.size === 0) return true;
  const group = parsed.group ? String(parsed.group).trim().toLowerCase() : "";
  if (group !== "") return allowed.has(group);
  const contact = parsed.contact
    ? String(parsed.contact).trim().toLowerCase()
    : "";
  return contact !== "" && allowed.has(contact);
}

/**
 * The channel-owned continuation token for an iMessage conversation. For a 1:1
 * chat the recipient handle IS the thread key; for a group it is the group id.
 * (Eve prepends the channel name itself, so this is just the conversation key.)
 *
 * @param {string|null|undefined} key group id (preferred) or contact handle
 * @returns {string}
 */
export function imessageContinuationToken(key) {
  return String(key ?? "");
}

/**
 * Constant-time verification of an inbound webhook's Authorization header.
 *
 * LoopMessage echoes the dashboard-configured `webhook_header` value verbatim in
 * the `Authorization` header of every event; we compare it to our configured
 * secret. Both sides are SHA-256 digested first so the compare is both
 * constant-time AND length-safe (`timingSafeEqual` throws on unequal lengths).
 * FAIL CLOSED: an empty configured secret (env unset) rejects all inbound, so a
 * misconfigured deploy never accepts unauthenticated webhooks.
 *
 * @param {string} received the incoming Authorization header value
 * @param {string} expected the configured LOOPMESSAGE_WEBHOOK_SECRET_TOKEN
 * @returns {boolean}
 */
export function verifyWebhookAuthorization(received, expected) {
  if (typeof expected !== "string" || expected === "") return false;
  if (typeof received !== "string" || received === "") return false;
  const a = createHash("sha256").update(received, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}
