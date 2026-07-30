import { describe, expect, it } from "vitest";
import { classifyTaskProfile } from "./classify-task";
import { ALL_TASK_TYPES } from "../alignment/eligibility";
import type { TaskType } from "../alignment/classifier";
import type { QualityProfile } from "../alignment/quality-profile";

const VALID_PROFILES: QualityProfile[] = ["economy", "standard", "premium"];

describe("classifyTaskProfile: totality over every real TaskType (ALL_TASK_TYPES)", () => {
  // Canary: if ALL_TASK_TYPES ever came back empty (e.g. a future refactor
  // of eligibility.ts's EXCLUDED_MODELS breaks its key-derivation), every
  // `it` below driven by this list would vacuously pass instead of failing
  // loudly — same pattern import-direction.test.ts uses for its own file
  // scan. This pins a sane lower bound so that failure mode is itself caught.
  it("found real task types to check", () => {
    expect(ALL_TASK_TYPES.length).toBeGreaterThan(0);
  });

  it("every ALL_TASK_TYPES member returns a valid QualityProfile (runtime-checked totality)", () => {
    for (const taskType of ALL_TASK_TYPES) {
      const profile = classifyTaskProfile(taskType);
      expect(
        VALID_PROFILES,
        `classifyTaskProfile("${taskType}") returned "${profile}", not a valid QualityProfile`
      ).toContain(profile);
    }
  });

  it("pins the exact mapping table (reviewable judgment call — full rationale in this module's doc comment and the PR body)", () => {
    const mapping = {} as Record<TaskType, QualityProfile>;
    for (const taskType of ALL_TASK_TYPES) {
      mapping[taskType] = classifyTaskProfile(taskType);
    }
    expect(mapping).toEqual({
      mechanical: "economy",
      ui: "standard",
      general: "standard",
      refactor: "premium",
    });
  });

  it("band counts: 1 economy / 2 standard / 1 premium", () => {
    const counts: Record<QualityProfile, number> = { economy: 0, standard: 0, premium: 0 };
    for (const taskType of ALL_TASK_TYPES) {
      counts[classifyTaskProfile(taskType)]++;
    }
    expect(counts).toEqual({ economy: 1, standard: 2, premium: 1 });
  });
});

describe("classifyTaskProfile: spot checks, one per band", () => {
  it('"mechanical" (small, bounded, low-risk — rename/bump/typo/formatting, classifier.ts) -> economy', () => {
    expect(classifyTaskProfile("mechanical")).toBe("economy");
  });

  it('"ui" (routine frontend engineering — components/pages/forms) -> standard', () => {
    expect(classifyTaskProfile("ui")).toBe("standard");
  });

  it('"general" (ambiguous/no-keyword-match default, classifier.ts\'s safe fallback) -> standard', () => {
    expect(classifyTaskProfile("general")).toBe("standard");
  });

  it('"refactor" (architecture, migration, restructuring — reasoning-heavy, classifier.ts) -> premium', () => {
    expect(classifyTaskProfile("refactor")).toBe("premium");
  });
});

describe("classifyTaskProfile: purity", () => {
  it("is deterministic — same input always returns the same output", () => {
    for (const taskType of ALL_TASK_TYPES) {
      expect(classifyTaskProfile(taskType)).toBe(classifyTaskProfile(taskType));
    }
  });
});
