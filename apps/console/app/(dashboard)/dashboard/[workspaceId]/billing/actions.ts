"use server";

import type Stripe from "stripe";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import {
  db,
  bindStripeCustomer,
  getBillingAccountForWorkspace,
  getBillingAccountIdForWorkspace,
  getSeatAccountId,
  releaseSeat,
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

  // Final whole-slice review, Critical: without this check, an
  // already-subscribed account could start a SECOND, independent Stripe
  // subscription by clicking a different plan's checkout button rather than
  // changing the existing one — `applySubscriptionStateForStripeEvent` (the
  // webhook) is last-write-wins, so one subscription would end up billing
  // invisibly. Plan changes go through the Stripe customer portal instead
  // (`createPortalSessionAction` below), already wired on this page's
  // "Manage billing" button. Checked here, server-side and independent of
  // `canStartCheckout` in `billing-helpers.ts` (which only hides the UI),
  // BEFORE any Stripe call — including the ensure-customer step next.
  if (account.stripeSubscriptionId) {
    return {
      ok: false,
      error: "This workspace already has a subscription. Use Manage billing to change plans.",
    };
  }

  // Ensure a Stripe customer exists — the ONE write this action may make
  // (see this module's top doc-comment). `bindStripeCustomer` is fill-only
  // (`WHERE stripe_customer_id IS NULL`), so a second checkout attempt
  // racing this one is benign in the sense that neither write can clobber
  // the other — but it CAN still lose: two concurrent attempts each create
  // their OWN Stripe customer, and only the first bind wins, so
  // `billing_accounts.stripe_customer_id` can end up permanently pointing
  // at the LOSING (dead, unused) customer while the actual paying
  // subscription lives on the other one. That's acceptable, not a
  // correctness bug, ONLY because the webhook (Task 4,
  // `stripe/webhook/route.ts`) never resolves an account through this
  // column as its primary path — it resolves METADATA-FIRST: the checkout
  // session below stamps `billingAccountId` on both `metadata` (the
  // session itself) AND `subscription_data.metadata` (the subscription it
  // creates), so whichever Stripe object a later event is actually about
  // always carries the correct account id regardless of which customer bind
  // won. `getBillingAccountByStripeCustomerId` — the one place this
  // possibly-wrong column IS read — is a fallback the webhook only reaches
  // when that metadata is absent, and it loudly `console.warn`s every time
  // it's used.
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

export type CreatePortalSessionResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

/**
 * Stripe customer-portal session (slice-3 plan Task 5). Backs the Settings
 * "Plan & billing" page's "Manage billing" button — hands an
 * already-subscribed customer to Stripe's own hosted portal (payment
 * method, invoices, cancel) instead of this app reimplementing any of that.
 *
 * Unlike `createSubscriptionCheckoutSessionAction` above, this NEVER creates
 * a Stripe customer — a missing `stripeCustomerId` is a typed error, never
 * create-on-the-fly, matching this module's own "no billing account for the
 * workspace is a typed error" posture at the top of this file (there's
 * nothing to manage in the portal until a checkout has run at least once).
 *
 * `subscriptionBillingConfigured()` is deliberately NOT the gate here
 * (contrast the checkout action above): that check also requires both plan
 * Price ids to be set, which the portal has no dependency on — an account
 * that already has a `stripeCustomerId` (from an earlier checkout) must
 * still be able to manage its existing subscription even if this
 * deployment's price-id env later goes stale or a plan gets discontinued.
 * The only real dependency is Stripe itself being configured
 * (`getStripeClient()`), same gate the wallet top-up flow uses.
 *
 * Same owner-OR-admin `ADMIN_ROLES` authz as checkout above — managing
 * billing (including cancellation, from inside Stripe's own portal UI) is
 * the same admin-level trust as starting a subscription.
 */
export async function createPortalSessionAction(
  workspaceId: string,
  deps: {
    stripe?: Stripe;
    db?: typeof db;
    fetchAccount?: typeof getBillingAccountForWorkspace;
  } = {}
): Promise<CreatePortalSessionResult> {
  // Same "a Server Action is a real wire endpoint" runtime check as
  // createSubscriptionCheckoutSessionAction above (#1343 minor (d)).
  if (typeof workspaceId !== "string" || !workspaceId) {
    return { ok: false, error: "Missing workspace." };
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

  const stripe = deps.stripe ?? getStripeClient();
  if (!stripe) {
    return { ok: false, error: "Billing isn't configured for this deployment yet." };
  }

  const database = deps.db ?? db;
  const fetchAccount = deps.fetchAccount ?? getBillingAccountForWorkspace;

  let account: BillingAccountRow | null;
  try {
    account = await fetchAccount(database, workspaceId);
  } catch (err) {
    console.error("[billing] failed to fetch the billing account:", err);
    return { ok: false, error: "Couldn't open billing. Try again in a moment." };
  }
  if (!account) {
    return { ok: false, error: "This workspace doesn't have a billing account yet." };
  }
  if (!account.stripeCustomerId) {
    return { ok: false, error: "This workspace hasn't started a subscription yet." };
  }

  const origin = await resolveOrigin();

  let portalUrl: string;
  try {
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: account.stripeCustomerId,
      return_url: `${origin}/dashboard/${workspaceId}/billing`,
    });
    portalUrl = portalSession.url;
  } catch (err) {
    console.error("[billing] failed to create Stripe billing portal session:", err);
    return { ok: false, error: "Couldn't open billing. Try again in a moment." };
  }

  return { ok: true, url: portalUrl };
}

export type ReleaseSeatResult = { ok: true } | { ok: false; error: string };

/**
 * Release-a-seat server action (subscription-platform-design spec §5, §7
 * "seats list with release"; slice-4 plan Task 5). Backs the Plan & billing
 * page's per-seat Release button (`components/release-seat-button.tsx`).
 *
 * Same owner-OR-admin `ADMIN_ROLES` authz as the checkout/portal actions
 * above — managing seats is the same admin-level trust as managing the
 * subscription itself, not the owner-only ceiling `permissions/actions.ts`
 * gates — re-checked here server-side regardless of what the page's own
 * `canManage` prop hid client-side.
 *
 * Ownership check, BEFORE calling `releaseSeat`: unlike the two actions
 * above (whose only caller-supplied id is `workspaceId` itself, the thing
 * membership is already checked against), this action ALSO takes a bare
 * `seatId` — and nothing about that id, by itself, proves it belongs to the
 * workspace the caller has admin rights on. Without this check, an
 * admin/owner of workspace A could release a seat belonging to workspace B's
 * account simply by knowing (or guessing/replaying) its id. This resolves
 * the CALLER's own account id (`getBillingAccountIdForWorkspace`, the
 * id-only sibling — this action never needs the full row) and the SEAT's
 * actual account id (`getSeatAccountId`, `queries/seats.ts`, added for this
 * action) and compares them; a mismatch is a typed error and `releaseSeat`
 * is never reached.
 *
 * Releasing your own seat is explicitly ALLOWED — nothing here checks
 * whether the seat being released belongs to the calling user, and that's
 * intentional (slice-4 plan Task 5's own note): a seat is claimed again on
 * that person's next served chat turn or console visit (`claimSeat`'s own
 * ON CONFLICT DO NOTHING no-op-or-insert contract), so releasing your own
 * seat self-heals on your next served turn rather than locking you out of
 * anything — there is no session/auth dependency anywhere on this app that
 * requires holding an active seat.
 *
 * `revalidatePath` on success only (mirrors `permissions/actions.ts`'s
 * `setMergePermissionAction` own precedent for a same-page mutation, as
 * opposed to the checkout/portal actions above, which redirect off-page and
 * have no local list to refresh) so the seats list reflects the release the
 * moment the client's own `router.refresh()` runs
 * (`components/release-seat-button.tsx`) without racing a stale
 * Next.js Data Cache entry.
 */
export async function releaseSeatAction(
  workspaceId: string,
  seatId: string,
  deps: {
    db?: typeof db;
    fetchAccountId?: typeof getBillingAccountIdForWorkspace;
    fetchSeatAccountId?: typeof getSeatAccountId;
    doRelease?: typeof releaseSeat;
  } = {}
): Promise<ReleaseSeatResult> {
  // #1343 minor (d): a Server Action is a real wire endpoint, not just a
  // typed function call — validate every argument at runtime (same posture
  // as every other action in this file).
  if (typeof workspaceId !== "string" || !workspaceId) {
    return { ok: false, error: "Missing workspace." };
  }
  if (typeof seatId !== "string" || !seatId) {
    return { ok: false, error: "Missing seat." };
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
    return { ok: false, error: "Only an owner or admin can manage seats." };
  }

  const database = deps.db ?? db;
  const fetchAccountId = deps.fetchAccountId ?? getBillingAccountIdForWorkspace;
  const fetchSeatAccountId = deps.fetchSeatAccountId ?? getSeatAccountId;
  const doRelease = deps.doRelease ?? releaseSeat;

  let accountId: string | null;
  try {
    accountId = await fetchAccountId(database, workspaceId);
  } catch (err) {
    console.error("[billing] failed to fetch the billing account:", err);
    return { ok: false, error: "Couldn't release the seat. Try again in a moment." };
  }
  if (!accountId) {
    return { ok: false, error: "This workspace doesn't have a billing account yet." };
  }

  let seatAccountId: string | null;
  try {
    seatAccountId = await fetchSeatAccountId(database, seatId);
  } catch (err) {
    console.error("[billing] failed to look up the seat:", err);
    return { ok: false, error: "Couldn't release the seat. Try again in a moment." };
  }
  if (seatAccountId === null) {
    return { ok: false, error: "This seat doesn't exist." };
  }
  if (seatAccountId !== accountId) {
    return { ok: false, error: "This seat doesn't belong to this workspace." };
  }

  try {
    await doRelease(database, seatId);
  } catch (err) {
    console.error("[billing] failed to release the seat:", err);
    return { ok: false, error: "Couldn't release the seat. Try again in a moment." };
  }

  revalidatePath(`/dashboard/${workspaceId}/billing`);

  return { ok: true };
}
