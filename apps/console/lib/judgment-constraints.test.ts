import { describe, expect, it } from "vitest";
import {
  evaluateJudgmentConstraints,
  parseJudgmentConstraintsMode,
} from "./judgment-constraints";

describe("judgment constraints", () => {
  it("parses only off/warn/block modes", () => {
    expect(parseJudgmentConstraintsMode(undefined)).toBe("off");
    expect(parseJudgmentConstraintsMode("warn")).toBe("warn");
    expect(parseJudgmentConstraintsMode("BLOCK")).toBe("block");
    expect(parseJudgmentConstraintsMode("fail")).toBe("off");
  });

  it("off mode does not evaluate constraints", () => {
    const result = evaluateJudgmentConstraints({
      mode: "off",
      issue: { title: "Switch to MongoDB" },
      items: [{ id: "m1", content: "Do not use MongoDB.", type: "decision" }],
    });
    expect(result).toEqual({ allow: true, mode: "off", violations: [] });
  });

  it("warn mode reports decision violations without blocking", () => {
    const result = evaluateJudgmentConstraints({
      mode: "warn",
      issue: { title: "Switch issue storage to MongoDB" },
      items: [{ id: "m1", content: "Do not use MongoDB for storage.", type: "decision" }],
    });
    expect(result.allow).toBe(true);
    expect(result.violations).toEqual([
      {
        kind: "decision",
        id: "m1",
        reason: "Issue appears to contradict a recorded decision: mongodb.",
        source: "memory_items",
      },
    ]);
  });

  it("block mode blocks rejected approaches", () => {
    const result = evaluateJudgmentConstraints({
      mode: "block",
      issue: { whatToBuild: "Implement the direct GitHub PAT fallback." },
      items: [
        {
          id: "j1",
          content: "Rejected approach: direct github pat fallback because hosted paths use app tokens.",
          tags: ["rejected_approach"],
          source: "judgment_events",
        },
      ],
    });
    expect(result.allow).toBe(false);
    expect(result.violations[0]).toMatchObject({
      kind: "rejected_approach",
      id: "j1",
      source: "judgment_events",
    });
  });
});
