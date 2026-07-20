/**
 * Eligibility layer for the model-selection learning loop (#1338 PR②).
 *
 * This is layer 1 of 3 (eligibility -> seeds -> data-driven selection, see
 * `seeds.ts` / `selector.ts`): a CURATED, human-authored allow/deny list of
 * which EXECUTE models are even allowed to be picked for a given
 * {@link TaskType}. This is DOMAIN KNOWLEDGE, NOT LEARNED — nothing here is
 * derived from `run_outcomes` data. The data-driven selector in `selector.ts`
 * (best-from-data comparison AND ε-exploration) only ever considers models
 * that pass through this layer first; a model excluded here can never be
 * auto-picked for that task type, no matter how good its (hypothetical)
 * run_outcomes stats might look.
 *
 * HARD OWNER RULE (non-negotiable, per the #1338 PR② brief): `ui` tasks
 * NEVER get `anthropic/claude-haiku-4.5` — it is underpowered for building
 * UI. This is encoded as a plain, reviewable data entry in
 * {@link EXCLUDED_MODELS} below, not as special-cased logic — adding a
 * future exclusion (a different model, a different task type) is a
 * one-line addition to that table, never a restructuring of this module.
 *
 * `validator.ts`'s `validateOverride` deliberately does NOT read this
 * module for its allowlist scoping — see that file's own doc-comment: an
 * explicit user override is allowed even for a model this layer would deny
 * to the AUTO picker (eligibility constrains automatic selection, not an
 * informed human's explicit choice).
 */

import type { TaskType } from "./classifier";
import { MODEL_CATALOG } from "./catalog";

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
 * The full universe of EXECUTE-model slugs eligibility draws from: every
 * distinct slug appearing anywhere in {@link MODEL_CATALOG}'s four seats
 * today (sonnet-5, opus-4.8, haiku-4.5) — the same closed keyspace
 * `validator.ts`'s pre-#1338 allowlist already used. A future PR (#1339 and
 * beyond) may widen this to the full OpenRouter catalog; v1 deliberately
 * keeps the eligible universe == the catalog's own known-priced seats so
 * eligibility, pricing, and override validation all stay in the same
 * keyspace.
 */
function candidateModelSlugs(): string[] {
  return Array.from(new Set(Object.values(MODEL_CATALOG).map((seat) => seat.slug)));
}

/**
 * The eligible EXECUTE-model slugs for a task type: every candidate model
 * MINUS that type's curated exclusions above. Order is not significant —
 * callers (the selector) that need a stable order should sort/dedupe
 * themselves.
 */
export function eligibleModelsForTaskType(taskType: TaskType): string[] {
  const excluded = new Set(EXCLUDED_MODELS[taskType]);
  return candidateModelSlugs().filter((slug) => !excluded.has(slug));
}

/** Whether `slug` is eligible for the AUTO picker on this task type. */
export function isModelEligibleForTaskType(slug: string, taskType: TaskType): boolean {
  return !EXCLUDED_MODELS[taskType].includes(slug);
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
 * Today this equals `candidateModelSlugs()` in full (haiku is excluded only
 * from `ui`, and remains eligible for the other three task types, so the
 * union still covers all three catalog slugs) — but this is computed as a
 * REAL union, not hardcoded, so a future exclusion that removes a model
 * from EVERY task type correctly shrinks this set too.
 */
export function allEligibleModelSlugs(): string[] {
  const union = new Set<string>();
  for (const taskType of ALL_TASK_TYPES) {
    for (const slug of eligibleModelsForTaskType(taskType)) union.add(slug);
  }
  return Array.from(union);
}
