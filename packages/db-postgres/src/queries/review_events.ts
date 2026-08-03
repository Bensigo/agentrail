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
  type ReviewMetricEvent,
  type ReviewMetricWindow,
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

export type { ReviewEventRow, ReviewEventType, ReviewMetricEvent, ReviewMetrics };
