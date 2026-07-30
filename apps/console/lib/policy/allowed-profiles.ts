/**
 * The routing gate's profile-entitlement math (subscription platform spec,
 * `docs/superpowers/specs/2026-07-29-subscription-platform-design.md` §4
 * "Task-level, policy-aware routing", §6 gate 4 "Routing gate — the profile
 * entitlement filter of §4, inside model selection").
 *
 * Pure, synchronous, side-effect-free — the second half of subscription
 * platform slice 2's entitlement filter. The FIRST half
 * (`lib/alignment/candidates.ts`'s `slugsForProfiles`) mechanically filters a
 * slug list against an already-computed `ReadonlySet<QualityProfile>`; THIS
 * function computes that set from an `AiPolicy` and a classified profile.
 * Lives in `lib/policy/` (not `lib/alignment/`) because `AiPolicy` is a
 * billing/policy concept — the import-direction rule
 * (`lib/alignment/import-direction.test.ts`) forbids routing code from ever
 * importing `lib/policy/`, so this computation cannot live on the routing
 * side of that boundary; `lib/alignment/quality-profile.ts`'s own module doc
 * explains why the shared `QualityProfile` type lives on the routing (leaf)
 * side instead, making this one-directional import legal.
 *
 * SEMANTICS (order economy < standard < premium throughout; each pinned as
 * its own test in `allowed-profiles.test.ts`):
 *
 *   1. `effective` starts as `classified` (stage 1's own answer to "what
 *      level of reasoning would produce the best engineering outcome" —
 *      `classify-task.ts`). It is pulled DOWN to `policy.routing.defaultProfile`
 *      ONLY when `classified` ranks strictly above that default AND the
 *      policy disallows escalation (`!policy.routing.allowEscalation`) — i.e.
 *      escalation gates the classifier exceeding the plan's default, exactly
 *      as spec §4 constraint 2 describes ("Escalation above
 *      `routing.defaultProfile` happens only when classification says
 *      premium reasoning materially improves the outcome
 *      (`routing.allowEscalation`)"). Escalation NEVER adds profiles ABOVE
 *      `classified` — there is no branch below that raises `effective` past
 *      what stage 1 itself asked for; when `classified` is already at or
 *      below the default, this step is a no-op regardless of
 *      `allowEscalation`.
 *   2. `base` = `{effective}`, plus every profile ranked BELOW `effective`
 *      when `policy.routing.allowDowngrade` is true (margin protection: a
 *      cheaper entitled candidate is allowed to win inside the ranking
 *      engine — spec §4 constraint 2's `allowDowngrade` half).
 *      `allowDowngrade: false` collapses `base` to the single-member
 *      `{effective}`.
 *   3. The final result is `base` narrowed to what the plan is actually
 *      entitled to (`policy.qualityProfiles`) — routing math can put a
 *      profile into `base` that the plan was never actually SOLD (e.g.
 *      `starter`'s `premium: false`), and this step is what strips it back
 *      out. Can legitimately be the empty set for a self-contradictory
 *      policy (e.g. `routing.defaultProfile` pointing at a profile
 *      `qualityProfiles` doesn't entitle) — `eligibility.ts`'s
 *      `eligibleModelsForTaskType` is the layer that fails open on that, not
 *      this function.
 *
 * This function never reads `policy.economics` (the budget-aware ranking
 * PRESSURE spec §4 constraint 3 describes is the ranking engine's own job,
 * inside whatever pool this filter hands it — see `candidates.ts`'s
 * `slugsForProfiles` and the #1338 selector) and never reads anything
 * billing-plan-specific beyond the flat `AiPolicy` it's handed — consistent
 * with `resolvePolicyForWorkspace`'s own module doc: "nothing below the
 * resolver may ever branch on a `BillingPlan` value."
 */

import type { AiPolicy } from "./plan-policies";
import type { QualityProfile } from "../alignment/quality-profile";

/** Ascending reasoning-level order — the ONLY place this module's "below"/"above" comparisons are defined. */
const PROFILE_RANK_ASCENDING: readonly QualityProfile[] = ["economy", "standard", "premium"];

function rankOf(profile: QualityProfile): number {
  return PROFILE_RANK_ASCENDING.indexOf(profile);
}

/**
 * The set of {@link QualityProfile}s a task classified as `classified` may
 * actually run at, under `policy` — see this module's own doc comment for
 * the full three-step semantics. Pure: same inputs always produce an equal
 * (freshly constructed) `Set`, never a shared or mutated reference, and
 * `policy` itself is only ever read, never written to.
 */
export function allowedProfilesFor(
  policy: AiPolicy,
  classified: QualityProfile
): ReadonlySet<QualityProfile> {
  const classifiedRank = rankOf(classified);
  const defaultRank = rankOf(policy.routing.defaultProfile);

  const effective: QualityProfile =
    classifiedRank > defaultRank && !policy.routing.allowEscalation
      ? policy.routing.defaultProfile
      : classified;
  const effectiveRank = rankOf(effective);

  const base = new Set<QualityProfile>([effective]);
  if (policy.routing.allowDowngrade) {
    for (const profile of PROFILE_RANK_ASCENDING) {
      if (rankOf(profile) < effectiveRank) base.add(profile);
    }
  }

  const allowed = new Set<QualityProfile>();
  for (const profile of base) {
    if (policy.qualityProfiles[profile]) allowed.add(profile);
  }
  return allowed;
}
