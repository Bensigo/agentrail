/**
 * The permanent quality-profile abstraction (subscription platform spec,
 * `docs/superpowers/specs/2026-07-29-subscription-platform-design.md` §4):
 * stable while the OpenRouter model catalog underneath it churns. Economy /
 * standard / premium describe REASONING LEVEL, never a specific model or
 * provider — `candidates.ts`'s model-selection pools partition by this
 * value, and `lib/policy/plan-policies.ts`'s `AiPolicy.qualityProfiles` /
 * `AiPolicy.routing.defaultProfile` entitle a billing plan to it.
 *
 * Deliberately a LEAF module under `lib/alignment/`, not under `lib/policy/`
 * where it is consumed alongside billing concepts: both the policy layer
 * (billing -> entitlement) and the candidate registry (routing -> model
 * pools) need this type, but the routing code must never import from
 * `lib/policy/` (import-direction rule — slice-2 plan Task 9's guard test
 * asserts no file under `lib/alignment/` imports from `lib/policy/`).
 * Putting the shared type in `lib/alignment/` instead of `lib/policy/` is
 * what makes that one-directional import graph possible at all.
 */
export type QualityProfile = "economy" | "standard" | "premium";
