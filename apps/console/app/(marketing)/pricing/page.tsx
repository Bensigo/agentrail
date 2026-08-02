import Image from "next/image";
import Link from "next/link";
import { LIGHT_SURFACE } from "../../../lib/light-surface";
import { isPricingClaimLive } from "../_pricing-gate";
// Tier card grid (subscription-platform slice 10, Task 1): extracted
// verbatim into its own module so the landing page can render the exact
// same cards too — a page.tsx file can't carry named exports (Next
// route-type contract), so the grid can't live here anymore. See
// ./tier-cards.tsx's own doc-comment.
import { TierCards } from "./tier-cards";

export const metadata = {
  title: "Pricing — Jace",
  description:
    "Plans priced by team size. One subscription, a fractional AI engineer for your whole team.",
};

const STEPS = [
  "Pick a plan: Starter, Growth, or Enterprise.",
  "Talk to Jace on Telegram, Slack, or Discord.",
  "Approve the work. It ships as a pull request.",
];

/**
 * Subscription-platform slice 7 (`docs/superpowers/plans/
 * 2026-07-31-subscription-marketing-slice7.md`, Task 1) — this page's
 * second rewrite. Slice 3 Task 7 (the prior doc-comment here) truthed the
 * copy up from the retired usage-based pricing model to a bare three-tier
 * summary: names, prices, seats, one capacity number, nothing else. That
 * was a minimum-honest page, not a real one — no feature differentiation
 * between tiers, no working CTA (Enterprise's "Contact us" was plain text,
 * not a link; Starter/Growth had no CTA at all), no vocabulary explaining
 * what the capacity number means. This rewrite adds all three: per-tier
 * feature lists (`TIERS[].features`, spec §10 vocabulary), working CTAs
 * (`/login` for Starter/Growth, `ENTERPRISE_CONTACT_EMAIL` for Enterprise —
 * see `TIER_CTA_PRIMARY`'s doc-comment for the sign-in route trace), and a
 * capacity explainer paragraph below the grid.
 *
 * The explainer deliberately reads "comes with included monthly
 * engineering capacity" rather than the more natural "includes monthly
 * engineering capacity": `pricing-copy.test.ts` pins the exact phrase
 * "included monthly engineering capacity" (spec §7 — this is the wording
 * customers actually see in-product), and the participle form is the one
 * that makes that phrase a real substring instead of a near-miss.
 *
 * Landing honesty rule (unchanged by this edit): this page is reachable at
 * all times (nothing to hide about the intended model), but it never
 * overstates what's true TODAY. `isPricingClaimLive()` — the same gate
 * that controls whether the landing page links here — decides which
 * status line renders: "Live" once the owner has flipped
 * `NEXT_PUBLIC_BILLING_VERIFIED_LIVE` after browser-verifying subscription
 * checkout on prod, or an honest "Preview" note before that. Neither state
 * claims something false.
 */
export default function PricingPage() {
  const live = isPricingClaimLive();

  return (
    <main className="min-h-screen bg-[var(--paper)]" style={LIGHT_SURFACE}>
      <header className="mx-auto flex max-w-[720px] items-center justify-between px-6 py-8">
        <Link href="/" className="flex items-center gap-2.5">
          <Image
            src="/jace-avatar.png"
            alt="Jace"
            width={32}
            height={32}
            className="rounded-full"
          />
          <span className="font-bold text-[var(--gray-13)]">Jace</span>
        </Link>
        <Link
          href="/"
          className="text-body-sm rounded-sm text-[var(--gray-11)] transition-colors hover:text-[var(--accent-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gray-13)]"
        >
          Back to home
        </Link>
      </header>

      <div className="mx-auto max-w-[560px] px-6">
        <h1 className="text-heading-2">Pricing</h1>

        <p
          className={`mt-2 inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 text-xs font-bold ${
            live
              ? "border-[var(--green-09)]/30 bg-[var(--green-09)]/10 text-[var(--green-11)]"
              : "border-[var(--gray-06)] bg-[var(--gray-03)] text-[var(--gray-10)]"
          }`}
        >
          {live ? "Live" : "Preview: not charging real payments yet"}
        </p>

        <p className="mt-6 text-[var(--gray-11)]">
          Jace is an AI software engineer for your team. One subscription
          covers everyone — plans are priced by team size, never per task.
        </p>
      </div>

      <section className="mx-auto mt-10 max-w-[960px] px-6">
        <TierCards />
      </section>

      <div className="mx-auto max-w-[560px] px-6 pb-24">
        <p className="mt-10 text-[var(--gray-11)]">
          Every plan comes with included monthly engineering capacity —
          measured in tasks, not dollars. Starter includes ≈350 tasks a
          month; Growth includes ≈1,000. Jace asks before anything runs, and
          finished work ships as a pull request.
        </p>

        <ol className="mt-8 flex flex-col gap-4">
          {STEPS.map((line, i) => (
            <li key={i} className="flex items-baseline gap-4">
              <span
                aria-hidden
                className="h-2.5 w-2.5 shrink-0 rounded-sm border border-[var(--gray-13)] bg-[var(--accent-fill)]"
              />
              <p className="text-[var(--gray-12)]">{line}</p>
            </li>
          ))}
        </ol>
      </div>
    </main>
  );
}
