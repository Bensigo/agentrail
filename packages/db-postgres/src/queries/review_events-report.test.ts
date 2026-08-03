import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewMetricEvent } from "../review_metrics.js";

const state = vi.hoisted(() => ({
  selectResponses: [] as unknown[][],
}));

function nextResponse(): unknown[] {
  return state.selectResponses.shift() ?? [];
}

vi.mock("../db.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => nextResponse(),
      }),
    }),
  },
}));

import { getReviewMetricsReport } from "./review_events.js";

const workspaceId = "ws-1";

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

beforeEach(() => {
  state.selectResponses = [];
});

describe("getReviewMetricsReport", () => {
  it("returns the dated current report, the dated baseline, and the computed comparison", async () => {
    state.selectResponses = [
      [
        event(1, "current-opened", "opened", "2026-08-01T09:00:00Z"),
        event(1, "current-review", "review_submitted", "2026-08-01T09:20:00Z"),
        event(1, "current-merged", "merged", "2026-08-01T10:00:00Z"),
        event(1, "current-human-time", "human_review_time", "2026-08-01T09:30:00Z", {
          humanReviewMinutes: 18,
          humanReviewSource: "timer",
        }),
      ],
      [
        event(1, "baseline-opened", "opened", "2026-07-25T09:00:00Z"),
        event(1, "baseline-review", "review_submitted", "2026-07-25T09:40:00Z"),
        event(1, "baseline-merged", "merged", "2026-07-25T10:00:00Z"),
        event(1, "baseline-human-time", "human_review_time", "2026-07-25T09:50:00Z", {
          humanReviewMinutes: 12,
          humanReviewSource: "human_input",
        }),
      ],
    ];

    const report = await getReviewMetricsReport({
      workspaceId,
      taskFamily: "dependency-upgrade",
      from: new Date("2026-08-01T00:00:00Z"),
      to: new Date("2026-08-02T00:00:00Z"),
      observedUntil: new Date("2026-08-02T00:00:00Z"),
      baselineFrom: new Date("2026-07-25T00:00:00Z"),
      baselineTo: new Date("2026-07-26T00:00:00Z"),
      baselineObservedUntil: new Date("2026-07-26T00:00:00Z"),
    });

    expect(report).toMatchObject({
      workspaceId,
      taskFamily: "dependency-upgrade",
      current: expect.objectContaining({
        sampleSize: 1,
        dateRange: {
          from: new Date("2026-08-01T00:00:00Z"),
          to: new Date("2026-08-02T00:00:00Z"),
        },
        humanReviewMinutes: { value: 18, knownSampleSize: 1 },
      }),
      baseline: expect.objectContaining({
        sampleSize: 1,
        dateRange: {
          from: new Date("2026-07-25T00:00:00Z"),
          to: new Date("2026-07-26T00:00:00Z"),
        },
        humanReviewMinutes: { value: 12, knownSampleSize: 1 },
      }),
      comparison: expect.objectContaining({
        sampleSizeDelta: 0,
        humanReviewMinutesDelta: 6,
        medianTimeToFirstReviewSecondsDelta: -1200,
      }),
    });
  });

  it("returns null when the requested task family has no report", async () => {
    state.selectResponses = [[]];
    await expect(
      getReviewMetricsReport({
        workspaceId,
        taskFamily: "dependency-upgrade",
        from: new Date("2026-08-01T00:00:00Z"),
        to: new Date("2026-08-02T00:00:00Z"),
      })
    ).resolves.toBeNull();
  });

  it("rejects a baseline window missing one bound", async () => {
    await expect(
      getReviewMetricsReport({
        workspaceId,
        taskFamily: "dependency-upgrade",
        from: new Date("2026-08-01T00:00:00Z"),
        to: new Date("2026-08-02T00:00:00Z"),
        baselineFrom: new Date("2026-07-25T00:00:00Z"),
      } as never)
    ).rejects.toThrow("baseline review metrics require both baselineFrom and baselineTo");
  });
});
