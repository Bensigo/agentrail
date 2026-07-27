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

// --- 1b. Group/supergroup mention gate (mirrors discord_gateway.core.mjs) ---
//
// eve's own `defaultOnMessage` (the handler this shim REPLACES the moment
// JACE_TELEGRAM_FORWARD_TO_CONSOLE is on) gates every `group`/`supergroup`
// message it dispatches through its `shouldDispatchTelegramMessage`: admitted
// ONLY as a bot command, an explicit `@botUsername` mention, or a reply to
// one of the bot's own messages — a `private` chat has no gate at all.
// `shapeTelegramInbound` otherwise has no admission logic of its own — it
// shapes and forwards every message carrying text — so flipping the flag
// would silently make Jace answer every message in every group it is in.
// `admitTelegramMessage` restores that gate for this forward path, the same
// way `admitMessage` gates discord_gateway.core.mjs's forward path. Operates
// on the RAW Telegram `Message` shape (snake_case `reply_to_message.from.is_bot`),
// since that is what this core receives — never eve's own camelCase
// `TelegramMessage`.

/**
 * True iff `text` opens with a Telegram bot-command token (`/foo` or
 * `/foo@bot`) — eve's own `shouldDispatchTelegramMessage` treats a bare
 * `/foo` (no `@target`) as always-admitted in a group regardless of
 * `botUsername`; mirrored here with the same lenient token check rather than
 * re-deriving eve's `@target` disambiguation.
 */
function isBotCommand(text) {
  return /^\/[A-Za-z0-9_]/.test(text);
}

/**
 * True iff `text` contains `@<botUsername>` (case-insensitive) — the same
 * plain substring check eve's own `mentionsBot` uses. Telegram already
 * resolves an `@mention` typed in a group message into literal text in
 * `message.text`, so no entity/offset parsing is needed.
 */
function mentionsBotUsername(text, botUsername) {
  if (!botUsername) return false;
  return text.toLowerCase().includes(`@${botUsername.toLowerCase()}`);
}

/**
 * True iff this message is a reply to one of the bot's own messages —
 * Telegram's raw `reply_to_message.from.is_bot` field. Like eve's own
 * `shouldDispatchTelegramMessage` (`replyToMessage?.from?.isBot === true`),
 * this cannot distinguish OUR bot from some other bot in the same group; the
 * looseness is mirrored intentionally for parity rather than tightened here.
 */
function isReplyToBot(message) {
  return message?.reply_to_message?.from?.is_bot === true;
}

/**
 * The admission gate `shapeTelegramInbound` applies before ever shaping a
 * message for the console — see this section's header comment for why it
 * exists. A `private` chat always admits. Any chat type other than
 * `private`/`group`/`supergroup` (e.g. `channel`) is refused outright, same
 * as eve refuses `channel` unconditionally. A `group`/`supergroup` message
 * admits only as a bot command, an `@botUsername` mention, or a reply to the
 * bot; anything else is refused.
 *
 * @param {{ chat?: { type?: string }, text?: string, caption?: string,
 *   reply_to_message?: { from?: { is_bot?: boolean } } }} message
 * @param {string | null | undefined} botUsername
 * @returns {boolean}
 */
export function admitTelegramMessage(message, botUsername) {
  const chatType = message?.chat?.type;
  if (chatType === "private") return true;
  if (chatType !== "group" && chatType !== "supergroup") return false;
  const text =
    typeof message?.text === "string"
      ? message.text
      : typeof message?.caption === "string"
        ? message.caption
        : "";
  return isBotCommand(text) || mentionsBotUsername(text, botUsername) || isReplyToBot(message);
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
 * discord_gateway.core.mjs's transport call. A `group`/`supergroup` message
 * that fails `admitTelegramMessage`'s mention gate is refused the same way,
 * for the same "no network call" reason.
 *
 * `botUsername` must be injected by the caller (via this second argument) —
 * this module never reads `process.env` directly; see
 * `forwardTelegramInbound`, which threads it through from its own `env`.
 *
 * @param {unknown} update
 * @param {{ botUsername?: string | null }} [options]
 * @returns {{ ok: true, body: { chatId: string, messageId: string,
 *   senderId: string, senderDisplay: string, senderUsername: string | null,
 *   text: string } } | { ok: false, reason: string }}
 */
export function shapeTelegramInbound(update, { botUsername } = {}) {
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

  if (!admitTelegramMessage(message, botUsername)) {
    return {
      ok: false,
      reason: "not admitted: group/supergroup message without a command, mention, or reply to the bot",
    };
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
 * Order of checks matters for the "no network call" guarantee: shaping
 * (including the group/supergroup mention gate) is checked BEFORE console
 * config, so a textless/malformed/un-admitted update is refused without ever
 * touching `transport`, even when config is present.
 *
 * `env.TELEGRAM_BOT_USERNAME` (trimmed; the same var
 * `agent/channels/telegram.ts` already reads for eve's own `botUsername`
 * config) is threaded through to `shapeTelegramInbound`'s mention gate — this
 * is the one injection point, so the pure core underneath never touches
 * `process.env` itself.
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
  const botUsername =
    typeof env.TELEGRAM_BOT_USERNAME === "string" ? env.TELEGRAM_BOT_USERNAME.trim() || undefined : undefined;
  const shaped = shapeTelegramInbound(update, { botUsername });
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
