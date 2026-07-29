import { describe, it, expect, vi } from "vitest";
import {
  ALL_TASK_TYPES,
  eligibleModelsForTaskType,
  isModelEligibleForTaskType,
  allEligibleModelSlugs,
} from "./eligibility";
import { CANDIDATES } from "./candidates";
import type { TaskType } from "./classifier";
import type { QualityProfile } from "./quality-profile";

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

// ---------------------------------------------------------------------------
// Subscription-platform slice 2, Task 11 — the optional `allowedProfiles`
// entitlement filter. Profile tags used below (candidates.ts's MODEL_SEATS,
// pinned by candidates.test.ts): kimi-code/glm-5.2/qwen/haiku = standard,
// kimi-k3/sonnet-5/opus-4.8/gpt-codex = premium, deepseek/glm-4.7 = economy.
// ---------------------------------------------------------------------------
describe("eligibleModelsForTaskType: allowedProfiles undefined (every pre-Task-11 caller) -- byte-identical to today", () => {
  it("omitting the second argument entirely matches passing it explicitly as undefined", () => {
    for (const taskType of ALL_TASK_TYPES) {
      expect(eligibleModelsForTaskType(taskType, undefined)).toEqual(eligibleModelsForTaskType(taskType));
    }
  });

  it("every existing pinned per-task pool assertion above already exercises the one-argument call -- this is the explicit anchor for why", () => {
    // eligibleModelsForTaskType(taskType) with no second argument is exactly
    // eligibleModelsForTaskType(taskType, undefined): the `allowedProfiles
    // === undefined` branch returns the unfiltered `eligible` list, so every
    // describe block above (ALL_TASK_TYPES, HARD OWNER RULE, pinned pools,
    // allEligibleModelSlugs) continuing to pass unmodified IS the
    // byte-identical proof for this requirement.
    expect(eligibleModelsForTaskType("ui")).toEqual([KIMI_CODE, GLM_5_2, KIMI_K3, SONNET]);
  });
});

describe("eligibleModelsForTaskType: allowedProfiles filters the pool by candidates.ts's profile tag", () => {
  it("ui, allowed={standard}: keeps kimi-code/glm-5.2, drops premium-tagged kimi-k3/sonnet-5", () => {
    const result = eligibleModelsForTaskType("ui", new Set<QualityProfile>(["standard"]));
    expect(result).toEqual([KIMI_CODE, GLM_5_2]);
  });

  it("refactor, allowed={economy}: keeps only deepseek-v4-pro", () => {
    const result = eligibleModelsForTaskType("refactor", new Set<QualityProfile>(["economy"]));
    expect(result).toEqual([DEEPSEEK]);
  });

  it("mechanical, allowed={economy, standard}: drops nothing (mechanical's pool has no premium-tagged member)", () => {
    const result = eligibleModelsForTaskType("mechanical", new Set<QualityProfile>(["economy", "standard"]));
    expect(result).toEqual(eligibleModelsForTaskType("mechanical"));
  });

  it("preserves the pool's own seed-first order, independent of the allowed Set's insertion order", () => {
    const result = eligibleModelsForTaskType(
      "refactor",
      new Set<QualityProfile>(["premium", "economy"]) // insertion order deliberately reversed vs. pool order
    );
    // Pool order is [opus-4.8(premium), glm-5.2(standard), deepseek(economy), kimi-code(standard), sonnet-5(premium)]
    expect(result).toEqual([OPUS, DEEPSEEK, SONNET]);
  });

  it("a filter containing every profile is equivalent to no filter at all", () => {
    const allProfiles = new Set<QualityProfile>(["economy", "standard", "premium"]);
    for (const taskType of ALL_TASK_TYPES) {
      expect(eligibleModelsForTaskType(taskType, allProfiles)).toEqual(eligibleModelsForTaskType(taskType));
    }
  });
});

describe("eligibleModelsForTaskType: fail-open -- an empty filtered pool falls back to the unfiltered eligible set", () => {
  it("a profile the pool simply doesn't offer (ui has zero economy-tagged candidates): falls back to the full ui pool, logs once", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = eligibleModelsForTaskType("ui", new Set<QualityProfile>(["economy"]));

    expect(result).toEqual([KIMI_CODE, GLM_5_2, KIMI_K3, SONNET]); // the full, unfiltered ui pool
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain("ui");

    errorSpy.mockRestore();
  });

  it("a literally empty allowed set: also falls back to the unfiltered pool rather than returning []", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = eligibleModelsForTaskType("mechanical", new Set<QualityProfile>());

    expect(result).toEqual(eligibleModelsForTaskType("mechanical"));
    expect(result.length).toBeGreaterThan(0);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    errorSpy.mockRestore();
  });

  it("fail-open never brick selection: the fallback result is never empty for any real task type, however narrow the filter", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const taskType of ALL_TASK_TYPES) {
      const result = eligibleModelsForTaskType(taskType, new Set<QualityProfile>());
      expect(result.length).toBeGreaterThan(0);
    }
    errorSpy.mockRestore();
  });
});
