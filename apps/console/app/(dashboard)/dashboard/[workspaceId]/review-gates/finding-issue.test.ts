import { describe, it, expect } from "vitest";
import { buildFindingIssue, type ReviewGateFinding } from "./finding-issue";

const finding: ReviewGateFinding = {
  severity: "major",
  category: "tests",
  description: "missing test for the empty-input path",
  suggested_fix: "add a unit test covering []",
};

describe("buildFindingIssue", () => {
  it("titles with a [review] prefix and the description", () => {
    const { title } = buildFindingIssue(finding, { runId: "run1", prUrl: "https://x/pr/1", gateId: "g1", index: 2 });
    expect(title).toBe("[review] missing test for the empty-input path");
  });

  it("emits the house sections in order", () => {
    const { body } = buildFindingIssue(finding, { runId: "run1", prUrl: "https://x/pr/1", gateId: "g1", index: 2 });
    const parent = body.indexOf("## Parent");
    const build = body.indexOf("## What to build");
    const ac = body.indexOf("## Acceptance criteria");
    const verify = body.indexOf("## Verification");
    expect(parent).toBeGreaterThanOrEqual(0);
    expect(build).toBeGreaterThan(parent);
    expect(ac).toBeGreaterThan(build);
    expect(verify).toBeGreaterThan(ac);
    expect(body).toContain("- [ ]");
    expect(body).toContain("review gate g1, finding #2");
    expect(body).toContain("add a unit test covering []");
  });

  it("truncates a long title to <= 80 chars", () => {
    const long = { ...finding, description: "x".repeat(200) };
    const { title } = buildFindingIssue(long, { runId: "r", prUrl: "u", gateId: "g", index: 0 });
    expect(title.length).toBeLessThanOrEqual("[review] ".length + 80);
  });
});
