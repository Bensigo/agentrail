import { describe, it, expect } from "vitest";
import {
  selectExecuteModel,
  describeModelSelection,
  DEFAULT_MIN_RUNS,
  DEFAULT_EXPLORATION_RATE,
} from "./selector";
import type { ModelSelection } from "./selector";
import { MODEL_CATALOG } from "./catalog";
import { eligibleModelsForTaskType } from "./eligibility";
import type { TaskType } from "./classifier";
import type { ModelOutcomeStatsRow } from "@agentrail/db-postgres";

const HAIKU = "anthropic/claude-haiku-4.5";
const SONNET = "anthropic/claude-sonnet-5";
const OPUS = "anthropic/claude-opus-4.8";

/** Never explores — random() always returns a value >= any explorationRate used in these tests. */
const NEVER_EXPLORE = () => 0.999;
/** Always explores — random() always returns 0, and (via pickExplorationTarget's tie-break) always picks index 0 of whichever candidate list it's given. */
const ALWAYS_EXPLORE = () => 0;

function row(overrides: Partial<ModelOutcomeStatsRow> & { executeModel: string; runCount: number }): ModelOutcomeStatsRow {
  const runCount = overrides.runCount;
  const successCount = overrides.successCount ?? runCount;
  return {
    taskType: overrides.taskType ?? null,
    executeModel: overrides.executeModel,
    runCount,
    successCount,
    successRate: overrides.successRate ?? (runCount > 0 ? successCount / runCount : 0),
    avgCostUsd: overrides.avgCostUsd ?? 1,
    costPerSuccess: overrides.costPerSuccess !== undefined ? overrides.costPerSuccess : successCount > 0 ? 1 : null,
  };
}

function fetchStatsReturning(rows: ModelOutcomeStatsRow[]) {
  return async () => rows;
}

describe("selectExecuteModel: no data -> the seed, reason 'seed'", () => {
  it("empty stats -> returns MODEL_CATALOG[taskType] exactly (the seed), reason 'seed', no runCount", async () => {
    const result = await selectExecuteModel("ui", "ws-1", {
      random: NEVER_EXPLORE,
      fetchStats: fetchStatsReturning([]),
    });
    expect(result.model).toBe(MODEL_CATALOG.ui);
    expect(result.reason).toBe("seed");
    expect(result.runCount).toBeUndefined();
  });

  it("every task type: no data -> seed matches MODEL_CATALOG[taskType]", async () => {
    const taskTypes: TaskType[] = ["ui", "refactor", "mechanical", "general"];
    for (const taskType of taskTypes) {
      const result = await selectExecuteModel(taskType, "ws-1", {
        random: NEVER_EXPLORE,
        fetchStats: fetchStatsReturning([]),
      });
      expect(result.model).toBe(MODEL_CATALOG[taskType]);
      expect(result.reason).toBe("seed");
    }
  });

  it("data exists but ALL rows are below MIN_RUNS -> still the seed (sample-aware, no thrash)", async () => {
    const result = await selectExecuteModel("ui", "ws-1", {
      random: NEVER_EXPLORE,
      fetchStats: fetchStatsReturning([
        row({ executeModel: OPUS, runCount: DEFAULT_MIN_RUNS - 1, successCount: DEFAULT_MIN_RUNS - 1 }), // 100% success, but under-sampled
      ]),
    });
    expect(result.model.slug).toBe(SONNET); // ui's seed
    expect(result.reason).toBe("seed");
  });

  it("seed's own data below MIN_RUNS surfaces as runCount on the 'seed' selection (for the brief's honest 'N runs so far' text)", async () => {
    const result = await selectExecuteModel("ui", "ws-1", {
      random: NEVER_EXPLORE,
      fetchStats: fetchStatsReturning([
        row({ executeModel: SONNET, runCount: 2, successCount: 2 }), // ui's own seed, under-sampled
      ]),
    });
    expect(result.reason).toBe("seed");
    expect(result.runCount).toBe(2);
  });
});

describe("selectExecuteModel: switches to best-from-data only after >= MIN_RUNS", () => {
  it("an eligible alternative with exactly MIN_RUNS and a better rate than the seed wins", async () => {
    const result = await selectExecuteModel("ui", "ws-1", {
      random: NEVER_EXPLORE,
      fetchStats: fetchStatsReturning([
        row({ executeModel: SONNET, runCount: 10, successCount: 5, successRate: 0.5 }), // the seed, mediocre
        row({ executeModel: OPUS, runCount: DEFAULT_MIN_RUNS, successCount: DEFAULT_MIN_RUNS, successRate: 1.0 }), // qualified, better
      ]),
    });
    expect(result.model.slug).toBe(OPUS);
    expect(result.reason).toBe("best-from-data");
    expect(result.runCount).toBe(DEFAULT_MIN_RUNS);
  });

  it("the SAME alternative with one run short of MIN_RUNS does NOT win, even with a perfect rate", async () => {
    const result = await selectExecuteModel("ui", "ws-1", {
      random: NEVER_EXPLORE,
      fetchStats: fetchStatsReturning([
        row({ executeModel: SONNET, runCount: 10, successCount: 5, successRate: 0.5 }),
        row({ executeModel: OPUS, runCount: DEFAULT_MIN_RUNS - 1, successCount: DEFAULT_MIN_RUNS - 1, successRate: 1.0 }),
      ]),
    });
    expect(result.model.slug).toBe(SONNET);
    expect(result.reason).toBe("seed");
  });

  it("a qualified alternative that does NOT beat the seed's rate does not win", async () => {
    const result = await selectExecuteModel("ui", "ws-1", {
      random: NEVER_EXPLORE,
      fetchStats: fetchStatsReturning([
        row({ executeModel: SONNET, runCount: 20, successCount: 19, successRate: 0.95 }), // seed, already great
        row({ executeModel: OPUS, runCount: 10, successCount: 6, successRate: 0.6 }), // qualified but worse
      ]),
    });
    expect(result.model.slug).toBe(SONNET);
    expect(result.reason).toBe("seed");
  });

  it("respects an injectable minRuns override", async () => {
    const result = await selectExecuteModel("ui", "ws-1", {
      random: NEVER_EXPLORE,
      minRuns: 2,
      fetchStats: fetchStatsReturning([
        row({ executeModel: SONNET, runCount: 10, successCount: 5, successRate: 0.5 }),
        row({ executeModel: OPUS, runCount: 2, successCount: 2, successRate: 1.0 }),
      ]),
    });
    expect(result.model.slug).toBe(OPUS);
    expect(result.reason).toBe("best-from-data");
  });

  it("tie on success rate: lower cost-per-success wins", async () => {
    const result = await selectExecuteModel("ui", "ws-1", {
      random: NEVER_EXPLORE,
      fetchStats: fetchStatsReturning([
        row({ executeModel: SONNET, runCount: 10, successCount: 5, successRate: 0.5 }), // seed baseline
        row({ executeModel: OPUS, runCount: 6, successCount: 6, successRate: 1.0, costPerSuccess: 4.0 }),
        // A THIRD candidate can't exist for ui (only 2 eligible slugs), so
        // exercise the tie-break with mechanical instead (3 eligible slugs).
      ]),
    });
    expect(result.model.slug).toBe(OPUS);

    const mechanicalResult = await selectExecuteModel("mechanical", "ws-1", {
      random: NEVER_EXPLORE,
      fetchStats: fetchStatsReturning([
        row({ executeModel: HAIKU, runCount: 10, successCount: 5, successRate: 0.5 }), // mechanical's seed
        row({ executeModel: SONNET, runCount: 8, successCount: 8, successRate: 1.0, costPerSuccess: 5.0 }),
        row({ executeModel: OPUS, runCount: 8, successCount: 8, successRate: 1.0, costPerSuccess: 2.0 }), // same rate, cheaper
      ]),
    });
    expect(mechanicalResult.model.slug).toBe(OPUS);
    expect(mechanicalResult.reason).toBe("best-from-data");
  });

  it("a null cost-per-success (zero successes) never wins a tiebreak against a real number", async () => {
    // Both qualified rows tie at successRate 0 (zero successes each) -- ties
    // at 0 can't beat the seed's own (also 0) baseline, so this should stay
    // on the seed regardless of the cost-per-success values involved.
    const result = await selectExecuteModel("mechanical", "ws-1", {
      random: NEVER_EXPLORE,
      fetchStats: fetchStatsReturning([
        row({ executeModel: HAIKU, runCount: 10, successCount: 0, successRate: 0, costPerSuccess: null }),
        row({ executeModel: SONNET, runCount: 10, successCount: 0, successRate: 0, costPerSuccess: null }),
      ]),
    });
    expect(result.reason).toBe("seed");
  });
});

describe("selectExecuteModel: HARD OWNER RULE — never returns haiku for ui, even under forced exploration", () => {
  it("forced exploration on empty stats never returns haiku for ui", async () => {
    const result = await selectExecuteModel("ui", "ws-1", {
      random: ALWAYS_EXPLORE,
      explorationRate: 1,
      fetchStats: fetchStatsReturning([]),
    });
    expect(result.model.slug).not.toBe(HAIKU);
    expect([SONNET, OPUS]).toContain(result.model.slug);
  });

  it("forced exploration with rich stats (including an adversarial haiku-for-ui row) never returns haiku for ui", async () => {
    const result = await selectExecuteModel("ui", "ws-1", {
      random: ALWAYS_EXPLORE,
      explorationRate: 1,
      fetchStats: fetchStatsReturning([
        row({ executeModel: SONNET, runCount: 20, successCount: 19, successRate: 0.95 }),
        row({ executeModel: OPUS, runCount: 20, successCount: 2, successRate: 0.1 }),
        // Adversarial: a haiku row for taskType 'ui' with a stellar record.
        // If eligibility filtering were ever bypassed, this row alone would
        // "win" on both success rate and volume — the selector must ignore
        // it completely because haiku is excluded from ui's eligible set.
        row({ executeModel: HAIKU, runCount: 1000, successCount: 1000, successRate: 1.0, costPerSuccess: 0.01 }),
      ]),
    });
    expect(result.model.slug).not.toBe(HAIKU);
  });

  it("exploit path (exploration disabled) with the same adversarial haiku row also never returns haiku for ui", async () => {
    const result = await selectExecuteModel("ui", "ws-1", {
      random: NEVER_EXPLORE,
      fetchStats: fetchStatsReturning([
        row({ executeModel: HAIKU, runCount: 1000, successCount: 1000, successRate: 1.0, costPerSuccess: 0.01 }),
      ]),
    });
    expect(result.model.slug).not.toBe(HAIKU);
    expect(result.model.slug).toBe(SONNET); // ui's seed, since haiku's data is never considered at all
    expect(result.reason).toBe("seed");
  });

  it("repeated calls across varied (deterministic) random draws never produce haiku for ui", async () => {
    const draws = [0, 0.05, 0.09, 0.099];
    for (const d of draws) {
      const result = await selectExecuteModel("ui", "ws-1", {
        random: () => d,
        fetchStats: fetchStatsReturning([
          row({ executeModel: SONNET, runCount: 3, successCount: 3 }),
          row({ executeModel: OPUS, runCount: 1, successCount: 1 }),
        ]),
      });
      expect(result.model.slug).not.toBe(HAIKU);
    }
  });
});

describe("selectExecuteModel: exploration stays within the eligible set for every task type", () => {
  const taskTypes: TaskType[] = ["ui", "refactor", "mechanical", "general"];

  for (const taskType of taskTypes) {
    it(`${taskType}: a forced-exploration pick is always a member of eligibleModelsForTaskType('${taskType}')`, async () => {
      const eligible = new Set(eligibleModelsForTaskType(taskType));
      const result = await selectExecuteModel(taskType, "ws-1", {
        random: ALWAYS_EXPLORE,
        explorationRate: 1,
        fetchStats: fetchStatsReturning([]),
      });
      expect(eligible.has(result.model.slug)).toBe(true);
      expect(result.reason).toBe("exploring");
    });
  }

  it("prefers the LEAST-sampled eligible alternative (excluding the exploit pick)", async () => {
    // mechanical's seed is haiku. sonnet has 0 recorded runs, opus has 5 --
    // exploration (excluding haiku, the exploit pick) should prefer sonnet.
    const result = await selectExecuteModel("mechanical", "ws-1", {
      random: ALWAYS_EXPLORE,
      explorationRate: 1,
      fetchStats: fetchStatsReturning([
        row({ executeModel: OPUS, runCount: 5, successCount: 5 }),
      ]),
    });
    expect(result.model.slug).toBe(SONNET);
    expect(result.reason).toBe("exploring");
  });

  it("never fires when the random draw is >= explorationRate (respects the configured rate)", async () => {
    const result = await selectExecuteModel("ui", "ws-1", {
      random: () => 0.5,
      explorationRate: 0.1, // 0.5 >= 0.1 -> no exploration
      fetchStats: fetchStatsReturning([]),
    });
    expect(result.reason).toBe("seed"); // exploit path, not exploring
  });
});

describe("selectExecuteModel: fetchStats is called with the exact (workspaceId, taskType)", () => {
  it("passes both through unchanged", async () => {
    let captured: { workspaceId: string; taskType: string } | null = null;
    await selectExecuteModel("refactor", "ws-42", {
      random: NEVER_EXPLORE,
      fetchStats: async (opts) => {
        captured = opts;
        return [];
      },
    });
    expect(captured).toEqual({ workspaceId: "ws-42", taskType: "refactor" });
  });
});

describe("describeModelSelection: the brief's one-line 'why'", () => {
  it("'seed' with no data: 'starting default, no data yet'", () => {
    const selection: ModelSelection = { model: MODEL_CATALOG.mechanical, reason: "seed" };
    expect(describeModelSelection("mechanical", selection)).toBe(
      "Claude Haiku 4.5 — starting default, no data yet"
    );
  });

  it("'seed' with some (below-threshold) data: names the run count and the threshold", () => {
    const selection: ModelSelection = { model: MODEL_CATALOG.mechanical, reason: "seed", runCount: 3 };
    expect(describeModelSelection("mechanical", selection)).toBe(
      `Claude Haiku 4.5 — starting default (3 runs so far, below the ${DEFAULT_MIN_RUNS}-run threshold)`
    );
  });

  it("'best-from-data': names the task type and run count", () => {
    const selection: ModelSelection = { model: MODEL_CATALOG.ui, reason: "best-from-data", runCount: 12 };
    expect(describeModelSelection("ui", selection)).toBe(
      "Claude Sonnet 5 — best success rate for ui (12 runs)"
    );
  });

  it("'exploring': the compare-and-learn framing, no run count needed", () => {
    const selection: ModelSelection = { model: MODEL_CATALOG.refactor, reason: "exploring" };
    expect(describeModelSelection("refactor", selection)).toBe("Trying Claude Opus 4.8 to compare");
  });
});

describe("DEFAULT_MIN_RUNS / DEFAULT_EXPLORATION_RATE: the documented defaults", () => {
  it("MIN_RUNS defaults to 5", () => {
    expect(DEFAULT_MIN_RUNS).toBe(5);
  });

  it("EXPLORATION_RATE defaults to 10%", () => {
    expect(DEFAULT_EXPLORATION_RATE).toBe(0.1);
  });
});
