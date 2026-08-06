import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  claimAcceptanceEvidenceReviewRequest: vi.fn(),
  getInstallationToken: vi.fn(),
}));
import { claimAcceptanceEvidenceReviewRequest, getInstallationToken } from "@agentrail/db-postgres";
import { POST } from "./route";

const SECRET = "jace-shared-secret";
const originalSecret = process.env.JACE_CONSOLE_TOKEN;
function request(body: unknown, authorized = true) {
  return new NextRequest("http://localhost/api/v1/runner/acceptance-evidence-review-requests/claim", {
    method: "POST",
    headers: { "content-type": "application/json", ...(authorized ? { Authorization: `Bearer ${SECRET}` } : {}) },
    body: JSON.stringify(body),
  });
}

const claimed = {
  request: {
    id: "review-request-1", workspaceId: "ws-1", recordId: "record-1", prRevisionId: "revision-1",
    acceptanceContractId: "contract-1", acceptanceContractVersion: 2, headSha: "a".repeat(40), attempts: 1,
  },
  contract: { id: "contract-1", version: 2, contract: { goal: "Save a draft" } },
  pr: { repositoryFullName: "ada/widgets", prNumber: 42, prUrl: "https://github.com/ada/widgets/pull/42", headSha: "a".repeat(40) },
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JACE_CONSOLE_TOKEN = SECRET;
});
afterEach(() => {
  if (originalSecret === undefined) delete process.env.JACE_CONSOLE_TOKEN;
  else process.env.JACE_CONSOLE_TOKEN = originalSecret;
});

describe("POST Acceptance Review request claim", () => {
  it("requires the Jace worker secret before reading a request", async () => {
    expect((await POST(request({ workerId: "reviewer-1" }, false))).status).toBe(401);
    expect(claimAcceptanceEvidenceReviewRequest).not.toHaveBeenCalled();
  });

  it("requires a worker identity and reports an empty queue without inventing a review", async () => {
    expect((await POST(request({}))).status).toBe(400);
    vi.mocked(claimAcceptanceEvidenceReviewRequest).mockResolvedValue(null as never);
    expect((await POST(request({ workerId: "reviewer-1" }))).status).toBe(204);
    expect(claimAcceptanceEvidenceReviewRequest).toHaveBeenLastCalledWith({ workerId: "reviewer-1" });
  });

  it("returns only the current request, contract, exact PR identity, and ephemeral token", async () => {
    vi.mocked(claimAcceptanceEvidenceReviewRequest).mockResolvedValue(claimed as never);
    vi.mocked(getInstallationToken).mockResolvedValue("ghs-ephemeral-token" as never);
    const response = await POST(request({ workerId: "reviewer-1" }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      request: {
        id: "review-request-1", workspaceId: "ws-1", recordId: "record-1", prRevisionId: "revision-1",
        acceptanceContractId: "contract-1", acceptanceContractVersion: 2, headSha: "a".repeat(40), attempts: 1,
      },
      contract: { id: "contract-1", version: 2, contract: { goal: "Save a draft" } },
      pr: { repositoryFullName: "ada/widgets", prNumber: 42, prUrl: "https://github.com/ada/widgets/pull/42", headSha: "a".repeat(40) },
      githubToken: "ghs-ephemeral-token",
      note: "Claimed is not a review verdict. Fetch and inspect only this exact PR head; completion remains separately validated and may emit only evidence-bound blockers.",
    });
    expect(getInstallationToken).toHaveBeenCalledWith("ws-1");
  });
});
