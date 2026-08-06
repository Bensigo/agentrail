import { describe, expect, it } from "vitest";
import { parseAcceptanceContract } from "@agentrail/contracts";

const valid = {
  originalUserWording: "Add a visible checkout status.",
  goal: "A signed-in buyer can see checkout status.",
  acceptanceCriteria: [{ id: "AC-1", text: "Status is visible", required: true, userVisible: false }],
  nonGoals: [],
  risks: [],
  environmentExpectations: [],
  stopConditions: [],
  affectedCodebaseUnits: [],
  openQuestions: [],
};

describe("Acceptance Contract boundary", () => {
  it("preserves original wording and makes criterion required explicit", () => {
    expect(parseAcceptanceContract(valid)).toEqual({ ok: true, value: valid });
  });

  it("rejects an objective with no criterion or duplicate criterion ids", () => {
    expect(parseAcceptanceContract({ ...valid, acceptanceCriteria: [] })).toMatchObject({
      ok: false,
      errors: { acceptanceCriteria: expect.any(String) },
    });
    expect(
      parseAcceptanceContract({
        ...valid,
        acceptanceCriteria: [
          valid.acceptanceCriteria[0],
          { id: "AC-1", text: "Different behavior", required: true },
        ],
      })
    ).toMatchObject({ ok: false });
  });

  it("does not let a resolved question omit its resolution", () => {
    expect(
      parseAcceptanceContract({
        ...valid,
        openQuestions: [{ id: "Q-1", text: "Which copy?", status: "resolved" }],
      })
    ).toMatchObject({ ok: false, errors: { "openQuestions.0.resolution": expect.any(String) } });
  });
});
