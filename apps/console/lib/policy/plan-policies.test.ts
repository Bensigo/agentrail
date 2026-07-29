import { describe, expect, it } from "vitest";
import { PLAN_POLICIES, type AiPolicy, type BillingPlan } from "./plan-policies";

const ALL_PLANS: BillingPlan[] = ["trial", "starter", "growth", "enterprise"];

// Launch priors (spec §2/§8, Global Constraints of the slice-2 plan) — the
// exact values this module must reproduce verbatim. Growth's own values are
// duplicated into GROWTH_LIKE rather than referenced from PLAN_POLICIES.growth,
// so this test doesn't just check the module against itself.
const STARTER: AiPolicy = {
  seatLimit: 4,
  monthlyCapacity: 350,
  qualityProfiles: { economy: true, standard: true, premium: false },
  routing: { defaultProfile: "standard", allowEscalation: false, allowDowngrade: true },
  economics: {
    monthlyAiBudgetUsd: 70,
    currentSpendUsd: 0,
    remainingBudgetUsd: 70,
    maxTaskCostUsd: 5,
  },
};

const GROWTH_LIKE: AiPolicy = {
  seatLimit: 10,
  monthlyCapacity: 1000,
  qualityProfiles: { economy: true, standard: true, premium: true },
  routing: { defaultProfile: "standard", allowEscalation: true, allowDowngrade: true },
  economics: {
    monthlyAiBudgetUsd: 150,
    currentSpendUsd: 0,
    remainingBudgetUsd: 150,
    maxTaskCostUsd: 8,
  },
};

describe("PLAN_POLICIES", () => {
  it("covers exactly the four billing plans", () => {
    expect(Object.keys(PLAN_POLICIES).sort()).toEqual(
      ["enterprise", "growth", "starter", "trial"]
    );
  });

  it("starter matches the launch-prior policy exactly", () => {
    expect(PLAN_POLICIES.starter).toEqual(STARTER);
  });

  it("growth matches the launch-prior policy exactly", () => {
    expect(PLAN_POLICIES.growth).toEqual(GROWTH_LIKE);
  });

  it("trial equals growth's values field-by-field, as an independent object (not the same reference)", () => {
    expect(PLAN_POLICIES.trial).toEqual(GROWTH_LIKE);
    expect(PLAN_POLICIES.trial).toEqual(PLAN_POLICIES.growth);
    expect(PLAN_POLICIES.trial).not.toBe(PLAN_POLICIES.growth);
  });

  it("enterprise uses growth's values as its base, as an independent object (not the same reference)", () => {
    // policy_overrides jsonb specializes this per-account inside the resolver
    // (Task 8) — out of scope here; this module only supplies the base.
    expect(PLAN_POLICIES.enterprise).toEqual(GROWTH_LIKE);
    expect(PLAN_POLICIES.enterprise).not.toBe(PLAN_POLICIES.growth);
  });

  it("premium quality is entitled everywhere except starter", () => {
    for (const plan of ALL_PLANS) {
      expect(PLAN_POLICIES[plan].qualityProfiles.premium).toBe(plan !== "starter");
    }
  });

  it("economy and standard are entitled on every plan", () => {
    for (const plan of ALL_PLANS) {
      expect(PLAN_POLICIES[plan].qualityProfiles.economy).toBe(true);
      expect(PLAN_POLICIES[plan].qualityProfiles.standard).toBe(true);
    }
  });

  it("every plan defaults routing to standard with downgrade allowed", () => {
    for (const plan of ALL_PLANS) {
      expect(PLAN_POLICIES[plan].routing.defaultProfile).toBe("standard");
      expect(PLAN_POLICIES[plan].routing.allowDowngrade).toBe(true);
    }
  });

  it("constants ship unhydrated economics: zero current spend, full remaining budget", () => {
    for (const plan of ALL_PLANS) {
      const { economics } = PLAN_POLICIES[plan];
      expect(economics.currentSpendUsd).toBe(0);
      expect(economics.remainingBudgetUsd).toBe(economics.monthlyAiBudgetUsd);
    }
  });

  it("is deep-frozen: mutating any level (top, plan, or nested) throws instead of silently succeeding", () => {
    expect(() => {
      (PLAN_POLICIES as Record<string, unknown>).starter = "clobbered";
    }).toThrow(TypeError);
    expect(() => {
      (PLAN_POLICIES.starter as { seatLimit: number }).seatLimit = 999;
    }).toThrow(TypeError);
    expect(() => {
      (PLAN_POLICIES.starter.qualityProfiles as { premium: boolean }).premium = true;
    }).toThrow(TypeError);
    expect(() => {
      (PLAN_POLICIES.starter.routing as { allowEscalation: boolean }).allowEscalation = true;
    }).toThrow(TypeError);
    expect(() => {
      // The exact field a resolver hydrating economics IN PLACE would
      // write to — this is the specific mutation the freeze exists to rule
      // out structurally.
      (PLAN_POLICIES.starter.economics as { currentSpendUsd: number }).currentSpendUsd = 999;
    }).toThrow(TypeError);
  });
});
