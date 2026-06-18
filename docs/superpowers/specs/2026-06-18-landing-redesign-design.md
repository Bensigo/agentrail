# Landing page redesign — design spec

Date: 2026-06-18
Surface: `apps/console/app/(marketing)/page.tsx`

## Problem

The landing page reads as "AI-generated" despite real effort. Not unfinished —
*undifferentiated*. It lands on the default polished-dev-tool template: pill
badges with pulsing dots, uppercase-mono eyebrow labels on every section, a
KPI signal strip, gradient-blur blobs, reveal-on-everything, and jargon-dense
copy ("agent control plane", "compiled context", "review gates it passed").

## Reference DNA (sites the user considers clearly not-AI)

fumadocs.dev, agentmail.to, cursor.com, devin.ai/desktop. Shared traits:

1. **Dark, premium, atmospheric** — near-black with subtle gradient depth, not
   flat-light, not gimmicky-themed.
2. **The real product is the hero** — big, literal product screenshots/UI
   (Cursor's IDE, Devin's boards), not abstract diagrams or metaphors.
3. **Big, confident, plain headlines** — no jargon stack, no decorative
   eyebrow chrome.
4. **Real proof** — recognizable names / real faces. No fabricated logos.
5. **Restraint on chrome, richness in atmosphere** — polish lives in type,
   depth, and product shots, not decorative badges.

## Rejected directions (and why)

- **Rail-world / departure-board metaphor** — skeuomorphic and "trying hard";
  the concept itself read as an AI tell. Dropped.
- **Flat fumadocs-light minimalism** — overcorrected into sterile; dropped the
  brand and atmosphere. Dropped.

## Direction (locked)

Dark, premium, product-led. The console is the hero.

- **Palette:** dark & premium (`--gray-00` near-black base). Overrides the
  prior "lighter marketing" note in `TASTE.md` (updated to match).
- **Brand personality kept** (`TASTE.md`): Inter for chrome/body, Berkeley Mono
  for real machine data only, lemon `#ffe629` as a *single surgical accent*
  (primary CTA, one live indicator) — never glow blobs. Voice: direct,
  concrete, no hype.
- **Hero:** centered, confident, plain headline + one-line sub; primary CTA
  (GitHub) + secondary (docs/demo); the interactive `DashboardDemo` presented
  large as the centerpiece below the copy. Remove the eyebrow pill and the KPI
  signal strip.
- **Atmosphere:** at most one large, soft, low-opacity ambient behind the hero
  — premium depth, not a decorative blob. Judge via screenshot.
- **Motion:** keep `Reveal`/`CountUp` but restrained; no reveal-on-everything.

## Build order

1. Update `TASTE.md` marketing note (dark premium). ✅ part of this change.
2. Rebuild the hero + nav; screenshot at full fidelity; iterate with user.
3. Once the hero is approved, carry the same rules through the rest of the page
   (how-it-works, platform, benchmark, FAQ, footer) — removing eyebrow chrome
   and jargon section by section.

## Out of scope (for now)

Docs + blog (Fumadocs + MDX in-monorepo) — separate follow-up the user already
chose; not part of this redesign.
