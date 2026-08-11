import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@agentrail/db-postgres", () => ({
  confirmAlignmentBrief: vi.fn(),
  decideDependencyUpgradeContract: vi.fn(),
  denyAlignmentBrief: vi.fn(),
  enqueueGithubIssue: vi.fn(),
  getDependencyUpgradeContractById: vi.fn(),
  recordDependencyUpgradeContractEvent: vi.fn(),
  setDependencyUpgradeContractState: vi.fn(),
  stampPublishedIssueUrl: vi.fn(),
  validateAcceptanceCriteria: vi.fn(() => ({ ok: true, criteria: ["AC1"] })),
}));
vi.mock("./dependency-upgrade-publisher", () => ({
  publishDependencyUpgradeIssue: vi.fn(),
}));
vi.mock("./alignment-brief", () => ({
  extractConfirmedBudgetAndModel: vi.fn(),
}));

import {
  decideDependencyUpgradeContract,
  enqueueGithubIssue,
  getDependencyUpgradeContractById,
  recordDependencyUpgradeContractEvent,
  setDependencyUpgradeContractState,
  stampPublishedIssueUrl,
} from "@agentrail/db-postgres";
import { publishDependencyUpgradeIssue } from "./dependency-upgrade-publisher";
import { applyAlignmentDecision } from "./approval-decision";

const contract = {
  id: "contract-1",
  workspaceId: "ws-1",
  repositoryId: "repo-1",
  watchId: "watch-1",
  approvalId: "approval-1",
  state: "proposed",
  packageName: "react",
  dependencyKind: "dependencies",
  specifier: "^18.2.0",
  currentVersion: "18.2.0",
  targetVersion: "18.3.1",
  manifestPath: "package.json",
  lockfilePath: "pnpm-lock.yaml",
  baselineSha: "sha-old",
  candidateFingerprint: "sha256:candidate-1",
  proposal: { title: "Upgrade react" },
};

const approval = {
  id: "approval-1",
  workspaceId: "ws-1",
  toolName: "dependency_upgrade_contract",
  toolInput: { contractId: "contract-1", candidateFingerprint: contract.candidateFingerprint },
  dependencyContractId: "contract-1",
  chatIdentityId: null,
  queueEntryId: null,
};

function expectNoLegacyDeliverySideEffects() {
  expect(publishDependencyUpgradeIssue).not.toHaveBeenCalled();
  expect(stampPublishedIssueUrl).not.toHaveBeenCalled();
  expect(enqueueGithubIssue).not.toHaveBeenCalled();
  expect(setDependencyUpgradeContractState).not.toHaveBeenCalled();
  expect(recordDependencyUpgradeContractEvent).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getDependencyUpgradeContractById).mockResolvedValue(contract as never);
  vi.mocked(decideDependencyUpgradeContract).mockResolvedValue({
    status: "approved",
    contract: { ...contract, state: "approved" },
  } as never);
  vi.mocked(publishDependencyUpgradeIssue).mockRejectedValue(
    new Error("legacy publisher must never be reached")
  );
});

describe("legacy dependency upgrade approval quarantine", () => {
  it("records approval truth but never publishes or queues legacy dependency work", async () => {
    const result = await applyAlignmentDecision(approval as never, "approved", {
      actorType: "console_user",
      actorId: "user-1",
    });

    expect(decideDependencyUpgradeContract).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "ws-1",
      contractId: "contract-1",
      approvalId: "approval-1",
      decision: "approved",
      actor: { actorType: "console_user", actorId: "user-1" },
    }));
    expect(result).toEqual({
      kind: "dependency_contract_quarantined",
      decision: "approved",
      contractId: "contract-1",
      reason: "legacy_dependency_contract_requires_r10_2_pack",
      resolution: "approved",
    });
    expectNoLegacyDeliverySideEffects();
  });

  it("retains denied and replayed decision truth without external side effects", async () => {
    vi.mocked(decideDependencyUpgradeContract).mockResolvedValue({
      status: "already_resolved",
      contract: { ...contract, state: "refused" },
    } as never);

    const result = await applyAlignmentDecision(approval as never, "denied");

    expect(result).toEqual(expect.objectContaining({
      kind: "dependency_contract_quarantined",
      decision: "denied",
      resolution: "already_resolved",
    }));
    expectNoLegacyDeliverySideEffects();
  });

  it("quarantines an invalid persisted binding without resolving or delivering it", async () => {
    const result = await applyAlignmentDecision({
      ...approval,
      toolInput: { contractId: "contract-other" },
    } as never, "approved");

    expect(result).toEqual({
      kind: "dependency_contract_quarantined",
      decision: "approved",
      contractId: "contract-1",
      reason: "legacy_dependency_contract_binding_is_invalid",
    });
    expect(getDependencyUpgradeContractById).not.toHaveBeenCalled();
    expect(decideDependencyUpgradeContract).not.toHaveBeenCalled();
    expectNoLegacyDeliverySideEffects();
  });

  it("quarantines missing or cross-workspace contracts and never reaches the publisher", async () => {
    vi.mocked(getDependencyUpgradeContractById).mockResolvedValue({
      ...contract,
      workspaceId: "workspace-other",
    } as never);

    const result = await applyAlignmentDecision(approval as never, "approved");

    expect(result).toEqual({
      kind: "dependency_contract_quarantined",
      decision: "approved",
      contractId: "contract-1",
      reason: "legacy_dependency_contract_is_unavailable",
    });
    expect(decideDependencyUpgradeContract).not.toHaveBeenCalled();
    expectNoLegacyDeliverySideEffects();
  });
});
