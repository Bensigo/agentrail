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

// Subscription-platform slice 9, Task 2: the Tier type + TIERS array moved
// verbatim out of page.tsx into a sibling ./tiers.ts module (so the landing
// page can import the same data — a page.tsx file can't carry named
// exports, per Next's route-type contract). Every `pricingSource.toContain`
// pin below that targets tier data (prices, feature vocabulary, CTA
// labels) still needs to see that text, so `pricingSource` is now the
// concatenation of both files — from this test's perspective, "the pricing
// page's copy" is page.tsx + its data module together, and the extraction
// changed neither file's rendered/data content (only where it lives).
const pricingPageSource = readFileSync(resolve(PRICING_DIR, "page.tsx"), "utf8");
const tiersSource = readFileSync(resolve(PRICING_DIR, "tiers.ts"), "utf8");
const pricingSource = stripComments(`${pricingPageSource}\n${tiersSource}`);
const landingSource = stripComments(readFileSync(resolve(MARKETING_DIR, "page.tsx"), "utf8"));
// Slice 7, Task 2: no dedicated `_nav.tsx` test file exists yet (confirmed —
// only `_craft-pins.test.ts` reads it, and only for the mechanical style
// pins), so the nav's new Pricing link is pinned here as a second readFile,
// same stripped-text idiom as the two sources above. Comment-stripped: the
// file's own module doc-comment narrates the nav's condensed-state design
// ("swaps the secondary 'Sign in' link...") and would false-positive a raw
// ordering check otherwise.
const navSource = stripComments(readFileSync(resolve(MARKETING_DIR, "_nav.tsx"), "utf8"));

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
  // Arc-closing review (slice 7, Task 2 fix round): the HOW_WE_WORK band's
  // Brief/Approve step bodies still promised the retired per-run billing
  // model — a "dollar estimate" and a run-level "budget" cap — unconditional
  // on the landing page, contradicting the demo's scope sentence, §6b, and
  // /pricing. Confirmed pricing/page.tsx never carried either phrase (it's
  // already covered by the dedicated "never budget or per-task language"
  // check below), so folding into this shared both-files loop is safe and
  // gives the landing side the check it was missing.
  "dollar estimate",
  "sets the run's budget",
  "charged when the task is done",
];

/**
 * Spec §10 feature-line vocabulary not already covered by its own dedicated
 * `it()` below (`architecture assistance` / `premium reasoning` /
 * `dedicated support` were named individually since the task brief called
 * them out by name) — the remaining 10 of the full 13-phrase vocabulary (4
 * Starter + 4 Growth + 5 Enterprise). Array-driven, same convention as
 * `RETIRED_PHRASES` above, so all 13 are covered without 10 near-duplicate
 * hand-written its.
 */
const REMAINING_FEATURE_LINES = [
  "PR reviews",
  "bug fixes",
  "documentation",
  "everyday engineering",
  "everything in Starter",
  "large refactors",
  "custom AI policies",
  "SSO",
  "self-hosting",
  "SLA",
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

  // ---------------------------------------------------------------------
  // Slice 7 (subscription-platform, `docs/superpowers/plans/
  // 2026-07-31-subscription-marketing-slice7.md`, Task 1) — the pricing
  // page's outcome-led rewrite. Global Constraints pins the capacity
  // vocabulary and Growth/Enterprise feature-line terms verbatim; a
  // dedicated CTA section below pins the working Starter/Growth/Enterprise
  // actions.
  // ---------------------------------------------------------------------

  it('pricing page names the capacity vocabulary customers actually see ("included monthly engineering capacity"), never budget or per-task language', () => {
    expect(pricingSource).toContain("included monthly engineering capacity");
    expect(pricingSource.toLowerCase()).not.toContain("budget");
    expect(pricingSource).not.toMatch(/\$\d+(\.\d{2})?\s*(per|\/)\s*task/i);
  });

  it("pricing page's Growth tier names architecture assistance (spec §10 feature vocabulary)", () => {
    expect(pricingSource).toContain("architecture assistance");
  });

  it("pricing page's Growth tier names premium reasoning (spec §10 feature vocabulary)", () => {
    expect(pricingSource).toContain("premium reasoning");
  });

  it("pricing page's Enterprise tier names dedicated support (spec §10 feature vocabulary)", () => {
    expect(pricingSource).toContain("dedicated support");
  });

  for (const phrase of REMAINING_FEATURE_LINES) {
    it(`pricing page names "${phrase}" (spec §10 feature vocabulary)`, () => {
      expect(pricingSource).toContain(phrase);
    });
  }

  it("pricing page's Enterprise CTA is a mailto link built from the ENTERPRISE_CONTACT_EMAIL const (hello@heyjace.com)", () => {
    // Raw-source pin, not a rendered-string pin (see this file's own
    // doc-comment on why raw text): the const is interpolated into the
    // href (`mailto:${ENTERPRISE_CONTACT_EMAIL}`), so the literal joined
    // string "mailto:hello@heyjace.com" never appears contiguously in
    // source — only the evaluated DOM attribute would show that. Pinning
    // both halves (the const's exact value + the interpolation site) gives
    // the same regression protection a single toContain would, without
    // forcing the page to hardcode the address a second time.
    expect(pricingSource).toContain('ENTERPRISE_CONTACT_EMAIL = "hello@heyjace.com"');
    expect(pricingSource).toContain("mailto:${ENTERPRISE_CONTACT_EMAIL}");
  });

  it('pricing page\'s Starter CTA reads "Start with Starter"', () => {
    expect(pricingSource).toContain("Start with Starter");
  });

  it('pricing page\'s Growth CTA reads "Start with Growth"', () => {
    expect(pricingSource).toContain("Start with Growth");
  });

  it("pricing page's CTA render site actually renders tier.ctaLabel, not a hardcoded string", () => {
    // Review fix (round 1): the two its above pass even if `ctaLabel` goes
    // orphaned in the TIERS data and both render branches hardcode a
    // different label instead (e.g. "Get started") — the literal strings
    // "Start with Starter"/"Start with Growth" would still exist SOMEWHERE
    // in source (the now-dead data fields), so those pins alone can't catch
    // that mutation. Same fix shape as the mailto pin above: anchor the
    // RENDER-SITE expression itself, not just the data value.
    expect(pricingSource).toContain("{tier.ctaLabel}");
  });

  it("pricing page's Starter/Growth CTA links to a real route, not an invented /signin path", () => {
    // The task brief that drove this rewrite named `href="/signin"` as the
    // example CTA target, but no such route exists anywhere in this app
    // (confirmed: no apps/console/app/**/signin/page.tsx, no href="/signin"
    // reference anywhere else in the codebase). The real route, traced from
    // `_nav.tsx`'s `signInAction` prop through `page.tsx`'s `signInWithGithub`
    // through NextAuth's own `pages.signIn` config
    // (`packages/auth/src/index.ts`), is "/login" — confirmed live at
    // `app/(auth)/login/page.tsx`, which runs the identical
    // `signIn("github", { redirectTo: "/" })` call. Pin the real target so a
    // future edit can't silently revert to the never-real "/signin".
    expect(pricingSource).toContain('href="/login"');
    expect(pricingSource).not.toContain("/signin");
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

  // -----------------------------------------------------------------------
  // Subscription-platform slice 7, Task 2 (`docs/superpowers/sdd/
  // task-2-brief.md`): §6b's sub now speaks the capacity vocabulary instead
  // of the bare "not by task" rebuttal, and the marketing nav gains an
  // ungated Pricing link. Heading, steps, kicker, and the gated "See exact
  // pricing" link are all pinned already (above / `_craft-pins.test.ts`) and
  // stay untouched by this task.
  // -----------------------------------------------------------------------

  it("landing §6b's sub speaks capacity vocabulary — priced by team size, measured in tasks (subscription-platform slice 7, Task 2)", () => {
    // Whitespace-normalized locally (not the shared `landingSource` other
    // tests use) so this full-sentence pin survives however the formatter
    // wraps this long JSX text node across lines — same reasoning as
    // collapsing JSX text at render time, just done for the string compare.
    const normalized = landingSource.replace(/\s+/g, " ");
    expect(normalized).toContain(
      "Plans are priced by team size — Starter for small teams, Growth for bigger ones. Every plan includes monthly engineering capacity, measured in tasks.",
    );
  });

  it("marketing nav carries an ungated Pricing link, placed before Sign in (subscription-platform slice 7, Task 2)", () => {
    expect(navSource).toMatch(/<Link\s+href="\/pricing"[^>]*>\s*Pricing\s*<\/Link>/);
    const pricingIdx = navSource.indexOf('href="/pricing"');
    const signInIdx = navSource.indexOf("Sign in");
    expect(pricingIdx).toBeGreaterThan(-1);
    expect(signInIdx).toBeGreaterThan(-1);
    expect(pricingIdx).toBeLessThan(signInIdx);
  });
});

// -----------------------------------------------------------------------
// Subscription-platform slice 9, Task 2 (owner ruling 2026-08-02: "in the
// landing page we should have our pricing") — §6b now renders the three
// tier lines inline instead of only linking out to /pricing. Render-site
// anchored (this repo's slice-7 lesson: a pin that only matches an
// orphaned data declaration, and not the actual JSX that consumes it, is a
// defect) — every check below is scoped to the real block that maps over
// TIERS, not just "this text exists somewhere in the file". The fully
// assembled DOM strings ("Starter · $80/mo · up to 4 people") can't be
// pinned as contiguous raw text — they're assembled from `{tier.name}` /
// `{tier.price}` expressions at render time, and this repo has no DOM
// render harness (see _craft-pins.test.ts's own doc-comment) — so this
// splits the guarantee across (a) the render site really consumes the
// tier data and the seats-descriptor map, and (b) that map carries the
// exact pinned phrasing, keyed to the right tier name.
// -----------------------------------------------------------------------

describe("landing §6b renders the tier pricing lines inline (subscription-platform slice 9, Task 2)", () => {
  const tiersMapIdx = landingSource.indexOf("TIERS.map(");
  const renderBlock = landingSource.slice(tiersMapIdx, tiersMapIdx + 700);

  it("the render site actually maps over the shared TIERS array (not a hardcoded copy)", () => {
    expect(tiersMapIdx).toBeGreaterThan(-1);
  });

  it("the render site reads the tier's own name and price, not hardcoded literals", () => {
    expect(renderBlock).toMatch(/\{tier\.name\}/);
    expect(renderBlock).toMatch(/\{tier\.price\}/);
  });

  it("the render site's price sits in font-mono (TASTE mono-on-data)", () => {
    const priceIdx = renderBlock.indexOf("{tier.price}");
    expect(priceIdx).toBeGreaterThan(-1);
    expect(renderBlock.slice(Math.max(0, priceIdx - 100), priceIdx)).toMatch(/font-mono/);
  });

  it("the render site's separator is a middle dot, never an em-dash", () => {
    expect(renderBlock).toContain("·");
    expect(renderBlock).not.toContain("—");
  });

  it("the render site actually consumes the seats-descriptor map — not an orphaned declaration", () => {
    expect(renderBlock).toContain("TIER_LANDING_TAIL[tier.name]");
  });

  it("the seats-descriptor map keys the exact pinned phrasing to the right tier name", () => {
    expect(landingSource).toMatch(/Starter:\s*"up to 4 people"/);
    expect(landingSource).toMatch(/Growth:\s*"up to 10 people"/);
    expect(landingSource).toMatch(/Enterprise:\s*"custom pricing"/);
  });

  it("the seats-descriptor numbers match tiers.ts's own seats field — no drift between the two files", () => {
    const starterSeats = tiersSource.match(/name: "Starter"[\s\S]*?seats: "Up to (\d+)"/)?.[1];
    const growthSeats = tiersSource.match(/name: "Growth"[\s\S]*?seats: "Up to (\d+)"/)?.[1];
    expect(starterSeats).toBe("4");
    expect(growthSeats).toBe("10");
    expect(landingSource).toContain(`up to ${starterSeats} people`);
    expect(landingSource).toContain(`up to ${growthSeats} people`);
  });

  it("the ungated pricing link still renders (owner ruling 2026-08-02: no isPricingClaimLive gate)", () => {
    expect(landingSource).toContain("See exact pricing");
    expect(landingSource).not.toContain("isPricingClaimLive");
  });
});
