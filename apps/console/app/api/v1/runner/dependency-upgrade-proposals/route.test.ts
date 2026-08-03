import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  attachDependencyUpgradeApproval: vi.fn(),
  createOrGetDependencyUpgradeContract: vi.fn(),
  findDependencyCandidate: vi.fn(),
  getDependencyUpgradeContract: vi.fn(),
  latestTelegramSessionForWorkspace: vi.fn(),
  recordDependencyUpgradeContractEvent: vi.fn(),
  refreshDependencyUpgradeContractProposal: vi.fn(),
  recordApprovalRequest: vi.fn(),
  validateAcceptanceCriteria: vi.fn(() => ({ ok: true, criteria: ["AC1"] })),
}));
vi.mock("../../../../../lib/approval-message", () => ({ renderApprovalMessage: vi.fn(() => "approval") }));
vi.mock("../../workspaces/[workspaceId]/connectors/secret/telegram", () => ({
  buildApprovalKeyboard: vi.fn(() => ({ inline_keyboard: [] })),
  sendTelegramMessage: vi.fn(async () => ({ ok: true })),
}));

import {
  attachDependencyUpgradeApproval,
  createOrGetDependencyUpgradeContract,
  findDependencyCandidate,
  getDependencyUpgradeContract,
  latestTelegramSessionForWorkspace,
  recordDependencyUpgradeContractEvent,
  refreshDependencyUpgradeContractProposal,
  recordApprovalRequest,
} from "@agentrail/db-postgres";
import { POST } from "./route";
import { computeDependencyCandidateFingerprint } from "../../../../../lib/dependency-upgrade-contract";

const SECRET = "jace-secret";
const candidate = {
  package: "react",
  dependency_kind: "dependencies",
  specifier: "^18.0.0",
  current_version: "18.2.0",
  target_version: "18.3.0",
  manifest_path: "package.json",
  lockfile_path: "pnpm-lock.yaml",
  baseline_sha: "a".repeat(40),
  fingerprint: "",
};
candidate.fingerprint = computeDependencyCandidateFingerprint(candidate);
const contract = { id: "contract-1", state: "needs-human-decision", approvalId: null };

function request(body: unknown, auth = true) {
  return new NextRequest("http://localhost/api/v1/runner/dependency-upgrade-proposals", {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { Authorization: `Bearer ${SECRET}` } : {}) },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JACE_CONSOLE_TOKEN = SECRET;
  vi.mocked(findDependencyCandidate).mockResolvedValue({ observationId: "obs", watchId: "watch", repositoryId: "repo", observationKey: "key", baselineSha: candidate.baseline_sha, candidate } as never);
  vi.mocked(createOrGetDependencyUpgradeContract).mockResolvedValue({ contract, created: true } as never);
  vi.mocked(getDependencyUpgradeContract).mockResolvedValue(contract as never);
  vi.mocked(latestTelegramSessionForWorkspace).mockResolvedValue(null as never);
  vi.mocked(recordDependencyUpgradeContractEvent).mockResolvedValue({} as never);
});

describe("dependency candidate proposal boundary", () => {
  it("fails closed without the Jace secret", async () => {
    const response = await POST(request({ workspaceId: "ws", watchId: "watch", candidateFingerprint: candidate.fingerprint }, false));
    expect(response.status).toBe(401);
    expect(findDependencyCandidate).not.toHaveBeenCalled();
  });

  it("never trusts a candidate supplied by the caller", async () => {
    vi.mocked(findDependencyCandidate).mockResolvedValue(null);
    const response = await POST(request({ workspaceId: "ws", watchId: "watch", candidateFingerprint: "sha256:forged" }));
    expect(response.status).toBe(409);
    expect(createOrGetDependencyUpgradeContract).not.toHaveBeenCalled();
  });

  it("persists an incomplete proposal as needs-human-decision and creates no approval", async () => {
    const response = await POST(request({ workspaceId: "ws", watchId: "watch", candidateFingerprint: candidate.fingerprint }));
    expect(response.status).toBe(202);
    expect(createOrGetDependencyUpgradeContract).toHaveBeenCalledWith(expect.objectContaining({ state: "needs-human-decision" }));
    expect(recordApprovalRequest).not.toHaveBeenCalled();
  });

  it("creates one candidate-bound approval only after complete evidence is present", async () => {
    const proposedContract = { id: "contract-1", state: "proposed", approvalId: null };
    vi.mocked(createOrGetDependencyUpgradeContract).mockResolvedValue({ contract: proposedContract, created: true } as never);
    vi.mocked(latestTelegramSessionForWorkspace).mockResolvedValue({
      id: "session-1", eveSessionId: "eve-1", chatIdentityId: "chat-1", channel: "telegram", conversationKey: "chat",
    } as never);
    vi.mocked(recordApprovalRequest).mockResolvedValue({
      created: true,
      approval: { id: "approval-1", callbackToken: "callback", status: "pending" },
    } as never);
    vi.mocked(attachDependencyUpgradeApproval).mockResolvedValue({
      ...proposedContract, approvalId: "approval-1",
    } as never);
    vi.mocked(getDependencyUpgradeContract).mockResolvedValue({
      ...proposedContract, approvalId: "approval-1",
    } as never);

    const response = await POST(request({
      workspaceId: "ws",
      watchId: "watch",
      candidateFingerprint: candidate.fingerprint,
      evidence: {
        releaseEvidence: ["https://github.com/facebook/react/releases/tag/v18.3.0"],
        usageScope: ["Direct imports are limited to the web package."],
        transitiveCompatibility: "The target lock resolution has no peer conflicts.",
        security: "No known advisories after review.",
        baselineTests: ["pnpm test -- --runInBand"],
        targetTests: ["pnpm test -- --runInBand"],
      },
    }));

    expect(response.status).toBe(201);
    expect(recordApprovalRequest).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "dependency_upgrade_contract",
      dependencyContractId: "contract-1",
      requestId: `dependency-upgrade:${candidate.fingerprint}`,
    }));
    expect(refreshDependencyUpgradeContractProposal).not.toHaveBeenCalled();
  });

  it("reuses an existing approval on a duplicate proposal request", async () => {
    const proposedContract = { id: "contract-1", state: "proposed", approvalId: "approval-1" };
    vi.mocked(createOrGetDependencyUpgradeContract).mockResolvedValue({ contract: proposedContract, created: false } as never);
    const response = await POST(request({
      workspaceId: "ws", watchId: "watch", candidateFingerprint: candidate.fingerprint,
      evidence: {
        releaseEvidence: ["https://github.com/facebook/react/releases/tag/v18.3.0"],
        usageScope: ["Direct imports are limited to the web package."],
        transitiveCompatibility: "No peer conflicts.",
        security: "No known advisories.",
        baselineTests: ["pnpm test"],
        targetTests: ["pnpm test"],
      },
    }));
    expect(response.status).toBe(200);
    expect(recordApprovalRequest).not.toHaveBeenCalled();
    expect(latestTelegramSessionForWorkspace).not.toHaveBeenCalled();
  });
});
