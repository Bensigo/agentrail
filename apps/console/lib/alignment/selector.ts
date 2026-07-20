/**
 * The SELECTOR for the model-selection learning loop (#1338 PR②) — layer 3
 * of 3 (eligibility -> seeds -> DATA-DRIVEN SELECTION + EXPLORATION, see
 * `eligibility.ts` / `seeds.ts`). Reads PR①'s fuel
 * (`getModelOutcomeStats` from `@agentrail/db-postgres`, per-`(task_type,
 * execute_model)` run counts/success rates/costs) to pick which EXECUTE
 * model to suggest for a task, within the eligible set ONLY.
 *
 * This module is the ONLY place in the alignment lib that touches the
 * database — `catalog.ts`/`classifier.ts`/`estimate.ts` all stay pure/sync
 * by design (see `estimate.ts`'s own module doc). `selectExecuteModel` is
 * async for exactly that reason; callers (`alignment-brief.ts`) await it
 * BEFORE calling the still-synchronous `estimateBrief`, feeding the
 * resolved model in as a plain value (see that file's own doc-comment).
 *
 * ALGORITHM (per task type + workspace):
 *   1. Gather `run_outcomes` stats for (workspaceId, taskType), keep ONLY
 *      rows whose `execute_model` is in this task type's ELIGIBLE set
 *      (`eligibility.ts`) — an ineligible model's data (e.g. a historical
 *      manual override) is never considered, no matter how good it looks.
 *   2. "Qualified" = eligible rows with `runCount >= MIN_RUNS`. Sample-aware
 *      by construction: NEVER switch off a model with fewer than MIN_RUNS
 *      of data, however good its rate looks so far (no thrash).
 *   3. No qualified rows at all -> the seed (`seeds.ts`), reason 'seed'.
 *   4. Otherwise, find the qualified row with the best success rate
 *      (ties broken by lower cost-per-success; a null cost — zero
 *      successes — never wins a tiebreak against a real number). If its
 *      rate is STRICTLY BETTER than the seed's own measured rate (0 if the
 *      seed has no data at all) -> that model, reason 'best-from-data'.
 *      Otherwise -> the seed still wins, reason 'seed' (this naturally
 *      covers "the seed itself is the qualified best": comparing its own
 *      rate against itself is never a strict improvement, so it stays
 *      labeled 'seed' rather than manufacturing a redundant data claim).
 *   5. ε-exploration (default 10%, `DEFAULT_EXPLORATION_RATE`): applied AS
 *      A MODIFIER over the exploit decision above, independent of whether
 *      any data was qualified — exploration is what lets an
 *      under-sampled ELIGIBLE alternative accumulate its first runs at
 *      all (if it only fired once something else already had MIN_RUNS,
 *      nothing would ever reach MIN_RUNS in the first place). The
 *      exploration TARGET is drawn only from this task type's eligible
 *      set, excluding whatever the exploit step just picked, preferring
 *      whichever eligible alternative has the LEAST recorded data (a
 *      classic "explore the least-tried arm" bandit rule) — reason
 *      'exploring'. If there is no other eligible model to explore (a
 *      task type with only one eligible slug), exploration is a no-op:
 *      the exploit decision stands unchanged.
 *
 * INVIOLABLE: because the exploration pool is drawn from
 * `eligibleModelsForTaskType`, an excluded model (haiku for `ui`, per the
 * HARD OWNER RULE) can NEVER be returned for that task type — not by the
 * exploit path (the seed/best-from-data comparison only ever considers
 * eligible rows), and not by exploration either (`selector.test.ts` pins
 * this even when exploration is forced on every call).
 */

import { getModelOutcomeStats } from "@agentrail/db-postgres";
import type { ModelOutcomeStatsRow } from "@agentrail/db-postgres";
import type { ModelSeat } from "./catalog";
import { MODEL_SEATS } from "./candidates";
import type { TaskType } from "./classifier";
import { eligibleModelsForTaskType } from "./eligibility";
import { seedModel } from "./seeds";

/** Minimum recorded runs before an eligible model's data can outrank the seed — sample-aware, no thrash. */
export const DEFAULT_MIN_RUNS = 5;

/** Default probability of returning a different (less-sampled) eligible model instead of the exploit pick, to keep learning. */
export const DEFAULT_EXPLORATION_RATE = 0.1;

/** Why the selector picked what it picked — rendered as the brief's one-line "why" (see `describeModelSelection`). */
export type SelectionReason = "seed" | "best-from-data" | "exploring";

export interface ModelSelection {
  model: ModelSeat;
  reason: SelectionReason;
  /**
   * The picked model's own recorded run count for this (workspace,
   * taskType), when it has any. Present for 'best-from-data' (always >=
   * MIN_RUNS there), present for 'seed' when the seed has SOME data below
   * MIN_RUNS, and present for 'exploring' when the explored alternative has
   * some (necessarily below-the-leader) prior data. Absent (never `0` —
   * see `run_outcomes.ts`'s own GROUP BY note: a group with zero rows never
   * appears as a row) when there is truly no recorded run for that model
   * yet.
   */
  runCount?: number;
}

export interface SelectExecuteModelOptions {
  /** Injectable for deterministic tests — defaults to `Math.random`. May be called more than once per selection (the ε-exploration check, and again to break a tie among equally-least-sampled exploration candidates). */
  random?: () => number;
  /** Injectable for tests — defaults to {@link DEFAULT_MIN_RUNS}. */
  minRuns?: number;
  /** Injectable for tests — defaults to {@link DEFAULT_EXPLORATION_RATE}. */
  explorationRate?: number;
  /** Injectable for tests — defaults to the real `getModelOutcomeStats` (`@agentrail/db-postgres`), so unit tests never need a live Postgres connection (mirrors that package's own "every query spec mocks `db`" convention). */
  fetchStats?: (opts: {
    workspaceId: string;
    taskType: string;
  }) => Promise<ModelOutcomeStatsRow[]>;
}

/** `candidates.ts`'s `MODEL_SEATS` slug -> seat lookup (#1338 PR③ — every eligible slug is, by construction (`eligibility.ts`'s `candidateModelSlugs`, `candidates.ts`'s `CANDIDATES`), one of that registry's own keys). */
function seatForSlug(slug: string): ModelSeat {
  const seat = MODEL_SEATS[slug];
  if (!seat) {
    // Unreachable in practice: eligible slugs are always drawn from
    // candidates.ts's CANDIDATES, and every CANDIDATES entry has a matching
    // MODEL_SEATS entry (candidates.test.ts pins this). A loud throw here
    // (rather than a silent fallback) surfaces a future candidates.ts drift
    // immediately instead of shipping a priceless/nameless seat.
    throw new Error(
      `[selector] no ModelSeat found for eligible slug "${slug}" — eligible slugs must always be ` +
        `drawn from candidates.ts's MODEL_SEATS registry (see eligibility.ts's candidateModelSlugs).`
    );
  }
  return seat;
}

function runCountForSlug(stats: readonly ModelOutcomeStatsRow[], slug: string): number {
  return stats.find((row) => row.executeModel === slug)?.runCount ?? 0;
}

/**
 * The "exploit" decision: seed vs. the qualified eligible model with the
 * best success rate (cost-per-success tiebreak) — steps 1-4 of the module
 * doc's algorithm. Never touches exploration.
 */
function decideExploit(
  taskType: TaskType,
  eligibleSlugs: readonly string[],
  stats: readonly ModelOutcomeStatsRow[],
  minRuns: number
): ModelSelection {
  const seed = seedModel(taskType);
  const eligibleSet = new Set(eligibleSlugs);
  const eligibleStats = stats.filter(
    (row) => row.executeModel !== null && eligibleSet.has(row.executeModel)
  );
  const qualified = eligibleStats.filter((row) => row.runCount >= minRuns);

  const seedRow = eligibleStats.find((row) => row.executeModel === seed.slug);
  const seedSelection: ModelSelection = {
    model: seed,
    reason: "seed",
    ...(seedRow ? { runCount: seedRow.runCount } : {}),
  };

  if (qualified.length === 0) {
    // No data / all < MIN_RUNS -> the seed, unconditionally.
    return seedSelection;
  }

  const seedSuccessRate = seedRow ? seedRow.successRate : 0;

  let best: ModelOutcomeStatsRow | null = null;
  for (const row of qualified) {
    if (!best || row.successRate > best.successRate) {
      best = row;
      continue;
    }
    if (row.successRate < best.successRate) continue;
    // Tie on success rate: lower cost-per-success wins. `null` (zero
    // successes recorded yet) never outranks a real number.
    if (best.costPerSuccess === null && row.costPerSuccess !== null) {
      best = row;
    } else if (
      row.costPerSuccess !== null &&
      best.costPerSuccess !== null &&
      row.costPerSuccess < best.costPerSuccess
    ) {
      best = row;
    }
  }

  if (best && best.successRate > seedSuccessRate) {
    return {
      model: seatForSlug(best.executeModel as string),
      reason: "best-from-data",
      runCount: best.runCount,
    };
  }

  // The qualified best doesn't beat the seed's own rate (including the
  // case where the qualified best IS the seed's own row: comparing its
  // rate to itself is never a strict improvement) -> stay on the seed.
  return seedSelection;
}

/**
 * Pick an exploration target: an ELIGIBLE model other than `excludeSlug`
 * (the exploit pick), preferring whichever has the LEAST recorded data —
 * classic "explore the least-tried arm." `null` when there is no other
 * eligible model to explore (a task type whose eligible set has only one
 * member).
 */
function pickExplorationTarget(
  eligibleSlugs: readonly string[],
  excludeSlug: string,
  stats: readonly ModelOutcomeStatsRow[],
  random: () => number
): string | null {
  const candidates = eligibleSlugs.filter((slug) => slug !== excludeSlug);
  if (candidates.length === 0) return null;

  const counts = candidates.map((slug) => runCountForSlug(stats, slug));
  const minCount = Math.min(...counts);
  const leastSampled = candidates.filter((_, i) => counts[i] === minCount);

  const idx = Math.min(Math.floor(random() * leastSampled.length), leastSampled.length - 1);
  return leastSampled[Math.max(idx, 0)] ?? null;
}

/**
 * Pick the EXECUTE model for `taskType` in `workspaceId`. See the module
 * doc for the full algorithm. Considers ELIGIBLE models only, at every
 * step — the exploit comparison, its data source, and the exploration
 * pool are all scoped to `eligibleModelsForTaskType(taskType)`, so an
 * excluded model (haiku for `ui`) can never come back from this function
 * for that task type.
 */
export async function selectExecuteModel(
  taskType: TaskType,
  workspaceId: string,
  opts: SelectExecuteModelOptions = {}
): Promise<ModelSelection> {
  const random = opts.random ?? Math.random;
  const minRuns = opts.minRuns ?? DEFAULT_MIN_RUNS;
  const explorationRate = opts.explorationRate ?? DEFAULT_EXPLORATION_RATE;
  const fetchStats = opts.fetchStats ?? getModelOutcomeStats;

  const eligibleSlugs = eligibleModelsForTaskType(taskType);
  const stats = await fetchStats({ workspaceId, taskType });

  const exploit = decideExploit(taskType, eligibleSlugs, stats, minRuns);

  if (random() < explorationRate) {
    const exploreSlug = pickExplorationTarget(eligibleSlugs, exploit.model.slug, stats, random);
    if (exploreSlug) {
      const runCount = runCountForSlug(stats, exploreSlug);
      return {
        model: seatForSlug(exploreSlug),
        reason: "exploring",
        ...(runCount > 0 ? { runCount } : {}),
      };
    }
  }

  return exploit;
}

/**
 * Human-readable one-line "why" behind a {@link ModelSelection}, for the
 * alignment brief (both the Telegram render and the console card — see
 * `approval-message.ts`'s `renderAlignmentBrief` and `approvals-helpers.ts`'s
 * `summarizeAlignmentBrief`, both of which just display this precomputed
 * string verbatim; neither has access to this module or live stats).
 */
export function describeModelSelection(
  taskType: TaskType,
  selection: ModelSelection,
  minRuns: number = DEFAULT_MIN_RUNS
): string {
  const name = selection.model.displayName;
  switch (selection.reason) {
    case "best-from-data":
      return (
        `${name} — best success rate for ${taskType}` +
        (selection.runCount !== undefined ? ` (${selection.runCount} runs)` : "")
      );
    case "exploring":
      return `Trying ${name} to compare`;
    case "seed":
      return selection.runCount !== undefined
        ? `${name} — starting default (${selection.runCount} runs so far, below the ${minRuns}-run threshold)`
        : `${name} — starting default, no data yet`;
  }
}
