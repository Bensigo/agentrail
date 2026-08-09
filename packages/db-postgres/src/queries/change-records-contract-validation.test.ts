import { describe, expect, it } from "vitest";
import { validateAcceptanceContract } from "./change_records.js";

const completeContract = {
  originalRequest: "Add saved filters",
  normalizedRequirements: ["Users can save and reuse a filter"],
  acceptanceCriteria: [{ id: "AC-1", text: "A user can save a filter" }],
  nonGoals: [],
  risks: [],
  environment: { kind: "existing_preview" },
  stops: [],
  unresolvedQuestions: [],
};

describe("validateAcceptanceContract", () => {
  it("accepts an explicit complete Contract", () => {
    expect(validateAcceptanceContract(completeContract)).toEqual({ ok: true });
  });

  it("rejects omitted boundaries instead of treating them as known-empty", () => {
    expect(
      validateAcceptanceContract({
        originalRequest: "Add saved filters",
        acceptanceCriteria: [{ id: "AC-1", text: "A user can save a filter" }],
        unresolvedQuestions: [],
      })
    ).toEqual({
      ok: false,
      errors: expect.arrayContaining([
        "normalizedRequirements",
        "nonGoals",
        "risks",
        "environment",
        "stops",
      ]),
    });
  });

  it("requires stable ids and text for criteria and unresolved questions", () => {
    expect(
      validateAcceptanceContract({
        ...completeContract,
        acceptanceCriteria: [{ id: "AC-1" }],
        unresolvedQuestions: [{ id: "Q-1" }],
      })
    ).toEqual({
      ok: false,
      errors: expect.arrayContaining(["acceptanceCriteria", "unresolvedQuestions"]),
    });
  });
});
