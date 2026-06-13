import { describe, it, expect } from "vitest";
import { buildRunnerScorecard } from "./runner-scorecard";
import type { RunnerRunStatsRow } from "@agentrail/db-postgres";
import type { RunnerCostStatsRow, RunnerContextEfficiencyRow } from "@agentrail/db-clickhouse";

function makePgRow(overrides: Partial<RunnerRunStatsRow> = {}): RunnerRunStatsRow {
  return {
    runner_name: "claude",
    run_ids: ["run-1", "run-2", "run-3", "run-4"],
    total_count: 4,
    success_count: 3,
    human_review_count: 1,
    review_fix_count: 2,
    ...overrides,
  };
}

function makeCostRow(overrides: Partial<RunnerCostStatsRow> = {}): RunnerCostStatsRow {
  return {
    runner_name: "claude",
    total_cost_usd: 6.0,
    run_count: 4,
    ...overrides,
  };
}

function makeEffRow(overrides: Partial<RunnerContextEfficiencyRow> = {}): RunnerContextEfficiencyRow {
  return {
    runner_name: "claude",
    tokens_saved_sum: 800,
    token_budget_sum: 1000,
    ...overrides,
  };
}

describe("buildRunnerScorecard", () => {
  it("AC1: computes all five metrics correctly for two runners", () => {
    const pg = [
      makePgRow({ runner_name: "claude", total_count: 4, success_count: 3, human_review_count: 1, review_fix_count: 2, run_ids: ["r1", "r2", "r3", "r4"] }),
      makePgRow({ runner_name: "codex",  total_count: 2, success_count: 1, human_review_count: 0, review_fix_count: 1, run_ids: ["r5", "r6"] }),
    ];
    const cost = [
      makeCostRow({ runner_name: "claude", total_cost_usd: 6.0 }),
      makeCostRow({ runner_name: "codex",  total_cost_usd: 2.0 }),
    ];
    const eff = [
      makeEffRow({ runner_name: "claude", tokens_saved_sum: 800, token_budget_sum: 1000 }),
      makeEffRow({ runner_name: "codex",  tokens_saved_sum: 300, token_budget_sum: 600 }),
    ];

    const rows = buildRunnerScorecard(pg, cost, eff);
    expect(rows).toHaveLength(2);

    const claudeRow = rows.find((r) => r.runner_name === "claude")!;
    expect(claudeRow.success_rate).toBeCloseTo(3 / 4);
    expect(claudeRow.review_fix_rate).toBeCloseTo(2 / 4);
    expect(claudeRow.human_review_rate).toBeCloseTo(1 / 4);
    expect(claudeRow.cost_per_merged_pr).toBeCloseTo(6.0 / 3);
    expect(claudeRow.context_efficiency).toBeCloseTo(800 / 1000);

    const codexRow = rows.find((r) => r.runner_name === "codex")!;
    expect(codexRow.success_rate).toBeCloseTo(1 / 2);
    expect(codexRow.review_fix_rate).toBeCloseTo(1 / 2);
    expect(codexRow.human_review_rate).toBe(0);
    expect(codexRow.cost_per_merged_pr).toBeCloseTo(2.0 / 1);
    expect(codexRow.context_efficiency).toBeCloseTo(300 / 600);
  });

  it("AC2: success_rate is null (not NaN or 0) when total_count is 0", () => {
    const pg = [makePgRow({ total_count: 0, success_count: 0, human_review_count: 0, review_fix_count: 0 })];
    const rows = buildRunnerScorecard(pg, [], []);
    expect(rows[0].success_rate).toBeNull();
    expect(rows[0].review_fix_rate).toBeNull();
    expect(rows[0].human_review_rate).toBeNull();
  });

  it("AC3: context_efficiency is null when no context_packs rows for a runner", () => {
    const pg = [makePgRow({ runner_name: "claude" })];
    const cost = [makeCostRow({ runner_name: "claude" })];
    // No eff row for "claude"
    const rows = buildRunnerScorecard(pg, cost, []);
    expect(rows[0].context_efficiency).toBeNull();
  });

  it("AC3: context_efficiency is null when token_budget_sum is 0", () => {
    const pg = [makePgRow({ runner_name: "claude" })];
    const eff = [makeEffRow({ runner_name: "claude", tokens_saved_sum: 0, token_budget_sum: 0 })];
    const rows = buildRunnerScorecard(pg, [], eff);
    expect(rows[0].context_efficiency).toBeNull();
  });

  it("AC4: run_ids lists all contributing run IDs", () => {
    const runIds = ["run-a", "run-b", "run-c"];
    const pg = [makePgRow({ run_ids: runIds })];
    const rows = buildRunnerScorecard(pg, [], []);
    expect(rows[0].run_ids).toEqual(runIds);
  });

  it("cost_per_merged_pr is null when no cost data", () => {
    const pg = [makePgRow({ success_count: 2 })];
    // No cost row
    const rows = buildRunnerScorecard(pg, [], []);
    expect(rows[0].cost_per_merged_pr).toBeNull();
  });

  it("cost_per_merged_pr is null when success_count is 0", () => {
    const pg = [makePgRow({ success_count: 0 })];
    const cost = [makeCostRow({ total_cost_usd: 5.0 })];
    const rows = buildRunnerScorecard(pg, cost, []);
    expect(rows[0].cost_per_merged_pr).toBeNull();
  });

  it("returns empty array when pgRows is empty", () => {
    const rows = buildRunnerScorecard([], [makeCostRow()], [makeEffRow()]);
    expect(rows).toHaveLength(0);
  });

  it("runners without matching cost/eff rows still get computed rate metrics", () => {
    const pg = [makePgRow({ runner_name: "solo", total_count: 5, success_count: 4, human_review_count: 1, review_fix_count: 3 })];
    const rows = buildRunnerScorecard(pg, [], []);
    expect(rows[0].success_rate).toBeCloseTo(4 / 5);
    expect(rows[0].review_fix_rate).toBeCloseTo(3 / 5);
    expect(rows[0].human_review_rate).toBeCloseTo(1 / 5);
    expect(rows[0].cost_per_merged_pr).toBeNull();
    expect(rows[0].context_efficiency).toBeNull();
  });
});
