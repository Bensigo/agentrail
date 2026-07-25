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
export {
  resolveHostedBotUsername,
  telegramDeepLink,
  messageJaceTarget,
  SELF_HOST_TELEGRAM_DOCS_URL,
  type MessageJaceTarget,
} from "../../../../lib/telegram-bot";

// `messageJaceTarget`/`MessageJaceTarget` moved to `lib/telegram-bot.ts` at
// merge time (see the note there) — re-exported above so every existing
// caller/test keeps its import path. `SELF_HOST_TELEGRAM_DOCS_URL` joined
// them there in the gateways-page whole-branch-review fix wave, for the same
// reason: the Gateways page needed it too (`gateways-panel.tsx` imports it
// directly from `lib/telegram-bot.ts`).
