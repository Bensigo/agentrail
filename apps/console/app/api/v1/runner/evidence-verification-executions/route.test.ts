import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("@agentrail/db-postgres", () => ({ enqueueEvidenceVerificationExecution: vi.fn() }));
import { enqueueEvidenceVerificationExecution } from "@agentrail/db-postgres";
import { POST } from "./route";
const secret = "secret";
const body = { workspaceId: "ws", recordId: "record", prRevisionId: "revision", verificationPlanId: "plan" };
const request = (value: unknown = body, auth = true) => new NextRequest("http://localhost", { method: "POST", headers: { "content-type": "application/json", ...(auth ? { Authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify(value) });
beforeEach(() => { vi.clearAllMocks(); process.env.JACE_CONSOLE_TOKEN = secret; vi.mocked(enqueueEvidenceVerificationExecution).mockResolvedValue({ execution: { id: "execution", verificationPlanId: "plan", status: "queued" }, inserted: true } as never); });
describe("verification execution admission", () => {
  it("queues only a persisted plan without claiming proof", async () => { const response = await POST(request()); expect(response.status).toBe(201); await expect(response.json()).resolves.toMatchObject({ execution: { status: "queued" } }); });
  it("fails closed for invalid or unauthenticated requests", async () => { expect((await POST(request({}, true))).status).toBe(400); expect((await POST(request(body, false))).status).toBe(401); });
});
