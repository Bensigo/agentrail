import { describe, expect, it } from "vitest";
import { acceptanceContextPackRepositoryRefMatches, acceptanceIntakeId, acceptanceIntakeMessageId, hasOpenAcceptanceQuestions, validateAcceptancePrDecision } from "./change_records.js";

describe("acceptance Context Pack repository binding", () => {
  it("accepts only the exact non-empty compilation ref", () => {
    expect(acceptanceContextPackRepositoryRefMatches({ repositoryRef: "main" }, "main")).toBe(true);
    expect(acceptanceContextPackRepositoryRefMatches({ repositoryRef: "other-ref" }, "main")).toBe(false);
    expect(acceptanceContextPackRepositoryRefMatches({}, "main")).toBe(false);
  });
});

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

describe("Acceptance Record final PR decisions", () => {
  it("requires an explicit rationale for an exception and keeps the decision vocabulary bounded", () => {
    expect(validateAcceptancePrDecision({ decision: "approved" })).toBe(true);
    expect(validateAcceptancePrDecision({ decision: "changes_requested" })).toBe(true);
    expect(validateAcceptancePrDecision({ decision: "approved_with_exception" })).toBe(false);
    expect(validateAcceptancePrDecision({ decision: "approved_with_exception", rationale: "Production incident mitigation requires this release." })).toBe(true);
    expect(validateAcceptancePrDecision({ decision: "merge_now" })).toBe(false);
  });
});

describe("Acceptance Intake identities", () => {
  it("is stable per workspace/channel/conversation and isolates source messages", () => {
    const intake = acceptanceIntakeId({ workspaceId: "workspace-1", originChannel: "slack", conversationKey: "thread-1" });
    expect(acceptanceIntakeId({ workspaceId: "workspace-1", originChannel: "slack", conversationKey: "thread-1" })).toBe(intake);
    expect(acceptanceIntakeId({ workspaceId: "workspace-1", originChannel: "slack", conversationKey: "thread-2" })).not.toBe(intake);
    expect(acceptanceIntakeMessageId({ intakeId: intake, sourceKey: "message-1" })).not.toBe(
      acceptanceIntakeMessageId({ intakeId: intake, sourceKey: "message-2" }),
    );
  });
});
