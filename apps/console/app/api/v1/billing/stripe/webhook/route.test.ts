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
}));

vi.mock("@agentrail/db-postgres", () => ({
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
}));

import { POST } from "./route";
import {
  creditTopUpForStripeEvent,
  recordIgnoredStripeEvent,
} from "@agentrail/db-postgres";

const mockCredit = vi.mocked(creditTopUpForStripeEvent);
const mockIgnored = vi.mocked(recordIgnoredStripeEvent);

const ORIGINAL_SECRET_KEY = process.env["STRIPE_SECRET_KEY"];
const ORIGINAL_WEBHOOK_SECRET = process.env["STRIPE_WEBHOOK_SECRET"];

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

beforeEach(() => {
  vi.clearAllMocks();
  mockState.creditedEventIds.clear();
  mockState.creditCalls = [];
  mockState.ignoredCalls = [];
  process.env["STRIPE_SECRET_KEY"] = "sk_test_dummy_key_for_route";
  process.env["STRIPE_WEBHOOK_SECRET"] = STRIPE_WEBHOOK_SECRET;
});

afterEach(() => {
  if (ORIGINAL_SECRET_KEY === undefined) delete process.env["STRIPE_SECRET_KEY"];
  else process.env["STRIPE_SECRET_KEY"] = ORIGINAL_SECRET_KEY;
  if (ORIGINAL_WEBHOOK_SECRET === undefined) delete process.env["STRIPE_WEBHOOK_SECRET"];
  else process.env["STRIPE_WEBHOOK_SECRET"] = ORIGINAL_WEBHOOK_SECRET;
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
});
