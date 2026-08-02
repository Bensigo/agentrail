import Image from "next/image";
import Link from "next/link";
import { LIGHT_SURFACE } from "../../../lib/light-surface";
import { isPricingClaimLive } from "../_pricing-gate";
// Tier data (subscription-platform slice 9, Task 2): extracted verbatim
// into its own module so the landing page can share it too — a page.tsx
// file can't carry named exports (Next route-type contract), so the data
// can't live here anymore. See ./tiers.ts's own doc-comment.
import { TIERS } from "./tiers";

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
 * Enterprise contact address (subscription-platform slice 7 Global
 * Constraints: "a mailto: link behind one const ... with a doc-comment").
 * OWNER MUST CONFIRM this inbox exists and is monitored BEFORE the pricing
 * claim goes live — i.e. before `NEXT_PUBLIC_BILLING_VERIFIED_LIVE` flips to
 * "1" and `isPricingClaimLive()` (`../_pricing-gate.ts`) starts rendering
 * "Live" instead of "Preview" below. The Preview chip covers the interim:
 * nothing on this page claims the inbox is staffed today. No contact form
 * exists in this app (none planned for this slice) — mailto is the honest,
 * buildable option now.
 */
const ENTERPRISE_CONTACT_EMAIL = "hello@heyjace.com";

/** Primary tier CTA (Starter/Growth) — the landing's "ink press" lemon-fill
 *  button recipe (see `INK_BUTTON`/`ChannelButton` in `../page.tsx`),
 *  stretched to the card's width and pinned to the card's bottom edge
 *  (`mt-auto` inside an `h-full` card) so three cards with different
 *  feature-list lengths still line their buttons up in the grid row.
 *
 *  Target: the brief driving this rewrite named `href="/signin"` as the
 *  example CTA target, but no such route exists anywhere in this app —
 *  confirmed via a repo-wide search. The real target, traced per the
 *  brief's own "do not invent a route" instruction: `_nav.tsx` takes a
 *  `signInAction` prop; `page.tsx` wires it to a local, non-exported
 *  `signInWithGithub` server action (`signIn("github", { redirectTo: "/" })`)
 *  invoked from a `<form>`, not a link — there's no URL to copy, and the
 *  action isn't importable from another route's module. NextAuth's own
 *  `pages.signIn` config (`packages/auth/src/index.ts`) names the real page
 *  for this: `/login`, confirmed live at `app/(auth)/login/page.tsx`, which
 *  runs the identical `signIn("github", { redirectTo: "/" })` call ("Same
 *  server action as the landing's sign-in seams" — that file's own
 *  doc-comment). `/login` is the real route; linking to it is reuse, not
 *  invention. */
const TIER_CTA_PRIMARY =
  "mt-auto inline-flex w-full items-center justify-center gap-2 rounded-md border-2 border-[var(--gray-13)] bg-[var(--accent-fill)] px-5 py-2.5 font-bold text-[var(--accent-fill-text)] shadow-[3px_3px_0_0_var(--gray-13)] transition-[transform,background-color,box-shadow] duration-150 ease-out hover:translate-x-[1px] hover:translate-y-[1px] hover:bg-[var(--accent-fill-hover)] hover:shadow-[2px_2px_0_0_var(--gray-13)] active:translate-x-[3px] active:translate-y-[3px] active:shadow-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gray-13)]";

/** Enterprise's "Contact us" CTA — the neutral bordered recipe (same as the
 *  nav's plain "Sign in" button), never the lemon fill: this tier isn't a
 *  self-serve start action, it's "talk to us first". */
const TIER_CTA_SECONDARY =
  "mt-auto inline-flex w-full items-center justify-center gap-2 rounded-md border border-[var(--gray-06)] bg-[var(--gray-02)] px-5 py-2.5 font-bold text-[var(--gray-11)] transition-colors hover:border-[var(--gray-08)] hover:text-[var(--gray-12)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gray-13)]";

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
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {TIERS.map((tier) => {
            const isEnterprise = tier.name === "Enterprise";
            return (
              <div
                key={tier.name}
                className="flex h-full flex-col rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-6"
              >
                <div>
                  <h2 className="text-label font-bold text-[var(--gray-12)]">{tier.name}</h2>
                  <p className="mt-1 font-mono text-heading-2 text-[var(--gray-12)]">{tier.price}</p>
                </div>
                <dl className="mt-4 flex flex-col gap-3 font-mono text-body-sm">
                  <div>
                    <dt className="text-[var(--gray-11)]">Seats</dt>
                    <dd className="text-[var(--gray-12)]">{tier.seats}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--gray-11)]">Included</dt>
                    <dd className="text-[var(--gray-12)]">{tier.included}</dd>
                  </div>
                </dl>
                <ul className="mt-4 mb-6 flex flex-col gap-2">
                  {tier.features.map((feature) => (
                    <li key={feature} className="flex items-baseline gap-2.5">
                      <span
                        aria-hidden
                        className="h-2.5 w-2.5 shrink-0 rounded-sm border border-[var(--gray-13)] bg-[var(--accent-fill)]"
                      />
                      <p className="text-body-sm text-[var(--gray-12)]">{feature}</p>
                    </li>
                  ))}
                </ul>
                {isEnterprise ? (
                  <a href={`mailto:${ENTERPRISE_CONTACT_EMAIL}`} className={TIER_CTA_SECONDARY}>
                    {tier.ctaLabel}
                  </a>
                ) : (
                  <Link href="/login" className={TIER_CTA_PRIMARY}>
                    {tier.ctaLabel}
                  </Link>
                )}
              </div>
            );
          })}
        </div>
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
