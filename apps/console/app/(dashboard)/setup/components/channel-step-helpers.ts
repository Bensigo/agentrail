/**
 * Pure helpers for the setup wizard's channel step (#1262 PR ③) — hosted vs.
 * self-host Telegram rendering. Split out of `channel-step.tsx` so the
 * env-driven branch decision is unit-testable without a DOM, mirroring how
 * `connector-helpers.ts` keeps its pure model separate from the client form.
 *
 * `resolveHostedBotUsername`/`telegramDeepLink` themselves now live in
 * `apps/console/lib/telegram-bot.ts` (#1279 PR ①) — lifted so the landing
 * page's Message-Jace CTA can share the exact same env-driven logic instead
 * of a second hand-rolled copy. Re-exported here unchanged so this file's
 * import path, and every existing caller/test, needs zero changes.
 */
export { resolveHostedBotUsername, telegramDeepLink } from "../../../../lib/telegram-bot";

/**
 * Self-host BYO-bot docs — the jace README's Channels section, where the
 * "Hosted vs self-host" note (added alongside this PR) sits next to the
 * existing BotFather + setWebhook instructions.
 */
export const SELF_HOST_TELEGRAM_DOCS_URL =
  "https://github.com/Bensigo/agentrail/blob/main/apps/jace/README.md#hosted-vs-self-host";

export interface MessageJaceTarget {
  href: string;
  /** True when `href` deep-links the hosted Telegram bot directly (open in
   * a new tab); false when it falls back to the setup wizard (same-tab
   * internal navigation). */
  external: boolean;
}

/**
 * Where a "Message Jace" affordance should point (#1281 AC2 — Home/Work
 * dead-end copy dies). The hosted shared bot's deep link when the env is
 * set; otherwise there's no bot to message yet (self-host default), so it
 * falls back to the setup wizard's channel step. Home's digest card and
 * Work's empty state both call this so they point the same way.
 *
 * TEMPORARY location: this belongs with `resolveHostedBotUsername`/
 * `telegramDeepLink` above, which are setup-wizard-local today. If the
 * #1279 landing lane lifts these into a shared `lib/telegram-bot.ts`, this
 * function should move there too — do not duplicate the lift here.
 */
export function messageJaceTarget(
  hostedBotUsernameEnv: string | undefined,
  workspaceId: string
): MessageJaceTarget {
  const botUsername = resolveHostedBotUsername(hostedBotUsernameEnv);
  return botUsername
    ? { href: telegramDeepLink(botUsername), external: true }
    : { href: `/setup?workspace=${workspaceId}`, external: false };
}
