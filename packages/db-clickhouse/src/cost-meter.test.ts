import { describe, it, expect } from "vitest";
import {
  computeCacheReadCreationRatio,
  computeCostPerIssueToGreen,
  type CacheTokenRow,
  type IssueGroup,
  type RunCost,
} from "./cost-meter";

// ---------------------------------------------------------------------------
// AC2 — cache read-to-creation ratio (falsifiable: can be < 1)
// ---------------------------------------------------------------------------

describe("computeCacheReadCreationRatio (AC2)", () => {
  function rows(...rs: Partial<CacheTokenRow>[]): CacheTokenRow[] {
    return rs.map((r) => ({
      cache_tokens: r.cache_tokens ?? 0,
      cache_creation_tokens: r.cache_creation_tokens ?? 0,
    }));
  }

  it("returns ratio = read / creation summed across rows", () => {
    const result = computeCacheReadCreationRatio(
      rows(
        { cache_tokens: 600, cache_creation_tokens: 200 },
        { cache_tokens: 400, cache_creation_tokens: 200 }
      )
    );
    expect(result.cacheReadTokens).toBe(1000);
    expect(result.cacheCreationTokens).toBe(400);
    expect(result.ratio).toBeCloseTo(2.5);
  });

  it("can come back below 1 when writes exceed reads (cache not yet paying off)", () => {
    const result = computeCacheReadCreationRatio(
      rows({ cache_tokens: 100, cache_creation_tokens: 500 })
    );
    expect(result.ratio).toBeCloseTo(0.2);
    expect(result.ratio).toBeLessThan(1);
  });

  it("ratio is null when no cache-creation tokens (undefined, not Infinity)", () => {
    const result = computeCacheReadCreationRatio(
      rows({ cache_tokens: 100, cache_creation_tokens: 0 })
    );
    expect(result.cacheReadTokens).toBe(100);
    expect(result.cacheCreationTokens).toBe(0);
    expect(result.ratio).toBeNull();
  });

  it("ratio is null for empty input", () => {
    const result = computeCacheReadCreationRatio([]);
    expect(result.cacheReadTokens).toBe(0);
    expect(result.cacheCreationTokens).toBe(0);
    expect(result.ratio).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC1 — Cost-per-Issue-to-Green
// ---------------------------------------------------------------------------

describe("computeCostPerIssueToGreen (AC1)", () => {
  const runCosts: RunCost[] = [
    { run_id: "r1", cost_usd: 1.0 },
    { run_id: "r2", cost_usd: 2.0 },
    { run_id: "r3", cost_usd: 0.5 },
    { run_id: "r4", cost_usd: 4.0 },
  ];

  it("sums every run's cost for an issue that reached Green", () => {
    // Issue A re-enqueued once (r1 cheap fail → r2 escalated green): cost = 3.0
    const issues: IssueGroup[] = [
      { issueKey: "A", runIds: ["r1", "r2"], reachedGreen: true },
    ];
    const result = computeCostPerIssueToGreen(runCosts, issues);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ issueKey: "A", costUsd: 3.0 });
    expect(result.greenIssueCount).toBe(1);
    expect(result.avgCostUsd).toBeCloseTo(3.0);
  });

  it("averages cost across only the issues that reached Green", () => {
    const issues: IssueGroup[] = [
      { issueKey: "A", runIds: ["r1", "r2"], reachedGreen: true }, // 3.0
      { issueKey: "B", runIds: ["r3"], reachedGreen: true }, // 0.5
    ];
    const result = computeCostPerIssueToGreen(runCosts, issues);
    expect(result.greenIssueCount).toBe(2);
    expect(result.avgCostUsd).toBeCloseTo((3.0 + 0.5) / 2);
  });

  it("excludes issues that never reached Green from the average (falsifiable: cost can rise)", () => {
    const issues: IssueGroup[] = [
      { issueKey: "A", runIds: ["r1", "r2"], reachedGreen: true }, // 3.0
      { issueKey: "B", runIds: ["r4"], reachedGreen: false }, // escalated-to-human, not counted
    ];
    const result = computeCostPerIssueToGreen(runCosts, issues);
    expect(result.greenIssueCount).toBe(1);
    expect(result.issues.map((i) => i.issueKey)).toEqual(["A"]);
    expect(result.avgCostUsd).toBeCloseTo(3.0);
  });

  it("treats a run with no cost rows as $0 contribution", () => {
    const issues: IssueGroup[] = [
      { issueKey: "A", runIds: ["r1", "missing"], reachedGreen: true },
    ];
    const result = computeCostPerIssueToGreen(runCosts, issues);
    expect(result.issues[0].costUsd).toBeCloseTo(1.0);
  });

  it("returns avgCostUsd = null when no issue reached Green", () => {
    const issues: IssueGroup[] = [
      { issueKey: "B", runIds: ["r4"], reachedGreen: false },
    ];
    const result = computeCostPerIssueToGreen(runCosts, issues);
    expect(result.greenIssueCount).toBe(0);
    expect(result.issues).toHaveLength(0);
    expect(result.avgCostUsd).toBeNull();
  });

  it("orders returned green issues by cost descending", () => {
    const issues: IssueGroup[] = [
      { issueKey: "B", runIds: ["r3"], reachedGreen: true }, // 0.5
      { issueKey: "A", runIds: ["r1", "r2"], reachedGreen: true }, // 3.0
    ];
    const result = computeCostPerIssueToGreen(runCosts, issues);
    expect(result.issues.map((i) => i.issueKey)).toEqual(["A", "B"]);
  });
});
