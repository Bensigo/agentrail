import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@agentrail/db-postgres", () => ({
  confirmAlignmentBrief: vi.fn(),
  denyAlignmentBrief: vi.fn(),
}));

vi.mock("./dependency-upgrade-publisher", () => ({
  publishDependencyUpgradeIssue: vi.fn(),
}));

import { confirmAlignmentBrief, denyAlignmentBrief } from "@agentrail/db-postgres";
import { publishDependencyUpgradeIssue } from "./dependency-upgrade-publisher";
import { applyAlignmentDecision } from "./approval-decision";

const legacyApproval = {
  id: "approval-1",
  workspaceId: "ws-1",
  toolName: "dependency_upgrade_contract",
  toolInput: { contractId: "contract-1" },
  dependencyContractId: "contract-1",
  queueEntryId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("legacy dependency approval side effect", () => {
  it("does nothing for dependency_upgrade_contract rows", async () => {
    await applyAlignmentDecision(legacyApproval as never, "approved");

    expect(confirmAlignmentBrief).not.toHaveBeenCalled();
    expect(denyAlignmentBrief).not.toHaveBeenCalled();
    expect(publishDependencyUpgradeIssue).not.toHaveBeenCalled();
  });

  it("does nothing for any approval carrying a dependency contract marker", async () => {
    await applyAlignmentDecision({
      ...legacyApproval,
      toolName: "create_issue",
    } as never, "denied");

    expect(confirmAlignmentBrief).not.toHaveBeenCalled();
    expect(denyAlignmentBrief).not.toHaveBeenCalled();
    expect(publishDependencyUpgradeIssue).not.toHaveBeenCalled();
  });
});
