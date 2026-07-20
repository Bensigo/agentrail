import { describe, it, expect } from "vitest";
import { seedModel } from "./seeds";
import { MODEL_CATALOG } from "./catalog";
import { ALL_TASK_TYPES, isModelEligibleForTaskType } from "./eligibility";

describe("seedModel: reuses MODEL_CATALOG directly (no second table, no drift)", () => {
  for (const taskType of ALL_TASK_TYPES) {
    it(`${taskType}: seedModel(taskType) === MODEL_CATALOG[taskType]`, () => {
      expect(seedModel(taskType)).toBe(MODEL_CATALOG[taskType]);
    });
  }
});

describe("seedModel: diverse per task type, matching the spec's stated defaults", () => {
  it("ui -> sonnet-5", () => {
    expect(seedModel("ui").slug).toBe("anthropic/claude-sonnet-5");
  });
  it("refactor -> opus-4.8", () => {
    expect(seedModel("refactor").slug).toBe("anthropic/claude-opus-4.8");
  });
  it("mechanical -> haiku-4.5", () => {
    expect(seedModel("mechanical").slug).toBe("anthropic/claude-haiku-4.5");
  });
  it("general -> sonnet-5", () => {
    expect(seedModel("general").slug).toBe("anthropic/claude-sonnet-5");
  });
});

describe("seedModel: every seed is a member of its own task type's eligible set", () => {
  for (const taskType of ALL_TASK_TYPES) {
    it(`${taskType}`, () => {
      const seat = seedModel(taskType);
      expect(isModelEligibleForTaskType(seat.slug, taskType)).toBe(true);
    });
  }

  it("in particular: ui's seed is sonnet-5, never haiku (the HARD OWNER RULE would make this seed invalid)", () => {
    expect(seedModel("ui").slug).not.toBe("anthropic/claude-haiku-4.5");
  });
});
