import { describe, expect, it } from "vitest";
import {
  compareReviewMetrics,
  computeReviewMetrics,
  type ReviewMetricEvent,
  type ReviewMetrics,
} from "./review_metrics.js";

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

describe("compareReviewMetrics", () => {
  const baseMetrics: ReviewMetrics = {
    workspaceId,
    taskFamily: "dependency-upgrade",
    dateRange: { from: new Date("2026-08-01T00:00:00Z"), to: new Date("2026-08-08T00:00:00Z") },
    sampleSize: 4,
    denominator: {
      openedPullRequests: 4,
      terminalPullRequests: 3,
      mergeRate: 3,
    },
    medianTimeToFirstReviewSeconds: { value: 1200, knownSampleSize: 3 },
    averageReviewCycles: { value: 1.5, knownSampleSize: 3 },
    medianPrSizeLines: { value: 42, knownSampleSize: 3 },
    mergeRate: { value: 0.75, knownSampleSize: 3 },
    postMergeReworkEvents: { value: 1, knownSampleSize: 3 },
    humanReviewMinutes: { value: 18, knownSampleSize: 3 },
    exclusions: ["1 conflicting delivery replay(s)"],
    limitations: ["Human review minutes come only from explicit human_input or timer events; calendar elapsed time is excluded."],
  };

  it("computes numeric deltas against the dated baseline", () => {
    const current: ReviewMetrics = {
      ...baseMetrics,
      sampleSize: 6,
      denominator: {
        openedPullRequests: 6,
        terminalPullRequests: 5,
        mergeRate: 5,
      },
      medianTimeToFirstReviewSeconds: { value: 900, knownSampleSize: 4 },
      averageReviewCycles: { value: 2, knownSampleSize: 4 },
      medianPrSizeLines: { value: 50, knownSampleSize: 4 },
      mergeRate: { value: 0.83, knownSampleSize: 4 },
      postMergeReworkEvents: { value: 3, knownSampleSize: 4 },
      humanReviewMinutes: { value: 24, knownSampleSize: 4 },
    };

    expect(compareReviewMetrics(current, baseMetrics)).toEqual({
      sampleSizeDelta: 2,
      denominatorDelta: {
        openedPullRequests: 2,
        terminalPullRequests: 2,
        mergeRate: 2,
      },
      medianTimeToFirstReviewSecondsDelta: -300,
      averageReviewCyclesDelta: 0.5,
      medianPrSizeLinesDelta: 8,
      mergeRateDelta: 0.07999999999999996,
      postMergeReworkEventsDelta: 2,
      humanReviewMinutesDelta: 6,
    });
  });

  it("preserves null when either side lacks a metric value", () => {
    const current: ReviewMetrics = {
      ...baseMetrics,
      medianTimeToFirstReviewSeconds: { value: null, knownSampleSize: 0 },
      averageReviewCycles: { value: null, knownSampleSize: 0 },
      medianPrSizeLines: { value: null, knownSampleSize: 0 },
      mergeRate: { value: null, knownSampleSize: 0 },
      postMergeReworkEvents: { value: null, knownSampleSize: 0 },
      humanReviewMinutes: { value: null, knownSampleSize: 0 },
    };

    expect(compareReviewMetrics(current, baseMetrics)).toEqual({
      sampleSizeDelta: 0,
      denominatorDelta: {
        openedPullRequests: 0,
        terminalPullRequests: 0,
        mergeRate: 0,
      },
      medianTimeToFirstReviewSecondsDelta: null,
      averageReviewCyclesDelta: null,
      medianPrSizeLinesDelta: null,
      mergeRateDelta: null,
      postMergeReworkEventsDelta: null,
      humanReviewMinutesDelta: null,
    });
  });
});
