import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@agentrail/db-postgres", () => ({
  db: {},
  getBillingAccountForWorkspace: vi.fn(),
  countActiveSeats: vi.fn(),
  countAccountRunsStartedInWindow: vi.fn(),
  countRunOutcomesForWorkspace: vi.fn(),
}));
vi.mock("./policy/resolve-policy", () => ({
  resolvePolicyForWorkspace: vi.fn(),
}));
vi.mock("./policy/feature-flags", () => ({
  subscriptionsEnforced: vi.fn(),
}));

import { loadPlanCardData } from "./plan-card-data";
import {
  db,
  getBillingAccountForWorkspace,
  countActiveSeats,
  countAccountRunsStartedInWindow,
  countRunOutcomesForWorkspace,
  type BillingAccountRow,
} from "@agentrail/db-postgres";
import { resolvePolicyForWorkspace, type ResolvedPolicy } from "./policy/resolve-policy";
import { subscriptionsEnforced } from "./policy/feature-flags";
import { PLAN_POLICIES } from "./policy/plan-policies";

/**
 * `loadPlanCardData` (subscription platform slice 6 plan
 * `docs/superpowers/plans/2026-07-31-subscription-console-slice6.md` Task
 * 2) — the server-side read behind the digest's plan-card (a later task in
 * the same slice mounts it; this file only proves the LOADER). Mirrors the
 * three existing enforcement gates' own test shape (`channel-dispatch.test.ts`'s
 * "chat seat gate" describe block, `route.test.ts`'s capacity-gate tests):
 * flag-gate-first, fail-open try/catch, degraded/null-account skip, and the
 * zero-spend `fetchMonthSpendUsd` stub — same conventions, new call site.
 */
describe("loadPlanCardData", () => {
  const mockSubsEnforced = vi.mocked(subscriptionsEnforced);
  const mockResolvePolicy = vi.mocked(resolvePolicyForWorkspace);
  const mockGetBillingAccount = vi.mocked(getBillingAccountForWorkspace);
  const mockCountActiveSeats = vi.mocked(countActiveSeats);
  const mockCountAccountRuns = vi.mocked(countAccountRunsStartedInWindow);
  const mockCountRunOutcomes = vi.mocked(countRunOutcomesForWorkspace);

  function resolved(overrides: Partial<ResolvedPolicy> = {}): ResolvedPolicy {
    return {
      policy: { ...PLAN_POLICIES.growth, seatLimit: 8, monthlyCapacity: 500 },
      billingAccountId: "acct-1",
      degraded: false,
      ...overrides,
    };
  }

  function accountRow(overrides: Partial<BillingAccountRow> = {}): BillingAccountRow {
    return {
      id: "acct-1",
      name: "Acme",
      plan: "growth",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      subscriptionStatus: null,
      currentPeriodEnd: null,
      trialEndsAt: new Date("2026-08-01T00:00:00.000Z"),
      policyOverrides: {},
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      ...overrides,
    } as BillingAccountRow;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // Off by default, matching every other gate's test-file convention —
    // each test that wants the loader live flips this on itself.
    mockSubsEnforced.mockReturnValue(false);
  });

  it("flag off: returns undefined without ever calling the policy resolver", async () => {
    const result = await loadPlanCardData("ws-1");

    expect(result).toBeUndefined();
    expect(mockResolvePolicy).not.toHaveBeenCalled();
  });

  it("degraded resolution: returns undefined, never reads seats/capacity/outcomes/account", async () => {
    mockSubsEnforced.mockReturnValue(true);
    mockResolvePolicy.mockResolvedValue(resolved({ degraded: true }));

    const result = await loadPlanCardData("ws-1");

    expect(result).toBeUndefined();
    expect(mockCountActiveSeats).not.toHaveBeenCalled();
    expect(mockCountAccountRuns).not.toHaveBeenCalled();
    expect(mockCountRunOutcomes).not.toHaveBeenCalled();
    expect(mockGetBillingAccount).not.toHaveBeenCalled();
  });

  it("any thrown error fails safe: returns undefined with a namespaced [plan-card] console.error", async () => {
    mockSubsEnforced.mockReturnValue(true);
    mockResolvePolicy.mockRejectedValue(new Error("boom: policy resolver down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await loadPlanCardData("ws-1");

    expect(result).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[plan-card]"),
      expect.anything()
    );
    errorSpy.mockRestore();
  });

  it("trial plan: renewalText reads 'Trial ends <date>' from trialEndsAt, ignoring currentPeriodEnd entirely", async () => {
    mockSubsEnforced.mockReturnValue(true);
    mockResolvePolicy.mockResolvedValue(
      resolved({ policy: { ...PLAN_POLICIES.trial, seatLimit: 10, monthlyCapacity: 1000 } })
    );
    mockCountActiveSeats.mockResolvedValue(3);
    mockCountAccountRuns.mockResolvedValue(42);
    mockCountRunOutcomes.mockResolvedValue({ success: 7, humanReview: 1, failed: 2 });
    mockGetBillingAccount.mockResolvedValue(
      accountRow({
        plan: "trial",
        trialEndsAt: new Date("2026-08-14T00:00:00.000Z"),
        // Deliberately non-null: proves the trial branch never reads this.
        currentPeriodEnd: new Date("2099-01-01T00:00:00.000Z"),
      })
    );

    const result = await loadPlanCardData("ws-1");

    expect(result).toEqual({
      planLabel: "Trial",
      seatsUsed: 3,
      seatLimit: 10,
      capacityUsed: 42,
      capacityTotal: 1000,
      renewalText: "Trial ends Aug 14, 2026",
      shippedAllTime: 7,
    });
  });

  it("non-trial plan (growth): renewalText uses renewalLabel(currentPeriodEnd), ignoring trialEndsAt entirely", async () => {
    mockSubsEnforced.mockReturnValue(true);
    mockResolvePolicy.mockResolvedValue(resolved());
    mockCountActiveSeats.mockResolvedValue(5);
    mockCountAccountRuns.mockResolvedValue(120);
    mockCountRunOutcomes.mockResolvedValue({ success: 30, humanReview: 2, failed: 1 });
    mockGetBillingAccount.mockResolvedValue(
      accountRow({
        plan: "growth",
        currentPeriodEnd: new Date("2026-08-30T00:00:00.000Z"),
        // Deliberately set: proves the non-trial branch never reads this.
        trialEndsAt: new Date("2020-01-01T00:00:00.000Z"),
      })
    );

    const result = await loadPlanCardData("ws-1");

    expect(result).toEqual({
      planLabel: "Growth",
      seatsUsed: 5,
      seatLimit: 8,
      capacityUsed: 120,
      capacityTotal: 500,
      renewalText: "Renews Aug 30, 2026",
      shippedAllTime: 30,
    });
  });

  it("wires every read to the right arguments, including the current UTC billing-period bounds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-31T23:59:00.000Z"));
    mockSubsEnforced.mockReturnValue(true);
    mockResolvePolicy.mockResolvedValue(resolved({ billingAccountId: "acct-42" }));
    mockCountActiveSeats.mockResolvedValue(1);
    mockCountAccountRuns.mockResolvedValue(1);
    mockCountRunOutcomes.mockResolvedValue({ success: 0, humanReview: 0, failed: 0 });
    mockGetBillingAccount.mockResolvedValue(accountRow());

    try {
      await loadPlanCardData("ws-9");
    } finally {
      vi.useRealTimers();
    }

    expect(mockResolvePolicy).toHaveBeenCalledWith(
      "ws-9",
      expect.objectContaining({ fetchMonthSpendUsd: expect.any(Function) })
    );
    const deps = mockResolvePolicy.mock.calls[0]?.[1] as {
      fetchMonthSpendUsd: () => Promise<number>;
    };
    await expect(deps.fetchMonthSpendUsd()).resolves.toBe(0);

    expect(mockCountActiveSeats).toHaveBeenCalledWith(db, "acct-42");
    expect(mockCountAccountRuns).toHaveBeenCalledWith(db, {
      billingAccountId: "acct-42",
      fromIso: "2026-01-01T00:00:00.000Z",
      toIso: "2026-02-01T00:00:00.000Z",
    });
    expect(mockCountRunOutcomes).toHaveBeenCalledWith("ws-9");
    expect(mockGetBillingAccount).toHaveBeenCalledWith(db, "ws-9");
  });
});
