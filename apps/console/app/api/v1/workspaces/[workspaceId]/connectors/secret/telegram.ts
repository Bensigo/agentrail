/**
 * Telegram connect-time side effects (server-only).
 *
 * Two things the verify step (read-only) does not do:
 *
 *  1. `resolveTelegramChatId` — when the user connects WITHOUT a chat id (a
 *     direct chat with the bot), discover the DM chat id from the bot's recent
 *     updates. Telegram forbids a bot from messaging a user who has not messaged
 *     it first, so the user must have sent the bot a message (e.g. /start); we
 *     read the most recent such chat via `getUpdates`.
 *  2. `sendTelegramWelcome` — post a one-time welcome message so the user gets
 *     immediate, visible confirmation the channel works on connect.
 *
 * Stdlib `fetch` with a timeout, mirroring `verify.ts`. All failures are
 * surfaced as a typed result so the route can return a helpful message rather
 * than throwing.
 */

const TIMEOUT_MS = 8000;

async function fetchWithTimeout(
  url: string,
  init?: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function apiUrl(token: string, method: string): string {
  return `https://api.telegram.org/bot${encodeURIComponent(token)}/${method}`;
}

export type SendResult = { ok: true } | { ok: false; error: string };

// --- inline-keyboard approvals (issue #1273) --------------------------------

/** A single Bot API inline-keyboard button (only the fields this file uses). */
export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data: string;
}

/** A Bot API `reply_markup` inline keyboard (rows of buttons). */
export interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}

/**
 * Shared prefix for every callback_data this seam produces, so the webhook
 * (`connectors/telegram/webhook/route.ts`) can cheaply tell "one of ours" from
 * "Eve's own `eve:`-prefixed HITL button" (which must be forwarded to the
 * sidecar unchanged, not handled here).
 */
export const APPROVAL_CALLBACK_PREFIX = "ar:";

/**
 * Build the Approve/Deny inline keyboard for an approval message.
 * `callbackToken` is `recordApprovalRequest`'s `randomBytes(8).toString("hex")`
 * (16 hex chars) — the flag character right after the prefix (`y`/`n`) is the
 * ONLY thing distinguishing the two buttons' callback_data, since both carry
 * the SAME token (it identifies the approval request, not the decision).
 * Total length (`ar:` + 1 flag char + 16 hex chars = 20 bytes) stays well
 * under Telegram's 64-byte callback_data cap alongside any future prefix
 * growth.
 */
export function buildApprovalKeyboard(
  callbackToken: string
): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        {
          text: "✅ Approve",
          callback_data: `${APPROVAL_CALLBACK_PREFIX}y${callbackToken}`,
        },
        {
          text: "❌ Deny",
          callback_data: `${APPROVAL_CALLBACK_PREFIX}n${callbackToken}`,
        },
      ],
    ],
  };
}

export type ApprovalCallbackDecision = "approved" | "denied";

export interface ParsedApprovalCallback {
  decision: ApprovalCallbackDecision;
  callbackToken: string;
}

/**
 * Decode a callback_query's `data` field back into a decision + token, the
 * exact inverse of {@link buildApprovalKeyboard}. Returns `null` for anything
 * that isn't a well-formed `ar:`-prefixed payload (wrong prefix — including
 * Eve's own `eve:` — missing token, or an unrecognized flag character) so the
 * webhook can fail closed rather than guess.
 */
export function parseApprovalCallbackData(
  data: string
): ParsedApprovalCallback | null {
  if (!data.startsWith(APPROVAL_CALLBACK_PREFIX)) return null;
  const rest = data.slice(APPROVAL_CALLBACK_PREFIX.length);
  const flag = rest.charAt(0);
  const callbackToken = rest.slice(1);
  if (!callbackToken) return null;
  if (flag === "y") return { decision: "approved", callbackToken };
  if (flag === "n") return { decision: "denied", callbackToken };
  return null;
}

/**
 * Post an arbitrary chat message via the Bot API `sendMessage`. The single,
 * shared sender both the welcome (connect-time) and the run-outcome notify
 * (#888) + inbound reply (#889) routes call — the timeout/fetch logic lives in
 * one place. Returns a typed result; a transport blip or a Telegram-side
 * rejection is surfaced (never thrown) so callers can keep it best-effort.
 *
 * `replyMarkup` (issue #1273) is optional and, when omitted, is not just
 * `undefined`-valued but ABSENT from the request body — existing callers
 * (welcome, run-outcome, system messages) send the exact same body they
 * always have.
 */
export async function sendTelegramMessage(
  token: string,
  chatId: string,
  text: string,
  replyMarkup?: TelegramInlineKeyboardMarkup
): Promise<SendResult> {
  try {
    const res = await fetchWithTimeout(apiUrl(token, "sendMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean };
    if (!body?.ok) {
      return {
        ok: false,
        error:
          "The bot can't message that chat — make sure the bot is in the chat and you've messaged it, then retry.",
      };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: "Couldn't reach Telegram to send the message — try again.",
    };
  }
}

export type ChatIdResult =
  | { ok: true; chatId: string }
  | { ok: false; error: string };

/**
 * Resolve the chat id for a direct chat: the most recent chat that has messaged
 * the bot. Returns a helpful error when the bot has no updates (the user has not
 * messaged it yet) or Telegram is unreachable.
 */
export async function resolveTelegramChatId(
  token: string
): Promise<ChatIdResult> {
  try {
    const res = await fetchWithTimeout(apiUrl(token, "getUpdates"));
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: Array<{
        message?: { chat?: { id?: number } };
        my_chat_member?: { chat?: { id?: number } };
      }>;
    };
    if (!body?.ok || !Array.isArray(body.result)) {
      return { ok: false, error: "Telegram rejected this bot token." };
    }
    // Walk newest-first; take the first update that carries a chat id.
    for (let i = body.result.length - 1; i >= 0; i--) {
      const u = body.result[i];
      const id = u.message?.chat?.id ?? u.my_chat_member?.chat?.id;
      if (typeof id === "number") return { ok: true, chatId: String(id) };
    }
    return {
      ok: false,
      error:
        "Couldn't find a chat — open your bot in Telegram and send it a message (e.g. /start), then connect again. Or paste a group/channel chat id.",
    };
  } catch {
    return {
      ok: false,
      error: "Couldn't reach Telegram to resolve the chat — try again.",
    };
  }
}

export type WelcomeResult = SendResult;

/** Post a one-time welcome message confirming the connection. */
export async function sendTelegramWelcome(
  token: string,
  chatId: string
): Promise<WelcomeResult> {
  return sendTelegramMessage(
    token,
    chatId,
    "✅ AgentRail is connected. I'll post run completions and escalation-to-human here. Send /status any time for the queue."
  );
}

/**
 * Acknowledge a callback_query via the Bot API `answerCallbackQuery` (issue
 * #1273). Telegram's inline-keyboard contract requires SOME response to every
 * button tap — until this is called the tapping client shows a loading
 * spinner — so the webhook calls this on every ar:-prefixed callback it
 * handles (found/not-found/sender-mismatch/already-resolved/success alike),
 * `text` is the short toast shown to the tapper; omitted when not supplied
 * (a bare acknowledgment with no visible toast). Never throws.
 */
export async function answerCallbackQuery(
  token: string,
  callbackQueryId: string,
  text?: string
): Promise<SendResult> {
  try {
    const res = await fetchWithTimeout(apiUrl(token, "answerCallbackQuery"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        ...(text ? { text } : {}),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean };
    if (!body?.ok) {
      return {
        ok: false,
        error: "Telegram rejected answerCallbackQuery.",
      };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: "Couldn't reach Telegram to answer the callback — try again.",
    };
  }
}

/**
 * Edit a previously sent message's text via the Bot API `editMessageText`
 * (issue #1273) — how the webhook marks an approval message
 * "✅ Approved by <name>" / "❌ Denied by <name>" in place after a button tap
 * resolves it. `chatId`/`messageId` come straight off the inbound
 * callback_query's own `message.chat.id` / `message.message_id` (v1 keeps no
 * separate storage for the sent message's id — see the webhook route's
 * doc-comment). Never throws.
 */
export async function editMessageText(
  token: string,
  chatId: string | number,
  messageId: string | number,
  text: string
): Promise<SendResult> {
  try {
    const res = await fetchWithTimeout(apiUrl(token, "editMessageText"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean };
    if (!body?.ok) {
      return {
        ok: false,
        error: "Telegram rejected editMessageText.",
      };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: "Couldn't reach Telegram to edit the message — try again.",
    };
  }
}
