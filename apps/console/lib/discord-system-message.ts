/**
 * Console-side Discord SYSTEM sends (#1284, mirroring #1262 PR ②'s
 * `telegram-system-message.ts`) — messages the dispatcher
 * (`channel-dispatch.ts`) posts directly, model-free: the multi-workspace
 * "which one is this about?" ask and its pin confirmation (same spec §4.2
 * flow Telegram already has). These are NOT model turns — Eve never sees
 * them — so they go straight to the Discord Bot API via
 * `sendDiscordChannelMessage`, distinctly from the Eve-turn path that replies
 * through Jace's own native discord channel.
 *
 * Resolves its OWN token from `DISCORD_BOT_TOKEN` — the shared hosted bot has
 * exactly one token, console-wide (deploy/.env.production.example, next to
 * `DISCORD_PUBLIC_KEY`) — matching the Telegram system-message module's
 * convention exactly.
 */
import { sendDiscordChannelMessage, type SendResult } from "./discord-bot";

/**
 * Post a system (non-model) message to `channelId` via the shared hosted
 * bot. Returns a typed failure — never throws — when `DISCORD_BOT_TOKEN` is
 * unset or the send itself fails.
 */
export async function sendSystemDiscordMessage(
  channelId: string,
  text: string
): Promise<SendResult> {
  const token = process.env["DISCORD_BOT_TOKEN"];
  if (!token) {
    return { ok: false, error: "DISCORD_BOT_TOKEN is not configured." };
  }
  return sendDiscordChannelMessage(token, channelId, text);
}
