import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  createDraftAcceptanceRecord: vi.fn(),
  createOrGetDependencyUpgradeContract: vi.fn(),
  findDependencyCandidate: vi.fn(),
  getRepository: vi.fn(),
  refreshDependencyUpgradeContractProposal: vi.fn(),
  validateAcceptanceCriteria: vi.fn(() => ({ ok: true, criteria: ["AC1"] })),
}));

import {
  createDraftAcceptanceRecord,
  createOrGetDependencyUpgradeContract,
  findDependencyCandidate,
  getRepository,
  refreshDependencyUpgradeContractProposal,
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
const contract = {
  id: "contract-1", repositoryId: "repo", state: "needs-human-decision", approvalId: null,
  candidateFingerprint: candidate.fingerprint, observationKey: "key", baselineSha: candidate.baseline_sha,
};

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
  vi.mocked(createOrGetDependencyUpgradeContract).mockImplementation(async (input: any) => ({ contract: { ...contract, proposal: input.proposal }, created: true }) as never);
  vi.mocked(getRepository).mockResolvedValue({ id: "repo", name: "ada/widgets" } as never);
  vi.mocked(createDraftAcceptanceRecord).mockResolvedValue({ record: { id: "record-1", repo: "ada/widgets" }, contract: { id: "acceptance-1", version: 1, status: "draft" } } as never);
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

  it("persists incomplete evidence as a canonical draft with open questions", async () => {
    const response = await POST(request({ workspaceId: "ws", watchId: "watch", candidateFingerprint: candidate.fingerprint }));
    expect(response.status).toBe(201);
    expect(createOrGetDependencyUpgradeContract).toHaveBeenCalledWith(expect.objectContaining({
      state: "needs-human-decision",
      observationKey: "key",
    }));
    expect(createDraftAcceptanceRecord).toHaveBeenCalledWith(expect.objectContaining({
      workKey: "dependency-upgrade:contract-1",
      originChannel: "dependency_watch",
      contract: expect.objectContaining({ openQuestions: expect.any(Array) }),
    }));
  });

  it("keeps unsupported evidence visible and routes the proposal to needs-human-decision", async () => {
    const response = await POST(request({
      workspaceId: "ws",
      watchId: "watch",
      candidateFingerprint: candidate.fingerprint,
      evidence: {
        releaseEvidence: [null, "https://github.com/facebook/react/releases/tag/v18.3.0"],
        usageScope: ["Direct imports are limited to the web package."],
        transitiveCompatibility: "The target lock resolution has no peer conflicts.",
        security: "No known advisories after review.",
        baselineTests: ["pnpm test -- --runInBand"],
        targetTests: ["pnpm test -- --runInBand"],
      },
    }));
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(createOrGetDependencyUpgradeContract).toHaveBeenCalledWith(expect.objectContaining({
      state: "needs-human-decision",
      observationKey: "key",
    }));
    expect(payload.needsHumanDecision).toEqual(expect.arrayContaining([
      expect.stringContaining("releaseEvidence contains unsupported evidence"),
    ]));
    expect(createDraftAcceptanceRecord).toHaveBeenCalledWith(expect.objectContaining({
      contract: expect.objectContaining({ openQuestions: expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining("releaseEvidence contains unsupported evidence") }),
      ]) }),
    }));
  });

  it("uses complete evidence only to create a deterministic Acceptance Record, never an approval", async () => {
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
    expect(createDraftAcceptanceRecord).toHaveBeenCalledWith(expect.objectContaining({
      workKey: "dependency-upgrade:contract-1",
      sourceReferences: [expect.objectContaining({ candidateFingerprint: candidate.fingerprint, observationKey: "key" })],
    }));
    expect(refreshDependencyUpgradeContractProposal).toHaveBeenCalledWith(expect.objectContaining({
      contractId: "contract-1",
      workspaceId: "ws",
    }));
  });

  it("fails closed when the candidate cannot be mapped to a connected repository", async () => {
    vi.mocked(getRepository).mockResolvedValue(null as never);
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
    expect(response.status).toBe(409);
    expect(createDraftAcceptanceRecord).not.toHaveBeenCalled();
  });
});
