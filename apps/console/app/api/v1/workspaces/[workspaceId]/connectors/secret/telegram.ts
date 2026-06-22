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

export type WebhookResult = { ok: true } | { ok: false; error: string };

/** A raw Telegram `Update` as returned by `getUpdates`. We only type the slice
 * the poller forwards to `decideReply` plus the `update_id` the cursor needs. */
export interface TelegramRawUpdate {
  update_id: number;
  message?: { text?: unknown; chat?: { id?: unknown } };
}

export type GetUpdatesResult =
  | { ok: true; updates: TelegramRawUpdate[] }
  | { ok: false; error: string };

/**
 * Long-poll the Bot API `getUpdates` for new updates (local-dev inbound mode).
 *
 * `offset` is the standard Telegram cursor: pass `lastUpdateId + 1` to confirm
 * receipt of everything before it (Telegram then drops those server-side) and
 * only return newer updates. We constrain `allowed_updates` to `message` to match
 * the webhook registration and trim noise. Best-effort: a transport blip or a
 * Telegram-side rejection is surfaced as a typed error (never thrown) so the
 * poller's loop can log + continue rather than crash.
 *
 * NOTE: getUpdates and a registered webhook are mutually exclusive — Telegram
 * returns 409 (ok:false) while a webhook is set. {@link deleteTelegramWebhook}
 * clears it first so polling works on localhost.
 */
export async function getTelegramUpdates(
  token: string,
  offset?: number
): Promise<GetUpdatesResult> {
  try {
    const res = await fetchWithTimeout(apiUrl(token, "getUpdates"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(typeof offset === "number" ? { offset } : {}),
        timeout: 0,
        allowed_updates: ["message"],
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      description?: string;
      result?: unknown;
    };
    if (!body?.ok || !Array.isArray(body.result)) {
      return {
        ok: false,
        error: body?.description || "Telegram rejected getUpdates.",
      };
    }
    // Keep only well-formed updates (a numeric update_id is required to advance
    // the cursor); a malformed row is dropped, not fatal.
    const updates = (body.result as unknown[]).filter(
      (u): u is TelegramRawUpdate =>
        typeof u === "object" &&
        u !== null &&
        typeof (u as { update_id?: unknown }).update_id === "number"
    );
    return { ok: true, updates };
  } catch {
    return { ok: false, error: "Couldn't reach Telegram for getUpdates." };
  }
}

/**
 * Remove any registered inbound webhook for this bot. The local-dev poller calls
 * this once on startup because getUpdates returns 409 while a webhook is set.
 * Harmless when no webhook exists (Telegram returns ok:true). Best-effort.
 */
export async function deleteTelegramWebhook(token: string): Promise<WebhookResult> {
  try {
    const res = await fetchWithTimeout(apiUrl(token, "deleteWebhook"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Drop any updates buffered against the webhook so polling starts clean.
      body: JSON.stringify({ drop_pending_updates: false }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      description?: string;
    };
    if (!body?.ok) {
      return {
        ok: false,
        error: body?.description || "Telegram rejected deleteWebhook.",
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't reach Telegram to delete the webhook." };
  }
}

/**
 * Register the inbound webhook with Telegram (#889). Telegram will POST updates
 * to `url` and echo `secretToken` in the `X-Telegram-Bot-Api-Secret-Token`
 * header of every delivery, which the webhook route validates per-workspace.
 *
 * Best-effort by contract: the caller (connect handler) treats a failure as a
 * warning, never a connect blocker — a missing inbound path must not stop the
 * outbound channel from being saved.
 */
export async function setTelegramWebhook(
  token: string,
  url: string,
  secretToken: string
): Promise<WebhookResult> {
  try {
    const res = await fetchWithTimeout(apiUrl(token, "setWebhook"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        secret_token: secretToken,
        // Only the update types we act on; trims noise + keeps the bot scoped.
        allowed_updates: ["message"],
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      description?: string;
    };
    if (!body?.ok) {
      return {
        ok: false,
        error: body?.description || "Telegram rejected the webhook registration.",
      };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: "Couldn't reach Telegram to register the webhook.",
    };
  }
}
