import { describe, expect, it } from "vitest";
import {
  buildCostAnomaliesUrl,
  formatBaselineLabel,
  formatDeviationSigma,
  getBaselineThreshold,
} from "./cost-anomaly-helpers";

describe("cost anomaly table helpers", () => {
  it("builds the anomalies URL with the shared time range", () => {
    const url = buildCostAnomaliesUrl({
      workspaceId: "ws-1",
      origin: "http://localhost",
      timeRange: "24h",
      now: new Date("2026-06-13T10:00:00.000Z"),
    });

    expect(url).toBe(
      "http://localhost/api/v1/workspaces/ws-1/costs/anomalies?time_from=2026-06-12T10%3A00%3A00.000Z&time_to=2026-06-13T10%3A00%3A00.000Z"
    );
  });

  it("formats positive deviation as monospace-ready sigma text", () => {
    expect(formatDeviationSigma(3.217)).toBe("+3.2σ");
  });

  it("computes and formats mean plus two sigma baseline", () => {
    const row = {
      run_id: "run-1",
      model: "gpt-5.5",
      phase: "execute",
      repository_id: "repo-1",
      cost_usd: 12.5,
      mean: 3.1,
      stddev: 1.2,
      deviation_sigmas: 7.83,
      occurred_at: "2026-06-13T08:00:00.000Z",
    };

    expect(getBaselineThreshold(row)).toBe(5.5);
    expect(formatBaselineLabel(row)).toBe(
      "Baseline: $5.5000 (mean + 2σ over 30d)"
    );
  });
});
