import { describe, it, expect } from "vitest";
import {
  ALL_TASK_TYPES,
  eligibleModelsForTaskType,
  isModelEligibleForTaskType,
  allEligibleModelSlugs,
} from "./eligibility";
import { MODEL_CATALOG } from "./catalog";
import type { TaskType } from "./classifier";

const HAIKU = "anthropic/claude-haiku-4.5";
const SONNET = "anthropic/claude-sonnet-5";
const OPUS = "anthropic/claude-opus-4.8";

describe("ALL_TASK_TYPES", () => {
  it("covers every TaskType MODEL_CATALOG's own Record<TaskType, ModelSeat> shape requires", () => {
    expect(new Set(ALL_TASK_TYPES)).toEqual(new Set(Object.keys(MODEL_CATALOG)));
    expect(ALL_TASK_TYPES).toHaveLength(4);
  });
});

describe("eligibleModelsForTaskType: HARD OWNER RULE — ui never includes haiku", () => {
  it("ui's eligible set excludes haiku", () => {
    expect(eligibleModelsForTaskType("ui")).not.toContain(HAIKU);
  });

  it("ui's eligible set still includes sonnet and opus (the exclusion is targeted, not a wipe)", () => {
    const eligible = eligibleModelsForTaskType("ui");
    expect(eligible).toContain(SONNET);
    expect(eligible).toContain(OPUS);
  });

  it("isModelEligibleForTaskType(haiku, 'ui') is false", () => {
    expect(isModelEligibleForTaskType(HAIKU, "ui")).toBe(false);
  });
});

describe("eligibleModelsForTaskType: no exclusions for refactor/mechanical/general today", () => {
  const unrestricted: TaskType[] = ["refactor", "mechanical", "general"];

  for (const taskType of unrestricted) {
    it(`${taskType}'s eligible set includes haiku (only ui excludes it)`, () => {
      expect(eligibleModelsForTaskType(taskType)).toContain(HAIKU);
    });

    it(`isModelEligibleForTaskType(haiku, '${taskType}') is true`, () => {
      expect(isModelEligibleForTaskType(HAIKU, taskType)).toBe(true);
    });
  }
});

describe("eligibleModelsForTaskType: every task type's eligible set is a non-empty subset of MODEL_CATALOG's known slugs", () => {
  const knownSlugs = new Set(Object.values(MODEL_CATALOG).map((seat) => seat.slug));

  for (const taskType of ALL_TASK_TYPES) {
    it(`${taskType}`, () => {
      const eligible = eligibleModelsForTaskType(taskType);
      expect(eligible.length).toBeGreaterThan(0);
      for (const slug of eligible) {
        expect(knownSlugs.has(slug)).toBe(true);
      }
    });
  }
});

describe("allEligibleModelSlugs: the union across every task type", () => {
  it("equals every MODEL_CATALOG slug today (haiku stays eligible for 3 of 4 task types)", () => {
    const knownSlugs = new Set(Object.values(MODEL_CATALOG).map((seat) => seat.slug));
    expect(new Set(allEligibleModelSlugs())).toEqual(knownSlugs);
  });

  it("includes haiku even though ui alone excludes it (union, not intersection)", () => {
    expect(allEligibleModelSlugs()).toContain(HAIKU);
  });
});
