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

/**
 * Post an arbitrary chat message via the Bot API `sendMessage`. The single,
 * shared sender both the welcome (connect-time) and the run-outcome notify
 * (#888) + inbound reply (#889) routes call — the timeout/fetch logic lives in
 * one place. Returns a typed result; a transport blip or a Telegram-side
 * rejection is surfaced (never thrown) so callers can keep it best-effort.
 */
export async function sendTelegramMessage(
  token: string,
  chatId: string,
  text: string
): Promise<SendResult> {
  try {
    const res = await fetchWithTimeout(apiUrl(token, "sendMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
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
