import { describe, expect, it, vi } from "vitest";
import type { BillingAccountRow } from "@agentrail/db-postgres";
import { resolvePolicyForWorkspace } from "./resolve-policy";
import { PLAN_POLICIES } from "./plan-policies";

/**
 * Fixture builder for `BillingAccountRow` — every field is required on the
 * real type, so this keeps each test's overrides focused on what it's
 * actually exercising. Timestamps are fixed (not `new Date()`) so failures
 * reproduce deterministically.
 */
function makeAccount(overrides: Partial<BillingAccountRow> = {}): BillingAccountRow {
  return {
    id: "acct-1",
    name: "Acme Inc",
    plan: "growth",
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

describe("resolvePolicyForWorkspace", () => {
  it("no billing account: resolves the trial policy, billingAccountId null, not degraded", async () => {
    const fetchAccount = vi.fn(async () => null);
    const fetchWorkspaceIds = vi.fn(async () => {
      throw new Error("must not be called when there is no billing account");
    });
    const fetchMonthSpendUsd = vi.fn(async () => {
      throw new Error("must not be called when there is no billing account");
    });

    const result = await resolvePolicyForWorkspace("ws-orphan", {
      fetchAccount: fetchAccount as never,
      fetchWorkspaceIds: fetchWorkspaceIds as never,
      fetchMonthSpendUsd,
    });

    expect(result.billingAccountId).toBeNull();
    expect(result.degraded).toBe(false);
    expect(result.policy).toEqual(PLAN_POLICIES.trial);
    expect(fetchAccount).toHaveBeenCalledWith(expect.anything(), "ws-orphan");
    expect(fetchWorkspaceIds).not.toHaveBeenCalled();
    expect(fetchMonthSpendUsd).not.toHaveBeenCalled();
  });

  it("selects the plan constants matching account.plan", async () => {
    // Starter is the most distinguishable plan (premium off, escalation
    // off) — the best disambiguator that the RIGHT plan was picked rather
    // than defaulting to trial/growth.
    const account = makeAccount({ plan: "starter", policyOverrides: {} });
    const fetchAccount = vi.fn(async () => account);
    const fetchWorkspaceIds = vi.fn(async () => ["ws-1"]);
    const fetchMonthSpendUsd = vi.fn(async () => 0);

    const result = await resolvePolicyForWorkspace("ws-1", {
      fetchAccount: fetchAccount as never,
      fetchWorkspaceIds: fetchWorkspaceIds as never,
      fetchMonthSpendUsd,
    });

    expect(result.billingAccountId).toBe("acct-1");
    expect(result.policy.seatLimit).toBe(PLAN_POLICIES.starter.seatLimit);
    expect(result.policy.monthlyCapacity).toBe(PLAN_POLICIES.starter.monthlyCapacity);
    expect(result.policy.qualityProfiles).toEqual(PLAN_POLICIES.starter.qualityProfiles);
    expect(result.policy.routing).toEqual(PLAN_POLICIES.starter.routing);
  });

  it("enterprise: policy_overrides deep-merges over the plan constants inside this function, ignoring unknown keys", async () => {
    const account = makeAccount({
      plan: "enterprise",
      policyOverrides: {
        seatLimit: 25,
        qualityProfiles: { premium: false },
        routing: { defaultProfile: "premium", allowEscalation: false },
        economics: { monthlyAiBudgetUsd: 500, maxTaskCostUsd: 20 },
        // Junk that must never survive into the resolved policy.
        notARealTopLevelField: "should be dropped",
      } as never,
    });
    const fetchAccount = vi.fn(async () => account);
    const fetchWorkspaceIds = vi.fn(async () => ["ws-1"]);
    const fetchMonthSpendUsd = vi.fn(async () => 0);

    const result = await resolvePolicyForWorkspace("ws-1", {
      fetchAccount: fetchAccount as never,
      fetchWorkspaceIds: fetchWorkspaceIds as never,
      fetchMonthSpendUsd,
    });

    // Overridden fields win.
    expect(result.policy.seatLimit).toBe(25);
    expect(result.policy.qualityProfiles.premium).toBe(false);
    expect(result.policy.routing.defaultProfile).toBe("premium");
    expect(result.policy.routing.allowEscalation).toBe(false);
    expect(result.policy.economics.monthlyAiBudgetUsd).toBe(500);
    expect(result.policy.economics.maxTaskCostUsd).toBe(20);

    // Fields NOT present in the override keep the plan's base constants —
    // partial nested overrides merge per-field, not wholesale replacement.
    expect(result.policy.monthlyCapacity).toBe(PLAN_POLICIES.enterprise.monthlyCapacity);
    expect(result.policy.qualityProfiles.economy).toBe(true);
    expect(result.policy.qualityProfiles.standard).toBe(true);
    expect(result.policy.routing.allowDowngrade).toBe(true);

    // Unknown keys never get spread into the flat, final policy.
    expect(result.policy).not.toHaveProperty("notARealTopLevelField");
    expect(Object.keys(result.policy).sort()).toEqual(
      ["economics", "monthlyCapacity", "qualityProfiles", "routing", "seatLimit"].sort()
    );
    expect(Object.keys(result.policy.qualityProfiles).sort()).toEqual(
      ["economy", "premium", "standard"].sort()
    );
  });

  it("hydrates economics: currentSpendUsd sums month spend across ALL the account's workspaces; remainingBudgetUsd = max(0, budget - spend)", async () => {
    const account = makeAccount({ plan: "growth", policyOverrides: {} }); // budget 150
    const accountWorkspaceIds = ["ws-1", "ws-2", "ws-3"];
    const fetchAccount = vi.fn(async () => account);
    const fetchWorkspaceIds = vi.fn(async () => accountWorkspaceIds);
    const fetchMonthSpendUsd = vi.fn(async () => 200); // over budget — exercises the clamp too

    const result = await resolvePolicyForWorkspace("ws-2", {
      fetchAccount: fetchAccount as never,
      fetchWorkspaceIds: fetchWorkspaceIds as never,
      fetchMonthSpendUsd,
    });

    expect(fetchWorkspaceIds).toHaveBeenCalledWith(expect.anything(), "acct-1");
    expect(fetchMonthSpendUsd).toHaveBeenCalledWith(accountWorkspaceIds);
    expect(result.policy.economics.currentSpendUsd).toBe(200);
    expect(result.policy.economics.remainingBudgetUsd).toBe(0); // never negative
    expect(result.degraded).toBe(false);
  });

  it("hydrates economics: under-budget spend leaves the exact remainder", async () => {
    const account = makeAccount({ plan: "growth", policyOverrides: {} }); // budget 150
    const fetchAccount = vi.fn(async () => account);
    const fetchWorkspaceIds = vi.fn(async () => ["ws-1"]);
    const fetchMonthSpendUsd = vi.fn(async () => 42.5);

    const result = await resolvePolicyForWorkspace("ws-1", {
      fetchAccount: fetchAccount as never,
      fetchWorkspaceIds: fetchWorkspaceIds as never,
      fetchMonthSpendUsd,
    });

    expect(result.policy.economics.currentSpendUsd).toBe(42.5);
    expect(result.policy.economics.remainingBudgetUsd).toBe(107.5);
  });

  it("economics hydration computes against the OVERRIDDEN budget, not the plan's base budget", async () => {
    const account = makeAccount({
      plan: "enterprise", // base monthlyAiBudgetUsd is 150
      policyOverrides: { economics: { monthlyAiBudgetUsd: 500 } } as never,
    });
    const fetchAccount = vi.fn(async () => account);
    const fetchWorkspaceIds = vi.fn(async () => ["ws-1"]);
    const fetchMonthSpendUsd = vi.fn(async () => 300);

    const result = await resolvePolicyForWorkspace("ws-1", {
      fetchAccount: fetchAccount as never,
      fetchWorkspaceIds: fetchWorkspaceIds as never,
      fetchMonthSpendUsd,
    });

    expect(result.policy.economics.monthlyAiBudgetUsd).toBe(500);
    expect(result.policy.economics.currentSpendUsd).toBe(300);
    // 500 (overridden) - 300, NOT 150 (base) - 300 (which would clamp to 0).
    expect(result.policy.economics.remainingBudgetUsd).toBe(200);
  });

  it("billing-account fetch throws: resolves the trial policy (never throws), billingAccountId null, degraded: true, one loud console.error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchAccount = vi.fn(async () => {
      throw new Error("connection reset");
    });
    const fetchWorkspaceIds = vi.fn(async () => {
      throw new Error("must not be called when the account fetch itself failed");
    });
    const fetchMonthSpendUsd = vi.fn(async () => {
      throw new Error("must not be called when the account fetch itself failed");
    });

    const result = await resolvePolicyForWorkspace("ws-1", {
      fetchAccount: fetchAccount as never,
      fetchWorkspaceIds: fetchWorkspaceIds as never,
      fetchMonthSpendUsd,
    });

    expect(result.billingAccountId).toBeNull();
    expect(result.degraded).toBe(true);
    expect(result.policy).toEqual(PLAN_POLICIES.trial);
    expect(fetchWorkspaceIds).not.toHaveBeenCalled();
    expect(fetchMonthSpendUsd).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("resolvePolicyForWorkspace"),
      expect.anything()
    );

    errorSpy.mockRestore();
  });

  it("workspace-id fan-out throws: also degrades gracefully (fail-open covers the whole hydration step, not only the spend query)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const account = makeAccount({ plan: "growth" });
    const fetchAccount = vi.fn(async () => account);
    const fetchWorkspaceIds = vi.fn(async () => {
      throw new Error("connection reset");
    });
    const fetchMonthSpendUsd = vi.fn(async () => 0);

    const result = await resolvePolicyForWorkspace("ws-1", {
      fetchAccount: fetchAccount as never,
      fetchWorkspaceIds: fetchWorkspaceIds as never,
      fetchMonthSpendUsd,
    });

    expect(result.degraded).toBe(true);
    expect(result.policy.economics.currentSpendUsd).toBe(0);
    expect(result.policy.economics.remainingBudgetUsd).toBe(
      PLAN_POLICIES.growth.economics.monthlyAiBudgetUsd
    );
    expect(fetchMonthSpendUsd).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);

    errorSpy.mockRestore();
  });

  it("spend fetch throws: degrades gracefully instead of throwing, zero spend, full remaining budget, one loud console.error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const account = makeAccount({ plan: "growth", policyOverrides: {} }); // budget 150
    const fetchAccount = vi.fn(async () => account);
    const fetchWorkspaceIds = vi.fn(async () => ["ws-1"]);
    const fetchMonthSpendUsd = vi.fn(async () => {
      throw new Error("ClickHouse connection refused");
    });

    const result = await resolvePolicyForWorkspace("ws-1", {
      fetchAccount: fetchAccount as never,
      fetchWorkspaceIds: fetchWorkspaceIds as never,
      fetchMonthSpendUsd,
    });

    expect(result.degraded).toBe(true);
    expect(result.policy.economics.currentSpendUsd).toBe(0);
    expect(result.policy.economics.remainingBudgetUsd).toBe(
      PLAN_POLICIES.growth.economics.monthlyAiBudgetUsd
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("resolvePolicyForWorkspace"),
      expect.anything()
    );

    errorSpy.mockRestore();
  });

  it("never rejects even when the spend fetch throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const account = makeAccount({ plan: "growth" });
    const fetchAccount = vi.fn(async () => account);
    const fetchWorkspaceIds = vi.fn(async () => ["ws-1"]);
    const fetchMonthSpendUsd = vi.fn(async () => {
      throw new Error("boom");
    });

    // `.resolves` itself fails the assertion if the promise rejects instead
    // — the strongest, least ambiguous way to prove this never throws.
    await expect(
      resolvePolicyForWorkspace("ws-1", {
        fetchAccount: fetchAccount as never,
        fetchWorkspaceIds: fetchWorkspaceIds as never,
        fetchMonthSpendUsd,
      })
    ).resolves.toMatchObject({ degraded: true });

    vi.restoreAllMocks();
  });

  it("aliasing: the resolved policy (and every nested object) is never the same reference as the PLAN_POLICIES entry — account found", async () => {
    const account = makeAccount({ plan: "growth", policyOverrides: {} });
    const fetchAccount = vi.fn(async () => account);
    const fetchWorkspaceIds = vi.fn(async () => ["ws-1"]);
    const fetchMonthSpendUsd = vi.fn(async () => 0);

    const result = await resolvePolicyForWorkspace("ws-1", {
      fetchAccount: fetchAccount as never,
      fetchWorkspaceIds: fetchWorkspaceIds as never,
      fetchMonthSpendUsd,
    });

    expect(result.policy).not.toBe(PLAN_POLICIES.growth);
    expect(result.policy.qualityProfiles).not.toBe(PLAN_POLICIES.growth.qualityProfiles);
    expect(result.policy.routing).not.toBe(PLAN_POLICIES.growth.routing);
    expect(result.policy.economics).not.toBe(PLAN_POLICIES.growth.economics);
  });

  it("aliasing: the trial policy returned for a null account is never the same reference as PLAN_POLICIES.trial", async () => {
    const fetchAccount = vi.fn(async () => null);
    const fetchWorkspaceIds = vi.fn(async () => []);
    const fetchMonthSpendUsd = vi.fn(async () => 0);

    const result = await resolvePolicyForWorkspace("ws-orphan", {
      fetchAccount: fetchAccount as never,
      fetchWorkspaceIds: fetchWorkspaceIds as never,
      fetchMonthSpendUsd,
    });

    expect(result.policy).not.toBe(PLAN_POLICIES.trial);
    expect(result.policy.qualityProfiles).not.toBe(PLAN_POLICIES.trial.qualityProfiles);
    expect(result.policy.routing).not.toBe(PLAN_POLICIES.trial.routing);
    expect(result.policy.economics).not.toBe(PLAN_POLICIES.trial.economics);
  });

  it("resolving twice yields independent objects (value-equal, reference-distinct)", async () => {
    const account = makeAccount({ plan: "growth", policyOverrides: {} });
    const fetchAccount = vi.fn(async () => account);
    const fetchWorkspaceIds = vi.fn(async () => ["ws-1"]);
    const fetchMonthSpendUsd = vi.fn(async () => 10);
    const deps = {
      fetchAccount: fetchAccount as never,
      fetchWorkspaceIds: fetchWorkspaceIds as never,
      fetchMonthSpendUsd,
    };

    const first = await resolvePolicyForWorkspace("ws-1", deps);
    const second = await resolvePolicyForWorkspace("ws-1", deps);

    expect(first.policy).toEqual(second.policy);
    expect(first.policy).not.toBe(second.policy);
    expect(first.policy.qualityProfiles).not.toBe(second.policy.qualityProfiles);
    expect(first.policy.routing).not.toBe(second.policy.routing);
    expect(first.policy.economics).not.toBe(second.policy.economics);
  });
});
