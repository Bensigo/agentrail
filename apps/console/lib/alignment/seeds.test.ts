import { describe, it, expect } from "vitest";
import { seedModel } from "./seeds";
import { CANDIDATES, MODEL_SEATS } from "./candidates";
import {
  ALL_TASK_TYPES,
  eligibleModelsForTaskType,
  isModelEligibleForTaskType,
} from "./eligibility";

describe("seedModel: reuses candidates.ts's MODEL_SEATS registry (no second table, no drift)", () => {
  for (const taskType of ALL_TASK_TYPES) {
    it(`${taskType}: seedModel(taskType) === MODEL_SEATS[CANDIDATES[taskType][0]]`, () => {
      expect(seedModel(taskType)).toBe(MODEL_SEATS[CANDIDATES[taskType][0]]);
    });
  }
});

describe("seedModel: diverse per task type, matching the #1338 PR③ confirmed spread", () => {
  it("ui -> kimi-k2.7-code", () => {
    expect(seedModel("ui").slug).toBe("moonshotai/kimi-k2.7-code");
  });
  it("refactor -> opus-4.8", () => {
    expect(seedModel("refactor").slug).toBe("anthropic/claude-opus-4.8");
  });
  it("mechanical -> glm-4.7", () => {
    expect(seedModel("mechanical").slug).toBe("z-ai/glm-4.7");
  });
  it("general -> glm-5.2", () => {
    expect(seedModel("general").slug).toBe("z-ai/glm-5.2");
  });
});

// ---------------------------------------------------------------------------
// Every seed must be eligible for its own task type — the same invariant
// seeds.ts's module-load self-check enforces (fails loudly at import time if
// violated), pinned here as a directly-readable assertion per task type.
// ---------------------------------------------------------------------------
describe("seedModel: every seed is a member of its own task type's eligible set", () => {
  for (const taskType of ALL_TASK_TYPES) {
    it(`${taskType}`, () => {
      const seat = seedModel(taskType);
      expect(isModelEligibleForTaskType(seat.slug, taskType)).toBe(true);
      expect(eligibleModelsForTaskType(taskType)).toContain(seat.slug);
      // The seed is also, by construction, the FIRST entry of its pool.
      expect(eligibleModelsForTaskType(taskType)[0]).toBe(seat.slug);
    });
  }

  it("in particular: ui's seed is kimi-k2.7-code, never haiku (the HARD OWNER RULE would make this seed invalid)", () => {
    expect(seedModel("ui").slug).not.toBe("anthropic/claude-haiku-4.5");
  });
});
