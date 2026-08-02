# Subscription Slice 9 — No Customer-Facing Trial + Landing Pricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two owner rulings (2026-08-02): (1) "we don't have trial — bensigo egwey is just an exception user": the `trial` plan stops being presented to customers anywhere; un-subscribed accounts read as **No plan yet** with usage-only numbers and a choose-a-plan CTA. (2) "in the landing page we should have our pricing": the landing §6b shows the actual tier prices inline, ungated.

**Architecture:** One PR on `feat/sub-s9-no-trial-landing-pricing` (base main ~711e6bec). Display-only, unconditional (slice-8 ruling). The internal `trial` enum value, `PLAN_POLICIES.trial`, backfill, and enforcement semantics ALL stay — trial policy values keep acting as the default grace limits for un-subscribed accounts when enforcement is on; only the PRESENTATION dies. No migrations, no db changes, no enforcement changes.

## Global Constraints

- **No customer surface renders the word "Trial" or a trial-ends date.** Un-subscribed (plan === "trial") accounts present as `No plan yet`; their numbers are USAGE-ONLY (never "0 of 10" — an entitlement claim of a plan they don't have).
- **Pinned copy (byte-exact):**
  - Plan card, no-plan state: headline `No plan yet`; rows `Seats · ${seatsUsed} in use` and `Capacity · ${capacityUsed} tasks this month`; third line `Choose a plan to get started.`; CTA `Choose a plan` → same billing href.
  - Plan card, paid state: EXACTLY today's rendering (planLabel headline, `Seats · X of Y`, `Capacity · N of M tasks this month`, renewalLabel, `Upgrade plan`).
  - Landing §6b tier lines (one per tier, middle dots, NO em-dashes): `Starter · $80/mo · up to 4 people` / `Growth · $200/mo · up to 10 people` / `Enterprise · custom pricing`.
- **Craft gates:** page.tsx em-dash count stays EXACTLY 2; prices/numbers get `font-mono` (TASTE mono-on-data); no new rebuttal lines; tokens only; no new mascots; `_craft-pins.test.ts` + `pricing-copy.test.ts` + `_conversation-demo.tokens-only.test.ts` green.
- **Next route-export contract:** NEVER add named exports to a `page.tsx`/`layout.tsx` (the SidebarWithWorkspaces lesson) — shared tier data gets its own module.
- **Single source for tier values:** one `tiers.ts` module feeds BOTH the pricing page and the landing tier lines. No duplicated price literals.
- House conventions: full console suite + `tsc --noEmit` (must stay 0) before each commit; explicit-path commits + trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Trial dies as a display concept

**Files:**
- Modify: `apps/console/app/(dashboard)/dashboard/[workspaceId]/billing/billing-helpers.ts` — `planLabel` map: `trial: "Trial"` → `trial: "No plan yet"`. Check every other rendered trial-word in the billing folder (grep `Trial`/`trial` across billing/page.tsx + components) and align: the billing page's un-subscribed state presents `No plan yet`, seats as `${used} in use` (NOT seatsLabel's "X of Y") — trace how page.tsx composes the seat text for the plan chip area and adjust only the trial branch.
- Modify: `apps/console/lib/plan-card-data.ts` — `PlanCardData` gains `hasPlan: boolean` (`account.plan !== "trial"`); the trial `renewalText` branch (`Trial ends …`, :131) becomes `Choose a plan to get started.`; doc-comment updated (owner ruling 2026-08-02: no customer-facing trial; internal enum + grace limits remain). `formatUtcDate` import may die — remove if unused.
- Modify: `apps/console/app/(dashboard)/dashboard/[workspaceId]/components/digest-panel.tsx` — `PlanCardBlock` branches on `data.hasPlan`: false ⇒ the no-plan state per Global Constraints (headline `No plan yet`, usage-only rows, `Choose a plan to get started.` line, CTA `Choose a plan`); true ⇒ byte-identical today.
- Modify: `apps/console/app/(dashboard)/dashboard/[workspaceId]/components/digest-panel-helpers.ts` — add `seatsInUseText(n)` / `capacityUsedText(n)` pure helpers for the usage-only rows (pinned).
- Modify: `docs/superpowers/specs/2026-07-29-subscription-platform-design.md` §7 trial paragraph — append: `Owner ruling 2026-08-02: no customer-facing trial. Un-subscribed accounts present as "No plan yet" (usage-only numbers, choose-a-plan CTA); the internal trial enum and its policy values remain as the default grace limits for enforcement.`
- Tests: plan-card-data.test.ts (trial fixture ⇒ hasPlan false + the new third-line string + NO `Trial ends`; growth fixture ⇒ hasPlan true unchanged); digest-panel tests (both PlanCardBlock states pinned byte-exact; sweep: `Trial` appears in NEITHER state's output); helpers pins; billing page/helpers tests updated. Repo sweep: grep rendered `Trial` in apps/console app/(dashboard) + lib — zero customer-visible hits remain (test files/comments/enum internals fine).

- [ ] TDD pins-first → RED → implement → GREEN → full console suite + `tsc --noEmit` → commit `feat(console): un-subscribed accounts read as "No plan yet" — trial retired from display`.

### Task 2: Landing shows the pricing

**Files:**
- Create: `apps/console/app/(marketing)/pricing/tiers.ts` — extract the `Tier` type + `TIERS` array from `pricing/page.tsx` VERBATIM (all fields incl. features/ctaLabel); pricing/page.tsx imports from it (no other change there — its pins must stay green untouched).
- Modify: `apps/console/app/(marketing)/page.tsx` §6b — after the kicker, render the three tier lines from the shared `TIERS` (map name/price + a landing-local seats descriptor per Global Constraints copy — the `up to N people` phrasing derives from the tier's seat data, but the LITERAL pinned strings govern; a tiny local map `{Starter: "up to 4 people", Growth: "up to 10 people", Enterprise: "custom pricing"}` keyed by name is acceptable and honest since seat NUMBERS still come from... prefer deriving `up to ${n} people` from a numeric field if TIERS carries one; read the Tier type first and choose the least-duplicative derivation, documenting it). Prices in `font-mono`. Then UNGATE the `See exact pricing` link (remove the `isPricingClaimLive()` wrapper + its import if unused; the pricing page's own Live/Preview chip carries payment honesty — one-line comment). Section shell/Reveal/markers unchanged.
- Tests: pricing-copy.test.ts — landing present-pins for all three tier lines (render-site anchored, the slice-7 lesson); pricing page pins UNTOUCHED and green (proves the extraction changed nothing); `_pricing-gate.test.ts` — the gate function tests stay (the pricing page chip still uses it); update/remove only an assertion that pinned the landing link as gated, if one exists (grep first). `_craft-pins.test.ts` green with em-dash exactly 2; add the tier-price mono pin if the file's marker convention makes it cheap (`monoAppliesBefore` marker for the tier-price render site).

- [ ] TDD pins-first → RED → implement → GREEN → full console suite + `tsc --noEmit` + `next build` (the page-module extraction must survive route-type validation) → commit `feat(console): landing shows tier pricing inline`.

---

## Verification & ship
- Full console + db suites, `tsc --noEmit` 0, `next build` clean.
- Whole-branch review (single reviewer): the two pinned copy sets byte-exact; no rendered `Trial` anywhere customer-visible; tier values single-sourced (grep `$80` outside tiers.ts/tests = pricing/landing render sites only via import); em-dash 2; enforcement + db untouched; pricing page pins untouched.
- Live verify (dev server): dashboard plan card shows `No plan yet` + usage-only rows for the dev trial account; billing page consistent; landing §6b shows the three tier lines + ungated link; /pricing unchanged.
- PR `feat(console): no customer-facing trial + landing pricing`, base main; body records both rulings.
