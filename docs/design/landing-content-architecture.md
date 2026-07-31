# Landing Content Architecture (context-first)

Decide the content before the UI. This doc is the paper trail for what each
landing section says and why, so copy doesn't drift without a record. Pairs
with `docs/design/redesign-direction.md` (the craft bar). Landing v2 (#1279)
and the subscription-platform pivot
(`docs/superpowers/specs/2026-07-29-subscription-platform-design.md`) have
both shipped — this file now describes the LIVE page, not a pre-build plan.

## The spine — UPDATED 2026-07-29

**AI fractional software engineer, one subscription per team, outcomes not
costs.** Jace is sold as an AI fractional software engineer (hero ruling,
2026-07-22) — one subscription per team, priced by team size (subscription
pivot, owner ruling 2026-07-29, which supersedes this doc's earlier
pay-per-use / "cut your AI-coding cost" spine, dated 2026-06-15). The page
sells engineering outcomes — PRs shipped, capacity included — never model
names, per-task dollars, or a "free" claim.

## Section-by-section: the LIVE landing map (`apps/console/app/(marketing)/page.tsx`)

| Section | What it says |
|---|---|
| Hero | "Hey, I'm Jace" + "The AI fractional software engineer." One CTA: message Jace on Telegram, or sign in. |
| PhoneDemo | The real conversation demo, device-as-stage; every number computed by the live estimate lib; the outcome line carries no `$` (subscription pivot). |
| Use cases | Sticky-stack cards; each one maps to a real product surface. |
| How I work | Full-bleed lemon band; the named 5-step loop (Message / Brief / Approve / Pull request / Merge). |
| Where you'll find me | The channel scene — Telegram, Slack, and Discord as equal panels; every button honesty-gated, never a dead link. |
| The numbers | Live cached stats (`/api/v1/stats`, hourly); documented dogfood baseline + real platform outcomes; failures counted, not hidden. |
| Subscription §6b | "One subscription for your whole team" — plans by team size, monthly engineering capacity stated in tasks; gated `See exact pricing` link to `/pricing`. |
| Pricing (`/pricing`) | **LIVE**: outcome-led tiers by team size (slice 7) — Starter / Growth / Enterprise, per-tier feature lines, capacity explainer, working CTAs (`/login`; `mailto:` for Enterprise). |
| Closing CTA | Jace-wave mascot beside the closing message-Jace ask. |
| footer | Wordmark, docs/GitHub/CLI links, conditional Discord/Slack, sign-in. |

## Open decisions for sign-off

- **Enterprise contact address**: `hello@heyjace.com` (`pricing/page.tsx`'s
  `ENTERPRISE_CONTACT_EMAIL`) — owner must confirm the inbox exists and is
  monitored before the pricing claim goes live.
- **`NEXT_PUBLIC_BILLING_VERIFIED_LIVE` flip timing**: ops flips this once
  AC1 (Stripe test-mode top-up) and AC2 (billing-enabled admission +
  completion charge) are browser-verified on prod (`_pricing-gate.ts`). Not
  part of this slice.
