/**
 * The ARC-LEVEL kill-switch for subscription-platform enforcement (spec
 * `docs/superpowers/specs/2026-07-29-subscription-platform-design.md` §6
 * "Enforcement seams": "Four gates, one resolver (§3), all behind a single
 * kill-switch (`BILLING_SUBSCRIPTIONS_ENFORCED`, default OFF until launch)").
 *
 * Distinct from, and orthogonal to, `lib/alignment/feature-flags.ts`'s
 * `isModelSelectionLearningEnabled` (the #1338 model-selection LEARNING
 * loop's own flag): that flag decides whether `selectExecuteModel` runs at
 * all. THIS flag decides whether, given that it does run, its eligible pool
 * is additionally narrowed by billing-plan entitlement
 * (`lib/policy/allowed-profiles.ts`'s `allowedProfilesFor`). One flag being
 * off has no bearing on the other — no cross-wiring between the two, same
 * as `resolveModelSelectionForBrief`'s existing `isModelSelectionLearningEnabled`
 * gate stays completely unmodified by this one layering on top of it.
 *
 * OFF (falsy/unset) by default everywhere, until this exact env var is set
 * to the literal string `"1"` — every other value (`"true"`, `"yes"`, `""`,
 * unset) stays disabled; same "explicit opt-in, no fuzzy truthiness" posture
 * `channel-dispatch.ts`'s other kill-switches use, deliberately stricter than
 * `lib/alignment/feature-flags.ts`'s own `isTruthyFlag` (which also accepts
 * `"true"`) — this flag guards real customer-facing entitlement enforcement,
 * not an internal learning loop, so it stays maximally unambiguous.
 *
 * `resolvePolicyForWorkspace` (`resolve-policy.ts`) itself has no notion of
 * this flag; it always resolves a real policy regardless. This flag governs
 * a single question, at the single admission call site (`alignment-brief.ts`'s
 * `resolveModelSelectionForBrief`): whether that resolved policy gets
 * ENFORCED as a filter on model selection, or ignored entirely.
 */

/**
 * The subset of `process.env` this module reads — injectable for tests so
 * they never need to mutate the real `process.env` (mirrors
 * `lib/alignment/feature-flags.ts`'s own `FeatureFlagEnv` idiom, including
 * the index signature required for `NodeJS.ProcessEnv` to satisfy this type
 * as the default parameter value below).
 */
export interface SubscriptionFeatureFlagEnv {
  BILLING_SUBSCRIPTIONS_ENFORCED?: string | undefined;
  [key: string]: string | undefined;
}

/**
 * Whether subscription-platform enforcement (seat/capacity/invite/routing
 * gates) is live. `env` defaults to the real `process.env`; pass a fake
 * object in tests.
 */
export function subscriptionsEnforced(env: SubscriptionFeatureFlagEnv = process.env): boolean {
  return env.BILLING_SUBSCRIPTIONS_ENFORCED === "1";
}
