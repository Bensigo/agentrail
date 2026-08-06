import { describe, expect, it } from "vitest";
import { hasOpenAcceptanceQuestions } from "./change_records.js";

describe("hasOpenAcceptanceQuestions", () => {
  it("permits contracts without questions or with resolved questions", () => {
    expect(hasOpenAcceptanceQuestions({ goal: "Save" })).toBe(false);
    expect(hasOpenAcceptanceQuestions({
      openQuestions: [{ id: "Q-1", text: "Which account?", status: "resolved", resolution: "Primary" }],
    })).toBe(false);
  });

  it("fails closed for open or malformed question data", () => {
    expect(hasOpenAcceptanceQuestions({
      openQuestions: [{ id: "Q-1", text: "Which account?", status: "open" }],
    })).toBe(true);
    expect(hasOpenAcceptanceQuestions({ openQuestions: [{ id: "Q-1" }] })).toBe(true);
    expect(hasOpenAcceptanceQuestions({ openQuestions: "not-an-array" })).toBe(true);
  });
});
