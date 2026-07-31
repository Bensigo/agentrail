/**
 * Task classification -> quality profile (subscription platform spec,
 * `docs/superpowers/specs/2026-07-29-subscription-platform-design.md` §4
 * "Task-level, policy-aware routing"): stage 1 of three completely
 * independent stages, each answering its own question —
 *
 *   1. Task classification (THIS FILE)   -> what level of reasoning would
 *      produce the best engineering outcome?
 *   2. Policy entitlement (`plan-policies.ts` / `resolve-policy.ts`) -> is
 *      the company entitled to that level?
 *   3. Model selection (`lib/alignment/selector.ts`, #1338)          -> which
 *      available model best satisfies that profile?
 *
 * This module answers ONLY question 1. It has no notion of a billing plan,
 * seat entitlement, budget, or specific model/slug — those belong to the
 * other two stages. Keeping this module pure, static, and unaware of
 * `lib/policy/plan-policies.ts`'s own concepts is what makes the three-stage
 * separation real rather than nominal (spec §4's routing diagram: "Task ->
 * Planner -> Execution profile -> AI Policy (entitlement) -> Quality Profile
 * -> Candidate Pool -> Ranking Engine").
 *
 * v1 is a static map, not a learned or measured classification — the same
 * "keyword-heuristic-until-measured" posture as `lib/alignment/classifier.ts`'s
 * own {@link classifyTaskType}, which produces the {@link TaskType} this
 * module consumes as input (see that file's module doc: no measured
 * task-type signal exists anywhere in this codebase yet).
 *
 * `Record<TaskType, QualityProfile>` is exhaustive by construction: TypeScript
 * requires every {@link TaskType} member as a key, so a future addition to
 * `classifier.ts`'s `TaskType` union is a COMPILE error here, not a silent
 * runtime hole that would fall through to some default profile.
 *
 * BAND RATIONALE (owner-reviewable judgment call — the same table also goes
 * in this task's PR body for human review):
 *
 *   - `mechanical` -> economy. `classifier.ts`'s own doc-comment calls this
 *     type's keyword set (rename, bump, typo, config, changelog, formatting,
 *     dependency/version bump) a signal for "a small, bounded, low-risk
 *     change" — spec §4's economy band is defined by the same shape of work
 *     ("formatting, summaries, documentation, lightweight edits").
 *     Corroborated by two independent prior codepoints: `catalog.ts`'s
 *     pre-quality-profile `MODEL_CATALOG` (#1275) already seats `mechanical`
 *     at its CHEAPEST model, and `candidates.ts`'s seed for `mechanical`
 *     (`z-ai/glm-4.7`) is independently tagged `profile: "economy"` in Task 9.
 *
 *   - `refactor` -> premium. `classifier.ts` calls this type's keyword set
 *     (refactor, architecture, migrate, migration, redesign, extract,
 *     restructure, decouple, consolidate) a signal for "a harder,
 *     reasoning-heavy change" — nearly a direct match for spec §4's premium
 *     band ("architecture, distributed systems, large refactors, difficult
 *     debugging"). Corroborated by `MODEL_CATALOG` seating `refactor` at its
 *     STRONGEST reasoner, and by `candidates.ts`'s seed for `refactor`
 *     (`anthropic/claude-opus-4.8`), independently tagged `profile:
 *     "premium"` in Task 9.
 *
 *   - `ui` -> standard. Bounded, well-specified, routine frontend work
 *     (component/page/css/layout/form/button — see `classifier.ts`'s
 *     `UI_KEYWORDS`) — not the documentation-only end of the spectrum
 *     (economy) and not open-ended architecture reasoning (premium), so it
 *     lands in spec §4's standard band ("PR reviews, bug fixes, everyday
 *     engineering"). `eligibility.ts`'s HARD OWNER RULE (haiku-4.5, the
 *     cheapest execute model, is never eligible for `ui`) confirms this type
 *     needs more than bare-minimum reasoning even though it isn't
 *     architecture-class either. Corroborated by `MODEL_CATALOG` seating
 *     `ui` at a "frontend-strong" model (one tier above `mechanical`'s
 *     cheapest pick, distinct from `refactor`'s strongest), and by
 *     `candidates.ts`'s seed for `ui` (`moonshotai/kimi-k2.7-code`),
 *     independently tagged `profile: "standard"` in Task 9.
 *
 *   - `general` -> standard. The classifier's own honest, non-committal
 *     fallback for when no keyword matches at all (`classifier.ts`: "the
 *     safe direction to fail in"). `MODEL_CATALOG`'s module doc literally
 *     documents `general` as "same as ui (the safe, capable default)", and
 *     `candidates.ts`'s seed for `general` (`z-ai/glm-5.2`) is independently
 *     tagged `profile: "standard"` in Task 9. Unspecified, everyday
 *     engineering work is exactly spec §4's standard band.
 */

import type { TaskType } from "../alignment/classifier";
import type { QualityProfile } from "../alignment/quality-profile";

const TASK_TYPE_QUALITY_PROFILE: Record<TaskType, QualityProfile> = {
  mechanical: "economy",
  ui: "standard",
  general: "standard",
  refactor: "premium",
};

/**
 * Stage 1 of spec §4's three independent routing stages: what level of
 * reasoning would produce the best engineering outcome for this task type?
 * Pure and static — no policy entitlement, no budget, no model/slug; see
 * this file's module doc for the full band rationale and the corroborating
 * evidence for each assignment.
 */
export function classifyTaskProfile(taskType: TaskType): QualityProfile {
  return TASK_TYPE_QUALITY_PROFILE[taskType];
}
