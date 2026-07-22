import { unstable_cache } from "next/cache";
import { countRunOutcomes } from "@agentrail/db-postgres";
import type { RunOutcomeCounts } from "@agentrail/db-postgres";

/**
 * The landing page's live numbers (landing v2,
 * docs/superpowers/plans/2026-07-22-landing-v2.md §Task 9).
 *
 * Two honest inputs, summed:
 * 1. DOGFOOD_BASELINE — the documented pre-prod dogfood record
 *    (docs/benchmarks/results/dogfood-track-record.md): full autonomous runs
 *    on AgentRail's own backlog. Static history; it predates the prod DB, so
 *    adding live counts on top never double-counts.
 * 2. Live platform terminal outcomes from `run_outcomes` (one row per
 *    terminal queue transition, prod-wired 2026-07-20).
 *
 * Vocabulary mapping keeps the baseline's own semantics: shipped = the
 * verify gate passed (`success`); didn't land = everything terminal that
 * didn't (`human_review` + `failed`) — counted, not hidden.
 *
 * If the DB is unreachable (build time, dev without Postgres, an outage)
 * the numbers fall back to the baseline alone and say so via `source` —
 * they never invent and never render zeros.
 */
export const DOGFOOD_BASELINE = {
  workedOn: 53,
  shipped: 33,
  didntLand: 20,
} as const;

export interface LandingStats {
  workedOn: number;
  shipped: number;
  didntLand: number;
  source: "live+baseline" | "baseline-only";
}

/** Pure math + fallback, with the count function injectable for tests. */
export async function computeLandingStats(
  count: () => Promise<RunOutcomeCounts> = countRunOutcomes
): Promise<LandingStats> {
  try {
    const live = await count();
    return {
      workedOn: DOGFOOD_BASELINE.workedOn + live.success + live.humanReview + live.failed,
      shipped: DOGFOOD_BASELINE.shipped + live.success,
      didntLand: DOGFOOD_BASELINE.didntLand + live.humanReview + live.failed,
      source: "live+baseline",
    };
  } catch {
    return { ...DOGFOOD_BASELINE, source: "baseline-only" };
  }
}

/** The cached read the page and /api/v1/stats share — refreshed hourly. */
export const getLandingStats = unstable_cache(
  () => computeLandingStats(),
  ["landing-stats"],
  { revalidate: 3600 }
);
