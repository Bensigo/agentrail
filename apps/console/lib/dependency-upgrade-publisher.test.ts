import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@agentrail/db-postgres", () => ({
  getConnector: vi.fn(),
  getApprovalById: vi.fn(),
  getInstallationToken: vi.fn(),
  getRepository: vi.fn(),
}));

import { getApprovalById, getConnector, getInstallationToken, getRepository } from "@agentrail/db-postgres";
import { buildDependencyUpgradeProposal, computeDependencyCandidateFingerprint } from "./dependency-upgrade-contract";
import { publishDependencyUpgradeIssue } from "./dependency-upgrade-publisher";

const candidate = {
  package: "react",
  dependency_kind: "dependencies",
  specifier: "^18.2.0",
  current_version: "18.2.0",
  target_version: "18.3.1",
  manifest_path: "package.json",
  lockfile_path: "pnpm-lock.yaml",
  baseline_sha: "abc123",
  fingerprint: "sha256:candidate-1",
};
candidate.fingerprint = computeDependencyCandidateFingerprint(candidate);

const proposal = buildDependencyUpgradeProposal(candidate, {
  releaseEvidence: ["https://github.com/facebook/react/releases/tag/v18.3.1"],
  usageScope: ["Direct imports in the web package."],
  transitiveCompatibility: "No peer conflicts.",
  security: "No known advisories.",
  baselineTests: ["pnpm test"],
  targetTests: ["pnpm test"],
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getApprovalById).mockResolvedValue({
    id: "approval-1", workspaceId: "ws-1", status: "approved",
    toolName: "dependency_upgrade_contract", dependencyContractId: "contract-1",
  } as never);
  vi.mocked(getRepository).mockResolvedValue({ url: "https://github.com/acme/widgets" } as never);
  vi.mocked(getInstallationToken).mockResolvedValue("installation-token");
  vi.mocked(getConnector).mockResolvedValue({ config: { triggerLabel: "ready-for-agent" } } as never);
});

describe("publishDependencyUpgradeIssue", () => {
  it("publishes only the server-built house-format issue with the trigger label", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ html_url: "https://github.com/acme/widgets/issues/42", number: 42 }), {
          status: 201,
          headers: { "content-type": "application/json" },
        })
      );

    const result = await publishDependencyUpgradeIssue({
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      approvalId: "approval-1",
      contractId: "contract-1",
      candidate,
      proposal,
      fetchImpl,
    });

    expect(result).toEqual(expect.objectContaining({
      url: "https://github.com/acme/widgets/issues/42",
      number: 42,
      repoFullName: "acme/widgets",
    }));
    const init = fetchImpl.mock.calls[1]?.[1] as RequestInit;
    const payload = JSON.parse(String(init.body));
    expect(payload.labels).toEqual(["ready-for-agent"]);
    expect(payload.body).toContain(`Candidate fingerprint: ${candidate.fingerprint}`);
    expect(payload.body).toMatch(/- \[ \] AC1:/);
  });

  it("fails closed when the GitHub response is rejected", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    await expect(
      publishDependencyUpgradeIssue({ workspaceId: "ws-1", repositoryId: "repo-1", approvalId: "approval-1", contractId: "contract-1", candidate, proposal, fetchImpl })
    ).rejects.toThrow("GitHub rejected");
  });

  it("rejects a proposal that is not bound to the observed candidate", async () => {
    await expect(
      publishDependencyUpgradeIssue({
        workspaceId: "ws-1",
        repositoryId: "repo-1",
        approvalId: "approval-1",
        contractId: "contract-1",
        candidate,
        proposal: { ...proposal, candidateFingerprint: "sha256:other" },
        fetchImpl: vi.fn(),
      })
    ).rejects.toThrow("not bound");
  });

  it("fails closed when no approved candidate-bound approval exists", async () => {
    vi.mocked(getApprovalById).mockResolvedValue(null);
    await expect(
      publishDependencyUpgradeIssue({
        workspaceId: "ws-1", repositoryId: "repo-1", approvalId: "approval-1", contractId: "contract-1",
        candidate, proposal, fetchImpl: vi.fn(),
      })
    ).rejects.toThrow("requires the approved candidate-bound");
  });
});
