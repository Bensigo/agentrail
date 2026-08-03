import { describe, expect, it } from "vitest";
import { decideRequirementContract } from "./requirement-decision";

const BASE = {
  title: "Update the API",
  body: "## Acceptance criteria\n- [ ] the endpoint returns 200\n",
  acceptanceCriteria: ["the endpoint returns 200"],
};

describe("decideRequirementContract", () => {
  it("accepts a bounded brief and reports confidence as unknown rather than inventing a percentage", () => {
    const result = decideRequirementContract({ ...BASE, taskFamily: "general" });

    expect(result.decision).toBe("accept");
    expect(result.taskFamily).toBe("general");
    expect(result.confidence.state).toBe("unknown");
    expect(result.confidence.basis.join(" ")).toContain("Task family: general");
    expect(result.confidence.basis.join(" ")).toContain("no explicit refusal signal");
  });

  it.each([
    ["conflicting_acceptance_criteria", ["must enable caching", "must disable caching"]],
    ["unresolved_blocking_question", ["Which database should be used?"]],
    ["unsupported_environment", ["the unsupported environment must be supported"]],
    ["excessive_scope", ["rewrite the entire codebase"]],
    ["missing_proof_path", ["there is no way to verify this"]],
    ["unavailable_evidence", ["production logs are unavailable"]],
  ] as const)("returns a typed refusal for %s", (code, acceptanceCriteria) => {
    const result = decideRequirementContract({
      ...BASE,
      body: `## Acceptance criteria\n${acceptanceCriteria.map((item) => `- [ ] ${item}`).join("\n")}\n`,
      acceptanceCriteria: [...acceptanceCriteria],
      taskFamily: "mechanical",
    });

    expect(result.decision).toBe("refuse");
    if (result.decision === "refuse") {
      expect(result.refusal.code).toBe(code);
      expect(result.refusal.cannotEstablish).toBeTruthy();
      expect(result.refusal.requiredToProceed).toBeTruthy();
      expect(result.refusal.taskFamily).toBe("mechanical");
      expect(result.refusal.confidence.state).toBe("unknown");
    }
  });

  it("uses the first stable refusal reason when several explicit problems are present", () => {
    const result = decideRequirementContract({
      ...BASE,
      body: "## Open questions\n- [ ] Which database?\nrewrite the entire codebase",
      acceptanceCriteria: ["Which database?", "rewrite the entire codebase"],
    });

    expect(result.decision).toBe("refuse");
    if (result.decision === "refuse") {
      expect(result.refusal.code).toBe("unresolved_blocking_question");
    }
  });

  it("does not treat a normal mention of a test as a refusal", () => {
    const result = decideRequirementContract({
      ...BASE,
      body: "## Acceptance criteria\n- [ ] the test passes\n",
      acceptanceCriteria: ["the test passes"],
    });

    expect(result.decision).toBe("accept");
  });
});
