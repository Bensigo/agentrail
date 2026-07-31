import { isStripeConfigured } from "../stripe";

/**
 * Plan <-> Stripe Price id mapping (subscription slice 3 plan,
 * `docs/superpowers/plans/2026-07-29-subscription-stripe-slice3.md`, Task 1).
 *
 * Pure config plumbing — the ONLY thing this module knows is which env var
 * holds which plan's Stripe recurring Price id, and the inverse lookup.
 * Plans and their entitlements (seat limits, capacity, quality profiles,
 * budgets) live in CODE, in `lib/policy/plan-policies.ts`'s
 * `PLAN_POLICIES` — Stripe Price ids are deployment config (they differ
 * between Stripe test mode, live mode, and any future second Stripe
 * account), never a source of policy truth. NEVER derive a policy value
 * from anything Stripe returns; the only fact this module is allowed to
 * learn from Stripe is "which `PaidPlan` does this Price id correspond to"
 * and back — nothing about seats, capacity, or budget.
 *
 * `PaidPlan` is deliberately narrower than `plan-policies.ts`'s
 * `BillingPlan` ("trial" | "starter" | "growth" | "enterprise"): "trial" has
 * no Stripe Price (granted free at workspace creation, slice-3 Task 6) and
 * "enterprise" is sold off-platform (Stripe Checkout never runs for it) —
 * only the two self-serve plans a customer can actually buy through
 * Checkout have a Price id to map.
 */

export type PaidPlan = "starter" | "growth";

/**
 * The subset of `process.env` this module reads — injectable for tests so
 * they never need to mutate the real `process.env` for the price-id checks
 * (mirrors `lib/policy/feature-flags.ts`'s `SubscriptionFeatureFlagEnv`
 * idiom, including the index signature required for `NodeJS.ProcessEnv` to
 * satisfy this type as the default parameter value below). Does NOT cover
 * `STRIPE_SECRET_KEY` — see `subscriptionBillingConfigured`'s doc comment.
 */
export interface StripePlanEnv {
  STRIPE_PRICE_STARTER?: string | undefined;
  STRIPE_PRICE_GROWTH?: string | undefined;
  [key: string]: string | undefined;
}

const PRICE_ENV_VAR: Record<PaidPlan, "STRIPE_PRICE_STARTER" | "STRIPE_PRICE_GROWTH"> = {
  starter: "STRIPE_PRICE_STARTER",
  growth: "STRIPE_PRICE_GROWTH",
};

/**
 * Iteration order for the inverse lookup below — also the tie-break if a
 * deployment ever misconfigures both plans to the same Price id ("starter"
 * wins). No real deployment should hit that: each plan is its own Stripe
 * Price object with its own unique id.
 */
const PAID_PLANS: readonly PaidPlan[] = ["starter", "growth"];

/**
 * The Stripe recurring Price id configured for `plan`, or `null` if unset
 * or empty. `env` defaults to the real `process.env`; pass a fake object in
 * tests.
 */
export function subscriptionPriceId(
  plan: PaidPlan,
  env: StripePlanEnv = process.env
): string | null {
  const value = env[PRICE_ENV_VAR[plan]];
  return value !== undefined && value.length > 0 ? value : null;
}

/**
 * The inverse of `subscriptionPriceId`: which `PaidPlan` a Stripe Price id
 * belongs to, resolved against that SAME env-configured mapping (never a
 * hardcoded/duplicated table). `null` when `priceId` matches neither
 * configured price — including when a price env is unset entirely. Callers
 * (the webhook, Task 4) must treat `null` as "never guess a plan", per the
 * slice-3 plan's "Unknown price id on any event -> record the event, log
 * loudly, change nothing" rule.
 */
export function resolvePlanFromPriceId(
  priceId: string,
  env: StripePlanEnv = process.env
): PaidPlan | null {
  for (const plan of PAID_PLANS) {
    if (subscriptionPriceId(plan, env) === priceId) return plan;
  }
  return null;
}

/**
 * Whether subscription checkout can run at all: both plan Price ids are
 * configured AND the Stripe client itself is configured
 * (`isStripeConfigured()`, `lib/stripe.ts`).
 *
 * `isStripeConfigured()` has no injectable-env override (see that module's
 * own doc comment — this codebase has no central env schema) — it always
 * reads the REAL `process.env["STRIPE_SECRET_KEY"]`, regardless of what
 * `env` is passed here. So `env` only ever governs the two price-id checks;
 * a test exercising the Stripe-key half of this function must set/restore
 * `process.env["STRIPE_SECRET_KEY"]` directly (same posture as
 * `app/api/v1/billing/stripe/webhook/route.test.ts`), not via `env`.
 */
export function subscriptionBillingConfigured(env: StripePlanEnv = process.env): boolean {
  return (
    subscriptionPriceId("starter", env) !== null &&
    subscriptionPriceId("growth", env) !== null &&
    isStripeConfigured()
  );
}
