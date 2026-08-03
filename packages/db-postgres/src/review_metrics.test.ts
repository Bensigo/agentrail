import { describe, expect, it } from "vitest";
import { computeReviewMetrics, type ReviewMetricEvent } from "./review_metrics.js";

const workspaceId = "ws-1";
const openedAt = new Date("2026-08-01T09:00:00Z");

function event(
  prNumber: number,
  deliveryId: string,
  eventType: ReviewMetricEvent["eventType"],
  occurredAt: string,
  extra: Partial<ReviewMetricEvent> = {}
): ReviewMetricEvent {
  return {
    workspaceId,
    repo: "ada/widgets",
    prNumber,
    taskFamily: "dependency-upgrade",
    deliveryId,
    eventType,
    occurredAt: new Date(occurredAt),
    headSha: null,
    reviewState: null,
    actorType: null,
    additions: null,
    deletions: null,
    changedFiles: null,
    humanReviewMinutes: null,
    humanReviewSource: null,
    ...extra,
  };
}

describe("computeReviewMetrics", () => {
  it("deduplicates a replayed delivery before counting review cycles", () => {
    const opened = event(1, "delivery-opened", "opened", openedAt.toISOString());
    const review = event(1, "delivery-review", "review_submitted", "2026-08-01T09:20:00Z");

    const [metrics] = computeReviewMetrics(
      [opened, review, { ...review }],
      { observedUntil: new Date("2026-08-02T00:00:00Z") }
    );

    expect(metrics?.sampleSize).toBe(1);
    expect(metrics?.averageReviewCycles).toEqual({ value: 1, knownSampleSize: 1 });
    expect(metrics?.medianTimeToFirstReviewSeconds.value).toBe(1200);
  });

  it("keeps missing lifecycle evidence null instead of fabricating zeros", () => {
    const [metrics] = computeReviewMetrics(
      [event(2, "delivery-opened", "opened", openedAt.toISOString())],
      { observedUntil: new Date("2026-08-02T00:00:00Z") }
    );

    expect(metrics?.sampleSize).toBe(1);
    expect(metrics?.mergeRate.value).toBeNull();
    expect(metrics?.mergeRate.knownSampleSize).toBe(0);
    expect(metrics?.medianTimeToFirstReviewSeconds.value).toBeNull();
    expect(metrics?.humanReviewMinutes.value).toBeNull();
    expect(metrics?.postMergeReworkEvents.value).toBeNull();
  });

  it("treats a reopen after close as incomplete rather than as a failed merge", () => {
    const [metrics] = computeReviewMetrics(
      [
        event(3, "opened-3", "opened", openedAt.toISOString()),
        event(3, "closed-3", "closed", "2026-08-01T10:00:00Z"),
        event(3, "reopened-3", "reopened", "2026-08-01T11:00:00Z"),
      ],
      { observedUntil: new Date("2026-08-02T00:00:00Z") }
    );

    expect(metrics?.sampleSize).toBe(1);
    expect(metrics?.denominator.terminalPullRequests).toBe(0);
    expect(metrics?.mergeRate.value).toBeNull();
    expect(metrics?.exclusions).toEqual([]);
  });

  it("counts only explicit revert/rework signals and explicit human minutes", () => {
    const [metrics] = computeReviewMetrics(
      [
        event(4, "opened-4", "opened", openedAt.toISOString(), {
          additions: 30,
          deletions: 10,
          changedFiles: 2,
        }),
        event(4, "merged-4", "merged", "2026-08-01T10:00:00Z"),
        event(4, "reverted-4", "reverted", "2026-08-01T12:00:00Z"),
        event(4, "rework-4", "post_merge_rework", "2026-08-01T13:00:00Z"),
        event(4, "human-time-4", "human_review_time", "2026-08-01T09:30:00Z", {
          humanReviewMinutes: 18,
          humanReviewSource: "timer",
        }),
      ],
      { observedUntil: new Date("2026-08-02T00:00:00Z") }
    );

    expect(metrics?.mergeRate.value).toBe(1);
    expect(metrics?.postMergeReworkEvents).toEqual({ value: 2, knownSampleSize: 1 });
    expect(metrics?.humanReviewMinutes).toEqual({ value: 18, knownSampleSize: 1 });
    expect(metrics?.medianPrSizeLines.value).toBe(40);
  });
});
