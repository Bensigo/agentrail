/**
 * The landing page's primary CTA resolution (#1279 PR ①, controller ruling
 * "CTA: REPLACE"). Message Jace on Telegram is the primary action whenever
 * the hosted shared bot is configured; when it isn't (a self-host/dev
 * deploy with no `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME`), the CTA falls back to
 * GitHub sign-in with honest copy — never a dead link.
 *
 * Pure and unit-testable without rendering `page.tsx` (a React Server
 * Component, which pulls in `@agentrail/auth`/`@agentrail/db-postgres` at
 * import time) — mirrors the split already used by the setup wizard's
 * `channel-step.tsx` + `channel-step-helpers.ts`.
 *
 * Telegram is the only open chat door today (#1262/#1263 shipped; #1261
 * chat-identity spine). A multi-channel picker (Discord/Slack/iMessage)
 * arrives with W5 — see
 * `docs/superpowers/plans/2026-07-17-jace-e2e-arc-issues.md`. Until then this
 * intentionally renders one plain path, no picker component.
 */

import { resolveHostedBotUsername, telegramDeepLink } from "../../lib/telegram-bot";

export interface MessageJaceCta {
  kind: "telegram" | "sign-in";
  /** Only set when `kind === "telegram"`. */
  href?: string;
  /** Only set when `kind === "telegram"`. */
  botUsername?: string;
}

/**
 * Resolve the landing page's primary CTA from the build-time-inlined
 * `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` env value. Deterministic, no I/O.
 */
export function resolveMessageJaceCta(envBotUsername: string | undefined): MessageJaceCta {
  const botUsername = resolveHostedBotUsername(envBotUsername);
  if (botUsername) {
    return { kind: "telegram", href: telegramDeepLink(botUsername), botUsername };
  }
  return { kind: "sign-in" };
}
