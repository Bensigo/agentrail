import { describe, expect, it } from "vitest";
import {
  buildMeterUrl,
  formatCacheRatio,
  formatCostUsd,
  formatTokens,
  resolveMeterState,
  type CostMeterData,
} from "./cost-meter-panel-helpers";

describe("buildMeterUrl", () => {
  it("omits time params when timeRange is empty", () => {
    expect(
      buildMeterUrl({
        workspaceId: "ws-1",
        origin: "http://localhost",
        timeRange: "",
      })
    ).toBe("http://localhost/api/v1/workspaces/ws-1/costs/meter");
  });

  it("includes time_from and time_to when timeRange is set", () => {
    const url = buildMeterUrl({
      workspaceId: "ws-1",
      origin: "http://localhost",
      timeRange: "24h",
      now: new Date("2026-06-15T10:00:00.000Z"),
    });
    expect(url).toContain("time_from=2026-06-14T10%3A00%3A00.000Z");
    expect(url).toContain("time_to=2026-06-15T10%3A00%3A00.000Z");
  });
});

describe("formatCostUsd", () => {
  it("formats whole-dollar costs with 2 decimals", () => {
    expect(formatCostUsd(3.5)).toBe("$3.50");
  });
  it("formats sub-cent costs with 4 decimals", () => {
    expect(formatCostUsd(0.0042)).toBe("$0.0042");
  });
  it("formats zero as $0.00", () => {
    expect(formatCostUsd(0)).toBe("$0.00");
  });
});

describe("formatCacheRatio", () => {
  it("renders an em dash when ratio is null", () => {
    expect(formatCacheRatio(null)).toBe("—");
  });
  it("renders ratio with × suffix", () => {
    expect(formatCacheRatio(2.5)).toBe("2.50×");
  });
  it("can render a falsifiable below-1 ratio", () => {
    expect(formatCacheRatio(0.2)).toBe("0.20×");
  });
});

describe("formatTokens", () => {
  it("formats millions", () => {
    expect(formatTokens(1_200_000)).toBe("1.2M");
  });
  it("formats thousands", () => {
    expect(formatTokens(53_000)).toBe("53.0k");
  });
  it("formats small counts verbatim", () => {
    expect(formatTokens(412)).toBe("412");
  });
});

describe("resolveMeterState", () => {
  const data: CostMeterData = {
    costPerIssueToGreen: {
      issues: [{ issueKey: "feat/x", costUsd: 3 }],
      greenIssueCount: 1,
      avgCostUsd: 3,
    },
    cacheRatio: { cacheReadTokens: 1000, cacheCreationTokens: 400, ratio: 2.5 },
  };

  it("loading takes precedence", () => {
    expect(resolveMeterState({ loading: true, error: null, data: null })).toBe(
      "loading"
    );
  });

  it("error when error present and not loading", () => {
    expect(
      resolveMeterState({ loading: false, error: "boom", data: null })
    ).toBe("error");
  });

  it("data when there are green issues or cache tokens", () => {
    expect(resolveMeterState({ loading: false, error: null, data })).toBe(
      "data"
    );
  });

  it("empty when no green issues and no cache tokens", () => {
    expect(
      resolveMeterState({
        loading: false,
        error: null,
        data: {
          costPerIssueToGreen: { issues: [], greenIssueCount: 0, avgCostUsd: null },
          cacheRatio: { cacheReadTokens: 0, cacheCreationTokens: 0, ratio: null },
        },
      })
    ).toBe("empty");
  });

  it("data when only cache tokens exist (no green issues yet)", () => {
    expect(
      resolveMeterState({
        loading: false,
        error: null,
        data: {
          costPerIssueToGreen: { issues: [], greenIssueCount: 0, avgCostUsd: null },
          cacheRatio: { cacheReadTokens: 500, cacheCreationTokens: 200, ratio: 2.5 },
        },
      })
    ).toBe("data");
  });
});
