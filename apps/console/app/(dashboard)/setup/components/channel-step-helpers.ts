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
