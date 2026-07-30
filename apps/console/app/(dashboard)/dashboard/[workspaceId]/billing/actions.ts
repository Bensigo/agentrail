"use server";

import type Stripe from "stripe";
import { headers } from "next/headers";
import {
  db,
  bindStripeCustomer,
  getBillingAccountForWorkspace,
  type BillingAccountRow,
} from "@agentrail/db-postgres";
import { getMembership, getSession } from "../../../../../lib/cached";
import { getStripeClient } from "../../../../../lib/stripe";
import {
  subscriptionBillingConfigured,
  subscriptionPriceId,
  type PaidPlan,
} from "../../../../../lib/billing/stripe-plans";

/**
 * Subscription checkout server action (subscription-platform-design spec
 * `docs/superpowers/specs/2026-07-29-subscription-platform-design.md` §3,
 * §9; slice-3 plan
 * `docs/superpowers/plans/2026-07-29-subscription-stripe-slice3.md`,
 * Task 3). Creates a Stripe Checkout Session in `mode: "subscription"` for
 * one of the two self-serve plans (`PaidPlan` — "enterprise" is sold
 * off-platform and "trial" has no Stripe price; see `stripe-plans.ts`) and
 * returns its URL.
 *
 * Mirrors `wallet/actions.ts`'s shape and this repo's "webhook is the only
 * billing-state writer" house rule, restated in the slice-3 plan's Global
 * Constraints: "Checkout actions never touch `billing_accounts` money/plan
 * state except binding a freshly-created Stripe customer id." This action
 * makes exactly ONE possible DB write — `bindStripeCustomer` — and only the
 * first time a workspace's billing account ever checks out (see the
 * ensure-customer step below). The SUBSCRIPTION itself (`plan`,
 * `subscription_status`, `stripe_subscription_id`, `current_period_end`) is
 * written exclusively by the signature-verified webhook (Task 4) once
 * Stripe confirms the subscription actually exists — this action only ever
 * gets as far as starting a Checkout Session, which the customer can
 * abandon, back-button, or which Stripe can decline downstream, none of
 * which is observable here. Same posture as the wallet top-up flow's own
 * "never credits the wallet" doc-comment, just for subscriptions instead of
 * one-off payments.
 *
 * Auth follows the same owner-OR-admin `ADMIN_ROLES` precedent as the
 * wallet flow (slice-3 plan's Global Constraints, pointing at
 * `wallet/actions.ts:32,78-84`) — managing the company subscription is an
 * admin-level action, not the owner-only trust ceiling
 * `permissions/actions.ts` gates.
 *
 * No billing account for the workspace is a typed error, never a
 * create-on-the-fly: Task 6 (trial billing account at workspace creation)
 * guarantees every workspace already has one by the time a human can click
 * a checkout button, so this function is intentionally read-only on that
 * front — inventing an account here would risk racing or duplicating
 * Task 6's own insert.
 */

export type CreateSubscriptionCheckoutResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

const ADMIN_ROLES = ["owner", "admin"] as const;
const PAID_PLANS = ["starter", "growth"] as const;

/**
 * Identical derivation to `wallet/actions.ts`'s own `resolveOrigin` —
 * duplicated rather than extracted into a shared helper, matching this
 * codebase's established convention of re-declaring small per-route/action
 * helpers rather than centralizing them (see `ADMIN_ROLES` itself, copied
 * verbatim at every one of this repo's admin-gated route/action files).
 */
async function resolveOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3001";
  const proto =
    h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export async function createSubscriptionCheckoutSessionAction(
  workspaceId: string,
  plan: PaidPlan,
  deps: {
    stripe?: Stripe;
    db?: typeof db;
    fetchAccount?: typeof getBillingAccountForWorkspace;
    bindCustomer?: typeof bindStripeCustomer;
  } = {}
): Promise<CreateSubscriptionCheckoutResult> {
  // #1343 minor (d): a Server Action is a real wire endpoint, not just a
  // typed function call — validate every argument at runtime even though
  // the client's own TS types already constrain both parameters (same
  // posture as wallet/actions.ts and permissions/actions.ts).
  if (typeof workspaceId !== "string" || !workspaceId) {
    return { ok: false, error: "Missing workspace." };
  }
  if (!PAID_PLANS.includes(plan as (typeof PAID_PLANS)[number])) {
    return { ok: false, error: "Unknown plan." };
  }

  const session = await getSession();
  const userId = session?.user?.id;
  if (!userId) {
    return { ok: false, error: "Not signed in." };
  }

  const membership = await getMembership(userId, workspaceId);
  if (
    !membership ||
    !ADMIN_ROLES.includes(membership.role as (typeof ADMIN_ROLES)[number])
  ) {
    return { ok: false, error: "Only an owner or admin can manage the subscription." };
  }

  // Fail fast on misconfiguration BEFORE touching Postgres or Stripe, same
  // spot wallet/actions.ts checks getStripeClient() — right after authz,
  // before any further work.
  if (!subscriptionBillingConfigured()) {
    return { ok: false, error: "Billing isn't configured for this deployment yet." };
  }
  const priceId = subscriptionPriceId(plan);
  if (!priceId) {
    return { ok: false, error: "This plan isn't available for checkout yet." };
  }

  const stripe = deps.stripe ?? getStripeClient();
  if (!stripe) {
    return { ok: false, error: "Billing isn't configured for this deployment yet." };
  }

  const database = deps.db ?? db;
  const fetchAccount = deps.fetchAccount ?? getBillingAccountForWorkspace;
  const bindCustomer = deps.bindCustomer ?? bindStripeCustomer;

  let account: BillingAccountRow | null;
  try {
    account = await fetchAccount(database, workspaceId);
  } catch (err) {
    console.error("[billing] failed to fetch the billing account:", err);
    return { ok: false, error: "Couldn't start checkout. Try again in a moment." };
  }
  if (!account) {
    return { ok: false, error: "This workspace doesn't have a billing account yet." };
  }

  // Ensure a Stripe customer exists — the ONE write this action may make
  // (see this module's top doc-comment). `bindStripeCustomer` is fill-only
  // (`WHERE stripe_customer_id IS NULL`), so a second checkout attempt
  // racing this one is benign: whichever completes second finds the guard
  // already tripped and silently no-ops instead of clobbering the
  // first-bound id.
  let stripeCustomerId = account.stripeCustomerId;
  if (!stripeCustomerId) {
    try {
      const customer = await stripe.customers.create({
        metadata: { billingAccountId: account.id },
      });
      stripeCustomerId = customer.id;
      await bindCustomer(database, account.id, stripeCustomerId);
    } catch (err) {
      console.error("[billing] failed to create/bind the Stripe customer:", err);
      return { ok: false, error: "Couldn't start checkout. Try again in a moment." };
    }
  }
  if (!stripeCustomerId) {
    // Unreachable in practice — the branch above always either assigns a
    // value or returns early on failure. A pure type-narrowing guard so
    // the checkout-session call below can treat `customer` as a plain
    // `string`.
    return { ok: false, error: "Couldn't start checkout. Try again in a moment." };
  }

  const origin = await resolveOrigin();

  let checkoutUrl: string | null;
  try {
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: stripeCustomerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/dashboard/${workspaceId}/billing?checkout=success`,
      cancel_url: `${origin}/dashboard/${workspaceId}/billing?checkout=cancelled`,
      // Task 4's webhook reads `metadata.billingAccountId` off the SESSION
      // to resolve which account a `checkout.session.completed` event
      // means (mirrors wallet/actions.ts's own metadata comment).
      metadata: { billingAccountId: account.id, plan },
      // The webhook ALSO needs the account id on the SUBSCRIPTION object
      // itself, not just the session: every subsequent
      // `customer.subscription.*` event payload carries the subscription,
      // never the checkout session that originally created it.
      subscription_data: {
        metadata: { billingAccountId: account.id },
      },
    });
    checkoutUrl = checkoutSession.url;
  } catch (err) {
    console.error("[billing] failed to create Stripe Checkout Session:", err);
    return { ok: false, error: "Couldn't start checkout. Try again in a moment." };
  }

  if (!checkoutUrl) {
    return { ok: false, error: "Stripe didn't return a checkout URL." };
  }

  return { ok: true, url: checkoutUrl };
}
