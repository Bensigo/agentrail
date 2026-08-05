import { and, eq, gte, lt } from "drizzle-orm";
import { db } from "../db.js";
import { reviewEvents } from "../schema/review_events.js";
import type {
  HumanReviewSource,
  NewReviewEvent,
  ReviewActorType,
  ReviewEventRow,
  ReviewEventType,
} from "../schema/review_events.js";
import {
  computeReviewMetrics,
  compareReviewMetrics,
  type ReviewMetricEvent,
  type ReviewMetricWindow,
  type ReviewMetricComparison,
  type ReviewMetrics,
} from "../review_metrics.js";

export type RecordReviewEventInput = Omit<NewReviewEvent, "id" | "createdAt"> & {
  deliveryId: string;
  eventType: ReviewEventType;
  occurredAt: Date;
  actorType?: ReviewActorType | null;
  humanReviewSource?: HumanReviewSource | null;
};

export type RecordReviewEventResult = {
  recorded: boolean;
  eventId: string | null;
};

function validateReviewEvent(input: RecordReviewEventInput): void {
  if (!input.deliveryId.trim()) throw new Error("review event deliveryId is required");
  if (input.prNumber <= 0 || !Number.isInteger(input.prNumber)) {
    throw new Error("review event prNumber must be a positive integer");
  }
  if (input.eventType === "human_review_time") {
    if (
      typeof input.humanReviewMinutes !== "number" ||
      !Number.isFinite(input.humanReviewMinutes) ||
      input.humanReviewMinutes < 0
    ) {
      throw new Error("human review time requires non-negative explicit minutes");
    }
    if (input.humanReviewSource !== "human_input" && input.humanReviewSource !== "timer") {
      throw new Error("human review time requires an explicit human_input or timer source");
    }
  } else if (input.humanReviewMinutes != null || input.humanReviewSource != null) {
    throw new Error("human review minutes are only valid on human_review_time events");
  }

  if (input.eventType === "reverted" || input.eventType === "post_merge_rework") {
    if (input.actorType !== "human") {
      throw new Error("rework and revert evidence requires an explicit human actor");
    }
    if (!input.headSha || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(input.headSha)) {
      throw new Error("rework and revert evidence requires an exact head SHA");
    }
  }
}

/**
 * Insert one review-evidence event. The `(workspace_id, delivery_id)` unique
 * key is the concurrency-safe replay guard; this is intentionally not a
 * check-then-insert read.
 */
export async function recordReviewEvent(
  input: RecordReviewEventInput
): Promise<RecordReviewEventResult> {
  validateReviewEvent(input);
  const [row] = await db
    .insert(reviewEvents)
    .values(input)
    .onConflictDoNothing({
      target: [reviewEvents.workspaceId, reviewEvents.deliveryId],
    })
    .returning({ id: reviewEvents.id });
  return { recorded: !!row, eventId: row?.id ?? null };
}

/**
 * Record explicit human review time. `minutes` must come from a human input
 * or a stopped timer; this seam never accepts opened/merged timestamps and
 * never computes a duration from them.
 */
export async function recordHumanReviewTime(input: {
  workspaceId: string;
  repo: string;
  prNumber: number;
  taskFamily?: string | null;
  deliveryId: string;
  occurredAt: Date;
  minutes: number;
  source: HumanReviewSource;
}): Promise<RecordReviewEventResult> {
  return recordReviewEvent({
    workspaceId: input.workspaceId,
    repo: input.repo,
    prNumber: input.prNumber,
    taskFamily: input.taskFamily ?? null,
    deliveryId: input.deliveryId,
    eventType: "human_review_time",
    occurredAt: input.occurredAt,
    humanReviewMinutes: input.minutes,
    humanReviewSource: input.source,
  });
}

export type ReviewMetricsQuery = {
  workspaceId: string;
  /** Dated windows are required for pilot evidence; no timeless dashboard claim. */
  from: Date;
  to: Date;
  observedUntil?: Date;
};

export type ReviewMetricsReportQuery = ReviewMetricsQuery & {
  taskFamily: string;
  baselineFrom?: Date;
  baselineTo?: Date;
  baselineObservedUntil?: Date;
};

export type ReviewMetricsReport = {
  workspaceId: string;
  taskFamily: string;
  current: ReviewMetrics;
  baseline: ReviewMetrics | null;
  comparison: ReviewMetricComparison | null;
};

/** Read the event ledger and compute the same pure metric definitions for all task families. */
export async function getReviewMetrics(
  input: ReviewMetricsQuery
): Promise<ReviewMetrics[]> {
  if (input.to <= input.from) {
    throw new Error("review metrics require a non-empty date range");
  }
  const conditions = [eq(reviewEvents.workspaceId, input.workspaceId)];
  conditions.push(gte(reviewEvents.occurredAt, input.from));
  conditions.push(lt(reviewEvents.occurredAt, input.to));

  const rows = await db
    .select()
    .from(reviewEvents)
    .where(and(...conditions));
  const window: ReviewMetricWindow = {
    from: input.from,
    to: input.to,
    observedUntil: input.observedUntil,
  };
  return computeReviewMetrics(rows as ReviewMetricEvent[], window);
}

/**
 * Read a dated task-family report and, when requested, compare it against a
 * second dated baseline window. This is the report seam the console route can
 * expose without inventing its own metric math.
 */
export async function getReviewMetricsReport(
  input: ReviewMetricsReportQuery
): Promise<ReviewMetricsReport | null> {
  if (input.to <= input.from) {
    throw new Error("review metrics require a non-empty date range");
  }
  if ((input.baselineFrom && !input.baselineTo) || (!input.baselineFrom && input.baselineTo)) {
    throw new Error("baseline review metrics require both baselineFrom and baselineTo");
  }
  if (input.baselineFrom && input.baselineTo && input.baselineTo <= input.baselineFrom) {
    throw new Error("baseline review metrics require a non-empty date range");
  }

  const [currentMetrics, baselineMetrics] = await Promise.all([
    getReviewMetrics({
      workspaceId: input.workspaceId,
      from: input.from,
      to: input.to,
      observedUntil: input.observedUntil,
    }),
    input.baselineFrom && input.baselineTo
      ? getReviewMetrics({
          workspaceId: input.workspaceId,
          from: input.baselineFrom,
          to: input.baselineTo,
          observedUntil: input.baselineObservedUntil ?? input.baselineTo,
        })
      : Promise.resolve([] as ReviewMetrics[]),
  ]);

  const current = currentMetrics.find((metric) => metric.taskFamily === input.taskFamily) ?? null;
  if (!current) return null;

  const baseline = baselineMetrics.find((metric) => metric.taskFamily === input.taskFamily) ?? null;
  return {
    workspaceId: input.workspaceId,
    taskFamily: input.taskFamily,
    current,
    baseline,
    comparison: baseline ? compareReviewMetrics(current, baseline) : null,
  };
}

/**
 * Read the append-only review-event history for one PR, oldest first. The
 * route uses this only after a run's PR URL has been parsed successfully.
 */
export async function listReviewEventsForPr(input: {
  workspaceId: string;
  repo: string;
  prNumber: number;
}): Promise<ReviewEventRow[]> {
  return db
    .select()
    .from(reviewEvents)
    .where(
      and(
        eq(reviewEvents.workspaceId, input.workspaceId),
        eq(reviewEvents.repo, input.repo),
        eq(reviewEvents.prNumber, input.prNumber)
      )
    )
    .orderBy(reviewEvents.occurredAt, reviewEvents.createdAt);
}

/**
 * Read events attributable to one exact published PR head. Events without a
 * head are intentionally excluded: their relationship to a specific run is
 * unknown and must never be guessed from the PR number alone.
 */
export async function listReviewEventsForPrHead(input: {
  workspaceId: string;
  repo: string;
  prNumber: number;
  headSha: string;
}): Promise<ReviewEventRow[]> {
  return db
    .select()
    .from(reviewEvents)
    .where(
      and(
        eq(reviewEvents.workspaceId, input.workspaceId),
        eq(reviewEvents.repo, input.repo),
        eq(reviewEvents.prNumber, input.prNumber),
        eq(reviewEvents.headSha, input.headSha)
      )
    )
    .orderBy(reviewEvents.occurredAt, reviewEvents.createdAt);
}

export type {
  ReviewEventRow,
  ReviewEventType,
  ReviewMetricEvent,
  ReviewMetrics,
  ReviewMetricComparison,
};
