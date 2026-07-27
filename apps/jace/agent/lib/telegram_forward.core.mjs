// Pure, dependency-free core for normalizing an inbound Telegram Update and
// forwarding it to the console's OWN intake — the same "normalize, then POST"
// shape as discord_gateway.core.mjs's admitted-message -> discord-inbound
// path, applied to the OTHER native channel door Jace still mounts directly:
// /eve/v1/telegram (agent/channels/telegram.ts) turns a raw Telegram Update
// straight into an Eve turn today, with zero workspace resolution — the
// console's OWN Telegram webhook
// (apps/console/app/api/v1/connectors/telegram/webhook/route.ts) already
// does that resolution (resolveInboundChatIdentity, enqueueChannelMessage,
// chat-identity binding) for every update Telegram is actually pointed at.
// Whichever URL `setWebhook` points at is what silently decides whether a
// conversation is resolvable at all — this module is the fix: shape what
// Jace's listener saw into a normalized body, and POST it to the console,
// rather than ever answering the update locally. No channel wiring lives
// here — this is only the pure decision + transport shim; the next task
// wires it into agent/channels/telegram.ts.
//
// Two concerns:
//   1. Update shaping — is there message text at all, and what body does the
//      console's telegram-inbound intake expect?
//   2. Console transport — POST that body, mirroring
//      console_chat_reply.core.mjs / discord_gateway.core.mjs's injected-
//      `transport` pattern: never throws, never retries, a failed forward is
//      reported, not re-attempted.
//
// Same env resolution as every other Jace->console core module
// (JACE_CONSOLE_BASE_URL / JACE_CONSOLE_TOKEN); deliberately duplicated
// verbatim rather than imported from console_chat_reply.core.mjs /
// discord_gateway.core.mjs — see discord_gateway.core.mjs's own header note
// on why each core module here stays dependency-free of the others.

// --- 1. Update shaping -------------------------------------------------------

/**
 * Telegram's `from.username`, else "first_name last_name" trimmed — the SAME
 * fallback chain the console's own Telegram webhook already uses
 * (`displayNameFor` in
 * apps/console/app/api/v1/connectors/telegram/webhook/route.ts), kept
 * consistent so a sender's display name never depends on which Telegram door
 * delivered the update. `Array#join` treats a missing/undefined
 * `first_name`/`last_name` as `""` rather than the string `"undefined"`, so
 * this is safe even when only one of the two is present.
 */
function displayNameFor(from) {
  return from?.username ?? [from?.first_name, from?.last_name].join(" ").trim();
}

/**
 * Shape a raw Telegram `Update` (the exact JSON body Telegram POSTs to a
 * webhook — https://core.telegram.org/bots/api#update) into the body the
 * console's telegram-inbound intake expects, or refuse it with a reason.
 * Never throws.
 *
 * Admits `message` and `edited_message` only — the two update kinds that can
 * ever carry a conversational text turn. Anything else (my_chat_member,
 * channel_post, callback_query, …) is refused, same as this door's console-
 * side sibling ignores update kinds it does not process. A message/
 * edited_message missing `chat`/`from`/`message_id`, or carrying neither
 * `text` nor `caption` (a bare photo, sticker, location, …), is refused too —
 * refusing here means `forwardTelegramInbound` never makes a network call
 * for any of these, exactly like `admitMessage` short-circuits
 * discord_gateway.core.mjs's transport call.
 *
 * @param {unknown} update
 * @returns {{ ok: true, body: { chatId: string, messageId: string,
 *   senderId: string, senderDisplay: string, senderUsername: string | null,
 *   text: string } } | { ok: false, reason: string }}
 */
export function shapeTelegramInbound(update) {
  if (!update || typeof update !== "object") {
    return { ok: false, reason: "malformed update" };
  }

  const message = update.message ?? update.edited_message;
  if (!message || typeof message !== "object") {
    return { ok: false, reason: "no message in update" };
  }

  const chat = message.chat;
  if (!chat || typeof chat !== "object" || chat.id == null) {
    return { ok: false, reason: "missing chat" };
  }

  const from = message.from;
  if (!from || typeof from !== "object" || from.id == null) {
    return { ok: false, reason: "missing sender" };
  }

  if (message.message_id == null) {
    return { ok: false, reason: "missing message id" };
  }

  const rawText =
    typeof message.text === "string"
      ? message.text
      : typeof message.caption === "string"
        ? message.caption
        : "";
  const text = rawText.trim();
  if (!text) {
    return { ok: false, reason: "no message text" };
  }

  const senderUsername = typeof from.username === "string" ? from.username : null;

  return {
    ok: true,
    body: {
      chatId: String(chat.id),
      messageId: String(message.message_id),
      senderId: String(from.id),
      senderDisplay: displayNameFor(from),
      senderUsername,
      text,
    },
  };
}

// --- 2. Jace -> console transport (mirrors discord_gateway.core.mjs) --------

export const TELEGRAM_INBOUND_PATH = "/api/v1/runner/telegram-inbound";

/**
 * Resolve the console endpoint + bearer from the environment. Trims both,
 * strips a trailing slash from the base URL, and reports which var(s) are
 * missing. Same two vars, same shape, same behavior as
 * console_chat_reply.core.mjs's / discord_gateway.core.mjs's own console-
 * config resolver — duplicated rather than imported (see this file's header
 * comment).
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ ok: true, baseUrl: string, token: string } | { ok: false, missing: string[] }}
 */
export function resolveConsoleConfig(env = {}) {
  const baseUrl = String(env.JACE_CONSOLE_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const token = String(env.JACE_CONSOLE_TOKEN ?? "").trim();
  const missing = [];
  if (!baseUrl) missing.push("JACE_CONSOLE_BASE_URL");
  if (!token) missing.push("JACE_CONSOLE_TOKEN");
  if (missing.length) return { ok: false, missing };
  return { ok: true, baseUrl, token };
}

/** Build the telegram-inbound URL. */
export function buildTelegramInboundUrl(baseUrl) {
  return `${baseUrl}${TELEGRAM_INBOUND_PATH}`;
}

/**
 * Normalize a raw Telegram Update and POST it to the console's telegram-
 * inbound door. NEVER throws: a malformed/textless update, missing console
 * config, a network error, and a non-2xx response all resolve to a typed
 * `{ ok: false, reason }` the caller can log and move on from — exactly like
 * `postDiscordInboundMessage`'s contract, just with `reason` in place of
 * `error` (this module's declared return type). Never retries; a failed
 * forward is reported, not re-attempted.
 *
 * Order of checks matters for the "no network call" guarantee: shaping is
 * checked BEFORE console config, so a textless/malformed update is refused
 * without ever touching `transport`, even when config is present.
 *
 * @param {{
 *   env?: Record<string, string|undefined>,
 *   update: unknown,
 *   transport: (url: string, init: { method: string, headers: Record<string,string>, body: string }) =>
 *     Promise<{ status: number }>,
 * }} args
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
export async function forwardTelegramInbound({ env = {}, update, transport }) {
  const shaped = shapeTelegramInbound(update);
  if (!shaped.ok) {
    return { ok: false, reason: shaped.reason };
  }

  const cfg = resolveConsoleConfig(env);
  if (!cfg.ok) {
    return { ok: false, reason: "config_missing" };
  }

  let res;
  try {
    res = await transport(buildTelegramInboundUrl(cfg.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.token}`,
      },
      body: JSON.stringify(shaped.body),
    });
  } catch (err) {
    return {
      ok: false,
      reason: `telegram-inbound: request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (res.status < 200 || res.status >= 300) {
    return { ok: false, reason: `telegram-inbound: console returned ${res.status}` };
  }

  return { ok: true };
}
