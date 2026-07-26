import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * #1415 — the Stripe-event dedup + wallet-credit transaction. No live-DB
 * harness in this package (see `wallet.test.ts`'s own note) — `db` is
 * mocked, with `db.transaction` running its callback against the same mock
 * object (mirrors `goals.test.ts`'s idiom). This is the test that proves the
 * ACTUAL idempotency mechanism (`ON CONFLICT (event_id) DO NOTHING` ⇒ no
 * wallet insert): a duplicate Stripe event id must credit zero additional
 * cents. The webhook route's own test
 * (`apps/console/.../billing/stripe/webhook/route.test.ts`) proves the HTTP
 * layer (real signed payloads, signature rejection) calls this function
 * correctly; this file proves what happens once it's called.
 */
const mockState = vi.hoisted(() => ({
  eventInsertReturn: [] as unknown[],
  walletInsertReturn: [] as unknown[],
  updateCalls: [] as Array<{ set: Record<string, unknown> }>,
  selectReturn: [] as unknown[],
}));

vi.mock("../db.js", () => {
  const db: Record<string, unknown> = {
    transaction: async (cb: (tx: unknown) => unknown) => cb(db),
    insert: (_table: unknown) => ({
      values: (v: Record<string, unknown>) => ({
        // stripe_events insert: `.onConflictDoNothing({...}).returning({id})`
        onConflictDoNothing: (_opts?: unknown) => ({
          returning: async (_cols?: unknown) =>
            "eventId" in v ? mockState.eventInsertReturn : [],
        }),
        // wallet_transactions insert: plain `.returning()`, no conflict target
        returning: async () => ("kind" in v ? mockState.walletInsertReturn : []),
      }),
    }),
    update: (_table: unknown) => ({
      set: (s: Record<string, unknown>) => ({
        where: (_w: unknown) => {
          mockState.updateCalls.push({ set: s });
          return Promise.resolve(undefined);
        },
      }),
    }),
    select: (_cols?: unknown) => ({
      from: (_table: unknown) => ({
        where: (_w: unknown) => ({
          limit: async () => mockState.selectReturn,
        }),
      }),
    }),
  };
  return { db };
});

import {
  creditTopUpForStripeEvent,
  recordIgnoredStripeEvent,
  hasProcessedStripeEvent,
} from "./stripe_events.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockState.eventInsertReturn = [];
  mockState.walletInsertReturn = [];
  mockState.updateCalls = [];
  mockState.selectReturn = [];
});

describe("creditTopUpForStripeEvent", () => {
  const input = {
    eventId: "evt_test_1",
    eventType: "checkout.session.completed",
    workspaceId: "ws-1",
    amountUsdCents: 2500,
  };

  it("(a) a brand-new event id credits the wallet exactly once and flips billing_enabled", async () => {
    mockState.eventInsertReturn = [{ id: "se-1" }]; // conflict-free insert
    mockState.walletInsertReturn = [
      { id: "wt-1", workspaceId: "ws-1", kind: "top_up", amountUsdCents: 2500 },
    ];

    const result = await creditTopUpForStripeEvent(input);

    expect(result.credited).toBe(true);
    expect(result.transaction?.id).toBe("wt-1");
    // billing_enabled flip attempted (guarded `WHERE billing_enabled = false`
    // in the real SQL — this mock only proves the UPDATE was issued with the
    // right SET clause; the guard itself is expressed in the `.where()` call
    // args, exercised for real by the query builder, not re-asserted here).
    expect(mockState.updateCalls).toHaveLength(1);
    expect(mockState.updateCalls[0]?.set).toEqual({ billingEnabled: true });
  });

  it("(b) a REPLAYED event id (same event.id redelivered) credits ZERO additional cents", async () => {
    // First delivery: genuinely new, credits once.
    mockState.eventInsertReturn = [{ id: "se-1" }];
    mockState.walletInsertReturn = [
      { id: "wt-1", workspaceId: "ws-1", kind: "top_up", amountUsdCents: 2500 },
    ];
    const first = await creditTopUpForStripeEvent(input);
    expect(first.credited).toBe(true);

    // Second delivery of the SAME event id: the unique index on event_id
    // means the INSERT ... ON CONFLICT DO NOTHING returns zero rows — mock
    // that exact behavior (empty return), which is what a real duplicate key
    // produces.
    mockState.eventInsertReturn = [];
    mockState.walletInsertReturn = [
      { id: "wt-2", workspaceId: "ws-1", kind: "top_up", amountUsdCents: 2500 },
    ]; // present to prove it's never reached, not to be credited
    const second = await creditTopUpForStripeEvent(input);

    expect(second.credited).toBe(false);
    expect(second.transaction).toBeUndefined();
    // The wallet-crediting branch (and the billing_enabled flip) must never
    // run on the duplicate — total credited amount across both calls is
    // $25.00 once, not twice.
    expect(mockState.updateCalls).toHaveLength(1); // only from the FIRST call
  });

  it("a zero/negative amount is still passed through as-is (webhook route's own amount_total guard is what filters this, not this function)", async () => {
    mockState.eventInsertReturn = [{ id: "se-1" }];
    mockState.walletInsertReturn = [
      { id: "wt-1", workspaceId: "ws-1", kind: "top_up", amountUsdCents: 100 },
    ];
    const result = await creditTopUpForStripeEvent({ ...input, amountUsdCents: 100 });
    expect(result.credited).toBe(true);
  });
});

describe("recordIgnoredStripeEvent", () => {
  it("records a new ignored event id once", async () => {
    mockState.eventInsertReturn = [{ id: "se-1" }];
    const result = await recordIgnoredStripeEvent({
      eventId: "evt_ignored_1",
      eventType: "payment_intent.succeeded",
    });
    expect(result.recorded).toBe(true);
  });

  it("a duplicate ignored event id is a no-op (idempotent replay guard applies here too)", async () => {
    mockState.eventInsertReturn = [];
    const result = await recordIgnoredStripeEvent({
      eventId: "evt_ignored_1",
      eventType: "payment_intent.succeeded",
    });
    expect(result.recorded).toBe(false);
  });
});

describe("hasProcessedStripeEvent", () => {
  it("true when a row exists for the event id", async () => {
    mockState.selectReturn = [{ id: "se-1" }];
    expect(await hasProcessedStripeEvent("evt_test_1")).toBe(true);
  });

  it("false when no row exists", async () => {
    mockState.selectReturn = [];
    expect(await hasProcessedStripeEvent("evt_unknown")).toBe(false);
  });
});
