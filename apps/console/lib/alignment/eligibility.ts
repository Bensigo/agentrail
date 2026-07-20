/**
 * Eligibility layer for the model-selection learning loop (#1338 PR②, pool
 * widened PR③).
 *
 * This is layer 1 of 3 (candidates -> eligibility -> seeds -> data-driven
 * selection, see `candidates.ts` / `seeds.ts` / `selector.ts`): a CURATED,
 * human-authored allow/deny list of which EXECUTE models are even allowed to
 * be picked for a given {@link TaskType}. This is DOMAIN KNOWLEDGE, NOT
 * LEARNED — nothing here is derived from `run_outcomes` data. The
 * data-driven selector in `selector.ts` (best-from-data comparison AND
 * ε-exploration) only ever considers models that pass through this layer
 * first; a model excluded here can never be auto-picked for that task type,
 * no matter how good its (hypothetical) run_outcomes stats might look.
 *
 * PR③ widened the raw pool this layer filters (`candidateModelSlugs` now
 * reads `candidates.ts`'s per-task {@link CANDIDATES}, seed-first, instead of
 * `MODEL_CATALOG`'s fixed 3-slug universe) — this file's OWN job is
 * unchanged: apply {@link EXCLUDED_MODELS} on top of whatever pool it's
 * given.
 *
 * HARD OWNER RULE (non-negotiable, per the #1338 PR② brief, reaffirmed PR③):
 * `ui` tasks NEVER get `anthropic/claude-haiku-4.5` — it is underpowered for
 * building UI. This is encoded as a plain, reviewable data entry in
 * {@link EXCLUDED_MODELS} below, not as special-cased logic — adding a
 * future exclusion (a different model, a different task type) is a
 * one-line addition to that table, never a restructuring of this module.
 * PR③'s widened `ui` pool (`candidates.ts`) doesn't even OFFER haiku as a
 * candidate anymore, but this exclusion stays as a defense-in-depth backstop
 * regardless — a future pool edit that accidentally re-added haiku to `ui`
 * would still be caught here.
 *
 * `validator.ts`'s `validateOverride` deliberately does NOT read this
 * module for its allowlist scoping — see that file's own doc-comment: an
 * explicit user override is allowed even for a model this layer would deny
 * to the AUTO picker (eligibility constrains automatic selection, not an
 * informed human's explicit choice).
 */

import type { TaskType } from "./classifier";
import { CANDIDATES } from "./candidates";

const HAIKU_SLUG = "anthropic/claude-haiku-4.5";

/**
 * Per-task-type exclusions — the ONLY place this module denies a model.
 * Every {@link TaskType} key is required (TypeScript enforces it via
 * `Record<TaskType, ...>`), so a future new task type forces a decision
 * here too, at compile time, exactly like `MODEL_CATALOG`'s own shape.
 *
 * To add a new exclusion: append the slug to that task type's array. That
 * is the ENTIRE change — {@link eligibleModelsForTaskType},
 * {@link isModelEligibleForTaskType}, the selector's exploration pool, and
 * `validator.ts`'s widened allowlist all recompute from this table
 * automatically; nothing else needs to change.
 */
const EXCLUDED_MODELS: Record<TaskType, readonly string[]> = {
  // HARD OWNER RULE: haiku-4.5 is underpowered for building UI — never
  // eligible for the auto picker on a `ui`-classified task.
  ui: [HAIKU_SLUG],
  refactor: [],
  mechanical: [],
  general: [],
};

/**
 * Every {@link TaskType} value, derived from {@link EXCLUDED_MODELS}'s own
 * keys (which `Record<TaskType, ...>` forces to be exhaustive) rather than
 * hand-maintained as a second parallel list — a future new TaskType can't
 * silently fall out of sync between the two.
 */
export const ALL_TASK_TYPES: readonly TaskType[] = Object.keys(
  EXCLUDED_MODELS
) as TaskType[];

/**
 * The raw candidate pool eligibility draws from, FOR THIS TASK TYPE, before
 * {@link EXCLUDED_MODELS} is applied: `candidates.ts`'s per-task
 * {@link CANDIDATES}, seed-first (#1338 PR③). Before PR③ this returned a
 * single flat, deduped list of `MODEL_CATALOG`'s 3 slugs for EVERY task type
 * — the same fixed universe regardless of which task was asked. Reworked to
 * be per-task so `refactor`/`mechanical`/`general` each get their own
 * genuinely different, mostly-non-Claude pool instead of sharing one.
 */
function candidateModelSlugs(taskType: TaskType): readonly string[] {
  return CANDIDATES[taskType];
}

/**
 * The eligible EXECUTE-model slugs for a task type: that type's candidate
 * pool ({@link candidateModelSlugs}) MINUS its curated exclusions above.
 * Order follows the pool's own seed-first order — callers that need a
 * different order should sort themselves.
 */
export function eligibleModelsForTaskType(taskType: TaskType): string[] {
  const excluded = new Set(EXCLUDED_MODELS[taskType]);
  return candidateModelSlugs(taskType).filter((slug) => !excluded.has(slug));
}

/**
 * Whether `slug` is eligible for the AUTO picker on this task type: a member
 * of {@link eligibleModelsForTaskType}'s own result, i.e. IN this task
 * type's candidate pool AND not excluded. Defined directly in terms of
 * {@link eligibleModelsForTaskType} (rather than a separate
 * exclusion-only check) so the two can never drift apart — PR③'s widened,
 * per-task candidate pools mean "not excluded" alone is no longer a
 * sufficient definition of "eligible" (a slug can simply be absent from a
 * task's pool without being on its exclusion list at all, e.g. haiku for
 * `refactor`/`general` today).
 */
export function isModelEligibleForTaskType(slug: string, taskType: TaskType): boolean {
  return eligibleModelsForTaskType(taskType).includes(slug);
}

/**
 * The union of every task type's eligible set — every model this system
 * will auto-pick for AT LEAST ONE task type. `validator.ts` uses this (not
 * a single task type's own eligible set) to scope a user's explicit
 * override: the override surface is "a model this system knows how to run
 * at all," not "a model eligible for the specific task this override
 * happens to apply to" — see that module's own doc-comment for why a
 * user's explicit pick is allowed even where the AUTO picker would refuse.
 *
 * Computed as a REAL union over {@link candidateModelSlugs}'s widened,
 * per-task pools (#1338 PR③) — not hardcoded — so a future exclusion or pool
 * edit that removes a model from EVERY task type correctly shrinks this set
 * too, and a newly-added candidate model correctly grows it.
 */
export function allEligibleModelSlugs(): string[] {
  const union = new Set<string>();
  for (const taskType of ALL_TASK_TYPES) {
    for (const slug of eligibleModelsForTaskType(taskType)) union.add(slug);
  }
  return Array.from(union);
}
