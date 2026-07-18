/**
 * Console-side Telegram SYSTEM sends (issue #1262 PR ②) — messages the
 * dispatcher (`channel-dispatch.ts`) posts directly, model-free: the
 * multi-workspace "which one is this about?" ask and its pin confirmation
 * (spec §4.2). These are NOT model turns — Eve never sees them — so they
 * are sent straight to the Telegram Bot API, distinctly from the Eve-turn
 * path that replies through Jace's own sender.
 *
 * `sendSystemTelegramMessage` reuses `sendTelegramMessage`'s HTTP mechanics
 * (the same timeout + typed-result plumbing every other console Telegram
 * sender already shares — see `notify.ts`'s `notifyTelegram`) rather than
 * duplicating them. It resolves its OWN token from `TELEGRAM_BOT_TOKEN`
 * instead of taking one as a parameter: unlike the legacy per-workspace
 * connector flow, the shared hosted bot has exactly one token, console-wide
 * (deploy/.env.production.example, next to `TELEGRAM_WEBHOOK_SECRET_TOKEN`).
 */
import { sendTelegramMessage, type SendResult } from "../app/api/v1/workspaces/[workspaceId]/connectors/secret/telegram";

/**
 * Post a system (non-model) message to `chatId` via the shared hosted bot.
 * Returns a typed failure — never throws — when `TELEGRAM_BOT_TOKEN` is
 * unset or the send itself fails, matching `sendTelegramMessage`'s own
 * best-effort contract.
 *
 * `messageThreadId` is accepted for signature parity with a future
 * forum-thread reply path (v1's door is DM-first — see
 * annex-eve-internals.md point 5 — so channel_inbox never carries one
 * today), but is not yet forwarded: `sendTelegramMessage` has no thread
 * parameter, and adding one is out of this PR's surface
 * (packages/db-postgres queries are frozen here; this file only reuses
 * the existing connector helper as-is).
 */
export async function sendSystemTelegramMessage(
  chatId: string,
  text: string,
  messageThreadId?: string
): Promise<SendResult> {
  void messageThreadId;
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) {
    return { ok: false, error: "TELEGRAM_BOT_TOKEN is not configured." };
  }
  return sendTelegramMessage(token, chatId, text);
}

/** One reachable workspace, as rendered in the choice list (structural — no db-postgres dependency). */
export interface WorkspaceChoiceOption {
  name: string;
}

/**
 * The multi-workspace disambiguation "ask" (spec §4.2): short, numbered,
 * plain text (no markdown risk over Telegram).
 */
export function buildWorkspaceChoiceMessage(
  options: readonly WorkspaceChoiceOption[]
): string {
  const lines = options.map((option, index) => `${index + 1}. ${option.name}`);
  return [
    `You're in ${options.length} workspaces. Which one is this about?`,
    ...lines,
    "Reply with a number or the name.",
  ].join("\n");
}

/** One-line confirmation once a conversation is pinned to a workspace. */
export function buildPinConfirmationMessage(workspaceName: string): string {
  return `Got it — this conversation is now about ${workspaceName}.`;
}
