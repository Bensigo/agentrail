/**
 * Discord notify sender (server-only) — the console port of the legacy Python
 * Discord adapter (`agentrail/connectors/discord.py`) into the self-hosted-runner
 * model.
 *
 * Discord is a **notify** gateway: it surfaces a run's terminal Run Outcome on a
 * configured channel via an incoming webhook. Unlike Slack/Telegram (whose
 * credential lives in the write-only `connectors.secret`), Discord keeps its
 * webhook URL on the workspace row (`workspaces.discord_webhook_url`) — so this
 * sender takes the webhook URL directly rather than a bot token.
 *
 * The delivery is a single stdlib `fetch` POST of `{ content: text }`, the shape
 * a Discord incoming webhook expects. Best-effort by contract: a transport blip
 * or a Discord-side rejection is surfaced as a typed result (never thrown) so the
 * run-outcome notify caller can keep it best-effort. Mirrors
 * `secret/telegram.ts`'s `sendTelegramMessage`.
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

export type SendResult = { ok: true } | { ok: false; error: string };

/**
 * Post a message to a Discord channel via its incoming webhook. `webhookUrl` is
 * the workspace's stored `discord.com/api/webhooks/…` URL; `text` is the built
 * Run-Outcome line. Returns a typed result — a non-2xx response or a transport
 * error is surfaced (never thrown) so callers stay best-effort.
 */
export async function sendDiscordMessage(
  webhookUrl: string,
  text: string
): Promise<SendResult> {
  try {
    const res = await fetchWithTimeout(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text }),
    });
    // Discord returns 204 (no content) on a successful webhook post; any 2xx is
    // fine. A 4xx/5xx (bad/removed webhook) is a soft failure, not an exception.
    if (!res.ok) {
      return {
        ok: false,
        error:
          "Discord rejected the webhook post — check the channel webhook is still valid, then retry.",
      };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: "Couldn't reach Discord to send the message — try again.",
    };
  }
}
