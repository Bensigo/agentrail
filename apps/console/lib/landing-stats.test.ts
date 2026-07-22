import { describe, expect, it } from "vitest";
import { computeLandingStats, DOGFOOD_BASELINE } from "./landing-stats";

describe("computeLandingStats", () => {
  it("sums live terminal outcomes on top of the documented dogfood baseline", async () => {
    const stats = await computeLandingStats(async () => ({
      success: 2,
      humanReview: 1,
      failed: 1,
    }));
    expect(stats).toEqual({
      workedOn: 57,
      shipped: 35,
      didntLand: 22,
      source: "live+baseline",
    });
  });

  it("falls back to baseline-only when the DB read throws — never invents, never zeros", async () => {
    const stats = await computeLandingStats(async () => {
      throw new Error("no database");
    });
    expect(stats).toEqual({ ...DOGFOOD_BASELINE, source: "baseline-only" });
  });

  it("keeps the baseline pinned to the documented dogfood record (docs/benchmarks/results/dogfood-track-record.md)", () => {
    // didn't land = worked on - shipped: the three numbers must stay one
    // consistent record, not three independently editable literals.
    expect(DOGFOOD_BASELINE).toEqual({ workedOn: 53, shipped: 33, didntLand: 20 });
    expect(DOGFOOD_BASELINE.workedOn - DOGFOOD_BASELINE.shipped).toBe(
      DOGFOOD_BASELINE.didntLand
    );
  });
});
