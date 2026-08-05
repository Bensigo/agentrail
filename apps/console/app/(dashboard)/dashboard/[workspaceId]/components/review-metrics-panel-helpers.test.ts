import { describe, expect, it } from "vitest";
import { formatKnownSampleSize, formatReviewMetric, formatReviewDateRange, reviewMetricsWindow } from "./review-metrics-panel-helpers";

describe("review metrics panel helpers", () => {
  it("creates an explicit UTC 30-day window", () => {
    expect(reviewMetricsWindow(new Date("2026-08-05T12:00:00.000Z"))).toEqual({
      from: "2026-07-06T12:00:00.000Z",
      to: "2026-08-05T12:00:00.000Z",
    });
  });

  it("keeps unknown values and their known sample size visible", () => {
    expect(formatReviewMetric(null, "minutes")).toBe("unknown");
    expect(formatKnownSampleSize({ value: null, knownSampleSize: 2 })).toBe("n=2");
    expect(formatReviewMetric(0.75, "percent")).toBe("75%");
  });

  it("formats the dated range in UTC", () => {
    expect(formatReviewDateRange({ from: "2026-07-06T00:00:00.000Z", to: "2026-08-05T00:00:00.000Z" })).toBe("Jul 6, 2026 – Aug 5, 2026");
  });
});
