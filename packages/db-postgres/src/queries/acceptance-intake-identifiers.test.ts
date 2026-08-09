import { describe, expect, it } from "vitest";
import {
  acceptanceIntakeId,
  acceptanceIntakeMessageId,
} from "./change_records.js";

describe("Acceptance Intake identifiers", () => {
  it("is deterministic per workspace, canonical channel, and conversation", () => {
    const intake = acceptanceIntakeId({
      workspaceId: "workspace-1",
      originChannel: "slack",
      conversationKey: "thread-1",
    });
    expect(
      acceptanceIntakeId({
        workspaceId: "workspace-1",
        originChannel: "slack",
        conversationKey: "thread-1",
      })
    ).toBe(intake);
    expect(
      acceptanceIntakeId({
        workspaceId: "workspace-1",
        originChannel: "mcp",
        conversationKey: "thread-1",
      })
    ).not.toBe(intake);
    expect(
      acceptanceIntakeMessageId({ intakeId: intake, sourceKey: "message-1" })
    ).not.toBe(
      acceptanceIntakeMessageId({ intakeId: intake, sourceKey: "message-2" })
    );
  });
});
