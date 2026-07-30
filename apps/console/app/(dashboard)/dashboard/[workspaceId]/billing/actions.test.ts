import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { BillingAccountRow } from "@agentrail/db-postgres";

vi.mock("../../../../../lib/cached", () => ({
  getSession: vi.fn(),
  getMembership: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

import { getSession, getMembership } from "../../../../../lib/cached";
import { headers } from "next/headers";
import {
  createSubscriptionCheckoutSessionAction,
  createPortalSessionAction,
  type CreateSubscriptionCheckoutResult,
  type CreatePortalSessionResult,
} from "./actions";
import type { PaidPlan } from "../../../../../lib/billing/stripe-plans";

/**
 * `createSubscriptionCheckoutSessionAction` (slice-3 plan Task 3,
 * `docs/superpowers/plans/2026-07-29-subscription-stripe-slice3.md`).
 *
 * `@agentrail/db-postgres` and `lib/stripe.ts` are DELIBERATELY not
 * `vi.mock`'d here. There is no colocated `wallet/actions.test.ts` to mirror
 * (the house reference, `wallet/actions.ts`, ships with no test at all), so
 * this follows the closest REAL precedent in this codebase for testing a
 * function that calls `getBillingAccountForWorkspace`:
 * `lib/policy/resolve-policy.ts` + `resolve-policy.test.ts`. That pair
 * passes `fetchAccount` (and friends) through an injectable `deps` object
 * and never mocks `@agentrail/db-postgres` at all — the real `db` singleton
 * import is harmless in a test because `postgres()` (`packages/db-postgres
 * /src/db.ts`) connects lazily, and an injected fake never actually calls
 * through to it. This suite does the same, and additionally injects
 * `stripe` (no real Stripe client precedent exists yet to mirror, and
 * module-mocking the `stripe` package for every test would be far noisier
 * than a plain object fake of the two methods this action actually calls).
 *
 * `getSession`/`getMembership` are NOT parameterized on the action's
 * signature (matches `wallet/actions.ts` and `permissions/actions.ts`'s own
 * shape) — those still need `lib/cached` module-mocked, exactly like
 * `permissions/actions.test.ts` does.
 *
 * `next/headers` is module-mocked too: `resolveOrigin()` (copied from
 * `wallet/actions.ts`) calls the real `headers()`, which throws outside a
 * live Next.js request scope.
 *
 * `STRIPE_SECRET_KEY`/`STRIPE_PRICE_STARTER`/`STRIPE_PRICE_GROWTH` are
 * stubbed directly on `process.env` and restored in `afterEach` — the same
 * posture `stripe-plans.test.ts` uses for `STRIPE_SECRET_KEY`, extended to
 * the two price envs. `subscriptionBillingConfigured`/`subscriptionPriceId`
 * have no injectable-env parameter on this action (only `stripe-plans.ts`'s
 * own tests exercise their `env` override directly) — see
 * `stripe-plans.ts`'s own doc-comment on why the Stripe-key half in
 * particular has no seam.
 */

const WORKSPACE_ID = "ws-123";
const OWNER_USER_ID = "user-owner";
const BILLING_ACCOUNT_ID = "acct-1";
const PRICE_STARTER = "price_starter_123";
const PRICE_GROWTH = "price_growth_456";

const ORIGINAL_ENV = {
  STRIPE_SECRET_KEY: process.env["STRIPE_SECRET_KEY"],
  STRIPE_PRICE_STARTER: process.env["STRIPE_PRICE_STARTER"],
  STRIPE_PRICE_GROWTH: process.env["STRIPE_PRICE_GROWTH"],
};

function restoreEnvVar(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function mockSession(userId: string | null) {
  vi.mocked(getSession).mockResolvedValue(
    (userId ? { user: { id: userId } } : null) as Awaited<ReturnType<typeof getSession>>
  );
}

function mockMembership(role: "owner" | "admin" | "member" | "viewer" | null) {
  vi.mocked(getMembership).mockResolvedValue(
    (role
      ? { userId: OWNER_USER_ID, workspaceId: WORKSPACE_ID, role, createdAt: new Date() }
      : null) as Awaited<ReturnType<typeof getMembership>>
  );
}

function makeAccount(overrides: Partial<BillingAccountRow> = {}): BillingAccountRow {
  return {
    id: BILLING_ACCOUNT_ID,
    name: "Acme Inc",
    plan: "trial",
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    subscriptionStatus: null,
    currentPeriodEnd: null,
    trialEndsAt: new Date("2026-08-12T00:00:00Z"),
    policyOverrides: {},
    createdAt: new Date("2026-07-29T00:00:00Z"),
    updatedAt: new Date("2026-07-29T00:00:00Z"),
    ...overrides,
  };
}

function makeStripeFake(
  overrides: {
    customerId?: string;
    checkoutUrl?: string | null;
    customersCreateImpl?: () => Promise<{ id: string }>;
    sessionsCreateImpl?: () => Promise<{ url: string | null }>;
    portalUrl?: string;
    portalSessionsCreateImpl?: () => Promise<{ url: string }>;
  } = {}
) {
  const customersCreate = vi.fn(
    overrides.customersCreateImpl ?? (async () => ({ id: overrides.customerId ?? "cus_new_1" }))
  );
  const sessionsCreate = vi.fn(
    overrides.sessionsCreateImpl ??
      (async () => ({
        url:
          overrides.checkoutUrl === undefined
            ? "https://checkout.stripe.com/session_1"
            : overrides.checkoutUrl,
      }))
  );
  const portalSessionsCreate = vi.fn(
    overrides.portalSessionsCreateImpl ??
      (async () => ({
        url: overrides.portalUrl ?? "https://billing.stripe.com/session/portal_1",
      }))
  );
  const stripe = {
    customers: { create: customersCreate },
    checkout: { sessions: { create: sessionsCreate } },
    billingPortal: { sessions: { create: portalSessionsCreate } },
  } as unknown as Stripe;
  return { stripe, customersCreate, sessionsCreate, portalSessionsCreate };
}

function expectError(
  result: CreateSubscriptionCheckoutResult | CreatePortalSessionResult,
  error: string
) {
  expect(result).toEqual({ ok: false, error });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env["STRIPE_SECRET_KEY"] = "sk_test_dummy_for_billing_actions_test";
  process.env["STRIPE_PRICE_STARTER"] = PRICE_STARTER;
  process.env["STRIPE_PRICE_GROWTH"] = PRICE_GROWTH;
  vi.mocked(headers).mockResolvedValue(new Headers({ host: "app.test.local" }) as never);
});

afterEach(() => {
  restoreEnvVar("STRIPE_SECRET_KEY", ORIGINAL_ENV.STRIPE_SECRET_KEY);
  restoreEnvVar("STRIPE_PRICE_STARTER", ORIGINAL_ENV.STRIPE_PRICE_STARTER);
  restoreEnvVar("STRIPE_PRICE_GROWTH", ORIGINAL_ENV.STRIPE_PRICE_GROWTH);
});

describe("createSubscriptionCheckoutSessionAction", () => {
  // --- argument validation (#1343 minor (d): a Server Action is a real
  // wire endpoint, not just a typed function call) ------------------------

  it("rejects a missing workspaceId, never calls getSession", async () => {
    const { stripe } = makeStripeFake();

    const result = await createSubscriptionCheckoutSessionAction("", "starter", { stripe });

    expectError(result, "Missing workspace.");
    expect(getSession).not.toHaveBeenCalled();
  });

  it("rejects an unknown plan value, never calls getSession", async () => {
    const { stripe } = makeStripeFake();

    const result = await createSubscriptionCheckoutSessionAction(
      WORKSPACE_ID,
      "enterprise" as unknown as PaidPlan,
      { stripe }
    );

    expectError(result, "Unknown plan.");
    expect(getSession).not.toHaveBeenCalled();
  });

  // --- authz: owner/admin only, ADMIN_ROLES pattern -------------------------

  it("rejects when not signed in", async () => {
    mockSession(null);
    const { stripe } = makeStripeFake();

    const result = await createSubscriptionCheckoutSessionAction(WORKSPACE_ID, "starter", { stripe });

    expectError(result, "Not signed in.");
  });

  it("rejects when the user has no membership on this workspace", async () => {
    mockSession(OWNER_USER_ID);
    mockMembership(null);
    const { stripe, customersCreate } = makeStripeFake();

    const result = await createSubscriptionCheckoutSessionAction(WORKSPACE_ID, "starter", { stripe });

    expect(result.ok).toBe(false);
    expect(customersCreate).not.toHaveBeenCalled();
  });

  it.each(["member", "viewer"] as const)(
    "rejects a %s — owner/admin only, never reaches Stripe",
    async (role) => {
      mockSession(OWNER_USER_ID);
      mockMembership(role);
      const { stripe, customersCreate } = makeStripeFake();

      const result = await createSubscriptionCheckoutSessionAction(WORKSPACE_ID, "starter", { stripe });

      expectError(result, "Only an owner or admin can manage the subscription.");
      expect(customersCreate).not.toHaveBeenCalled();
    }
  );

  it.each(["owner", "admin"] as const)("allows a workspace %s through to Stripe", async (role) => {
    mockSession(OWNER_USER_ID);
    mockMembership(role);
    const account = makeAccount({ stripeCustomerId: "cus_existing" });
    const fetchAccount = vi.fn(async () => account);
    const { stripe } = makeStripeFake();

    const result = await createSubscriptionCheckoutSessionAction(WORKSPACE_ID, "starter", {
      stripe,
      fetchAccount: fetchAccount as never,
    });

    expect(result.ok).toBe(true);
  });

  // --- billing-configured gate (checked right after authz, before any DB
  // or Stripe call — mirrors wallet/actions.ts checking getStripeClient()
  // immediately after its own authz block) ----------------------------------

  it("rejects when STRIPE_SECRET_KEY is unset, never fetches the account", async () => {
    mockSession(OWNER_USER_ID);
    mockMembership("owner");
    delete process.env["STRIPE_SECRET_KEY"];
    const fetchAccount = vi.fn();
    const { stripe } = makeStripeFake();

    const result = await createSubscriptionCheckoutSessionAction(WORKSPACE_ID, "starter", {
      stripe,
      fetchAccount: fetchAccount as never,
    });

    expectError(result, "Billing isn't configured for this deployment yet.");
    expect(fetchAccount).not.toHaveBeenCalled();
  });

  it("rejects when a plan's price id is unset", async () => {
    mockSession(OWNER_USER_ID);
    mockMembership("owner");
    delete process.env["STRIPE_PRICE_GROWTH"];
    const { stripe } = makeStripeFake();

    const result = await createSubscriptionCheckoutSessionAction(WORKSPACE_ID, "growth", { stripe });

    expectError(result, "Billing isn't configured for this deployment yet.");
  });

  // --- account resolution: never creates one here ---------------------------

  it("rejects when the workspace has no billing account, never touches Stripe", async () => {
    mockSession(OWNER_USER_ID);
    mockMembership("owner");
    const fetchAccount = vi.fn(async () => null);
    const { stripe, customersCreate, sessionsCreate } = makeStripeFake();

    const result = await createSubscriptionCheckoutSessionAction(WORKSPACE_ID, "starter", {
      stripe,
      fetchAccount: fetchAccount as never,
    });

    expect(result.ok).toBe(false);
    expect(customersCreate).not.toHaveBeenCalled();
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  // --- ensure-customer step: the ONE write this action may make -----------

  it("creates and binds a Stripe customer when the account has none, then uses it for checkout", async () => {
    mockSession(OWNER_USER_ID);
    mockMembership("owner");
    const account = makeAccount({ stripeCustomerId: null });
    const fetchAccount = vi.fn(async () => account);
    const bindCustomer = vi.fn(async () => undefined);
    const { stripe, customersCreate, sessionsCreate } = makeStripeFake({ customerId: "cus_fresh_1" });

    const result = await createSubscriptionCheckoutSessionAction(WORKSPACE_ID, "starter", {
      stripe,
      fetchAccount: fetchAccount as never,
      bindCustomer: bindCustomer as never,
    });

    expect(customersCreate).toHaveBeenCalledWith({
      metadata: { billingAccountId: BILLING_ACCOUNT_ID },
    });
    expect(bindCustomer).toHaveBeenCalledWith(expect.anything(), BILLING_ACCOUNT_ID, "cus_fresh_1");
    expect(sessionsCreate).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus_fresh_1" }));
    expect(result.ok).toBe(true);
  });

  it("threads an injected db through to both fetchAccount and bindCustomer", async () => {
    mockSession(OWNER_USER_ID);
    mockMembership("owner");
    const fakeDb = { marker: "fake-db-instance" };
    const account = makeAccount({ stripeCustomerId: null });
    const fetchAccount = vi.fn(async () => account);
    const bindCustomer = vi.fn(async () => undefined);
    const { stripe } = makeStripeFake({ customerId: "cus_fresh_2" });

    await createSubscriptionCheckoutSessionAction(WORKSPACE_ID, "starter", {
      stripe,
      db: fakeDb as never,
      fetchAccount: fetchAccount as never,
      bindCustomer: bindCustomer as never,
    });

    expect(fetchAccount).toHaveBeenCalledWith(fakeDb, WORKSPACE_ID);
    expect(bindCustomer).toHaveBeenCalledWith(fakeDb, BILLING_ACCOUNT_ID, "cus_fresh_2");
  });

  it("skips customer creation entirely when the account already has one bound", async () => {
    mockSession(OWNER_USER_ID);
    mockMembership("owner");
    const account = makeAccount({ stripeCustomerId: "cus_existing_1" });
    const fetchAccount = vi.fn(async () => account);
    const bindCustomer = vi.fn(async () => undefined);
    const { stripe, customersCreate, sessionsCreate } = makeStripeFake();

    const result = await createSubscriptionCheckoutSessionAction(WORKSPACE_ID, "growth", {
      stripe,
      fetchAccount: fetchAccount as never,
      bindCustomer: bindCustomer as never,
    });

    expect(customersCreate).not.toHaveBeenCalled();
    expect(bindCustomer).not.toHaveBeenCalled();
    expect(sessionsCreate).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus_existing_1" }));
    expect(result.ok).toBe(true);
  });

  it("a Stripe error creating/binding the customer returns a generic error and never creates a checkout session", async () => {
    mockSession(OWNER_USER_ID);
    mockMembership("owner");
    const account = makeAccount({ stripeCustomerId: null });
    const fetchAccount = vi.fn(async () => account);
    const { stripe, sessionsCreate } = makeStripeFake({
      customersCreateImpl: async () => {
        throw new Error("Stripe API down");
      },
    });

    const result = await createSubscriptionCheckoutSessionAction(WORKSPACE_ID, "starter", {
      stripe,
      fetchAccount: fetchAccount as never,
    });

    expectError(result, "Couldn't start checkout. Try again in a moment.");
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  // --- checkout session params: mode, price, both metadata sites, URLs ----

  it("creates the session with mode=subscription, the plan's price, both metadata sites, and workspace-scoped billing-page URLs", async () => {
    mockSession(OWNER_USER_ID);
    mockMembership("admin");
    const account = makeAccount({ stripeCustomerId: "cus_existing_1" });
    const fetchAccount = vi.fn(async () => account);
    const { stripe, sessionsCreate } = makeStripeFake({
      checkoutUrl: "https://checkout.stripe.com/pay/cs_test_1",
    });

    const result = await createSubscriptionCheckoutSessionAction(WORKSPACE_ID, "growth", {
      stripe,
      fetchAccount: fetchAccount as never,
    });

    expect(sessionsCreate).toHaveBeenCalledWith({
      mode: "subscription",
      customer: "cus_existing_1",
      line_items: [{ price: PRICE_GROWTH, quantity: 1 }],
      success_url: `https://app.test.local/dashboard/${WORKSPACE_ID}/billing?checkout=success`,
      cancel_url: `https://app.test.local/dashboard/${WORKSPACE_ID}/billing?checkout=cancelled`,
      metadata: { billingAccountId: BILLING_ACCOUNT_ID, plan: "growth" },
      subscription_data: { metadata: { billingAccountId: BILLING_ACCOUNT_ID } },
    });
    expect(result).toEqual({ ok: true, url: "https://checkout.stripe.com/pay/cs_test_1" });
  });

  it('uses the starter price id for plan="starter"', async () => {
    mockSession(OWNER_USER_ID);
    mockMembership("owner");
    const account = makeAccount({ stripeCustomerId: "cus_existing_1" });
    const fetchAccount = vi.fn(async () => account);
    const { stripe, sessionsCreate } = makeStripeFake();

    await createSubscriptionCheckoutSessionAction(WORKSPACE_ID, "starter", {
      stripe,
      fetchAccount: fetchAccount as never,
    });

    expect(sessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ line_items: [{ price: PRICE_STARTER, quantity: 1 }] })
    );
  });

  it("a Stripe error creating the checkout session returns a generic error", async () => {
    mockSession(OWNER_USER_ID);
    mockMembership("owner");
    const account = makeAccount({ stripeCustomerId: "cus_existing_1" });
    const fetchAccount = vi.fn(async () => account);
    const { stripe } = makeStripeFake({
      sessionsCreateImpl: async () => {
        throw new Error("Stripe API down");
      },
    });

    const result = await createSubscriptionCheckoutSessionAction(WORKSPACE_ID, "starter", {
      stripe,
      fetchAccount: fetchAccount as never,
    });

    expectError(result, "Couldn't start checkout. Try again in a moment.");
  });

  it("a session with no URL returns a typed error instead of throwing", async () => {
    mockSession(OWNER_USER_ID);
    mockMembership("owner");
    const account = makeAccount({ stripeCustomerId: "cus_existing_1" });
    const fetchAccount = vi.fn(async () => account);
    const { stripe } = makeStripeFake({ checkoutUrl: null });

    const result = await createSubscriptionCheckoutSessionAction(WORKSPACE_ID, "starter", {
      stripe,
      fetchAccount: fetchAccount as never,
    });

    expectError(result, "Stripe didn't return a checkout URL.");
  });
});

/**
 * `createPortalSessionAction` (slice-3 plan Task 5) — same injectable-`deps`
 * / real-`getBillingAccountForWorkspace`-import posture as
 * `createSubscriptionCheckoutSessionAction` above (see that describe
 * block's own top doc-comment for the full rationale); this suite reuses
 * every fixture/fake defined above it (`mockSession`, `mockMembership`,
 * `makeAccount`, `makeStripeFake`, `expectError`) rather than duplicating
 * them.
 */
describe("createPortalSessionAction", () => {
  it("rejects a missing workspaceId, never calls getSession", async () => {
    const { stripe } = makeStripeFake();

    const result = await createPortalSessionAction("", { stripe });

    expectError(result, "Missing workspace.");
    expect(getSession).not.toHaveBeenCalled();
  });

  it("rejects when not signed in", async () => {
    mockSession(null);
    const { stripe } = makeStripeFake();

    const result = await createPortalSessionAction(WORKSPACE_ID, { stripe });

    expectError(result, "Not signed in.");
  });

  it("rejects when the user has no membership on this workspace", async () => {
    mockSession(OWNER_USER_ID);
    mockMembership(null);
    const { stripe, portalSessionsCreate } = makeStripeFake();

    const result = await createPortalSessionAction(WORKSPACE_ID, { stripe });

    expect(result.ok).toBe(false);
    expect(portalSessionsCreate).not.toHaveBeenCalled();
  });

  it.each(["member", "viewer"] as const)(
    "rejects a %s — owner/admin only, never reaches Stripe",
    async (role) => {
      mockSession(OWNER_USER_ID);
      mockMembership(role);
      const { stripe, portalSessionsCreate } = makeStripeFake();

      const result = await createPortalSessionAction(WORKSPACE_ID, { stripe });

      expectError(result, "Only an owner or admin can manage the subscription.");
      expect(portalSessionsCreate).not.toHaveBeenCalled();
    }
  );

  // --- billing-configured gate: Stripe itself only — deliberately NOT
  // subscriptionBillingConfigured() (see the action's own doc-comment: the
  // portal has no dependency on either plan's price id being set) ---------

  it("rejects when STRIPE_SECRET_KEY is unset, never fetches the account", async () => {
    mockSession(OWNER_USER_ID);
    mockMembership("owner");
    delete process.env["STRIPE_SECRET_KEY"];
    const fetchAccount = vi.fn();

    const result = await createPortalSessionAction(WORKSPACE_ID, {
      fetchAccount: fetchAccount as never,
    });

    expectError(result, "Billing isn't configured for this deployment yet.");
    expect(fetchAccount).not.toHaveBeenCalled();
  });

  // --- account resolution: never creates one here ---------------------------

  it("rejects when the workspace has no billing account, never touches Stripe", async () => {
    mockSession(OWNER_USER_ID);
    mockMembership("owner");
    const fetchAccount = vi.fn(async () => null);
    const { stripe, portalSessionsCreate } = makeStripeFake();

    const result = await createPortalSessionAction(WORKSPACE_ID, {
      stripe,
      fetchAccount: fetchAccount as never,
    });

    expectError(result, "This workspace doesn't have a billing account yet.");
    expect(portalSessionsCreate).not.toHaveBeenCalled();
  });

  it("a failure fetching the account returns a generic error", async () => {
    mockSession(OWNER_USER_ID);
    mockMembership("owner");
    const fetchAccount = vi.fn(async () => {
      throw new Error("db down");
    });
    const { stripe, portalSessionsCreate } = makeStripeFake();

    const result = await createPortalSessionAction(WORKSPACE_ID, {
      stripe,
      fetchAccount: fetchAccount as never,
    });

    expectError(result, "Couldn't open billing. Try again in a moment.");
    expect(portalSessionsCreate).not.toHaveBeenCalled();
  });

  // --- the typed error this action adds: no stripeCustomerId means no ------
  // portal to open, and this action never creates a customer (contrast
  // createSubscriptionCheckoutSessionAction's ensure-customer step) --------

  it("rejects with a typed error when the account has no stripeCustomerId, never calls Stripe", async () => {
    mockSession(OWNER_USER_ID);
    mockMembership("owner");
    const account = makeAccount({ stripeCustomerId: null });
    const fetchAccount = vi.fn(async () => account);
    const { stripe, portalSessionsCreate } = makeStripeFake();

    const result = await createPortalSessionAction(WORKSPACE_ID, {
      stripe,
      fetchAccount: fetchAccount as never,
    });

    expectError(result, "This workspace hasn't started a subscription yet.");
    expect(portalSessionsCreate).not.toHaveBeenCalled();
  });

  // --- happy path + params ---------------------------------------------------

  it.each(["owner", "admin"] as const)(
    "creates a portal session for a workspace %s, with the account's customer id and a workspace-scoped return_url",
    async (role) => {
      mockSession(OWNER_USER_ID);
      mockMembership(role);
      const account = makeAccount({ stripeCustomerId: "cus_existing_1" });
      const fetchAccount = vi.fn(async () => account);
      const { stripe, portalSessionsCreate } = makeStripeFake({
        portalUrl: "https://billing.stripe.com/session/portal_abc",
      });

      const result = await createPortalSessionAction(WORKSPACE_ID, {
        stripe,
        fetchAccount: fetchAccount as never,
      });

      expect(portalSessionsCreate).toHaveBeenCalledWith({
        customer: "cus_existing_1",
        return_url: `https://app.test.local/dashboard/${WORKSPACE_ID}/billing`,
      });
      expect(result).toEqual({
        ok: true,
        url: "https://billing.stripe.com/session/portal_abc",
      });
    }
  );

  it("threads an injected db through to fetchAccount", async () => {
    mockSession(OWNER_USER_ID);
    mockMembership("owner");
    const fakeDb = { marker: "fake-db-instance" };
    const account = makeAccount({ stripeCustomerId: "cus_existing_1" });
    const fetchAccount = vi.fn(async () => account);
    const { stripe } = makeStripeFake();

    await createPortalSessionAction(WORKSPACE_ID, {
      stripe,
      db: fakeDb as never,
      fetchAccount: fetchAccount as never,
    });

    expect(fetchAccount).toHaveBeenCalledWith(fakeDb, WORKSPACE_ID);
  });

  it("a Stripe error creating the portal session returns a generic error", async () => {
    mockSession(OWNER_USER_ID);
    mockMembership("owner");
    const account = makeAccount({ stripeCustomerId: "cus_existing_1" });
    const fetchAccount = vi.fn(async () => account);
    const { stripe } = makeStripeFake({
      portalSessionsCreateImpl: async () => {
        throw new Error("Stripe API down");
      },
    });

    const result = await createPortalSessionAction(WORKSPACE_ID, {
      stripe,
      fetchAccount: fetchAccount as never,
    });

    expectError(result, "Couldn't open billing. Try again in a moment.");
  });
});
