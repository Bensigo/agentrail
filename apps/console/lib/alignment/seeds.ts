/**
 * Seed layer for the model-selection learning loop (#1338 PR②, pool widened
 * PR③).
 *
 * Layer 2 of 3 (candidates -> eligibility -> SEEDS -> data-driven selection,
 * see `candidates.ts` / `eligibility.ts` / `selector.ts`): the selector's
 * starting point before any `run_outcomes` data exists for a given
 * (workspace, task_type) pair.
 *
 * PRE-PR③ this reused `MODEL_CATALOG` (`catalog.ts`, #1275) directly: the
 * seed for a task type WAS today's static, all-Claude pick. PR③ widened the
 * seed pool to a diverse, mostly-non-Claude spread (owner ruling: "Claude
 * tiers are baselines not defaults") — the seed for a task type is now
 * `candidates.ts`'s per-task {@link CANDIDATES} FIRST entry, resolved to a
 * {@link ModelSeat} via that module's {@link MODEL_SEATS} registry.
 * `MODEL_CATALOG` itself is UNCHANGED and untouched by this file: it remains
 * the flag-OFF static default `estimate.ts`/`alignment-brief.ts` fall back to
 * (see `catalog.ts`'s own module doc) — this seed is reached only from the
 * flag-gated `selector.ts` path, so widening it is invisible at runtime until
 * a workspace opts in (`feature-flags.ts`).
 */

import { CANDIDATES, MODEL_SEATS } from "./candidates";
import type { ModelSeat } from "./catalog";
import type { TaskType } from "./classifier";
import { ALL_TASK_TYPES, isModelEligibleForTaskType } from "./eligibility";

/** `CANDIDATES[taskType]`'s first entry — the seed slug, before it's resolved to a priced {@link ModelSeat}. */
function seedSlug(taskType: TaskType): string {
  return CANDIDATES[taskType][0];
}

/**
 * Self-check, run once at module load: every seed must be a member of its
 * OWN task type's eligible set (`eligibility.ts`). This asserts the
 * invariant eagerly, at import time, so a future edit to `candidates.ts`'s
 * `CANDIDATES`/`MODEL_SEATS` or `eligibility.ts`'s `EXCLUDED_MODELS` that
 * accidentally breaks it (e.g. someone points a task's seed at an excluded
 * or unlisted slug) fails loudly the moment the module is loaded — never
 * silently at selection time, deep inside a live request.
 */
for (const taskType of ALL_TASK_TYPES) {
  const slug = seedSlug(taskType);
  if (!isModelEligibleForTaskType(slug, taskType)) {
    throw new Error(
      `[seeds] configuration error: seed model "${slug}" for task type "${taskType}" is not ` +
        `in its own eligible set. Fix candidates.ts's CANDIDATES (the seed must be its task type's ` +
        `first entry) or eligibility.ts's EXCLUDED_MODELS so every seed stays eligible for its own task type.`
    );
  }
}

/**
 * The default EXECUTE model for a task type, before any learning applies.
 * Always a member of that task type's eligible set (see the self-check
 * above). Throws if `candidates.ts`'s `MODEL_SEATS` registry is missing an
 * entry for the seed slug — unreachable in practice (every `CANDIDATES`
 * entry has a matching `MODEL_SEATS` entry, pinned by
 * `candidates.test.ts`), but a loud failure here is safer than silently
 * returning `undefined` as a `ModelSeat`.
 */
export function seedModel(taskType: TaskType): ModelSeat {
  const slug = seedSlug(taskType);
  const seat = MODEL_SEATS[slug];
  if (!seat) {
    throw new Error(
      `[seeds] configuration error: seed slug "${slug}" for task type "${taskType}" has no matching ` +
        `entry in candidates.ts's MODEL_SEATS registry.`
    );
  }
  return seat;
}
