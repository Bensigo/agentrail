import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("@agentrail/db-postgres", () => ({ reportEvidenceVerificationExecution: vi.fn() }));
import { reportEvidenceVerificationExecution } from "@agentrail/db-postgres";
import { POST } from "./route";
const secret = "secret";
const params = Promise.resolve({ executionId: "execution" });
const request = (body: unknown, auth = true) => new NextRequest("http://localhost", { method: "POST", headers: { "content-type": "application/json", ...(auth ? { Authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify(body) });
beforeEach(() => { vi.clearAllMocks(); process.env.JACE_CONSOLE_TOKEN = secret; vi.mocked(reportEvidenceVerificationExecution).mockResolvedValue({ id: "execution", status: "proven", artifactIds: ["artifact"] } as never); });
describe("verification execution completion", () => {
  it("requires bound runtime evidence before accepting proven", async () => { expect((await POST(request({ workerId: "worker", status: "proven" }), { params })).status).toBe(400); const response = await POST(request({ workerId: "worker", status: "proven", observedBehavior: "saved", artifactIds: ["artifact"] }), { params }); expect(response.status).toBe(200); expect(reportEvidenceVerificationExecution).toHaveBeenCalledWith(expect.objectContaining({ executionId: "execution", artifactIds: ["artifact"] })); });
  it("fails closed without runner auth", async () => { expect((await POST(request({ workerId: "worker", status: "failed" }, false), { params })).status).toBe(401); });
});
