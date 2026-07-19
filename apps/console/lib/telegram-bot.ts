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
