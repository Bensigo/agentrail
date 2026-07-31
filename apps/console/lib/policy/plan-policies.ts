/**
 * The AI policy layer — the contract between billing and routing
 * (subscription platform spec,
 * `docs/superpowers/specs/2026-07-29-subscription-platform-design.md` §1
 * Principles, §3 "The AI policy object").
 *
 * Subscription plans define customer entitlements, never implementation
 * details: a plan never knows about OpenRouter, model names, or routing
 * algorithms. `AiPolicy` is what a plan resolves to, and it is the ONLY
 * thing that crosses from billing into routing — `resolvePolicyForWorkspace`
 * (`resolve-policy.ts`) is where billing disappears.
 * EVERYTHING downstream of that resolver — the task planner, the
 * entitlement filter, the #1338 ranking engine — receives an `AiPolicy` and
 * is completely unaware that "starter", "growth", "trial", or "enterprise"
 * exist. Nothing below the resolver may ever branch on a `BillingPlan`
 * value or import this module's `PLAN_POLICIES` map directly.
 *
 * `PLAN_POLICIES` is the plan -> policy mapping in code (the spec's "one
 * constants module" — same fresh-read-no-caching posture as the flag
 * columns in `packages/db-postgres/src/schema/workspaces.ts:82-84`; there is
 * no caching layer to invalidate because there is nothing here to cache).
 * Every plan is spelled out as its own full object literal (matching
 * `alignment/catalog.ts`'s `MODEL_CATALOG` convention) rather than built by
 * spreading one plan onto another — `trial` and `enterprise` share every
 * value with `growth` today, but a shared object reference (or a shallow
 * `{ ...GROWTH, seatLimit: 10 }`) would mean a future resolver that hydrates
 * `economics` in place (rather than returning a new object) could corrupt
 * more than one plan's constants at once. Full literals make each plan an
 * independent, reviewable value.
 *
 * Values are launch priors (spec §2/§8, Global Constraints of the slice-2
 * plan), calibrated monthly — not commitments to ourselves:
 *   - starter: 4 seats, 350 capacity/mo, economy+standard only (no premium),
 *     no escalation, $70/mo AI budget, $5 max per task.
 *   - growth: 10 seats, 1,000 capacity/mo, all three profiles, escalation
 *     allowed, $150/mo AI budget, $8 max per task.
 *   - trial: growth's values (14-day trial sells the best experience).
 *   - enterprise: growth's values as the base — `billing_accounts.policy_overrides`
 *     jsonb specializes it per account, but that merge happens INSIDE
 *     `resolvePolicyForWorkspace` (`resolve-policy.ts`), never here; this
 *     module supplies only the base.
 *
 * `economics.currentSpendUsd` and `economics.remainingBudgetUsd` are always
 * 0-and-full here — they are hydrated by the resolver from the period's cost
 * telemetry on every call (fail-open if that read is unavailable), never
 * cached or precomputed in these constants.
 */

import type { QualityProfile } from "../alignment/quality-profile";

export type BillingPlan = "trial" | "starter" | "growth" | "enterprise";

export type AiPolicy = {
  seatLimit: number;
  monthlyCapacity: number;
  qualityProfiles: { economy: boolean; standard: boolean; premium: boolean };
  routing: {
    defaultProfile: QualityProfile;
    allowEscalation: boolean;
    allowDowngrade: boolean;
  };
  economics: {
    monthlyAiBudgetUsd: number;
    /** Hydrated by `resolvePolicyForWorkspace`; always 0 in these constants. */
    currentSpendUsd: number;
    /** Hydrated by `resolvePolicyForWorkspace`; equals the budget in these constants. */
    remainingBudgetUsd: number;
    maxTaskCostUsd: number;
  };
};

/**
 * Recursively `Object.freeze`s every plain-object level of `value`. A
 * shallow `Object.freeze(PLAN_POLICIES)` only locks the top-level map
 * (`PLAN_POLICIES.starter = ...` would throw, but
 * `PLAN_POLICIES.starter.economics.currentSpendUsd = 1` would silently
 * succeed) — exactly the gap that would let a future resolver "hydrate
 * economics in place" the way the module doc-comment above warns against.
 * Deep-freezing turns that from a code-review convention into a runtime
 * guarantee: every assignment at every nesting level throws a `TypeError`
 * in strict mode (ES modules are always strict), so in-place mutation of
 * `PLAN_POLICIES` is now structurally impossible, not just discouraged.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

export const PLAN_POLICIES: Record<BillingPlan, AiPolicy> = deepFreeze({
  trial: {
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
  },
  starter: {
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
  },
  growth: {
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
  },
  enterprise: {
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
  },
});
