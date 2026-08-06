import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("@agentrail/db-postgres", () => ({ claimEvidenceVerificationExecution: vi.fn() }));
import { claimEvidenceVerificationExecution } from "@agentrail/db-postgres";
import { POST } from "./route";
const secret = "secret";
const request = (body: unknown, auth = true) => new NextRequest("http://localhost", { method: "POST", headers: { "content-type": "application/json", ...(auth ? { Authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify(body) });
beforeEach(() => { vi.clearAllMocks(); process.env.JACE_CONSOLE_TOKEN = secret; vi.mocked(claimEvidenceVerificationExecution).mockResolvedValue(null); });
describe("criterion execution claim", () => {
  it("returns no work cleanly and rejects a missing worker", async () => {
    expect((await POST(request({ workerId: "worker" }))).status).toBe(204);
    expect((await POST(request({}))).status).toBe(400);
  });
  it("returns persisted plan, exact PR coordinates, and only a resolved preview", async () => {
    const uiSteps = [{ action: "open", path: "/drafts/new" }, { action: "click", selector: "[data-testid=save]" }];
    vi.mocked(claimEvidenceVerificationExecution).mockResolvedValue({ workspaceId: "ws", execution: { id: "e", verificationPlanId: "p" }, plan: { recordId: "record", prRevisionId: "revision", criterionId: "saved", modality: "ui", environmentId: "preview", flow: "save", uiSteps, expectedBehavior: "Saved" }, repositoryFullName: "a/b", prNumber: 1, headSha: "head", previewUrl: "http://safe-preview" } as never);
    const response = await POST(request({ workerId: "worker" }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ workspaceId: "ws", plan: { criterionId: "saved", recordId: "record", prRevisionId: "revision", uiSteps }, pr: { headSha: "head" }, previewUrl: "http://safe-preview" });
  });
  it("returns the immutable API descriptor only from the claimed plan", async () => {
    vi.mocked(claimEvidenceVerificationExecution).mockResolvedValue({ execution: { id: "e", verificationPlanId: "p" }, plan: { criterionId: "audit", modality: "api", environmentId: "preview", flow: "read audit", apiRequest: { method: "GET", path: "/api/audit", expectedStatus: 200 }, expectedBehavior: "Audit recorded" }, repositoryFullName: "a/b", prNumber: 1, headSha: "head", previewUrl: "http://safe-preview" } as never);
    const response = await POST(request({ workerId: "worker" }));
    await expect(response.json()).resolves.toMatchObject({ plan: { modality: "api", apiRequest: { method: "GET", path: "/api/audit", expectedStatus: 200 } } });
  });

  it("returns the immutable data descriptor only from the claimed plan", async () => {
    const dataRequest = { method: "GET", path: "/api/account", expectedStatus: 200, expectedJson: [{ pointer: "/enabled", equals: true }] };
    vi.mocked(claimEvidenceVerificationExecution).mockResolvedValue({ execution: { id: "e", verificationPlanId: "p" }, plan: { criterionId: "account", modality: "data", environmentId: "preview", flow: "read account", dataRequest, expectedBehavior: "Account is enabled" }, repositoryFullName: "a/b", prNumber: 1, headSha: "head", previewUrl: "http://safe-preview" } as never);
    const response = await POST(request({ workerId: "worker" }));
    await expect(response.json()).resolves.toMatchObject({ plan: { modality: "data", dataRequest } });
  });
});
