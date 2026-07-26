import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import {
  creditTopUpForStripeEvent,
  recordIgnoredStripeEvent,
} from "@agentrail/db-postgres";
import { getStripeClient, getStripeWebhookSecret } from "../../../../../../lib/stripe";

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
    return handleCheckoutSessionCompleted(event);
  }

  // Recognized-but-ignored: see this route's own doc-comment for why
  // `payment_intent.succeeded` (and every other subscribed/unsubscribed
  // event type) must never ALSO credit the wallet.
  await recordIgnoredStripeEvent({ eventId: event.id, eventType: event.type });
  return NextResponse.json({ received: true, status: `ignored:${event.type}` });
}
