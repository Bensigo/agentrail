import Image from "next/image";
import Link from "next/link";
import { FLAT_PROFIT_CENTS, FLAT_SERVER_FEE_CENTS } from "@agentrail/db-postgres";
import { LIGHT_SURFACE } from "../../../lib/light-surface";
import { isPricingClaimLive } from "../_pricing-gate";

export const metadata = {
  title: "Pricing — Jace",
  description: "What it costs to have Jace work on your codebase.",
};

function formatFlatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const STEPS = [
  "Top up your balance.",
  "Approve a task. The estimate you approve is the budget cap.",
  "You're charged when the task is done, at the real price below.",
];

/**
 * #1415 PR② — the pricing page. Describes the prepaid per-task model with
 * the ACTUAL numbers (`billing/pricing.ts`'s `FLAT_SERVER_FEE_CENTS` /
 * `FLAT_PROFIT_CENTS`, the single source of truth for what a task costs —
 * never a hand-copied duplicate of those figures).
 *
 * Landing honesty rule: this page is reachable at all times (nothing to
 * hide about the intended model), but it never overstates what's true
 * TODAY. `isPricingClaimLive()` — the same gate that controls whether the
 * landing page links here — decides which status line renders: "Live" once
 * the owner has flipped `NEXT_PUBLIC_BILLING_VERIFIED_LIVE` after
 * browser-verifying AC1/AC2 on prod, or an honest "Preview" note before
 * that. Neither state claims something false.
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
          Jace is prepaid and pay-for-what-you-use. No seats, no subscription.
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

        <section className="mt-10 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-6">
          <h2 className="text-sm font-bold text-[var(--gray-12)]">
            What one task costs
          </h2>
          <p className="mt-2 text-[var(--gray-11)]">
            The price of a completed task is the real token cost it used,
            plus two flat amounts:
          </p>
          <dl className="mt-4 flex flex-col gap-2 font-mono text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-[var(--gray-11)]">Actual token cost</dt>
              <dd className="text-[var(--gray-12)]">varies by task</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-[var(--gray-11)]">Flat server fee</dt>
              <dd className="text-[var(--gray-12)]">
                {formatFlatCents(FLAT_SERVER_FEE_CENTS)}
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-[var(--gray-11)]">Flat profit</dt>
              <dd className="text-[var(--gray-12)]">
                {formatFlatCents(FLAT_PROFIT_CENTS)}
              </dd>
            </div>
          </dl>
          <p className="mt-4 text-body-sm text-[var(--gray-11)]">
            You&apos;re charged exactly this once a task finishes. If it runs
            under your approved estimate, you keep the difference. If it runs
            over, that one task is the only thing allowed to dip your
            balance negative. The next task waits for a top-up.
          </p>
        </section>

        <p className="mt-8 text-body-sm text-[var(--gray-11)]">
          No hidden fees, no per-seat charge, no monthly minimum. Every task
          shows its own cost next to its pull request.
        </p>
      </div>
    </main>
  );
}
