/**
 * Landing "also available on" channel cards (#1284 + #1285 PR ②) — SEPARATE
 * from `_cta.ts`'s primary Message-Jace CTA (Telegram, #1279), which stays
 * untouched. Discord (#1284) and Slack (#1285) each contribute their own
 * resolver to this file.
 *
 * HONESTY GATE (the arc's landing-honesty rule, AC2 on both #1284 and
 * #1285): a channel card must never claim a channel is live before a real
 * conversation on that channel has been verified on PROD. Code-complete is
 * NOT the same as verified — each channel's PR ① wires the inbound door end
 * to end against MOCKED platform APIs; it has never talked to the real
 * Discord/Slack API. So each resolver is gated behind an EXPLICIT "verified"
 * flag (`NEXT_PUBLIC_DISCORD_CHANNEL_LIVE` / `NEXT_PUBLIC_SLACK_CHANNEL_LIVE`),
 * separate from and in ADDITION to "is a bot/app configured" (the invite/
 * install URL alone is not enough to render the card) — unlike `_cta.ts`'s
 * Telegram CTA, which only checks "is a bot configured" because Telegram's
 * channel was ALREADY prod-verified when that CTA shipped (#1262/#1263).
 *
 * Both env vars per channel default unset, so each resolver returns `null`
 * and the landing page renders NOTHING extra today — zero visual diff until
 * the owner does two things: (1) supplies the invite/install URL and (2)
 * flips `NEXT_PUBLIC_*_CHANNEL_LIVE=true` — that second flip is the ONE-LINE
 * change this rule promises, and it must only happen AFTER a real
 * conversation has been verified on prod (the epic #1257 checklist's
 * deferred evidence item).
 *
 * Pure and unit-testable without rendering `page.tsx`, mirroring `_cta.ts`'s
 * own split.
 */

export interface ChannelCard {
  id: string;
  label: string;
  href: string;
}

function isTrue(value: string | undefined): boolean {
  return (value ?? "").trim().toLowerCase() === "true";
}

/**
 * Resolve the Discord "also available on" card. Returns `null` (render
 * nothing) unless BOTH the invite URL is configured AND the channel has been
 * explicitly flagged live post-verification — never a dead link, and never
 * a claim ahead of the evidence.
 */
export function resolveDiscordChannelCard(env: {
  live: string | undefined;
  inviteUrl: string | undefined;
}): ChannelCard | null {
  if (!isTrue(env.live)) return null;
  const href = env.inviteUrl?.trim();
  if (!href) return null;
  return { id: "discord", label: "Message Jace on Discord", href };
}

/**
 * Resolve the Slack "also available on" card. Returns `null` (render
 * nothing) unless BOTH the install URL is configured AND the channel has
 * been explicitly flagged live post-verification — never a dead link, and
 * never a claim ahead of the evidence.
 */
export function resolveSlackChannelCard(env: {
  live: string | undefined;
  installUrl: string | undefined;
}): ChannelCard | null {
  if (!isTrue(env.live)) return null;
  const href = env.installUrl?.trim();
  if (!href) return null;
  return { id: "slack", label: "Add Jace to Slack", href };
}
