import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({ createDraftAcceptanceRecord: vi.fn(), getDependencyUpgradeContract: vi.fn(), getRepository: vi.fn() }));
import { createDraftAcceptanceRecord, getDependencyUpgradeContract, getRepository } from "@agentrail/db-postgres";
import { POST } from "./route";

const SECRET = "jace-secret";
const params = Promise.resolve({ contractId: "dependency-1" });
const request = (body: unknown, authenticated = true) => new NextRequest("http://localhost/api/v1/runner/dependency-upgrade-contracts/dependency-1/acceptance-record", { method: "POST", headers: { "content-type": "application/json", ...(authenticated ? { authorization: `Bearer ${SECRET}` } : {}) }, body: JSON.stringify(body) });
const proposal = { title: "Upgrade react", candidateFingerprint: "sha256:candidate", acceptanceCriteria: ["Target tests pass."], nonGoals: ["No refactor."], expectedFiles: ["package.json"], stopConditions: ["Evidence missing."], verificationCommands: ["pnpm test"], needsHumanDecision: ["release evidence missing"], candidate: { package: "react", current_version: "18.2.0", target_version: "18.3.0", baseline_sha: "a".repeat(40) } };

beforeEach(() => {
  vi.clearAllMocks(); process.env.JACE_CONSOLE_TOKEN = SECRET;
  vi.mocked(getDependencyUpgradeContract).mockResolvedValue({ id: "dependency-1", repositoryId: "repo-1", proposal, candidateFingerprint: "sha256:candidate", observationKey: "observation-1", baselineSha: "a".repeat(40) } as never);
  vi.mocked(getRepository).mockResolvedValue({ id: "repo-1", name: "ada/widgets" } as never);
  vi.mocked(createDraftAcceptanceRecord).mockResolvedValue({ record: { id: "record-1", repo: "ada/widgets" }, contract: { id: "acceptance-1", version: 1, status: "draft" } } as never);
});

describe("dependency proposal Acceptance Record materialization", () => {
  it("creates only a deterministic canonical draft and preserves unresolved evidence", async () => {
    const response = await POST(request({ workspaceId: "ws-1" }), { params });
    expect(response.status).toBe(201);
    expect(createDraftAcceptanceRecord).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "ws-1", repo: "ada/widgets", originChannel: "dependency_watch", workKey: "dependency-upgrade:dependency-1",
      contract: expect.objectContaining({ openQuestions: [{ id: "dependency-evidence-1", text: "release evidence missing", status: "open" }] }),
    }));
  });
  it("fails closed before any draft when source lookup, authentication, or proposal shape is invalid", async () => {
    expect((await POST(request({ workspaceId: "ws-1" }, false), { params })).status).toBe(401);
    vi.mocked(getDependencyUpgradeContract).mockResolvedValue(null);
    expect((await POST(request({ workspaceId: "ws-1" }), { params })).status).toBe(404);
    vi.mocked(getDependencyUpgradeContract).mockResolvedValue({ id: "dependency-1", repositoryId: "repo-1", proposal: {}, candidateFingerprint: "sha", observationKey: "key", baselineSha: "a" } as never);
    expect((await POST(request({ workspaceId: "ws-1" }), { params })).status).toBe(409);
    expect(createDraftAcceptanceRecord).not.toHaveBeenCalled();
  });
});
