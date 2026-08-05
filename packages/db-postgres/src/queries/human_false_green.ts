import { and, eq, gte, inArray, lt, lte } from "drizzle-orm";
import { db } from "../db.js";
import { runs } from "../schema/runs.js";
import { runOutcomes } from "../schema/run_outcomes.js";
import { reviewEvents } from "../schema/review_events.js";
import {
  computeProductionHumanFalseGreen,
  type HumanFalseGreenWindow,
  type ProductionHumanFalseGreenReport,
  type SuccessfulRunForHumanFalseGreen,
} from "../human_false_green.js";

export type ProductionHumanFalseGreenQuery = {
  workspaceId: string;
} & HumanFalseGreenWindow;

/**
 * Read the durable run/result and GitHub review ledgers for the production
 * human false-green report. The metric math stays pure in `human_false_green`;
 * this seam only scopes both sources to one workspace and dated observation.
 */
export async function getProductionHumanFalseGreen(
  input: ProductionHumanFalseGreenQuery
): Promise<ProductionHumanFalseGreenReport> {
  if (input.to <= input.from) {
    throw new Error("human false-green metrics require a non-empty date range");
  }
  if (input.observedUntil < input.to) {
    throw new Error("human false-green observedUntil must not precede the report end");
  }
  const [runRows, eventRows] = await Promise.all([
    db
      .select({
        id: runs.id,
        workspaceId: runs.workspaceId,
        finishedAt: runs.finishedAt,
        prRepo: runs.prRepo,
        prNumber: runs.prNumber,
        prHeadSha: runs.prHeadSha,
      })
      .from(runs)
      .innerJoin(
        runOutcomes,
        and(
          eq(runOutcomes.queueEntryId, runs.queueEntryId),
          eq(runOutcomes.workspaceId, runs.workspaceId)
        )
      )
      .where(
        and(
          eq(runs.workspaceId, input.workspaceId),
          eq(runOutcomes.outcome, "success"),
          gte(runs.finishedAt, input.from),
          lt(runs.finishedAt, input.to)
        )
      ),
    db
      .select()
      .from(reviewEvents)
      .where(
        and(
          eq(reviewEvents.workspaceId, input.workspaceId),
          inArray(reviewEvents.eventType, [
            "review_submitted",
            "reverted",
            "post_merge_rework",
          ]),
          lte(reviewEvents.occurredAt, input.observedUntil)
        )
      ),
  ]);

  return computeProductionHumanFalseGreen(
    runRows as SuccessfulRunForHumanFalseGreen[],
    eventRows,
    input
  );
}
