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
  it("returns persisted plan and exact PR coordinates", async () => {
    vi.mocked(claimEvidenceVerificationExecution).mockResolvedValue({ execution: { id: "e", verificationPlanId: "p" }, plan: { criterionId: "saved", modality: "ui", environmentId: "preview", flow: "save", expectedBehavior: "Saved" }, repositoryFullName: "a/b", prNumber: 1, headSha: "head" } as never);
    const response = await POST(request({ workerId: "worker" }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ plan: { criterionId: "saved" }, pr: { headSha: "head" } });
  });
});
