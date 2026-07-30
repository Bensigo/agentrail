import { describe, expect, it } from "vitest";
import { allowedProfilesFor } from "./allowed-profiles";
import { PLAN_POLICIES, type AiPolicy } from "./plan-policies";
import type { QualityProfile } from "../alignment/quality-profile";

const ALL_PROFILES: QualityProfile[] = ["economy", "standard", "premium"];

/**
 * Fixture builder — every field required on the real `AiPolicy`, so tests
 * only spell out what they're actually exercising. Mirrors
 * `resolve-policy.test.ts`'s own `makeAccount` idiom.
 */
function makePolicy(overrides: {
  qualityProfiles?: Partial<AiPolicy["qualityProfiles"]>;
  routing?: Partial<AiPolicy["routing"]>;
} = {}): AiPolicy {
  return {
    seatLimit: 10,
    monthlyCapacity: 1000,
    qualityProfiles: { economy: true, standard: true, premium: true, ...overrides.qualityProfiles },
    routing: {
      defaultProfile: "standard",
      allowEscalation: true,
      allowDowngrade: true,
      ...overrides.routing,
    },
    economics: {
      monthlyAiBudgetUsd: 150,
      currentSpendUsd: 0,
      remainingBudgetUsd: 150,
      maxTaskCostUsd: 8,
    },
  };
}

// ---------------------------------------------------------------------------
// Pinned examples from the subscription-platform slice 2, Task 11 plan —
// each one verbatim.
// ---------------------------------------------------------------------------
describe("allowedProfilesFor: pinned examples (slice 2 plan)", () => {
  it("starter (premium:false, allowEscalation:false) + premium-classified -> {economy, standard}", () => {
    const result = allowedProfilesFor(PLAN_POLICIES.starter, "premium");
    expect(result).toEqual(new Set<QualityProfile>(["economy", "standard"]));
  });

  it("growth + premium-classified -> {economy, standard, premium}", () => {
    const result = allowedProfilesFor(PLAN_POLICIES.growth, "premium");
    expect(result).toEqual(new Set<QualityProfile>(["economy", "standard", "premium"]));
  });

  it("growth + economy-classified -> {economy} (no premium despite allowEscalation)", () => {
    const result = allowedProfilesFor(PLAN_POLICIES.growth, "economy");
    expect(result).toEqual(new Set<QualityProfile>(["economy"]));
  });

  it("starter + standard-classified -> {economy, standard}", () => {
    const result = allowedProfilesFor(PLAN_POLICIES.starter, "standard");
    expect(result).toEqual(new Set<QualityProfile>(["economy", "standard"]));
  });

  it("any policy with allowDowngrade:false + standard-classified -> {standard} ∩ entitled", () => {
    const fullyEntitled = makePolicy({ routing: { allowDowngrade: false } });
    expect(allowedProfilesFor(fullyEntitled, "standard")).toEqual(new Set<QualityProfile>(["standard"]));

    const notEntitledForStandard = makePolicy({
      qualityProfiles: { standard: false },
      routing: { allowDowngrade: false },
    });
    expect(allowedProfilesFor(notEntitledForStandard, "standard")).toEqual(new Set<QualityProfile>());
  });
});

// ---------------------------------------------------------------------------
// Escalation gate: only pulls `effective` DOWN when classified > default AND
// escalation is disallowed. Never raises it, in either direction.
// ---------------------------------------------------------------------------
describe("allowedProfilesFor: escalation gate never raises effective above classified", () => {
  it("classified below default, escalation OFF: effective stays classified (not raised to default)", () => {
    const policy = makePolicy({ routing: { defaultProfile: "premium", allowEscalation: false } });
    const result = allowedProfilesFor(policy, "economy");
    // effective = economy (classified), never premium (default) -- base = {economy} only.
    expect(result).toEqual(new Set<QualityProfile>(["economy"]));
  });

  it("classified equals default, escalation OFF: no clamping (ranks are equal, not classified > default)", () => {
    const policy = makePolicy({ routing: { defaultProfile: "standard", allowEscalation: false } });
    const result = allowedProfilesFor(policy, "standard");
    expect(result).toEqual(new Set<QualityProfile>(["economy", "standard"]));
  });

  it("classified above default, escalation ON: effective raises to classified", () => {
    const policy = makePolicy({ routing: { defaultProfile: "economy", allowEscalation: true } });
    const result = allowedProfilesFor(policy, "premium");
    expect(result).toEqual(new Set<QualityProfile>(["economy", "standard", "premium"]));
  });

  it("classified above default, escalation OFF: effective clamps down to default exactly", () => {
    const policy = makePolicy({ routing: { defaultProfile: "economy", allowEscalation: false } });
    const result = allowedProfilesFor(policy, "premium");
    // effective = economy (the default); base = {economy} (nothing below economy).
    expect(result).toEqual(new Set<QualityProfile>(["economy"]));
  });

  it("never returns a profile ranked above `classified`, across every policy/classified combination", () => {
    const rank: Record<QualityProfile, number> = { economy: 0, standard: 1, premium: 2 };
    const policies = [
      makePolicy({ routing: { defaultProfile: "economy", allowEscalation: false, allowDowngrade: true } }),
      makePolicy({ routing: { defaultProfile: "standard", allowEscalation: false, allowDowngrade: false } }),
      makePolicy({ routing: { defaultProfile: "premium", allowEscalation: true, allowDowngrade: true } }),
      PLAN_POLICIES.starter,
      PLAN_POLICIES.growth,
    ];
    for (const policy of policies) {
      for (const classified of ALL_PROFILES) {
        const result = allowedProfilesFor(policy, classified);
        for (const profile of result) {
          expect(
            rank[profile],
            `${JSON.stringify(policy.routing)} classified=${classified} produced ${profile}, ranked above classified`
          ).toBeLessThanOrEqual(rank[classified]);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Downgrade gate: adds every profile BELOW effective only when allowed.
// ---------------------------------------------------------------------------
describe("allowedProfilesFor: downgrade gate", () => {
  it("allowDowngrade:false + premium-classified + fully entitled -> {premium} only, no economy/standard added", () => {
    const policy = makePolicy({ routing: { allowDowngrade: false, allowEscalation: true } });
    const result = allowedProfilesFor(policy, "premium");
    expect(result).toEqual(new Set<QualityProfile>(["premium"]));
  });

  it("allowDowngrade:true + premium-classified + fully entitled -> {economy, standard, premium}", () => {
    const policy = makePolicy({ routing: { allowDowngrade: true, allowEscalation: true } });
    const result = allowedProfilesFor(policy, "premium");
    expect(result).toEqual(new Set<QualityProfile>(["economy", "standard", "premium"]));
  });

  it("classified is already the lowest profile (economy): downgrade is a no-op regardless of allowDowngrade", () => {
    const downgradeOn = makePolicy({ routing: { allowDowngrade: true } });
    const downgradeOff = makePolicy({ routing: { allowDowngrade: false } });
    expect(allowedProfilesFor(downgradeOn, "economy")).toEqual(new Set<QualityProfile>(["economy"]));
    expect(allowedProfilesFor(downgradeOff, "economy")).toEqual(new Set<QualityProfile>(["economy"]));
  });
});

// ---------------------------------------------------------------------------
// Entitlement is the final narrowing step -- routing math can put a profile
// into `base` that the plan was never actually SOLD.
// ---------------------------------------------------------------------------
describe("allowedProfilesFor: entitlement narrows even what routing math would otherwise allow", () => {
  it("a profile permitted by routing but not entitled (qualityProfiles) is stripped from the result", () => {
    // Self-contradictory-looking but syntactically valid policy: routing's
    // own default is "premium" (and classified matches it, no downgrade),
    // yet the plan doesn't actually sell premium -- e.g. a policy_overrides
    // misconfiguration. The final result must still respect entitlement.
    const policy = makePolicy({
      qualityProfiles: { premium: false },
      routing: { defaultProfile: "premium", allowEscalation: true, allowDowngrade: false },
    });
    const result = allowedProfilesFor(policy, "premium");
    expect(result).toEqual(new Set<QualityProfile>());
  });

  it("partial entitlement: only the entitled subset of an otherwise-allowed base survives", () => {
    const policy = makePolicy({
      qualityProfiles: { economy: false, standard: true, premium: true },
      routing: { defaultProfile: "standard", allowEscalation: true, allowDowngrade: true },
    });
    const result = allowedProfilesFor(policy, "premium");
    // base = {economy, standard, premium}; economy is not entitled -> dropped.
    expect(result).toEqual(new Set<QualityProfile>(["standard", "premium"]));
  });
});

// ---------------------------------------------------------------------------
// Systematic coverage over the 4 REAL PLAN_POLICIES plans -- every plan
// defaults to "standard" with downgrade allowed (plan-policies.test.ts's own
// pin), so `economy` (always entitled) is always reachable no matter the
// classified profile.
// ---------------------------------------------------------------------------
describe("allowedProfilesFor: every real plan x every classified profile always includes economy", () => {
  const PLANS = ["trial", "starter", "growth", "enterprise"] as const;

  for (const plan of PLANS) {
    for (const classified of ALL_PROFILES) {
      it(`${plan} classified=${classified}`, () => {
        const result = allowedProfilesFor(PLAN_POLICIES[plan], classified);
        expect(result.has("economy")).toBe(true);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Purity.
// ---------------------------------------------------------------------------
describe("allowedProfilesFor: purity", () => {
  it("same inputs produce an equal but freshly-constructed Set each call (never a shared/frozen reference)", () => {
    const first = allowedProfilesFor(PLAN_POLICIES.growth, "standard");
    const second = allowedProfilesFor(PLAN_POLICIES.growth, "standard");
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it("never mutates the policy argument", () => {
    const policy = makePolicy();
    const snapshot = JSON.parse(JSON.stringify(policy));
    allowedProfilesFor(policy, "premium");
    expect(policy).toEqual(snapshot);
  });
});
