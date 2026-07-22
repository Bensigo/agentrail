/**
 * Console-side Slack SYSTEM sends (#1285, mirroring #1284's
 * `discord-system-message.ts` / #1262 PR ②'s `telegram-system-message.ts`) —
 * the multi-workspace "which one is this about?" ask and its pin
 * confirmation, sent straight via the Slack Web API (Eve never sees these —
 * they are not model turns).
 *
 * Resolves its OWN token from `SLACK_BOT_TOKEN` — the shared hosted app has
 * exactly one bot token, console-wide (deploy/.env.production.example, next
 * to `SLACK_SIGNING_SECRET`).
 */
import { sendSlackChannelMessage, type SendResult } from "./slack-bot";

/**
 * Post a system (non-model) message to `channel` via the shared hosted app.
 * Returns a typed failure — never throws — when `SLACK_BOT_TOKEN` is unset
 * or the send itself fails.
 */
export async function sendSystemSlackMessage(
  channel: string,
  text: string
): Promise<SendResult> {
  const token = process.env["SLACK_BOT_TOKEN"];
  if (!token) {
    return { ok: false, error: "SLACK_BOT_TOKEN is not configured." };
  }
  return sendSlackChannelMessage(token, channel, text);
}
