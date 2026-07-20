import { describe, it, expect } from "vitest";
import {
  ALL_TASK_TYPES,
  eligibleModelsForTaskType,
  isModelEligibleForTaskType,
  allEligibleModelSlugs,
} from "./eligibility";
import { CANDIDATES } from "./candidates";
import type { TaskType } from "./classifier";

const HAIKU = "anthropic/claude-haiku-4.5";
const SONNET = "anthropic/claude-sonnet-5";
const OPUS = "anthropic/claude-opus-4.8";
const KIMI_CODE = "moonshotai/kimi-k2.7-code";
const KIMI_K3 = "moonshotai/kimi-k3";
const GLM_5_2 = "z-ai/glm-5.2";
const GLM_4_7 = "z-ai/glm-4.7";
const DEEPSEEK = "deepseek/deepseek-v4-pro";
const QWEN = "qwen/qwen3-coder-plus";
const GPT_CODEX = "openai/gpt-5.1-codex";

describe("ALL_TASK_TYPES", () => {
  it("covers every TaskType CANDIDATES' own Record<TaskType, readonly string[]> shape requires", () => {
    expect(new Set(ALL_TASK_TYPES)).toEqual(new Set(Object.keys(CANDIDATES)));
    expect(ALL_TASK_TYPES).toHaveLength(4);
  });
});

describe("eligibleModelsForTaskType: HARD OWNER RULE — ui never includes haiku", () => {
  it("ui's eligible set excludes haiku", () => {
    expect(eligibleModelsForTaskType("ui")).not.toContain(HAIKU);
  });

  it("isModelEligibleForTaskType(haiku, 'ui') is false", () => {
    expect(isModelEligibleForTaskType(HAIKU, "ui")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #1338 PR③ — pinned per-task pool, confirmed spread. Each task's eligible
// set must equal its intended CANDIDATES pool exactly, seed first.
// ---------------------------------------------------------------------------
describe("eligibleModelsForTaskType: pinned per-task pool (#1338 PR③ confirmed spread)", () => {
  it("ui: kimi-k2.7-code (seed), glm-5.2, kimi-k3, sonnet-5 — no haiku, no opus", () => {
    expect(eligibleModelsForTaskType("ui")).toEqual([KIMI_CODE, GLM_5_2, KIMI_K3, SONNET]);
  });

  it("refactor: opus-4.8 (seed), glm-5.2, deepseek-v4-pro, kimi-k2.7-code, sonnet-5", () => {
    expect(eligibleModelsForTaskType("refactor")).toEqual([
      OPUS,
      GLM_5_2,
      DEEPSEEK,
      KIMI_CODE,
      SONNET,
    ]);
  });

  it("mechanical: glm-4.7 (seed), glm-5.2, deepseek-v4-pro, qwen3-coder-plus, haiku-4.5", () => {
    expect(eligibleModelsForTaskType("mechanical")).toEqual([
      GLM_4_7,
      GLM_5_2,
      DEEPSEEK,
      QWEN,
      HAIKU,
    ]);
  });

  it("general: glm-5.2 (seed), kimi-k2.7-code, deepseek-v4-pro, gpt-5.1-codex, sonnet-5", () => {
    expect(eligibleModelsForTaskType("general")).toEqual([
      GLM_5_2,
      KIMI_CODE,
      DEEPSEEK,
      GPT_CODEX,
      SONNET,
    ]);
  });

  it("each task type's eligible set exactly equals its CANDIDATES pool (no exclusions apply beyond ui/haiku, which isn't even offered for ui)", () => {
    for (const taskType of ALL_TASK_TYPES) {
      expect(eligibleModelsForTaskType(taskType)).toEqual(CANDIDATES[taskType]);
    }
  });
});

describe("eligibleModelsForTaskType: haiku is offered for mechanical only under the widened pool (PR③)", () => {
  it("haiku IS eligible for mechanical", () => {
    expect(eligibleModelsForTaskType("mechanical")).toContain(HAIKU);
    expect(isModelEligibleForTaskType(HAIKU, "mechanical")).toBe(true);
  });

  it("haiku is NOT a candidate for refactor or general anymore — simply absent from those pools, not merely excluded", () => {
    const notOffered: TaskType[] = ["refactor", "general"];
    for (const taskType of notOffered) {
      expect(eligibleModelsForTaskType(taskType)).not.toContain(HAIKU);
      expect(isModelEligibleForTaskType(HAIKU, taskType)).toBe(false);
    }
  });
});

describe("eligibleModelsForTaskType: every task type's eligible set is a non-empty subset of candidates.ts's known slugs", () => {
  const knownSlugs = new Set(ALL_TASK_TYPES.flatMap((t) => CANDIDATES[t]));

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

describe("allEligibleModelSlugs: the union across every task type (#1338 PR③ — 10 distinct slugs)", () => {
  const ALL_SLUGS = [
    KIMI_CODE,
    GLM_5_2,
    KIMI_K3,
    SONNET,
    OPUS,
    DEEPSEEK,
    GLM_4_7,
    QWEN,
    HAIKU,
    GPT_CODEX,
  ];

  it("equals the full 10-slug union of the widened per-task pools", () => {
    expect(new Set(allEligibleModelSlugs())).toEqual(new Set(ALL_SLUGS));
    expect(allEligibleModelSlugs()).toHaveLength(ALL_SLUGS.length);
  });

  it("includes haiku even though only mechanical offers it (union, not intersection)", () => {
    expect(allEligibleModelSlugs()).toContain(HAIKU);
  });

  it("includes opus even though only refactor offers it", () => {
    expect(allEligibleModelSlugs()).toContain(OPUS);
  });
});
