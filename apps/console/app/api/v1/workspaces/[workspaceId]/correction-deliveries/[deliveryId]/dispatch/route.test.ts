import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({ auth: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({
  claimEvidenceReviewCorrectionDeliveryForGithubDispatch: vi.fn(), getInstallationToken: vi.fn(),
  getWorkspaceMembership: vi.fn(), reportEvidenceReviewCorrectionGithubDispatch: vi.fn(),
}));
import { auth } from "@agentrail/auth";
import { claimEvidenceReviewCorrectionDeliveryForGithubDispatch, getInstallationToken, getWorkspaceMembership, reportEvidenceReviewCorrectionGithubDispatch } from "@agentrail/db-postgres";
import { formatGithubCorrection, POST } from "./route";

const WS = "ws";
const DELIVERY = "delivery";
const params = Promise.resolve({ workspaceId: WS, deliveryId: DELIVERY });
const item = {
  delivery: { target: { repo: "org/repo", prNumber: 8 } }, attempt: 1,
  correction: { criterionId: "save", scopeBoundary: "confirmed contract", expectedBehavior: "saved", observedBehavior: "lost", evidenceRefs: [{ path: "app.ts", startLine: 9, endLine: 10, detail: "write is skipped" }], concreteImpact: "data loss", requiredCorrection: "persist before response", reverification: "save then reload", repairPath: null },
  criterion: { runtimeEvidence: [{ environmentId: "preview", artifactRef: "artifact-1" }] },
  revision: { id: "revision", headSha: "abc" }, pr: { repositoryFullName: "org/repo", prNumber: 8 },
};
const request = () => new NextRequest(`http://localhost/api/v1/workspaces/${WS}/correction-deliveries/${DELIVERY}/dispatch`, { method: "POST" });

describe("GitHub correction dispatch", () => {
  beforeEach(() => {
    vi.restoreAllMocks(); vi.clearAllMocks();
    vi.mocked(auth).mockResolvedValue({ user: { id: "user" } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ role: "owner" } as never);
    vi.mocked(claimEvidenceReviewCorrectionDeliveryForGithubDispatch).mockResolvedValue(item as never);
    vi.mocked(getInstallationToken).mockResolvedValue("token");
    vi.mocked(reportEvidenceReviewCorrectionGithubDispatch).mockResolvedValue({ id: DELIVERY, outcome: "delivered", attempt: 1, attemptedAt: new Date("2026-08-06T00:00:00Z") } as never);
  });

  it("posts the exact evidence-bound packet as a comment and records delivery", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: 3 }), { status: 201 }));
    const response = await POST(request(), { params });
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith("https://api.github.com/repos/org/repo/issues/8/comments", expect.objectContaining({ method: "POST" }));
    const sent = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(sent.body).toContain("Exact revision: PR #8, head `abc`");
    expect(sent.body).toContain("Environment: preview; artifact: artifact-1");
    expect(reportEvidenceReviewCorrectionGithubDispatch).toHaveBeenCalledWith(expect.objectContaining({ outcome: "delivered", reviewRevisionId: "revision" }));
  });

  it("records a failed attempt when GitHub rejects the comment", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("no", { status: 403 }));
    const response = await POST(request(), { params });
    expect(response.status).toBe(502);
    expect(reportEvidenceReviewCorrectionGithubDispatch).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed", detail: expect.stringContaining("HTTP 403") }));
  });

  it("formats all required correction fields without claiming a merge", () => {
    const text = formatGithubCorrection(item);
    for (const expected of ["confirmed contract", "Expected: saved", "Observed: lost", "Impact: data loss", "Required correction: persist before response", "Re-verification: save then reload"]) expect(text).toContain(expected);
    expect(text).toContain("has not changed code, approved this PR, or merged it");
  });
});
