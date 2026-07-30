import Image from "next/image";
import Link from "next/link";
import { LIGHT_SURFACE } from "../../../lib/light-surface";
import { isPricingClaimLive } from "../_pricing-gate";

export const metadata = {
  title: "Pricing — Jace",
  description: "What it costs to have Jace work on your codebase.",
};

const STEPS = [
  "Pick a plan: Starter, Growth, or Enterprise.",
  "Talk to Jace on Telegram, Slack, or Discord.",
  "Approve the work. It ships as a pull request.",
];

type Tier = {
  name: string;
  price: string;
  seats: string;
  included: string;
};

/**
 * Subscription-platform spec §2 commercial packaging (`docs/superpowers/
 * specs/2026-07-29-subscription-platform-design.md`). Seats and capacity
 * match `lib/policy/plan-policies.ts`'s `PLAN_POLICIES` as of this write
 * (starter: 4 seats / 350 capacity; growth: 10 seats / 1,000 capacity) —
 * spec §2 calls these "launch priors, calibrated monthly", so keep this
 * table in sync by hand if that file's numbers move. Dollar prices are NOT
 * a shared code constant: Stripe owns the actual recurring Price objects
 * (`lib/billing/stripe-plans.ts` maps plan -> Price id only, never a
 * dollar amount), so $80/$200 are hand-set here to match the Stripe
 * dashboard and the spec's own table. Enterprise has no public price or
 * checkout (spec §2: "no public pricing and no checkout flow — it is a
 * conversation") — "Contact us" ships as plain text, not a link: no
 * contact route exists in this app yet, and a fake/dead link would be
 * exactly the kind of overclaim this page exists to avoid.
 */
const TIERS: Tier[] = [
  { name: "Starter", price: "$80/mo", seats: "Up to 4", included: "≈350 engineering tasks/mo" },
  { name: "Growth", price: "$200/mo", seats: "Up to 10", included: "≈1,000 engineering tasks/mo" },
  { name: "Enterprise", price: "Contact us", seats: "Custom", included: "Custom" },
];

/**
 * Subscription-platform slice 3, Task 7 — the pricing page's copy
 * truth-up (rollout rider, `docs/superpowers/specs/
 * 2026-07-29-subscription-platform-design.md` §9: "the public pricing
 * surface must stop promising 'No seats, no subscription' the moment real
 * subscriptions can be sold"). This page used to describe the prepaid
 * per-task model with the ACTUAL numbers (`billing/pricing.ts`'s
 * `FLAT_SERVER_FEE_CENTS` / `FLAT_PROFIT_CENTS`). That model is retired as
 * the COMMERCIAL story — the wallet machinery itself stays, internal-only
 * (spec §1) — in favor of company subscriptions, so this page now names
 * the three sellable plans instead. See `TIERS` above for where its
 * numbers come from.
 *
 * `STEPS` (fix round, coordinator call): the original "top up your
 * balance... you're charged when the task is done" wallet-flow steps sat
 * one section above `TIERS`' "Starter $80/mo" cards — the same
 * contradiction this whole page exists to retire, just spelled
 * differently, so they're rewritten too, not just the claims spec §9
 * names verbatim. The three lines now name the actual subscription flow:
 * pick a plan, talk to Jace on an existing chat channel, approve the work.
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

      <div className="mx-auto max-w-[560px] px-6 pb-24">
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
          Jace is an AI software engineer for your team. Plans are priced by
          team size.
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

        <section className="mt-10 flex flex-col gap-4">
          {TIERS.map((tier) => (
            <div
              key={tier.name}
              className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-6"
            >
              <div className="flex items-baseline justify-between">
                <h2 className="text-sm font-bold text-[var(--gray-12)]">{tier.name}</h2>
                <p className="font-mono text-sm text-[var(--gray-12)]">{tier.price}</p>
              </div>
              <dl className="mt-4 flex flex-col gap-2 font-mono text-sm">
                <div className="flex items-center justify-between">
                  <dt className="text-[var(--gray-11)]">Seats</dt>
                  <dd className="text-[var(--gray-12)]">{tier.seats}</dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-[var(--gray-11)]">Included</dt>
                  <dd className="text-[var(--gray-12)]">{tier.included}</dd>
                </div>
              </dl>
            </div>
          ))}
        </section>
      </div>
    </main>
  );
}
