/**
 * The hosted shared Telegram bot's pure helpers (#1262 PR ③, lifted #1279
 * PR ①). Originally lived in the setup wizard's `channel-step-helpers.ts`;
 * moved here so the landing page's Message-Jace CTA can share the exact same
 * env-driven logic as the onboarding wizard's channel step, instead of a
 * second hand-rolled copy that could drift. `channel-step-helpers.ts`
 * re-exports both names unchanged — zero churn for the wizard lane.
 */

/**
 * Whether the hosted shared-bot flow should render, and its username.
 * `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` unset or blank (self-host default)
 * means the caller should fall back to its own honest non-Telegram path
 * (the wizard's bring-your-own-bot form; the landing page's GitHub sign-in
 * CTA) — never a dead link.
 */
export function resolveHostedBotUsername(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

/** The shared bot's Telegram deep link, e.g. `https://t.me/jace_bot`. */
export function telegramDeepLink(botUsername: string): string {
  return `https://t.me/${botUsername}`;
}

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
 * Moved here from `channel-step-helpers.ts` at merge time, exactly as that
 * file's own note prescribed, once #1279's lift of the two helpers above
 * landed — one canonical module, no duplicated env logic.
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
