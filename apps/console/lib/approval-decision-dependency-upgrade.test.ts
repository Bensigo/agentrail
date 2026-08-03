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

import {
  decideDependencyUpgradeContract,
  enqueueGithubIssue,
  getDependencyUpgradeContractById,
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getDependencyUpgradeContractById).mockResolvedValue(contract as never);
  vi.mocked(decideDependencyUpgradeContract).mockResolvedValue({
    status: "approved",
    contract: { ...contract, state: "approved" },
  } as never);
  vi.mocked(publishDependencyUpgradeIssue).mockResolvedValue({
    url: "https://github.com/acme/widgets/issues/42",
    number: 42,
    body: "body",
    repoFullName: "acme/widgets",
  });
  vi.mocked(stampPublishedIssueUrl).mockResolvedValue("stamped");
});

describe("dependency upgrade approval side effect", () => {
  it("publishes and admits only after the persisted contract decision is approved", async () => {
    await applyAlignmentDecision(approval as never, "approved", {
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
    expect(publishDependencyUpgradeIssue).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      candidate: expect.objectContaining({ fingerprint: contract.candidateFingerprint }),
    }));
    expect(stampPublishedIssueUrl).toHaveBeenCalledWith("approval-1", "https://github.com/acme/widgets/issues/42");
    expect(enqueueGithubIssue).toHaveBeenCalledWith(expect.objectContaining({ number: 42 }));
  });

  it("does not publish a refusal", async () => {
    vi.mocked(decideDependencyUpgradeContract).mockResolvedValue({ status: "refused", contract: { ...contract, state: "refused" } } as never);
    await applyAlignmentDecision(approval as never, "denied");
    expect(publishDependencyUpgradeIssue).not.toHaveBeenCalled();
    expect(enqueueGithubIssue).not.toHaveBeenCalled();
  });

  it("rejects an approval whose request payload disagrees with the persisted binding", async () => {
    await applyAlignmentDecision({
      ...approval,
      toolInput: { contractId: "contract-other" },
    } as never, "approved");
    expect(getDependencyUpgradeContractById).not.toHaveBeenCalled();
    expect(decideDependencyUpgradeContract).not.toHaveBeenCalled();
    expect(publishDependencyUpgradeIssue).not.toHaveBeenCalled();
  });
});
