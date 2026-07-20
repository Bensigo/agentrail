/**
 * Seed layer for the model-selection learning loop (#1338 PR②).
 *
 * Layer 2 of 3 (eligibility -> SEEDS -> data-driven selection, see
 * `eligibility.ts` / `selector.ts`): the selector's starting point before
 * any `run_outcomes` data exists for a given (workspace, task_type) pair.
 *
 * Deliberately reuses {@link MODEL_CATALOG} (`catalog.ts`, #1275) rather
 * than duplicating its values in a second table: the seed for a task type
 * IS today's static pick — diverse (ui/general -> sonnet-5, refactor ->
 * opus-4.8, mechanical -> haiku-4.5), already priced and drift-guarded by
 * `catalog.test.ts`, and — not incidentally — exactly what keeps the
 * flag-OFF path byte-identical to the pre-#1338 static behavior (see
 * `estimate.ts` and `selector.test.ts`'s pinned regression).
 */

import { MODEL_CATALOG } from "./catalog";
import type { ModelSeat } from "./catalog";
import type { TaskType } from "./classifier";
import { ALL_TASK_TYPES, isModelEligibleForTaskType } from "./eligibility";

/**
 * Self-check, run once at module load: every seed must be a member of its
 * OWN task type's eligible set (`eligibility.ts`). This asserts the
 * invariant eagerly, at import time, so a future edit to either
 * `MODEL_CATALOG` or `EXCLUDED_MODELS` that accidentally breaks it (e.g.
 * someone points `ui`'s seed at haiku, or excludes a model that's also a
 * seed) fails loudly the moment the module is loaded — never silently at
 * selection time, deep inside a live request.
 */
for (const taskType of ALL_TASK_TYPES) {
  const seat = MODEL_CATALOG[taskType];
  if (!isModelEligibleForTaskType(seat.slug, taskType)) {
    throw new Error(
      `[seeds] configuration error: seed model "${seat.slug}" for task type "${taskType}" is not ` +
        `in its own eligible set. Fix catalog.ts's MODEL_CATALOG or eligibility.ts's EXCLUDED_MODELS ` +
        `so every seed stays eligible for its own task type.`
    );
  }
}

/** The default EXECUTE model for a task type, before any learning applies. Always a member of that task type's eligible set (see the self-check above). */
export function seedModel(taskType: TaskType): ModelSeat {
  return MODEL_CATALOG[taskType];
}
