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
  commercialStatus: string;
  /** Commercial-experiment terms, not product outcomes or capacity. */
  features: string[];
  ctaLabel: string;
};

/**
 * R12.2 commercial-experiment packaging. The dollar prices and seat bands
 * are terms being tested, not delivery-capacity or product-value claims.
 * Stripe owns any actual recurring Price objects; these public terms do not
 * establish payment availability. Enterprise has no public price or checkout
 * and remains a contact-first conversation.
 *
 * `features` stays limited to the terms and boundaries of the commercial
 * experiment. `ctaLabel` is spelled out per tier rather than built from
 * `` `Start with ${tier.name}` `` at render time, so the
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
    commercialStatus: "Terms under evaluation",
    features: [
      "team commercial experiment",
      "team-size terms",
      "payment availability stated separately",
      "human decision retained",
    ],
    ctaLabel: "Start with Starter",
  },
  {
    name: "Growth",
    price: "$399/mo",
    seats: "Up to 10",
    commercialStatus: "Terms under evaluation",
    features: [
      "team commercial experiment",
      "team-size terms",
      "payment availability stated separately",
      "no delivery commitment",
    ],
    ctaLabel: "Start with Growth",
  },
  {
    name: "Enterprise",
    price: "Contact us",
    seats: "Custom",
    commercialStatus: "Discuss terms first",
    features: [
      "custom commercial experiment",
      "custom team terms",
      "no delivery commitment",
      "contact before any commitment",
    ],
    ctaLabel: "Contact us",
  },
];
