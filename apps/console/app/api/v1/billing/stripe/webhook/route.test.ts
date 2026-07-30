import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import Stripe from "stripe";

/**
 * #1415 AC1 verification. No live Stripe test-mode keys are available in
 * this environment, so this proves the webhook's SIGNATURE VERIFICATION and
 * REQUEST-HANDLING logic against REAL signed payloads: `Stripe.webhooks
 * .generateTestHeaderString` / `.constructEvent` are pure local crypto (no
 * network call, no live API key needed — see the stripe-node README's own
 * "Testing webhook signing" section) run against a TEST signing secret this
 * file controls end to end.
 *
 * `@agentrail/db-postgres`'s `creditTopUpForStripeEvent` is mocked here
 * (this app has no live-DB harness — same posture as every other route test
 * in this codebase, e.g. `connectors/github/webhook/route.test.ts`), but the
 * mock is STATEFUL: it tracks which event ids have already been "credited"
 * and returns `credited: false` on a repeat, mirroring exactly what the real
 * transactional `ON CONFLICT (event_id) DO NOTHING` does (proven for real,
 * against the actual query code, in
 * `packages/db-postgres/src/queries/stripe_events.test.ts`). That split is
 * deliberate: THIS file proves the HTTP layer calls the credit function with
 * the right, Stripe-verified args and reacts correctly to its result; that
 * file proves the credit function's own DB-level idempotency.
 *
 * Subscription-lifecycle coverage (slice-3 plan Task 4) below follows the
 * exact same split: `applySubscriptionStateForStripeEvent` /
 * `recordPastDueForStripeEvent` are mocked here (statefully, same
 * replay-tracking idiom), proven for real against the actual transactional
 * query code in `stripe_events.test.ts`. `checkout.session.completed`
 * (subscription mode) ALSO needs `stripe.subscriptions.retrieve` (webhook
 * payloads are never auto-expanded — see the route's own doc-comment) —
 * `lib/stripe.ts`'s `getStripeClient` is mocked to hand back a REAL `Stripe`
 * instance (so `webhooks.constructEvent`'s signature verification stays
 * genuine local crypto, same as `signer` below) with ONLY
 * `.subscriptions.retrieve` swapped for a plain `vi.fn()` — no network, no
 * live keys, fully deterministic.
 */

const STRIPE_WEBHOOK_SECRET = "whsec_test_secret_for_route_test";

const mockState = vi.hoisted(() => ({
  creditedEventIds: new Set<string>(),
  creditCalls: [] as Array<{
    eventId: string;
    eventType: string;
    workspaceId: string;
    amountUsdCents: number;
  }>,
  ignoredCalls: [] as Array<{ eventId: string; eventType: string }>,
  appliedSubscriptionEventIds: new Set<string>(),
  applySubscriptionCalls: [] as Array<Record<string, unknown>>,
  appliedPastDueEventIds: new Set<string>(),
  pastDueCalls: [] as Array<Record<string, unknown>>,
  bindCustomerCalls: [] as Array<{ billingAccountId: string; stripeCustomerId: string }>,
  // stripeCustomerId -> billingAccountId, for the getBillingAccountByStripeCustomerId fallback mock.
  customerIdToAccountId: new Map<string, string>(),
}));

vi.mock("@agentrail/db-postgres", () => ({
  db: {},
  creditTopUpForStripeEvent: vi.fn(
    async (input: {
      eventId: string;
      eventType: string;
      workspaceId: string;
      amountUsdCents: number;
    }) => {
      mockState.creditCalls.push(input);
      if (mockState.creditedEventIds.has(input.eventId)) {
        return { credited: false };
      }
      mockState.creditedEventIds.add(input.eventId);
      return {
        credited: true,
        transaction: {
          id: "wt-1",
          workspaceId: input.workspaceId,
          kind: "top_up",
          amountUsdCents: input.amountUsdCents,
        },
      };
    }
  ),
  recordIgnoredStripeEvent: vi.fn(async (input: { eventId: string; eventType: string }) => {
    mockState.ignoredCalls.push(input);
    return { recorded: true };
  }),
  bindStripeCustomer: vi.fn(
    async (_db: unknown, billingAccountId: string, stripeCustomerId: string) => {
      mockState.bindCustomerCalls.push({ billingAccountId, stripeCustomerId });
    }
  ),
  getBillingAccountByStripeCustomerId: vi.fn(async (_db: unknown, stripeCustomerId: string) => {
    const accountId = mockState.customerIdToAccountId.get(stripeCustomerId);
    return accountId ? { id: accountId } : null;
  }),
  applySubscriptionStateForStripeEvent: vi.fn(async (input: Record<string, unknown>) => {
    mockState.applySubscriptionCalls.push(input);
    const eventId = input["eventId"] as string;
    if (mockState.appliedSubscriptionEventIds.has(eventId)) {
      return { applied: false };
    }
    mockState.appliedSubscriptionEventIds.add(eventId);
    return { applied: true };
  }),
  recordPastDueForStripeEvent: vi.fn(async (input: Record<string, unknown>) => {
    mockState.pastDueCalls.push(input);
    const eventId = input["eventId"] as string;
    if (mockState.appliedPastDueEventIds.has(eventId)) {
      return { applied: false };
    }
    mockState.appliedPastDueEventIds.add(eventId);
    return { applied: true };
  }),
}));

const { mockSubscriptionsRetrieve } = vi.hoisted(() => ({
  mockSubscriptionsRetrieve: vi.fn(),
}));

vi.mock("../../../../../../lib/stripe", () => {
  // A REAL Stripe instance (so `webhooks.constructEvent`'s signature
  // verification stays genuine local crypto — same posture as `signer`
  // below) with ONLY `.subscriptions.retrieve` swapped for a controllable
  // `vi.fn()`. See this file's own top doc-comment. `Stripe` here is the
  // SAME top-of-file `import Stripe from "stripe"` used by `signer` — this
  // factory only runs lazily (when `./route`'s own import of this module is
  // resolved, which happens after that import has already evaluated), not
  // at `vi.mock` registration time, so referencing it here is safe.
  const client = new Stripe("sk_test_dummy_key_for_route_subscriptions");
  client.subscriptions.retrieve = mockSubscriptionsRetrieve;
  return {
    getStripeClient: () => (process.env["STRIPE_SECRET_KEY"] ? client : null),
    getStripeWebhookSecret: () => process.env["STRIPE_WEBHOOK_SECRET"],
    isStripeConfigured: () => !!process.env["STRIPE_SECRET_KEY"],
  };
});

import { POST } from "./route";
import {
  creditTopUpForStripeEvent,
  recordIgnoredStripeEvent,
  bindStripeCustomer,
  getBillingAccountByStripeCustomerId,
  applySubscriptionStateForStripeEvent,
  recordPastDueForStripeEvent,
} from "@agentrail/db-postgres";

const mockCredit = vi.mocked(creditTopUpForStripeEvent);
const mockIgnored = vi.mocked(recordIgnoredStripeEvent);
const mockBindCustomer = vi.mocked(bindStripeCustomer);
const mockGetAccountByCustomerId = vi.mocked(getBillingAccountByStripeCustomerId);
const mockApplySubscriptionState = vi.mocked(applySubscriptionStateForStripeEvent);
const mockRecordPastDue = vi.mocked(recordPastDueForStripeEvent);

const ORIGINAL_SECRET_KEY = process.env["STRIPE_SECRET_KEY"];
const ORIGINAL_WEBHOOK_SECRET = process.env["STRIPE_WEBHOOK_SECRET"];
const ORIGINAL_PRICE_STARTER = process.env["STRIPE_PRICE_STARTER"];
const ORIGINAL_PRICE_GROWTH = process.env["STRIPE_PRICE_GROWTH"];

// resolvePlanFromPriceId (stripe-plans.ts) reads real process.env — these
// two known-mapped price ids are what every "happy path" subscription
// fixture below uses; PRICE_UNMAPPED deliberately matches neither.
const PRICE_STARTER = "price_test_starter";
const PRICE_GROWTH = "price_test_growth";
const PRICE_UNMAPPED = "price_test_unmapped";

// A real Stripe client instantiated with a dummy key — only used here to
// SIGN test payloads (`webhooks.generateTestHeaderString`), a pure local
// operation that never calls the Stripe API.
const signer = new Stripe("sk_test_dummy_key_for_signing_only");

function signedRequest(payload: unknown, secret = STRIPE_WEBHOOK_SECRET): NextRequest {
  const payloadString = JSON.stringify(payload);
  const header = signer.webhooks.generateTestHeaderString({
    payload: payloadString,
    secret,
  });
  return new NextRequest("http://localhost/api/v1/billing/stripe/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": header },
    body: payloadString,
  });
}

function checkoutCompletedEvent(overrides: {
  eventId: string;
  workspaceId?: string;
  amountUsdCents?: number;
  paymentStatus?: string;
}) {
  return {
    id: overrides.eventId,
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_1",
        object: "checkout.session",
        payment_status: overrides.paymentStatus ?? "paid",
        amount_total: overrides.amountUsdCents ?? 2500,
        metadata:
          overrides.workspaceId === null
            ? {}
            : { workspaceId: overrides.workspaceId ?? "ws-1", amountUsdCents: "2500" },
      },
    },
  };
}

/**
 * Subscription-lifecycle fixtures below (checkout.session.completed
 * subscription-mode, customer.subscription.updated/deleted,
 * invoice.payment_failed) mirror the field NAMES and NESTING of
 * `node_modules/stripe` v18's actual `.d.ts` shapes for
 * `Stripe.Checkout.Session`, `Stripe.Subscription`, `Stripe.SubscriptionItem`,
 * and `Stripe.Invoice` — notably `current_period_end` living on the
 * subscription ITEM (not the subscription itself, per that SDK version) and
 * `Invoice.parent.subscription_details.metadata` (not a flat top-level
 * `subscription` field) — verified against those types directly while
 * writing this route, not recalled from memory. Each fixture only includes
 * the fields the route actually reads (same minimal-fixture philosophy as
 * `checkoutCompletedEvent` above), just with those particular fields shaped
 * exactly as Stripe really sends them.
 */

function subscriptionObject(overrides: {
  id?: string;
  customer?: string | null;
  metadata?: Record<string, string>;
  status?: string;
  priceId?: string | null; // null => zero subscription items
  currentPeriodEndSeconds?: number;
}) {
  const priceId = overrides.priceId === undefined ? PRICE_GROWTH : overrides.priceId;
  const subscriptionId = overrides.id ?? "sub_test_1";
  return {
    id: subscriptionId,
    object: "subscription",
    customer: overrides.customer === undefined ? "cus_test_1" : overrides.customer,
    metadata: overrides.metadata ?? {},
    status: overrides.status ?? "active",
    items: {
      object: "list",
      data:
        priceId === null
          ? []
          : [
              {
                id: "si_test_1",
                object: "subscription_item",
                price: { id: priceId, object: "price" },
                current_period_end: overrides.currentPeriodEndSeconds ?? 1798761600,
                current_period_start: 1796083200,
                subscription: subscriptionId,
              },
            ],
      has_more: false,
      url: `/v1/subscription_items?subscription=${subscriptionId}`,
    },
  };
}

function subscriptionUpdatedEvent(overrides: {
  eventId: string;
  id?: string;
  customer?: string | null;
  metadata?: Record<string, string>;
  status?: string;
  priceId?: string | null;
  currentPeriodEndSeconds?: number;
}) {
  return {
    id: overrides.eventId,
    object: "event",
    type: "customer.subscription.updated",
    data: { object: subscriptionObject(overrides) },
  };
}

function subscriptionDeletedEvent(overrides: {
  eventId: string;
  id?: string;
  customer?: string | null;
  metadata?: Record<string, string>;
}) {
  // A real `customer.subscription.deleted` payload still carries its items
  // (Stripe doesn't empty them on cancellation, just flips `status`) — kept
  // realistic here even though `handleSubscriptionDeleted` never reads
  // `items` at all (plan reverts to "trial" unconditionally, no price
  // lookup for a deletion).
  return {
    id: overrides.eventId,
    object: "event",
    type: "customer.subscription.deleted",
    data: {
      object: subscriptionObject({ ...overrides, status: "canceled" }),
    },
  };
}

function checkoutSubscriptionCompletedEvent(overrides: {
  eventId: string;
  billingAccountId?: string | null;
  customer?: string | null;
  subscriptionId?: string | null;
}) {
  return {
    id: overrides.eventId,
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_sub_1",
        object: "checkout.session",
        mode: "subscription",
        payment_status: "paid",
        customer: overrides.customer === undefined ? "cus_test_1" : overrides.customer,
        subscription:
          overrides.subscriptionId === undefined ? "sub_test_1" : overrides.subscriptionId,
        metadata:
          overrides.billingAccountId === null
            ? {}
            : { billingAccountId: overrides.billingAccountId ?? "acct-1", plan: "growth" },
      },
    },
  };
}

function invoicePaymentFailedEvent(overrides: {
  eventId: string;
  customer?: string | null;
  metadata?: Record<string, string> | null; // null => no parent.subscription_details at all
}) {
  return {
    id: overrides.eventId,
    object: "event",
    type: "invoice.payment_failed",
    data: {
      object: {
        id: "in_test_1",
        object: "invoice",
        customer: overrides.customer === undefined ? "cus_test_1" : overrides.customer,
        parent:
          overrides.metadata === null
            ? null
            : {
                type: "subscription_details",
                quote_details: null,
                subscription_details: {
                  subscription: "sub_test_1",
                  metadata: overrides.metadata ?? { billingAccountId: "acct-1" },
                },
              },
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockState.creditedEventIds.clear();
  mockState.creditCalls = [];
  mockState.ignoredCalls = [];
  mockState.appliedSubscriptionEventIds.clear();
  mockState.applySubscriptionCalls = [];
  mockState.appliedPastDueEventIds.clear();
  mockState.pastDueCalls = [];
  mockState.bindCustomerCalls = [];
  mockState.customerIdToAccountId.clear();
  mockSubscriptionsRetrieve.mockReset();
  process.env["STRIPE_SECRET_KEY"] = "sk_test_dummy_key_for_route";
  process.env["STRIPE_WEBHOOK_SECRET"] = STRIPE_WEBHOOK_SECRET;
  process.env["STRIPE_PRICE_STARTER"] = PRICE_STARTER;
  process.env["STRIPE_PRICE_GROWTH"] = PRICE_GROWTH;
});

afterEach(() => {
  if (ORIGINAL_SECRET_KEY === undefined) delete process.env["STRIPE_SECRET_KEY"];
  else process.env["STRIPE_SECRET_KEY"] = ORIGINAL_SECRET_KEY;
  if (ORIGINAL_WEBHOOK_SECRET === undefined) delete process.env["STRIPE_WEBHOOK_SECRET"];
  else process.env["STRIPE_WEBHOOK_SECRET"] = ORIGINAL_WEBHOOK_SECRET;
  if (ORIGINAL_PRICE_STARTER === undefined) delete process.env["STRIPE_PRICE_STARTER"];
  else process.env["STRIPE_PRICE_STARTER"] = ORIGINAL_PRICE_STARTER;
  if (ORIGINAL_PRICE_GROWTH === undefined) delete process.env["STRIPE_PRICE_GROWTH"];
  else process.env["STRIPE_PRICE_GROWTH"] = ORIGINAL_PRICE_GROWTH;
});

describe("POST /api/v1/billing/stripe/webhook", () => {
  it("(a) a validly signed checkout.session.completed credits the wallet exactly once", async () => {
    const event = checkoutCompletedEvent({ eventId: "evt_1", workspaceId: "ws-1", amountUsdCents: 2500 });
    const res = await POST(signedRequest(event));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ received: true, status: "credited" });
    expect(mockCredit).toHaveBeenCalledTimes(1);
    expect(mockCredit).toHaveBeenCalledWith({
      eventId: "evt_1",
      eventType: "checkout.session.completed",
      workspaceId: "ws-1",
      amountUsdCents: 2500,
      description: "Top-up",
    });
  });

  it("(b) a REPLAYED event id (Stripe redelivering the same webhook) credits ZERO additional cents", async () => {
    const event = checkoutCompletedEvent({ eventId: "evt_replay_1", workspaceId: "ws-1", amountUsdCents: 2500 });

    const first = await POST(signedRequest(event));
    const firstBody = await first.json();
    expect(firstBody.status).toBe("credited");

    // Same event id, same payload — a genuine Stripe redelivery.
    const second = await POST(signedRequest(event));
    const secondBody = await second.json();

    expect(second.status).toBe(200);
    expect(secondBody).toEqual({ received: true, status: "duplicate" });
    // The credit function WAS called again (that's how idempotency is
    // enforced — at the DB layer, not by skipping the call) but only ONE of
    // the two calls actually resulted in a credit; assert the amount
    // credited across both deliveries sums to exactly one top-up's worth.
    expect(mockCredit).toHaveBeenCalledTimes(2);
    expect(mockState.creditedEventIds.size).toBe(1);
  });

  it("(c) an invalid signature is rejected with 401 and never reaches the credit function", async () => {
    const event = checkoutCompletedEvent({ eventId: "evt_bad_sig", workspaceId: "ws-1" });
    const payloadString = JSON.stringify(event);
    const req = new NextRequest("http://localhost/api/v1/billing/stripe/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Well-formed-looking but wrong signature (correct shape, wrong secret).
        "stripe-signature": signer.webhooks.generateTestHeaderString({
          payload: payloadString,
          secret: "whsec_the_wrong_secret",
        }),
      },
      body: payloadString,
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(mockCredit).not.toHaveBeenCalled();
  });

  it("a missing stripe-signature header is rejected with 401", async () => {
    const event = checkoutCompletedEvent({ eventId: "evt_no_sig", workspaceId: "ws-1" });
    const req = new NextRequest("http://localhost/api/v1/billing/stripe/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(mockCredit).not.toHaveBeenCalled();
  });

  it("payment_intent.succeeded is recognized but never credits the wallet (avoids double-crediting one Checkout payment)", async () => {
    const event = {
      id: "evt_pi_1",
      object: "event",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_test_1", object: "payment_intent" } },
    };
    const res = await POST(signedRequest(event));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ received: true, status: "ignored:payment_intent.succeeded" });
    expect(mockCredit).not.toHaveBeenCalled();
    expect(mockIgnored).toHaveBeenCalledWith({
      eventId: "evt_pi_1",
      eventType: "payment_intent.succeeded",
    });
  });

  it("a checkout.session.completed missing workspace metadata is ignored, not credited", async () => {
    const event = checkoutCompletedEvent({ eventId: "evt_no_meta", workspaceId: null as unknown as string });
    const res = await POST(signedRequest(event));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ received: true, status: "ignored:missing_metadata" });
    expect(mockCredit).not.toHaveBeenCalled();
  });

  it("a session not yet paid is ignored, not credited", async () => {
    const event = checkoutCompletedEvent({ eventId: "evt_unpaid", workspaceId: "ws-1", paymentStatus: "unpaid" });
    const res = await POST(signedRequest(event));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ received: true, status: "ignored:not_paid" });
    expect(mockCredit).not.toHaveBeenCalled();
  });

  it("mode=payment events never touch the subscription-lifecycle path (bind/retrieve/apply)", async () => {
    const event = checkoutCompletedEvent({ eventId: "evt_payment_mode_untouched", workspaceId: "ws-1" });
    const res = await POST(signedRequest(event));
    const body = await res.json();

    expect(body).toEqual({ received: true, status: "credited" });
    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled();
    expect(mockBindCustomer).not.toHaveBeenCalled();
    expect(mockApplySubscriptionState).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/billing/stripe/webhook — checkout.session.completed (subscription mode)", () => {
  it("(a) happy path: resolves plan from the retrieved subscription's price, binds the customer, and activates the account", async () => {
    mockSubscriptionsRetrieve.mockResolvedValueOnce(
      subscriptionObject({ id: "sub_test_1", priceId: PRICE_GROWTH, currentPeriodEndSeconds: 1798761600 })
    );
    const event = checkoutSubscriptionCompletedEvent({
      eventId: "evt_checkout_sub_1",
      billingAccountId: "acct-1",
      customer: "cus_test_1",
      subscriptionId: "sub_test_1",
    });

    const res = await POST(signedRequest(event));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ received: true, status: "subscribed" });
    expect(mockSubscriptionsRetrieve).toHaveBeenCalledWith("sub_test_1");
    expect(mockBindCustomer).toHaveBeenCalledWith(expect.anything(), "acct-1", "cus_test_1");
    expect(mockApplySubscriptionState).toHaveBeenCalledWith({
      eventId: "evt_checkout_sub_1",
      eventType: "checkout.session.completed",
      billingAccountId: "acct-1",
      plan: "growth",
      subscriptionStatus: "active",
      stripeSubscriptionId: "sub_test_1",
      currentPeriodEnd: new Date(1798761600 * 1000),
    });
  });

  it("(b) a REPLAYED event id (Stripe redelivering the same webhook) is a no-op the second time", async () => {
    mockSubscriptionsRetrieve.mockResolvedValue(subscriptionObject({ id: "sub_test_1" }));
    const event = checkoutSubscriptionCompletedEvent({ eventId: "evt_checkout_sub_replay" });

    const first = await POST(signedRequest(event));
    expect((await first.json()).status).toBe("subscribed");

    const second = await POST(signedRequest(event));
    const secondBody = await second.json();

    expect(second.status).toBe(200);
    expect(secondBody).toEqual({ received: true, status: "duplicate" });
    // Called both times (dedup is enforced at the DB layer, proven in
    // stripe_events.test.ts) — this just proves the route reacts correctly
    // to the mock's own replay-tracking result.
    expect(mockApplySubscriptionState).toHaveBeenCalledTimes(2);
  });

  it("(c) metadata.billingAccountId absent but the customer id resolves via fallback — applies, and warns", async () => {
    mockState.customerIdToAccountId.set("cus_fallback_1", "acct-fallback");
    mockSubscriptionsRetrieve.mockResolvedValueOnce(subscriptionObject({ id: "sub_test_1" }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const event = checkoutSubscriptionCompletedEvent({
      eventId: "evt_checkout_sub_fallback",
      billingAccountId: null,
      customer: "cus_fallback_1",
    });
    const res = await POST(signedRequest(event));
    const body = await res.json();

    expect(body).toEqual({ received: true, status: "subscribed" });
    expect(mockGetAccountByCustomerId).toHaveBeenCalledWith(expect.anything(), "cus_fallback_1");
    expect(mockApplySubscriptionState).toHaveBeenCalledWith(
      expect.objectContaining({ billingAccountId: "acct-fallback" })
    );
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("(d) metadata absent AND the customer-id fallback also fails — ignored, never applied, logs loudly", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const event = checkoutSubscriptionCompletedEvent({
      eventId: "evt_checkout_sub_unresolvable",
      billingAccountId: null,
      customer: "cus_unknown_to_us",
    });

    const res = await POST(signedRequest(event));
    const body = await res.json();

    expect(body).toEqual({ received: true, status: "ignored:missing_metadata" });
    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled();
    expect(mockApplySubscriptionState).not.toHaveBeenCalled();
    expect(mockIgnored).toHaveBeenCalledWith({
      eventId: "evt_checkout_sub_unresolvable",
      eventType: "checkout.session.completed",
    });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("(e) an unmapped price id records the event, logs loudly, and writes nothing (never guesses a plan)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSubscriptionsRetrieve.mockResolvedValueOnce(
      subscriptionObject({ id: "sub_test_1", priceId: PRICE_UNMAPPED })
    );
    const event = checkoutSubscriptionCompletedEvent({ eventId: "evt_checkout_sub_unmapped" });

    const res = await POST(signedRequest(event));
    const body = await res.json();

    expect(body).toEqual({ received: true, status: "ignored:unmapped_price" });
    expect(mockApplySubscriptionState).not.toHaveBeenCalled();
    expect(mockBindCustomer).not.toHaveBeenCalled();
    expect(mockIgnored).toHaveBeenCalledWith({
      eventId: "evt_checkout_sub_unmapped",
      eventType: "checkout.session.completed",
    });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("(f) stripe.subscriptions.retrieve rejecting propagates — the event is left UNRECORDED so a Stripe redelivery retries cleanly", async () => {
    const retrieveError = new Error("stripe API request failed");
    mockSubscriptionsRetrieve.mockRejectedValueOnce(retrieveError);
    const event = checkoutSubscriptionCompletedEvent({
      eventId: "evt_checkout_sub_retrieve_rejects",
    });

    // No try/catch around the retrieve call in the handler — a transient
    // Stripe API failure must surface as an uncaught rejection (Next.js
    // turns this into a non-2xx response in production, so Stripe retries
    // the SAME event), never as a swallowed "ignored" outcome. Critically,
    // this must NOT record the event: recordIgnoredStripeEvent would
    // permanently trip the stripe_events dedup guard for an event that was
    // never actually processed, making a legitimate retry a silent no-op
    // forever.
    await expect(POST(signedRequest(event))).rejects.toThrow("stripe API request failed");

    expect(mockIgnored).not.toHaveBeenCalled();
    expect(mockApplySubscriptionState).not.toHaveBeenCalled();
    expect(mockBindCustomer).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/billing/stripe/webhook — customer.subscription.updated", () => {
  it("(a) happy path: derives plan from the first item's price and mirrors status + period end", async () => {
    const event = subscriptionUpdatedEvent({
      eventId: "evt_sub_updated_1",
      id: "sub_test_1",
      metadata: { billingAccountId: "acct-1" },
      status: "past_due",
      priceId: PRICE_STARTER,
      currentPeriodEndSeconds: 1798761600,
    });

    const res = await POST(signedRequest(event));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ received: true, status: "updated" });
    expect(mockApplySubscriptionState).toHaveBeenCalledWith({
      eventId: "evt_sub_updated_1",
      eventType: "customer.subscription.updated",
      billingAccountId: "acct-1",
      plan: "starter",
      subscriptionStatus: "past_due",
      stripeSubscriptionId: "sub_test_1",
      currentPeriodEnd: new Date(1798761600 * 1000),
    });
  });

  it("(b) a REPLAYED event id is a no-op the second time", async () => {
    const event = subscriptionUpdatedEvent({
      eventId: "evt_sub_updated_replay",
      metadata: { billingAccountId: "acct-1" },
    });

    const first = await POST(signedRequest(event));
    expect((await first.json()).status).toBe("updated");

    const second = await POST(signedRequest(event));
    expect(await second.json()).toEqual({ received: true, status: "duplicate" });
  });

  it("(c) metadata.billingAccountId absent but the customer id resolves via fallback — applies, and warns", async () => {
    mockState.customerIdToAccountId.set("cus_fallback_2", "acct-fallback-2");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const event = subscriptionUpdatedEvent({
      eventId: "evt_sub_updated_fallback",
      customer: "cus_fallback_2",
      metadata: {},
    });
    const res = await POST(signedRequest(event));
    const body = await res.json();

    expect(body).toEqual({ received: true, status: "updated" });
    expect(mockApplySubscriptionState).toHaveBeenCalledWith(
      expect.objectContaining({ billingAccountId: "acct-fallback-2" })
    );
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("(d) metadata absent AND the customer-id fallback also fails — ignored, never applied, logs loudly", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const event = subscriptionUpdatedEvent({
      eventId: "evt_sub_updated_unresolvable",
      customer: "cus_unknown_to_us",
      metadata: {},
    });

    const res = await POST(signedRequest(event));
    const body = await res.json();

    expect(body).toEqual({ received: true, status: "ignored:missing_metadata" });
    expect(mockApplySubscriptionState).not.toHaveBeenCalled();
    expect(mockIgnored).toHaveBeenCalledWith({
      eventId: "evt_sub_updated_unresolvable",
      eventType: "customer.subscription.updated",
    });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("(e) an unmapped price id records the event, logs loudly, and writes nothing (never guesses a plan)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const event = subscriptionUpdatedEvent({
      eventId: "evt_sub_updated_unmapped",
      metadata: { billingAccountId: "acct-1" },
      priceId: PRICE_UNMAPPED,
    });

    const res = await POST(signedRequest(event));
    const body = await res.json();

    expect(body).toEqual({ received: true, status: "ignored:unmapped_price" });
    expect(mockApplySubscriptionState).not.toHaveBeenCalled();
    expect(mockIgnored).toHaveBeenCalledWith({
      eventId: "evt_sub_updated_unmapped",
      eventType: "customer.subscription.updated",
    });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("POST /api/v1/billing/stripe/webhook — customer.subscription.deleted", () => {
  it("(a) happy path: reverts to trial/canceled and clears the subscription id + period end", async () => {
    const event = subscriptionDeletedEvent({
      eventId: "evt_sub_deleted_1",
      id: "sub_test_1",
      metadata: { billingAccountId: "acct-1" },
    });

    const res = await POST(signedRequest(event));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ received: true, status: "canceled" });
    expect(mockApplySubscriptionState).toHaveBeenCalledWith({
      eventId: "evt_sub_deleted_1",
      eventType: "customer.subscription.deleted",
      billingAccountId: "acct-1",
      plan: "trial",
      subscriptionStatus: "canceled",
      stripeSubscriptionId: null,
      currentPeriodEnd: null,
    });
  });

  it("(b) a REPLAYED event id is a no-op the second time", async () => {
    const event = subscriptionDeletedEvent({
      eventId: "evt_sub_deleted_replay",
      metadata: { billingAccountId: "acct-1" },
    });

    const first = await POST(signedRequest(event));
    expect((await first.json()).status).toBe("canceled");

    const second = await POST(signedRequest(event));
    expect(await second.json()).toEqual({ received: true, status: "duplicate" });
  });

  it("(c) metadata.billingAccountId absent but the customer id resolves via fallback — applies, and warns", async () => {
    mockState.customerIdToAccountId.set("cus_fallback_3", "acct-fallback-3");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const event = subscriptionDeletedEvent({
      eventId: "evt_sub_deleted_fallback",
      customer: "cus_fallback_3",
      metadata: {},
    });
    const res = await POST(signedRequest(event));
    const body = await res.json();

    expect(body).toEqual({ received: true, status: "canceled" });
    expect(mockApplySubscriptionState).toHaveBeenCalledWith(
      expect.objectContaining({ billingAccountId: "acct-fallback-3" })
    );
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("(d) metadata absent AND the customer-id fallback also fails — ignored, never applied, logs loudly", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const event = subscriptionDeletedEvent({
      eventId: "evt_sub_deleted_unresolvable",
      customer: "cus_unknown_to_us",
      metadata: {},
    });

    const res = await POST(signedRequest(event));
    const body = await res.json();

    expect(body).toEqual({ received: true, status: "ignored:missing_metadata" });
    expect(mockApplySubscriptionState).not.toHaveBeenCalled();
    expect(mockIgnored).toHaveBeenCalledWith({
      eventId: "evt_sub_deleted_unresolvable",
      eventType: "customer.subscription.deleted",
    });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("POST /api/v1/billing/stripe/webhook — invoice.payment_failed", () => {
  it("(a) happy path: flips subscription_status to past_due via the invoice's subscription_details metadata", async () => {
    const event = invoicePaymentFailedEvent({
      eventId: "evt_invoice_failed_1",
      metadata: { billingAccountId: "acct-1" },
    });

    const res = await POST(signedRequest(event));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ received: true, status: "past_due" });
    expect(mockRecordPastDue).toHaveBeenCalledWith({
      eventId: "evt_invoice_failed_1",
      eventType: "invoice.payment_failed",
      billingAccountId: "acct-1",
    });
  });

  it("(b) a REPLAYED event id is a no-op the second time", async () => {
    const event = invoicePaymentFailedEvent({
      eventId: "evt_invoice_failed_replay",
      metadata: { billingAccountId: "acct-1" },
    });

    const first = await POST(signedRequest(event));
    expect((await first.json()).status).toBe("past_due");

    const second = await POST(signedRequest(event));
    expect(await second.json()).toEqual({ received: true, status: "duplicate" });
  });

  it("(c) subscription_details metadata absent but the customer id resolves via fallback — applies, and warns", async () => {
    mockState.customerIdToAccountId.set("cus_fallback_4", "acct-fallback-4");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const event = invoicePaymentFailedEvent({
      eventId: "evt_invoice_failed_fallback",
      customer: "cus_fallback_4",
      metadata: null,
    });
    const res = await POST(signedRequest(event));
    const body = await res.json();

    expect(body).toEqual({ received: true, status: "past_due" });
    expect(mockRecordPastDue).toHaveBeenCalledWith(
      expect.objectContaining({ billingAccountId: "acct-fallback-4" })
    );
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("(d) unresolvable (no metadata, unknown customer) records the event, WARNS (not errors), and no-ops", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const event = invoicePaymentFailedEvent({
      eventId: "evt_invoice_failed_unresolvable",
      customer: "cus_unknown_to_us",
      metadata: null,
    });
    const res = await POST(signedRequest(event));
    const body = await res.json();

    expect(body).toEqual({ received: true, status: "ignored:missing_metadata" });
    expect(mockRecordPastDue).not.toHaveBeenCalled();
    expect(mockIgnored).toHaveBeenCalledWith({
      eventId: "evt_invoice_failed_unresolvable",
      eventType: "invoice.payment_failed",
    });
    // pin #4's specific carve-out: this unresolvable case is a WARN, never
    // an ERROR — a missed status mirror on a failed invoice isn't itself a
    // loss of billing state, unlike the other three handlers' unresolvable
    // case.
    expect(warnSpy).toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
