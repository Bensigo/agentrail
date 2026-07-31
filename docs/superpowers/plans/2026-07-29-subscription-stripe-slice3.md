# Subscription Slice 3 — Stripe Subscriptions + Copy Truth-Up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real company subscriptions — Stripe subscription checkout, webhook lifecycle, customer portal, a Plan & billing page, trial accounts at workspace creation — plus the rollout rider: the public pricing surface stops promising "No seats, no subscription" (spec §9 rollout decision, `docs/superpowers/specs/2026-07-29-subscription-platform-design.md`).

**Architecture:** One PR on `feat/sub-s3-stripe` (base `main`, which now contains slices 0–2). The webhook remains the ONLY writer of billing state (house rule from the wallet engine); checkout actions only create Stripe sessions. Plan↔price mapping rides env-configured Stripe price ids. Subscription checkout is NOT behind `BILLING_SUBSCRIPTIONS_ENFORCED` (paying must work before enforcement); the flag continues to gate enforcement only, and stays OFF.

**Tech Stack:** Stripe SDK v18 (`apps/console/lib/stripe.ts` — `getStripeClient()`, returns null unconfigured), Next.js server actions, Drizzle/Postgres (`billing_accounts` from slice 1), vitest.

## Global Constraints

- **Webhook = only billing-state writer.** Checkout actions never touch `billing_accounts` money/plan state except binding a freshly-created Stripe customer id.
- **Verify Stripe v18 API shapes against `node_modules/stripe`'s own `.d.ts`** for every call you write (`checkout.sessions.create`, `billingPortal.sessions.create`, `customers.create`, webhook event object shapes) — never from memory.
- **Existing wallet top-up flow must keep working unchanged**: `checkout.session.completed` with `mode === "payment"` follows the exact current path (`packages/db-postgres/src/queries/stripe_events.ts:54-92` credit + auto-enable). Subscription handling discriminates on `mode === "subscription"` / event types, never replaces the payment path.
- **Idempotency via the existing `stripe_events` dedup ledger** (`event_id` UNIQUE) for every new event type.
- New env vars: `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_GROWTH` — document them AND the two existing undocumented ones (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) in `.env.example`.
- Plans in code: `PLAN_POLICIES` from `apps/console/lib/policy/plan-policies.ts` is the source of seat limits shown in UI ($80/$200 prices may be stated in copy; never derive policy values from Stripe).
- Owner/admin gating for billing mutations: the `ADMIN_ROLES` membership-check pattern from `apps/console/app/(dashboard)/dashboard/[workspaceId]/wallet/actions.ts:32,78-84`.
- **Branch:** `feat/sub-s3-stripe`, base `main`. Commit format + trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. House test conventions as in the foundation plan (db mocks render SQL; console tests colocated).
- The copy truth-up (Task 7) changes CLAIMS, not information architecture — the full outcome-led pricing rewrite stays in slice 7. `NEXT_PUBLIC_BILLING_VERIFIED_LIVE` (`apps/console/app/(marketing)/_pricing-gate.ts:27`) remains the "Live vs Preview" honesty gate.

---

### Task 1: Plan↔price mapping + Stripe env plumbing

**Files:**
- Create: `apps/console/lib/billing/stripe-plans.ts`
- Modify: `.env.example` (document `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_GROWTH` with one-line comments)
- Test: `apps/console/lib/billing/stripe-plans.test.ts`

**Interfaces (produces):**
```ts
export type PaidPlan = "starter" | "growth";
export function subscriptionPriceId(plan: PaidPlan, env?: NodeJS.ProcessEnv): string | null;   // reads STRIPE_PRICE_STARTER / STRIPE_PRICE_GROWTH
export function resolvePlanFromPriceId(priceId: string, env?: NodeJS.ProcessEnv): PaidPlan | null;
export function subscriptionBillingConfigured(env?: NodeJS.ProcessEnv): boolean;               // both price ids present AND isStripeConfigured()
```
- [ ] Failing tests (env injected: mapping both ways, null on missing/unknown, configured only when all three present) → RED → implement → GREEN → commit `feat(console): stripe plan-price mapping + env plumbing`.

### Task 2: Subscription-state write queries

**Files:**
- Modify: `packages/db-postgres/src/queries/billing_accounts.ts` (+ barrel `queries/index.ts`)
- Test: extend `packages/db-postgres/src/__tests__/billing-accounts-queries.test.ts`

**Interfaces (produces):**
```ts
export function bindStripeCustomer(db: Db, billingAccountId: string, stripeCustomerId: string): Promise<void>;   // fill-only: WHERE stripe_customer_id IS NULL
export function getBillingAccountByStripeCustomerId(db: Db, stripeCustomerId: string): Promise<BillingAccountRow | null>;
export function applySubscriptionState(db: Db, args: {
  billingAccountId: string;
  plan: "trial" | "starter" | "growth" | "enterprise";
  subscriptionStatus: string;                 // Stripe status verbatim: active | past_due | canceled | …
  stripeSubscriptionId: string | null;
  currentPeriodEnd: Date | null;
}): Promise<void>;                            // one UPDATE, last-write-wins (webhook-ordered)
```
- [ ] Failing tests (rendered SQL: fill-only guard on bind; applySubscriptionState sets exactly the four columns + updated_at; lookup by customer id) → RED → implement (raw-SQL idiom of this file) → GREEN → full db suite + typecheck → commit `feat(db): subscription state writes on billing accounts`.

### Task 3: Subscription checkout server action

**Files:**
- Create: `apps/console/app/(dashboard)/dashboard/[workspaceId]/billing/actions.ts`
- Test: `apps/console/app/(dashboard)/dashboard/[workspaceId]/billing/actions.test.ts` (mirror the wallet action test's mocking style if one exists; otherwise inject `{stripe, db, fetchAccount}` deps)

**Behavior** (read `wallet/actions.ts:50-134` first and mirror its structure/authz):
1. Owner/admin only (`ADMIN_ROLES` pattern); resolve `getBillingAccountForWorkspace` — no account → error result (never create here; Task 6 guarantees accounts exist).
2. Ensure Stripe customer: if `account.stripeCustomerId` null → `stripe.customers.create({ metadata: { billingAccountId } })` → `bindStripeCustomer` (the ONE write this action may do).
3. `stripe.checkout.sessions.create({ mode: "subscription", customer, line_items: [{ price: subscriptionPriceId(plan), quantity: 1 }], success_url/cancel_url → the billing page, metadata: { billingAccountId, plan } , subscription_data: { metadata: { billingAccountId } } })` — verify exact v18 param names against the SDK types.
4. Return the session URL (redirect happens client-side/form action, same as wallet).
- [ ] TDD: authz reject; no-account error; customer created+bound only when missing; session params (mode, price, both metadata sites) asserted via injected stripe mock → commit `feat(console): subscription checkout action`.

### Task 4: Webhook subscription lifecycle

**Files:**
- Modify: `apps/console/app/api/v1/billing/stripe/webhook/route.ts`
- Modify: `packages/db-postgres/src/queries/stripe_events.ts` (new recorder for subscription events reusing the dedup-insert transaction pattern of `:54-92`)
- Test: extend the existing webhook/stripe_events tests (find them next to the modified files)

**Events** (each idempotent via `stripe_events` UNIQUE insert; unknown events keep being ignored):
- `checkout.session.completed` — `mode === "payment"`: EXISTING path, byte-identical. `mode === "subscription"`: read `metadata.billingAccountId` + subscription id + price → `bindStripeCustomer` (fill-only) + `applySubscriptionState({ plan: resolvePlanFromPriceId(price), subscriptionStatus: "active", stripeSubscriptionId, currentPeriodEnd })`.
- `customer.subscription.updated` — resolve account by `subscription.metadata.billingAccountId`, fallback `getBillingAccountByStripeCustomerId`; mirror status + plan (from the first item's price id) + `current_period_end`.
- `customer.subscription.deleted` — `applySubscriptionState({ plan: "trial", subscriptionStatus: "canceled", stripeSubscriptionId: null, currentPeriodEnd: null })` — the resolver then serves trial policy; enforcement of trial expiry is a later slice.
- `invoice.payment_failed` — status `past_due` only (no plan change).
- Unknown price id on any event → record the event, log loudly, change nothing (never guess a plan).
- [ ] TDD per event (construct realistic event fixtures from the SDK types; signature verification path unchanged) → full console webhook tests + db suite + typecheck → commit `feat(console): stripe subscription webhook lifecycle`.

### Task 5: Plan & billing page + customer portal

**Files:**
- Create: `apps/console/app/(dashboard)/dashboard/[workspaceId]/billing/page.tsx` (+ small server components as needed)
- Modify: `apps/console/app/components/sidebar-nav.ts` (SETTINGS_ZONE gains "Plan & billing"; read `:131-164` and mirror an existing entry)
- Modify: `billing/actions.ts` (add `createPortalSession` action: `stripe.billingPortal.sessions.create({ customer, return_url })`, admin-gated)
- Test: page helpers colocated (`billing/billing-helpers.ts` + test) for the display shaping (plan label, renewal date, seats "X of Y")

**Content** (server component; read a Settings-zone page for idiom first): current plan card — plan name, subscription status chip, renewal date (`current_period_end`), seats used (`countActiveSeats`) vs `PLAN_POLICIES[plan].seatLimit`; Starter/Growth checkout buttons (form actions from Task 3; hidden when `!subscriptionBillingConfigured()`); "Manage billing" portal link (only when `stripeCustomerId` present). Copy: product guidance voice, no dollar-cost-of-AI anywhere, prices $80/$200 stated plainly.
- [ ] TDD on helpers; page compiles + renders in typecheck; commit `feat(console): plan & billing settings page + portal`.

### Task 6: Trial billing account at workspace creation

**Files:**
- Modify: `packages/db-postgres/src/queries/index.ts` — `createWorkspace` (`:1438-1456`) and `completeOwnerElectWorkspace` (`:1539+`)
- Test: extend the existing tests covering those two functions (find them in `src/__tests__/`)

**Behavior:** inside each function's existing transaction: if the (new) workspace row has NULL `billing_account_id`, insert a `billing_accounts` row (`plan 'trial'`, `trial_ends_at now()+14d`, name = workspace name) and stamp the workspace. Idempotent WHERE-guard (only when NULL) so retries can't double-create — mirror the 0062 backfill's semantics in TS.
- [ ] TDD (account created + stamped in-transaction; pre-stamped workspace untouched) → db suite + typecheck → commit `feat(db): trial billing account at workspace creation`.

### Task 7: Copy truth-up (rollout rider — the public surface stops contradicting the model)

**Files:**
- Modify: `apps/console/app/(marketing)/pricing/page.tsx`
- Modify: `apps/console/app/(marketing)/page.tsx` (§6b, ~`:303-356`)
- Test: `apps/console/app/(marketing)/pricing/pricing-copy.test.ts` (string-level assertions on the exported copy constants — extract copy into a small exported structure if the page is pure JSX today)

**Requirements:**
1. DELETE the claims: "No seats, no subscription." (`pricing/page.tsx:74`), "no per-seat charge, no monthly minimum" (`:124-126`), "No seats. No subscription. Every run shows its cost next to its PR." (`page.tsx:336-337`), and the actual-token-cost + $0.50 + $1.00 `<dl>` (`:97-114`) with its `FLAT_SERVER_FEE_CENTS` imports.
2. REPLACE with minimal honest subscription copy (not the slice-7 rewrite): three tiers — Starter $80/mo, up to 4 seats, ≈350 engineering tasks included · Growth $200/mo, up to 10 seats, ≈1,000 included · Enterprise, contact us. One-line framing: an AI software engineer for your team; plans by team size. Landing §6b heading "Pay for what you use" → "One subscription for your whole team." Keep the `isPricingClaimLive()` Live/Preview chip logic intact.
3. A test pins the dead phrases stay dead: assert the page sources no longer contain "No seats" / "no subscription" / "per-seat charge" (read file content in the test, same mechanism as the import-direction test).
4. Grep the marketing tree for other instances of the retired claims (`(marketing)/` only) and update any found — list them in the report.
- [ ] TDD → console tests + typecheck → commit `feat(console): pricing copy truth-up — retire anti-subscription claims`.

---

## Verification & ship

- Full suites: db-postgres + console (delta vs the 17 known pre-existing channel-dispatch failures) + both typechecks.
- Coordinator: browser-verify `/pricing` and the billing page render (dev server) before PR merge; confirm main CI green from the foundation merges first.
- PR: `feat(console): subscription slice 3 — stripe subscriptions + copy truth-up`, base `main`, body lists the four env vars ops must set (secret, webhook secret, two price ids) and the Stripe dashboard prerequisites (two recurring Prices, webhook endpoint with the four event types, portal configuration).
- NOT in this slice: enforcement flag flip (user does it after the seed-fix chip lands), seat lifecycle, gates, console cost-UI demotion, full pricing-page redesign.
