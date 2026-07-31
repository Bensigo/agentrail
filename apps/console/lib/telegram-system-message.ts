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
 * `messageThreadId` (subscription-platform spec §6, "delivery trap #2":
 * `docs/superpowers/specs/2026-07-29-subscription-platform-design.md`) is
 * forwarded straight through to `sendTelegramMessage`'s own 5th param, which
 * owns the actual validation (numeric-string check, `message_thread_id` body
 * key — see that function's own doc-comment); this wrapper does no parsing
 * of its own. Until this fix the value was accepted but silently discarded
 * (`void messageThreadId`), even though `channel-dispatch.ts`'s
 * `sendSystemChannelMessage` is already fully wired to carry a real one
 * through from the inbound row's payload the moment one is ever present.
 * NOTE: as of this fix, neither Telegram inbound door
 * (`connectors/telegram/webhook/route.ts` nor
 * `runner/telegram-inbound/route.ts`) actually captures a forum-topic id
 * off the inbound Telegram Update yet, so this closes the drop but not the
 * full loop — nothing upstream populates `messageThreadId` on a real row
 * today, so this fix has no observable effect until a follow-up reads
 * `message.message_thread_id` off the webhook payload and enqueues it.
 * `replyMarkup` is explicitly passed as `undefined` below to reach the 5th
 * slot — this wrapper has no keyboard of its own to offer.
 */
export async function sendSystemTelegramMessage(
  chatId: string,
  text: string,
  messageThreadId?: string
): Promise<SendResult> {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) {
    return { ok: false, error: "TELEGRAM_BOT_TOKEN is not configured." };
  }
  return sendTelegramMessage(token, chatId, text, undefined, messageThreadId);
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
