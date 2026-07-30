import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import {
  db,
  creditTopUpForStripeEvent,
  recordIgnoredStripeEvent,
  applySubscriptionStateForStripeEvent,
  recordPastDueForStripeEvent,
  bindStripeCustomer,
  getBillingAccountByStripeCustomerId,
} from "@agentrail/db-postgres";
import { getStripeClient, getStripeWebhookSecret } from "../../../../../../lib/stripe";
import {
  resolvePlanFromPriceId,
  type PaidPlan,
} from "../../../../../../lib/billing/stripe-plans";

/**
 * #1415 (Stripe top-up, Wave 5 / epic #1257; #1290's deferred PR ③) —
 * signature-verified Stripe webhook. The ONLY writer of a wallet `top_up`
 * row: the client success-redirect (`wallet/actions.ts`'s Checkout Session
 * `success_url`) NEVER credits anything — it can only read state. Mirrors
 * this repo's magic-link-over-chat rule (a GET the browser controls can be
 * replayed, back-buttoned, or link-unfurled, so it must never be a money
 * write path); the wallet is credited only when Stripe itself, over a
 * signature-verified server-to-server POST, reports a payment settled.
 *
 * SIGNATURE VERIFICATION uses the Stripe SDK's own
 * `stripe.webhooks.constructEvent(rawBody, signatureHeader, webhookSecret)`
 * — NOT the hand-rolled HMAC this repo's other webhook
 * (`connectors/github/webhook/route.ts`) uses, since there's no existing
 * Stripe-specific verification to match and Stripe's SDK does exactly this
 * job (timing-safe comparison, tolerance window, replay-timestamp check)
 * more correctly than reimplementing it. An invalid/missing signature is a
 * 401, matching the GitHub webhook's own convention for a bad signature.
 *
 * ONLY `checkout.session.completed` credits the wallet. Stripe fires BOTH
 * `checkout.session.completed` and `payment_intent.succeeded` for one
 * Checkout payment — accepting a credit from both would double-credit a
 * single purchase (each has its OWN, different, event id, so the per-event
 * idempotency guard cannot catch this: it guards against a REPLAY of the
 * same event, not against two different legitimate events describing the
 * same underlying payment). `checkout.session.completed` carries the full
 * Checkout Session — the workspace metadata this app set at creation time
 * AND the actual settled `amount_total` — so it is the single source of
 * truth; `payment_intent.succeeded` is recognized (recorded, for audit
 * parity with the Stripe dashboard's event log) but intentionally a no-op.
 *
 * IDEMPOTENT PER STRIPE EVENT ID: `creditTopUpForStripeEvent` inserts the
 * `stripe_events` row and the `wallet_transactions` top-up row in one
 * transaction, keyed on Stripe's own globally-unique `event.id` — a
 * redelivered webhook (Stripe retries on any non-2xx response) can never
 * credit the wallet a second time. See `queries/stripe_events.ts`.
 */

const SIGNATURE_HEADER = "stripe-signature";

function extractWorkspaceId(session: Stripe.Checkout.Session): string | null {
  const workspaceId = session.metadata?.["workspaceId"];
  return typeof workspaceId === "string" && workspaceId.length > 0 ? workspaceId : null;
}

/**
 * The amount actually charged, in integer cents. `amount_total` is Stripe's
 * own settled total for the session (already integer minor-units for USD) —
 * the source of truth, NOT the `amountUsdCents` metadata this app requested
 * at Checkout-session-creation time (metadata is an unverified label Stripe
 * merely echoes back; `amount_total` is what the customer's payment method
 * was actually charged).
 */
function extractAmountUsdCents(session: Stripe.Checkout.Session): number | null {
  const amount = session.amount_total;
  return typeof amount === "number" && Number.isInteger(amount) && amount > 0
    ? amount
    : null;
}

async function handleCheckoutSessionCompleted(
  event: Stripe.Event
): Promise<NextResponse> {
  const session = event.data.object as Stripe.Checkout.Session;

  if (session.payment_status !== "paid") {
    await recordIgnoredStripeEvent({ eventId: event.id, eventType: event.type });
    return NextResponse.json({ received: true, status: "ignored:not_paid" });
  }

  const workspaceId = extractWorkspaceId(session);
  const amountUsdCents = extractAmountUsdCents(session);
  if (!workspaceId || amountUsdCents === null) {
    console.error(
      "[billing/stripe/webhook] checkout.session.completed missing workspace metadata or amount",
      { eventId: event.id, workspaceId, amountUsdCents }
    );
    await recordIgnoredStripeEvent({ eventId: event.id, eventType: event.type });
    return NextResponse.json({ received: true, status: "ignored:missing_metadata" });
  }

  const result = await creditTopUpForStripeEvent({
    eventId: event.id,
    eventType: event.type,
    workspaceId,
    amountUsdCents,
    description: "Top-up",
  });

  return NextResponse.json({
    received: true,
    status: result.credited ? "credited" : "duplicate",
  });
}

/**
 * Subscription lifecycle (subscription-platform-design spec
 * `docs/superpowers/specs/2026-07-29-subscription-platform-design.md` §9;
 * slice-3 plan
 * `docs/superpowers/plans/2026-07-29-subscription-stripe-slice3.md`,
 * Task 4). This is the ONLY writer of `billing_accounts`' Stripe-mirrored
 * columns (`plan`, `subscription_status`, `stripe_subscription_id`,
 * `current_period_end`) — the checkout server action
 * (`billing/actions.ts`, Task 3) deliberately makes at most ONE possible
 * write (`bindStripeCustomer`, and only the first time an account ever
 * checks out); everything else about what a customer actually bought is
 * written here, only once Stripe itself confirms it over a signature-
 * verified event.
 *
 * ACCOUNT RESOLUTION IS METADATA-FIRST, ALWAYS (`resolveBillingAccountId`
 * below). The checkout action stamps `billingAccountId` on BOTH the
 * Checkout Session's `metadata` and, via `subscription_data.metadata`, the
 * Subscription it creates — at the moment each object is created. That
 * makes resolution race-immune against `bindStripeCustomer`'s own
 * documented race (two concurrent checkouts for the same account creating
 * two Stripe customers, only one of which wins the fill-only bind): the
 * metadata on the object THIS EVENT is actually about is always correct for
 * THIS event, regardless of which customer id ended up on
 * `billing_accounts.stripe_customer_id`. `getBillingAccountByStripeCustomerId`
 * is used ONLY as a fallback when metadata is absent (a genuine anomaly —
 * e.g. a subscription that predates this metadata, or one created outside
 * this app) and is loudly `console.warn`ed every time it's tried, so a
 * deployment actually hitting that path is visible in logs, not silently
 * "working" on a fragile, race-prone lookup.
 *
 * NEVER GUESS A PLAN. `resolvePlanFromPriceId` (`stripe-plans.ts`) returns
 * `null` for any price id this deployment hasn't configured — every handler
 * below treats that exactly like an unresolvable account: record the event
 * (so a redelivery is still a no-op, not a retry storm) in the
 * `stripe_events` dedup ledger, log loudly, and write nothing to
 * `billing_accounts`.
 *
 * `checkout.session.completed` (subscription mode) needs its purchased
 * price, but webhook payloads are NEVER auto-expanded — Stripe's own words,
 * from their fulfillment guide (docs.stripe.com/checkout/fulfillment):
 * "Objects sent in events are always in their minimal form... you must
 * retrieve the object in a separate call within your webhook handler." So
 * `session.subscription` here is only ever a bare id string, and this
 * handler retrieves the full Subscription (`stripe.subscriptions.retrieve`)
 * to read its price — the SAME extraction
 * (`extractSubscriptionPlanAndPeriod`) that `customer.subscription.updated`
 * runs directly against its own event payload (a Subscription IS what that
 * event's `data.object` already is, no retrieve needed there).
 * `current_period_end` lives on the subscription's ITEM, not the
 * subscription itself, as of this SDK's API version
 * (`node_modules/stripe` v18) — Stripe moved it there to support
 * multi-price subscriptions billed on different cycles; this app only ever
 * creates single-price subscriptions, so "first item" is always the only
 * item in practice.
 */

/**
 * The id of a Stripe reference field that may arrive as a bare id string or
 * (only if a caller expanded it) the full object — `session.customer`,
 * `subscription.customer`, `invoice.customer`, and `session.subscription`
 * all share this `string | { id: string } | null` shape. Webhook payloads
 * are never auto-expanded (see this section's own doc-comment), so in
 * practice this only ever sees the bare string; the object branch exists so
 * this stays correct if a caller ever passes an expanded value.
 */
function extractStripeId(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

/**
 * Metadata-first account resolution — every subscription-lifecycle handler
 * below resolves `billingAccountId` through this one function. See this
 * section's own top doc-comment for the full race-immunity rationale.
 * Returns `null` when NEITHER metadata NOR the stripe-customer-id fallback
 * resolves an account — callers treat that as "unresolvable" and
 * record-but-no-op.
 */
async function resolveBillingAccountId(args: {
  metadataBillingAccountId: string | null | undefined;
  stripeCustomerId: string | null;
  eventId: string;
  eventType: string;
}): Promise<string | null> {
  const fromMetadata =
    typeof args.metadataBillingAccountId === "string" &&
    args.metadataBillingAccountId.length > 0
      ? args.metadataBillingAccountId
      : null;
  if (fromMetadata) return fromMetadata;

  if (!args.stripeCustomerId) return null;

  console.warn(
    "[billing/stripe/webhook] metadata.billingAccountId absent — falling back to stripe_customer_id lookup",
    { eventId: args.eventId, eventType: args.eventType, stripeCustomerId: args.stripeCustomerId }
  );
  const account = await getBillingAccountByStripeCustomerId(db, args.stripeCustomerId);
  return account?.id ?? null;
}

/**
 * The plan (via `resolvePlanFromPriceId`) and current-period-end derived
 * from a Stripe `Subscription`'s FIRST item. See this section's own
 * doc-comment for why `current_period_end` is read off the item, not the
 * subscription.
 */
function extractSubscriptionPlanAndPeriod(subscription: Stripe.Subscription): {
  priceId: string | null;
  plan: PaidPlan | null;
  currentPeriodEnd: Date | null;
} {
  const firstItem = subscription.items.data[0];
  const priceId = firstItem?.price.id ?? null;
  return {
    priceId,
    plan: priceId ? resolvePlanFromPriceId(priceId) : null,
    currentPeriodEnd: firstItem ? new Date(firstItem.current_period_end * 1000) : null,
  };
}

async function handleCheckoutSessionCompletedSubscription(
  event: Stripe.Event,
  stripe: Stripe
): Promise<NextResponse> {
  const session = event.data.object as Stripe.Checkout.Session;

  const metadataBillingAccountId =
    typeof session.metadata?.["billingAccountId"] === "string"
      ? session.metadata["billingAccountId"]
      : null;
  const stripeCustomerId = extractStripeId(session.customer);
  const stripeSubscriptionId = extractStripeId(session.subscription);

  const billingAccountId = await resolveBillingAccountId({
    metadataBillingAccountId,
    stripeCustomerId,
    eventId: event.id,
    eventType: event.type,
  });

  if (!billingAccountId || !stripeSubscriptionId) {
    console.error(
      "[billing/stripe/webhook] checkout.session.completed (subscription) missing billing account or subscription id",
      { eventId: event.id, billingAccountId, stripeSubscriptionId }
    );
    await recordIgnoredStripeEvent({ eventId: event.id, eventType: event.type });
    return NextResponse.json({ received: true, status: "ignored:missing_metadata" });
  }

  // Webhook payloads are never auto-expanded (see this section's top
  // doc-comment) — `session.subscription` above is only ever the bare id,
  // so the price this checkout actually purchased must be fetched in a
  // separate call, exactly as Stripe's own fulfillment guide recommends.
  const subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);
  const { plan, priceId, currentPeriodEnd } = extractSubscriptionPlanAndPeriod(subscription);

  if (!plan) {
    console.error(
      "[billing/stripe/webhook] checkout.session.completed (subscription) unmapped price id — refusing to guess a plan",
      { eventId: event.id, billingAccountId, priceId }
    );
    await recordIgnoredStripeEvent({ eventId: event.id, eventType: event.type });
    return NextResponse.json({ received: true, status: "ignored:unmapped_price" });
  }

  if (stripeCustomerId) {
    await bindStripeCustomer(db, billingAccountId, stripeCustomerId);
  }

  const result = await applySubscriptionStateForStripeEvent({
    eventId: event.id,
    eventType: event.type,
    billingAccountId,
    plan,
    subscriptionStatus: "active",
    stripeSubscriptionId,
    currentPeriodEnd,
  });

  return NextResponse.json({
    received: true,
    status: result.applied ? "subscribed" : "duplicate",
  });
}

async function handleSubscriptionUpdated(event: Stripe.Event): Promise<NextResponse> {
  const subscription = event.data.object as Stripe.Subscription;

  const metadataBillingAccountId =
    typeof subscription.metadata?.["billingAccountId"] === "string"
      ? subscription.metadata["billingAccountId"]
      : null;
  const stripeCustomerId = extractStripeId(subscription.customer);

  const billingAccountId = await resolveBillingAccountId({
    metadataBillingAccountId,
    stripeCustomerId,
    eventId: event.id,
    eventType: event.type,
  });

  if (!billingAccountId) {
    console.error(
      "[billing/stripe/webhook] customer.subscription.updated unresolvable billing account",
      { eventId: event.id, subscriptionId: subscription.id }
    );
    await recordIgnoredStripeEvent({ eventId: event.id, eventType: event.type });
    return NextResponse.json({ received: true, status: "ignored:missing_metadata" });
  }

  const { plan, priceId, currentPeriodEnd } = extractSubscriptionPlanAndPeriod(subscription);

  if (!plan) {
    console.error(
      "[billing/stripe/webhook] customer.subscription.updated unmapped price id — refusing to guess a plan",
      { eventId: event.id, billingAccountId, priceId }
    );
    await recordIgnoredStripeEvent({ eventId: event.id, eventType: event.type });
    return NextResponse.json({ received: true, status: "ignored:unmapped_price" });
  }

  const result = await applySubscriptionStateForStripeEvent({
    eventId: event.id,
    eventType: event.type,
    billingAccountId,
    plan,
    subscriptionStatus: subscription.status,
    stripeSubscriptionId: subscription.id,
    currentPeriodEnd,
  });

  return NextResponse.json({
    received: true,
    status: result.applied ? "updated" : "duplicate",
  });
}

async function handleSubscriptionDeleted(event: Stripe.Event): Promise<NextResponse> {
  const subscription = event.data.object as Stripe.Subscription;

  const metadataBillingAccountId =
    typeof subscription.metadata?.["billingAccountId"] === "string"
      ? subscription.metadata["billingAccountId"]
      : null;
  const stripeCustomerId = extractStripeId(subscription.customer);

  const billingAccountId = await resolveBillingAccountId({
    metadataBillingAccountId,
    stripeCustomerId,
    eventId: event.id,
    eventType: event.type,
  });

  if (!billingAccountId) {
    console.error(
      "[billing/stripe/webhook] customer.subscription.deleted unresolvable billing account",
      { eventId: event.id, subscriptionId: subscription.id }
    );
    await recordIgnoredStripeEvent({ eventId: event.id, eventType: event.type });
    return NextResponse.json({ received: true, status: "ignored:missing_metadata" });
  }

  // No price to resolve for a deletion — the brief's own rule: plan reverts
  // to "trial" outright. The resolver then serves trial policy from here;
  // enforcement of trial expiry (an account that never resubscribes
  // eventually losing access) is a later slice's job, not this webhook's.
  const result = await applySubscriptionStateForStripeEvent({
    eventId: event.id,
    eventType: event.type,
    billingAccountId,
    plan: "trial",
    subscriptionStatus: "canceled",
    stripeSubscriptionId: null,
    currentPeriodEnd: null,
  });

  return NextResponse.json({
    received: true,
    status: result.applied ? "canceled" : "duplicate",
  });
}

async function handleInvoicePaymentFailed(event: Stripe.Event): Promise<NextResponse> {
  const invoice = event.data.object as Stripe.Invoice;

  // Invoice.parent.subscription_details.metadata is Stripe's own immutable
  // snapshot of the subscription's metadata "at the time of invoice
  // finalization" — the same billingAccountId the checkout action stamped
  // via subscription_data.metadata, just reached through the invoice's own
  // parent link rather than a live subscription object.
  const subscriptionMetadata = invoice.parent?.subscription_details?.metadata;
  const metadataBillingAccountId =
    typeof subscriptionMetadata?.["billingAccountId"] === "string"
      ? subscriptionMetadata["billingAccountId"]
      : null;
  const stripeCustomerId = extractStripeId(invoice.customer);

  const billingAccountId = await resolveBillingAccountId({
    metadataBillingAccountId,
    stripeCustomerId,
    eventId: event.id,
    eventType: event.type,
  });

  if (!billingAccountId) {
    // Deliberately console.warn, not console.error: unlike the other
    // handlers' unresolvable-account case, missing this status mirror isn't
    // itself a loss of billing state (Stripe's own dunning/retry emails run
    // independent of this column) — logged less loudly than a subscription
    // create/update/delete this webhook genuinely couldn't apply.
    console.warn(
      "[billing/stripe/webhook] invoice.payment_failed unresolvable billing account — no-op",
      { eventId: event.id, invoiceId: invoice.id }
    );
    await recordIgnoredStripeEvent({ eventId: event.id, eventType: event.type });
    return NextResponse.json({ received: true, status: "ignored:missing_metadata" });
  }

  const result = await recordPastDueForStripeEvent({
    eventId: event.id,
    eventType: event.type,
    billingAccountId,
  });

  return NextResponse.json({
    received: true,
    status: result.applied ? "past_due" : "duplicate",
  });
}

export async function POST(request: NextRequest) {
  const stripe = getStripeClient();
  const webhookSecret = getStripeWebhookSecret();
  if (!stripe || !webhookSecret) {
    console.error("[billing/stripe/webhook] STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET not configured");
    return NextResponse.json({ error: "billing not configured" }, { status: 503 });
  }

  // Raw body, exactly as Stripe sent it — constructEvent's signature check
  // fails on a re-serialized/parsed body (matches this SDK's documented
  // contract, and the GitHub webhook route's own `request.text()` posture).
  const raw = await request.text();
  const signature = request.headers.get(SIGNATURE_HEADER);
  if (!signature) {
    return NextResponse.json({ error: "missing signature" }, { status: 401 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(raw, signature, webhookSecret);
  } catch (err) {
    console.error("[billing/stripe/webhook] signature verification failed:", err);
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  if (event.type === "checkout.session.completed") {
    // `mode === "payment"` is the EXISTING wallet top-up path, byte-
    // identical — handleCheckoutSessionCompleted's own body is untouched by
    // this task. `mode === "subscription"` is the new subscription-
    // lifecycle path (see that section's own top doc-comment above).
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.mode === "subscription") {
      return handleCheckoutSessionCompletedSubscription(event, stripe);
    }
    return handleCheckoutSessionCompleted(event);
  }

  if (event.type === "customer.subscription.updated") {
    return handleSubscriptionUpdated(event);
  }

  if (event.type === "customer.subscription.deleted") {
    return handleSubscriptionDeleted(event);
  }

  if (event.type === "invoice.payment_failed") {
    return handleInvoicePaymentFailed(event);
  }

  // Recognized-but-ignored: see this route's own doc-comment for why
  // `payment_intent.succeeded` (and every other subscribed/unsubscribed
  // event type) must never ALSO credit the wallet.
  await recordIgnoredStripeEvent({ eventId: event.id, eventType: event.type });
  return NextResponse.json({ received: true, status: `ignored:${event.type}` });
}
