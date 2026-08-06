import { describe, expect, it } from "vitest";
import { acceptanceIntakeId, acceptanceIntakeMessageId, hasOpenAcceptanceQuestions } from "./change_records.js";

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
