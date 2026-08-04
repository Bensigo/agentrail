/**
 * Shared tier data (subscription-platform slice 9, Task 2 — owner ruling
 * 2026-08-02: "in the landing page we should have our pricing"). Extracted
 * verbatim out of `./page.tsx` so ONE array feeds both the /pricing page's
 * tier cards and the landing page's (`../page.tsx`) §6b tier lines — no
 * duplicated price literals to drift out of sync between the two surfaces.
 * Next's route-type contract forbids named exports on a `page.tsx` /
 * `layout.tsx` file (this repo already paid for that lesson once), so the
 * shared data gets its own plain module instead of living on the page
 * component's file.
 */

export type Tier = {
  name: string;
  price: string;
  seats: string;
  included: string;
  /** Feature-line vocabulary — spec §10, byte-exact per subscription-
   *  platform slice 7's Global Constraints (see the doc-comment below). */
  features: string[];
  ctaLabel: string;
};

/**
 * Subscription-platform spec §2 commercial packaging (`docs/superpowers/
 * specs/2026-07-29-subscription-platform-design.md`). Seats and capacity
 * match `lib/policy/plan-policies.ts`'s `PLAN_POLICIES` as of this write
 * (starter: 4 seats / 34 capacity; growth: 10 seats / 74 capacity) —
 * spec §2 calls these "launch priors, calibrated monthly", so keep this
 * table in sync by hand if that file's numbers move. Dollar prices are NOT
 * a shared code constant: Stripe owns the actual recurring Price objects
 * (`lib/billing/stripe-plans.ts` maps plan -> Price id only, never a
 * dollar amount), so $199/$399 are hand-set here to match the current
 * commercial decision. Enterprise has no public price or
 * checkout (spec §2: "no public pricing and no checkout flow — it is a
 * conversation") — its CTA below is a `mailto:` link, never a checkout
 * link; see `ENTERPRISE_CONTACT_EMAIL` in `./page.tsx`.
 *
 * `features` is the tier feature-line vocabulary (subscription-platform
 * slice 7 Global Constraints, spec §10: "verbatim vocabulary") — copied
 * byte-exact, including "everything in Starter" as Growth's first line and
 * the deliberate lowercase-led phrasing of the rest (these read as list
 * items, not sentence openers). `ctaLabel` is spelled out per tier rather
 * than built from `` `Start with ${tier.name}` `` at render time, so the
 * literal strings "Start with Starter" / "Start with Growth" exist in this
 * file's own source text, not just in the rendered DOM —
 * `pricing-copy.test.ts` pins them as raw source text (see that file's own
 * doc-comment on why raw text), which a runtime-built string can't satisfy.
 */
export const TIERS: Tier[] = [
  {
    name: "Starter",
    price: "$199/mo",
    seats: "Up to 4",
    included: "≈34 engineering tasks/mo",
    features: [
      "acceptance contracts",
      "verification evidence",
      "reviewable changes",
      "team approvals",
    ],
    ctaLabel: "Start with Starter",
  },
  {
    name: "Growth",
    price: "$399/mo",
    seats: "Up to 10",
    included: "≈74 engineering tasks/mo",
    features: [
      "everything in Starter",
      "dependency upgrade workflow",
      "compatibility evidence",
      "calibrated refusal",
    ],
    ctaLabel: "Start with Growth",
  },
  {
    name: "Enterprise",
    price: "Contact us",
    seats: "Custom",
    included: "Custom",
    features: [
      "custom acceptance policies",
      "review-cost reporting",
      "environment fidelity",
      "SLA",
      "dedicated support",
    ],
    ctaLabel: "Contact us",
  },
];
