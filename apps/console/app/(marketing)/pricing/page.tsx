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
    "A team commercial experiment with terms priced by team size.",
};

const STEPS = [
  "Choose the team-size terms you want to discuss.",
  "Check the stated payment-availability status.",
  "Keep acceptance and delivery decisions with a human.",
];

/**
 * Subscription-platform slice 7 (`docs/superpowers/plans/
 * 2026-07-31-subscription-marketing-slice7.md`, Task 1) — this page's
 * second rewrite. R12.2 now keeps the tier names, prices, seats, CTAs, and
 * explicit payment-status boundary as a team commercial experiment. It does
 * not publish a delivery-capacity number or turn package terms into a claim
 * about generated, reviewed, or delivered work.
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
          {live
            ? "Experiment: payment availability has been independently verified"
            : "Experiment: payment availability has not been independently verified"}
        </p>

        <p className="mt-6 text-[var(--gray-11)]">
          These are team-size terms for a commercial experiment. They do not
          claim product value, delivery outcomes, or payment availability
          beyond the status shown above.
        </p>
      </div>

      <section className="mx-auto mt-10 max-w-[960px] px-6">
        <TierCards />
      </section>

      <div className="mx-auto max-w-[560px] px-6 pb-24">
        <p className="mt-10 text-[var(--gray-11)]">
          The listed prices and seat bands are commercial terms under
          evaluation. They do not promise that work will be generated,
          reviewed, or delivered.
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
