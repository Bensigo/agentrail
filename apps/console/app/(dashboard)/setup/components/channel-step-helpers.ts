/**
 * Pure helpers for the setup wizard's channel step (#1262 PR ③) — hosted vs.
 * self-host Telegram rendering. Split out of `channel-step.tsx` so the
 * env-driven branch decision is unit-testable without a DOM, mirroring how
 * `connector-helpers.ts` keeps its pure model separate from the client form.
 */

/**
 * Whether the hosted shared-bot flow should render, and its username.
 * `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` unset or blank (self-host default)
 * means the existing bring-your-own-bot form renders instead — see
 * `channel-step.tsx`.
 */
export function resolveHostedBotUsername(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

/** The shared bot's Telegram deep link, e.g. `https://t.me/jace_bot`. */
export function telegramDeepLink(botUsername: string): string {
  return `https://t.me/${botUsername}`;
}

/**
 * Self-host BYO-bot docs — the jace README's Channels section, where the
 * "Hosted vs self-host" note (added alongside this PR) sits next to the
 * existing BotFather + setWebhook instructions.
 */
export const SELF_HOST_TELEGRAM_DOCS_URL =
  "https://github.com/Bensigo/agentrail/blob/main/apps/jace/README.md#hosted-vs-self-host";
