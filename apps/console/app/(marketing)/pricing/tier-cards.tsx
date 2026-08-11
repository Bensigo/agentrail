import Link from "next/link";
import { TIERS } from "./tiers";

/**
 * Shared tier card grid (subscription-platform slice 10, Task 1 — owner
 * feedback 2026-08-02: the landing page must show the FULL pricing cards —
 * name, mono price, seats, commercial status, feature list, CTA — the same
 * presentation as `/pricing`, not the compact one-line tier summaries slice
 * 9 shipped). Moved verbatim out of `./page.tsx` (where this grid first
 * shipped, subscription-platform slice 7 Task 1) into its own module so
 * `../page.tsx` (the landing) can render the IDENTICAL grid instead of a
 * second, driftable copy — one component, two callers, byte-for-byte the
 * same cards. `TierCards` renders ONLY the grid, no outer `<section>` or
 * width wrapper: each caller keeps its own spacing (`/pricing`'s existing
 * `max-w-[960px]` section; the landing's own width breakout — see that
 * file's §6b comment for why a wide max-width can't just be nested inside
 * a narrower ancestor). Server component (no "use client") — nothing here
 * needs interactivity. A page.tsx file can't carry named exports (Next's
 * route-type contract, `./tiers.ts`'s own doc-comment), which is why this
 * lives as a third sibling module rather than back on `./page.tsx`.
 */

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

/**
 * The three tier cards (Starter/Growth/Enterprise) as a `grid-cols-1
 * lg:grid-cols-3` grid — name, mono price, seats/status pair,
 * feature list, CTA. Both `/pricing` and the landing render this exact
 * function; see this module's own doc-comment for the width-wrapper split
 * of responsibility.
 */
export function TierCards() {
  return (
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
                <dt className="text-[var(--gray-11)]">Commercial status</dt>
                <dd className="text-[var(--gray-12)]">{tier.commercialStatus}</dd>
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
  );
}
