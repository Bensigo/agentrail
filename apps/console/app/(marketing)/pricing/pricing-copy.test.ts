import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Pricing copy truth-up regression guard (subscription-platform slice 3,
// Task 7 — rollout rider, `docs/superpowers/specs/
// 2026-07-29-subscription-platform-design.md` §9: "the public pricing
// surface must stop promising 'No seats, no subscription' the moment real
// subscriptions can be sold").
//
// Before this task, both marketing surfaces asserted the OPPOSITE of what
// `billing_accounts` now sells: usage-based, no-seats, no-subscription
// pricing. This test reads both page sources as raw text — same "read the
// file, check what matters against the raw string" idiom as
// `lib/alignment/import-direction.test.ts` (see that file's own doc-comment
// for why raw text over an AST) — and pins the retired phrases dead so a
// future edit (or a careless revert) can't silently reintroduce a false
// commercial-model claim. It also positively asserts the new tier anchors
// exist, so a copy-paste accident that empties a tier card fails loudly
// too, not just silently renders blank.
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const PRICING_DIR = dirname(__filename); // apps/console/app/(marketing)/pricing
const MARKETING_DIR = resolve(PRICING_DIR, ".."); // apps/console/app/(marketing)

/**
 * Strips comments before checking copy — same approach as
 * `_craft-pins.test.ts`'s own em-dash budget check, for the same reason:
 * this task's own module docs legitimately QUOTE the retired phrases
 * (citing spec §9's "Copy that must be retired" wording so a future reader
 * knows exactly what changed and why) — that's documentation, not a public
 * claim. This guard cares about what a visitor actually reads, so it
 * checks rendered strings only.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*\*[\s\S]*?\*\//g, "") // JSDoc blocks
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "") // JSX comments
    .replace(/^\s*\/\/.*$/gm, ""); // line comments
}

const pricingSource = stripComments(readFileSync(resolve(PRICING_DIR, "page.tsx"), "utf8"));
const landingSource = stripComments(readFileSync(resolve(MARKETING_DIR, "page.tsx"), "utf8"));

/**
 * Every phrase that promised the retired usage-based, no-subscription
 * model. Checked case-insensitively — the brief's own casing varies across
 * the two files ("No seats..." title-case at both retirement sites, "no
 * per-seat charge"/"monthly minimum" lowercase, "Pay for what you use"
 * title-case as the old landing §6b heading) and a future rewrite could
 * plausibly re-add any of these with different capitalization; the claim
 * is dead regardless of case.
 */
const RETIRED_PHRASES = [
  "No seats",
  "no subscription",
  "per-seat charge",
  "monthly minimum",
  "Pay for what you use",
  // Fix round (coordinator call): the wallet-flow STEPS list ("Top up your
  // balance... You're charged when the task is done") sat one section under
  // the new "Starter $80/mo" tier cards / subscription heading — the same
  // contradiction this whole task exists to retire, just spelled
  // differently. Both lines are gone from the STEPS content on both pages.
  "Top up",
  "charged when the task is done",
];

describe("pricing page + landing §6b never reintroduce the retired anti-subscription claims", () => {
  for (const phrase of RETIRED_PHRASES) {
    it(`pricing/page.tsx source has no "${phrase}"`, () => {
      expect(pricingSource.toLowerCase()).not.toContain(phrase.toLowerCase());
    });

    it(`landing page.tsx source has no "${phrase}"`, () => {
      expect(landingSource.toLowerCase()).not.toContain(phrase.toLowerCase());
    });
  }

  it("pricing page names the Starter tier's real price ($80)", () => {
    expect(pricingSource).toContain("$80");
  });

  it("pricing page names the Growth tier's real price ($200)", () => {
    expect(pricingSource).toContain("$200");
  });

  it("pricing page ships an Enterprise contact path (\"Contact us\")", () => {
    expect(pricingSource).toContain("Contact us");
  });

  it("landing §6b carries its new subscription heading", () => {
    expect(landingSource).toContain("One subscription for your whole team");
  });

  // Fix round: the STEPS lists on both pages were rewritten too (see
  // RETIRED_PHRASES' "Top up" / "charged when the task is done" entries
  // above) — assert the replacement content actually landed, not just
  // that the old wording is gone.
  it("pricing page's new steps mention shipping as a pull request", () => {
    expect(pricingSource).toContain("ships as a pull request");
  });

  it("landing §6b's new steps mention shipping as a pull request", () => {
    expect(landingSource).toContain("ships as a pull request");
  });
});
