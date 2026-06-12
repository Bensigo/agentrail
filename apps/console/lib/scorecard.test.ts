import { describe, it, expect } from "vitest";
import { buildScorecard } from "./scorecard";
import type { AgentRunStatsRow } from "@agentrail/db-postgres";
import type { AgentModelCostRow } from "@agentrail/db-clickhouse";

function makePgRow(overrides: Partial<AgentRunStatsRow> = {}): AgentRunStatsRow {
  return {
    agent: "claude",
    runCount: 10,
    finishedCount: 8,
    successCount: 6,
    successRate: 0.75,
    avgDurationS: 120,
    avgReviewRounds: 1.5,
    ...overrides,
  };
}

function makeChRow(overrides: Partial<AgentModelCostRow> = {}): AgentModelCostRow {
  return {
    model: "claude-sonnet-4-6",
    runCount: 8,
    totalCostUsd: 4.0,
    avgCostUsd: 0.5,
    inputTokens: 100_000,
    outputTokens: 20_000,
    cacheTokens: 10_000,
    cacheRatio: 10_000 / 130_000,
    ...overrides,
  };
}

describe("buildScorecard", () => {
  it("produces correct agent and model rows from well-formed data", () => {
    const pg = [makePgRow()];
    const ch = [makeChRow()];
    const { agents, models } = buildScorecard(pg, ch);

    expect(agents).toHaveLength(1);
    expect(agents[0].agent).toBe("claude");
    expect(agents[0].runs).toBe(10);
    expect(agents[0].finishedRuns).toBe(8);
    expect(agents[0].successRate).toBeCloseTo(6 / 8);
    expect(agents[0].avgDurationS).toBe(120);
    expect(agents[0].avgReviewRounds).toBe(1.5);

    expect(models).toHaveLength(1);
    expect(models[0].model).toBe("claude-sonnet-4-6");
    expect(models[0].runs).toBe(8);
    expect(models[0].totalCostUsd).toBe(4.0);
    expect(models[0].avgCostUsd).toBeCloseTo(4.0 / 8);
    expect(models[0].cacheRatio).toBeCloseTo(10_000 / 130_000);
  });

  it("returns empty arrays for both tables when inputs are empty", () => {
    const { agents, models } = buildScorecard([], []);
    expect(agents).toHaveLength(0);
    expect(models).toHaveLength(0);
  });

  it("handles zero finishedCount without division-by-zero (successRate = 0)", () => {
    const pg = [makePgRow({ finishedCount: 0, successCount: 0 })];
    const { agents } = buildScorecard(pg, []);
    expect(agents[0].successRate).toBe(0);
  });

  it("handles null avgDurationS (runs with no timestamps)", () => {
    const pg = [makePgRow({ avgDurationS: null })];
    const { agents } = buildScorecard(pg, []);
    expect(agents[0].avgDurationS).toBeNull();
  });

  it("handles zero token counts without division-by-zero (cacheRatio = 0)", () => {
    const ch = [makeChRow({ inputTokens: 0, outputTokens: 0, cacheTokens: 0 })];
    const { models } = buildScorecard([], ch);
    expect(models[0].cacheRatio).toBe(0);
  });

  it("handles zero runCount in CH row without division-by-zero (avgCostUsd = 0)", () => {
    const ch = [makeChRow({ runCount: 0, totalCostUsd: 0 })];
    const { models } = buildScorecard([], ch);
    expect(models[0].avgCostUsd).toBe(0);
  });

  it("handles partial data: PG rows only (no CH rows)", () => {
    const pg = [makePgRow({ agent: "codex" })];
    const { agents, models } = buildScorecard(pg, []);
    expect(agents).toHaveLength(1);
    expect(agents[0].agent).toBe("codex");
    expect(models).toHaveLength(0);
  });

  it("handles partial data: CH rows only (no PG rows)", () => {
    const ch = [makeChRow({ model: "gpt-4o" })];
    const { agents, models } = buildScorecard([], ch);
    expect(agents).toHaveLength(0);
    expect(models).toHaveLength(1);
    expect(models[0].model).toBe("gpt-4o");
  });

  it("preserves multiple agents and models", () => {
    const pg = [makePgRow({ agent: "claude" }), makePgRow({ agent: "codex" })];
    const ch = [makeChRow({ model: "claude-sonnet-4-6" }), makeChRow({ model: "gpt-4o" })];
    const { agents, models } = buildScorecard(pg, ch);
    expect(agents).toHaveLength(2);
    expect(models).toHaveLength(2);
  });

  it("avgReviewRounds of 0 is valid (no review gates)", () => {
    const pg = [makePgRow({ avgReviewRounds: 0 })];
    const { agents } = buildScorecard(pg, []);
    expect(agents[0].avgReviewRounds).toBe(0);
  });
});
