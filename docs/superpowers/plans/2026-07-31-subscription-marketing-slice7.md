# Subscription Slice 7 — Marketing Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The final slice — the pricing page becomes a real outcome-led page (feature-led tiers, capacity vocabulary, CTAs, nav link, enterprise contact path), landing §6b speaks the same language, the last customer-facing dollar surfaces (outcome message, legacy budget notice) go scope-side under the flag, and the two design docs (landing-content-architecture, TASTE billing ruling) stop prescribing the retired pay-per-use model — per spec §9 slice 7 + §10 (`docs/superpowers/specs/2026-07-29-subscription-platform-design.md`).

**Architecture:** One PR on `feat/sub-s7-marketing` (base main, slices 0-6 merged). Marketing copy changes are UNCONDITIONAL (slice-3/6 precedent: marketing mirrors the flag-on product; the pricing page's own `isPricingClaimLive()` Preview chip carries payment honesty). Product-surface changes (outcome message, budget notice) are flag-gated exactly like slice 6's approval line. Every craft gate stays green: em-dash budget (1 of 2 spent on `page.tsx` — ≤1 new), ≤2 "X, not Y" rebuttal lines page-wide, mono-within-300-chars on data markers, exactly 3 mascots, tokens only, no new webfonts, no hex.

**Tech Stack:** Next marketing pages (server components), vitest raw-source pin tests, Markdown docs.

## Global Constraints

- **Copy pins (byte-exact where quoted).** Tier data comes from the existing `TIERS` values — prices `$80/mo` / `$200/mo` / `Contact us`, seats `Up to 4` / `Up to 10` / `Custom`, capacity `≈350 engineering tasks/mo` / `≈1,000 engineering tasks/mo` / `Custom` (numbers = `PLAN_POLICIES`, ship-as-written per spec §12 open decision 1).
- **Tier feature lines (from spec §10, verbatim vocabulary):** Starter → `PR reviews`, `bug fixes`, `documentation`, `everyday engineering`; Growth → `everything in Starter`, `architecture assistance`, `large refactors`, `premium reasoning`; Enterprise → `custom AI policies`, `SSO`, `self-hosting`, `SLA`, `dedicated support`.
- **Capacity vocabulary:** the phrase `included monthly engineering capacity` must appear on the pricing page (matching the §7 prompts customers actually receive); capacity is always tasks, never dollars. The word `budget` and any `$X.XX` per-task figure never appear on marketing surfaces.
- **Enterprise contact path:** a `mailto:` link behind one const `ENTERPRISE_CONTACT_EMAIL = "hello@heyjace.com"` with a doc-comment: OWNER MUST CONFIRM this address before `NEXT_PUBLIC_PRICING_CLAIM_LIVE` flips; the Preview chip covers the interim. No contact form (none exists; don't build one).
- **Nav:** `MarketingNav` gains an ungated `Pricing` → `/pricing` item (the page self-discloses via the Live/Preview chip). The §6b gated `See exact pricing` link stays exactly as is (zero churn).
- **Retire-list disposition (spec §9 list, final):** items 1-2 already retired; item 3 done (slice 6); item 4a (claim-route budget-exhausted `$X spent of $Y` Telegram notice) — SUPPRESSED when `subscriptionsEnforced()` (capacity system owns customer comms; log internally instead); items 4b (budget-helpers) + 5 (wallet-helpers) — STAY, with a one-line code comment each: these pages are internal-only since slice 6 (sidebar-hidden, staff telemetry, spec §8).
- **Outcome message:** `buildOutcomeMessage` (apps/console/lib/outcome-format.ts:74-86) gains an explicit options param `{ hideCost?: boolean }` — when set, the ` · $X.XX` segment is omitted (template stays otherwise byte-identical). Real call sites pass `hideCost: subscriptionsEnforced()`; the landing demo passes `hideCost: true` UNCONDITIONALLY (marketing mirrors flag-on). No env read inside the pure builder.
- **Craft gates are law:** `_craft-pins.test.ts` and `_conversation-demo.tokens-only.test.ts` must pass untouched EXCEPT where a pin's content deliberately moves (each such edit named in the task). `pricing/page.tsx` JOINS `STYLED_FILES` (it becomes a real styled page) — it must satisfy the weight/ad-hoc-size/token rules from the start. TASTE.md rules apply: lemon fill+dark text only, Berkeley Mono for data moments (prices/numbers = `font-mono`), type scale classes only, ≤2 rebuttal lines, no hype.
- House conventions: full console suite + `tsc --noEmit` before each commit; explicit-path commits with trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. No migrations, no db changes.

---

### Task 1: Pricing page rewrite (outcome-led tiers)

**Files:**
- Modify: `apps/console/app/(marketing)/pricing/page.tsx` (full rewrite of the content sections; header/chip/gate mechanics stay)
- Modify: `apps/console/app/(marketing)/pricing/pricing-copy.test.ts` (extend pins)
- Modify: `apps/console/app/(marketing)/_craft-pins.test.ts` (add `pricing/page.tsx` to `STYLED_FILES` only — line ~21-29)
- Test: both above

**Page structure (top to bottom):**
1. Header + Live/Preview chip + `<h1>Pricing</h1>` — unchanged mechanics; metadata description becomes `Plans priced by team size. One subscription, a fractional AI engineer for your whole team.`
2. Lede: `Jace is an AI software engineer for your team. One subscription covers everyone — plans are priced by team size, never per task.`
3. The three tier cards (grid, existing card shell style): name, `font-mono` price, `Seats` / `Included` rows (existing values verbatim), then a feature list (`<ul>`, lemon square markers like the STEPS pattern) with the Global Constraints feature lines, then a CTA:
   - Starter/Growth → `<Link href="/signin">Start with {name}</Link>` (check the real sign-in route — trace `MarketingNav`'s `signInAction`/`cta.href` and reuse its target; do not invent a route).
   - Enterprise → `<a href={`mailto:${ENTERPRISE_CONTACT_EMAIL}`}>Contact us</a>` with the owner-confirm doc-comment.
4. Capacity explainer (one short block under the grid): `Every plan includes monthly engineering capacity — measured in tasks, not dollars. Starter includes ≈350 tasks a month; Growth includes ≈1,000. Jace asks before anything runs, and finished work ships as a pull request.`
5. Keep the existing STEPS list (3 lines, verbatim) below the explainer, and the provenance doc-comments updated (numbers from `PLAN_POLICIES`; Stripe owns dollars; slice-7 rewrite note replacing the slice-3 truth-up note).

- [ ] TDD first: extend `pricing-copy.test.ts` — keep every existing pin; ADD present-pins for `included monthly engineering capacity`, `architecture assistance`, `premium reasoning`, `dedicated support`, `mailto:hello@heyjace.com`, `Start with Starter`, `Start with Growth`; keep RETIRED_PHRASES absent-pins green. RED → rewrite the page → GREEN.
- [ ] Add `pricing/page.tsx` to `STYLED_FILES`; run `_craft-pins.test.ts` — fix any weight/size/token violations the page has (use `text-heading-2`, `text-body`/`text-body-sm`, `font-mono` on prices; no ad-hoc `text-[...]`, no banned weights).
- [ ] Full console suite + `tsc --noEmit` → commit `feat(console): outcome-led pricing page`.

### Task 2: Landing §6b + marketing nav

**Files:**
- Modify: `apps/console/app/(marketing)/page.tsx` (§6b block only, ~:327-378)
- Modify: `apps/console/app/(marketing)/_nav.tsx` (add Pricing item)
- Test: extend `pricing-copy.test.ts` landing pins + `_nav`'s existing test file if one exists; `_craft-pins.test.ts` must pass UNTOUCHED for this task.

**§6b content (keep the section shell, `max-w-[560px]`, Reveal stagger, lemon markers):**
- Heading stays: `One subscription for your whole team` (already pinned by tests).
- Sub becomes: `Plans are priced by team size — Starter for small teams, Growth for bigger ones. Every plan includes monthly engineering capacity, measured in tasks.` (NOTE: this spends the em-dash budget's last slot — verify the ≤2 total pin still passes; if the existing "didn't land — counted, not hidden" line plus this one hits exactly 2, good; do NOT add a third anywhere.)
- Steps list: keep the existing 3 lines verbatim (already subscription-true).
- Kicker stays: `One shipped PR pays for the month.`
- Gated `See exact pricing` link: UNTOUCHED.
- No new rebuttal lines ("X, not Y" count stays ≤2), no new mascots, no new `{stats.*}` markers.

**Nav:** add `{ label: "Pricing", href: "/pricing" }` to `MarketingNav`'s items following its existing item shape (read `_nav.tsx` first — it currently has `#top`/Sign in/cta; place Pricing before Sign in). Ungated.

- [ ] TDD: pins for the new §6b sub line (present) + nav Pricing href (present, in `_nav`'s test or a new small pin in pricing-copy.test.ts) → RED → edit → GREEN. Run `_craft-pins.test.ts` and confirm em-dash count = 2 exactly.
- [ ] Full console suite + `tsc --noEmit` → commit `feat(console): landing §6b speaks capacity + pricing nav link`.

### Task 3: Outcome message + legacy budget notice go scope-side

**Files:**
- Modify: `apps/console/lib/outcome-format.ts` (`buildOutcomeMessage` gains `opts?: { hideCost?: boolean }`)
- Modify: its real call sites (grep `buildOutcomeMessage(` — runner/result path and any channel notifier) — pass `hideCost: subscriptionsEnforced()` from server code.
- Modify: `apps/console/app/(marketing)/_conversation-demo-data.ts` (demo passes `hideCost: true`) + `_conversation-demo-data.test.ts` (the :48 template pin updates to the no-dollar shape `AgentRail: PR ready — issue #N (pr-url)`; ADD a companion pin that WITH cost the old shape is byte-identical to before)
- Modify: `apps/console/app/api/v1/runner/claim/route.ts` (the workspace-budget block ~:176-214: when `subscriptionsEnforced()`, skip `notifyWorkspaceBudgetExhausted` — still CAS+log `[runner/claim] budget ceiling hit (internal only, subscriptions on)`; the 204 block behavior itself UNCHANGED — the ceiling still pauses as internal margin protection)
- Modify: `apps/console/app/(dashboard)/dashboard/[workspaceId]/budget/budget-helpers.ts` + `.../wallet/wallet-helpers.ts` (ONE-LINE comment each: internal-only page since slice 6; copy deliberately kept)
- Test: outcome-format tests (both shapes pinned), claim-route tests (flag on ⇒ notify skipped + internal log; flag off ⇒ notify exactly as today), demo tests.

- [ ] TDD → RED → implement → GREEN. The pure builder must NOT read env (param only — pin a test that the builder is deterministic).
- [ ] Full console suite + `tsc --noEmit` → commit `feat(console): outcome message and budget notice speak scope under subscriptions`.

### Task 4: Design-doc truth-up (landing-content-architecture + TASTE billing ruling)

**Files:**
- Modify: `docs/design/landing-content-architecture.md` (rewrite)
- Modify: `TASTE.md` (repo root — three surgical edits)
- Test: none (docs) — but `_craft-pins.test.ts` + `pricing-copy.test.ts` must still pass (they don't read these files; run them anyway as the task's gate).

**landing-content-architecture.md rewrite:** keep the preamble's purpose line; replace the stale spine + table with the CURRENT truth: spine = "AI fractional software engineer, one subscription per team, outcomes not costs" (hero ruling 2026-07-22, subscription pivot 2026-07-29); section table = the LIVE landing map (Hero / PhoneDemo / Use cases / How I work / Where you'll find me / The numbers / Subscription §6b / Closing CTA / footer) with one-line content notes; pricing row → "LIVE: /pricing, outcome-led tiers by team size (slice 7)"; open-decisions section → replace the "what is the paid model" question (DECIDED 2026-07-29: subscriptions by team size) leaving only genuinely open items (enterprise contact address confirmation; pricing-claim-live flip timing).
**TASTE.md surgical edits (owner-voice, mechanical truth-up only — change NOTHING else):**
1. `:291-294` billing ruling → `billing — **owner ruling 2026-07-29: subscription by team size** (Starter $80 ≤4 seats / Growth $200 ≤10 / Enterprise contact; capacity presented as ≈tasks, never dollars; approval sets scope, not a dollar cap — supersedes the 2026-07-22 top-up ruling).`
2. `:274` (and the `:111` echo if it exists inside the landing section) — the "upright serif display voice" clause → align with the 2026-07-22 Berkeley Mono ruling at `:49-61` (serif display RETIRED; mono-first). Smallest accurate edit.
3. `:295` "Inter body" → Berkeley Mono per the same ruling.

- [ ] Make the edits; diff-read TASTE.md to confirm nothing outside the three targets changed; run `_craft-pins.test.ts` + `pricing-copy.test.ts` + full console suite (unchanged code) → commit `docs: landing architecture + TASTE reflect the subscription model`.

---

## Verification & ship

- Full console + db suites, both typechecks, `next build`.
- Whole-slice adversarial review: copy audit against spec §10 vocabulary; retire-list final disposition verified; craft gates (em-dash=2, rebuttals ≤2, mono-on-data, 3 mascots, tokens); flag-off byte-identity for the product surfaces (outcome message, budget notice); demo shows zero dollars.
- Live verify (worktree dev server): `/pricing` renders the new tiers + nav link works + Preview chip shows; landing §6b new sub renders; demo outcome line has no `$`; with flag ON server-side surfaces unchanged from slice 6 verification. Screenshot if the pane cooperates; curl + flight-payload fallback otherwise (house convention).
- PR `feat(console): subscription slice 7 — outcome-led marketing`, base main. Body: before/after copy table, retire-list final state, the enterprise-email owner-confirm callout, docs truth-up summary. THE ARC-CLOSING PR — body ends with the full-arc slice map and the ops-only flag-ON checklist.
- NOT here: contact form; FAQ; pricing-claim-live flip (ops); Stripe env (ops).
