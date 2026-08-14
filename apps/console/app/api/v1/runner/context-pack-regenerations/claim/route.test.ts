import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  claimAcceptanceContextPackRegenerationExecution: vi.fn(),
}));
import { claimAcceptanceContextPackRegenerationExecution } from "@agentrail/db-postgres";
import { POST } from "./route";

const claim = vi.mocked(claimAcceptanceContextPackRegenerationExecution);
const token = "context-regeneration-secret";
function request(body: unknown, authorized = true) {
  return new NextRequest("http://localhost/api/v1/runner/context-pack-regenerations/claim", {
    method: "POST",
    headers: { "content-type": "application/json", ...(authorized ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

describe("Context Pack regeneration claim route", () => {
  beforeEach(() => { vi.clearAllMocks(); process.env.JACE_CONSOLE_TOKEN = token; });
  it("fails closed before touching the queue", async () => {
    expect((await POST(request({ workerId: "w" }, false))).status).toBe(401);
    expect(claim).not.toHaveBeenCalled();
  });
  it("rejects extra targeting fields", async () => {
    expect((await POST(request({ workerId: "w", workspaceId: "chosen" }))).status).toBe(400);
    expect(claim).not.toHaveBeenCalled();
  });
  it("rejects declared and streamed oversized bodies before touching the queue", async () => {
    const declared = request({ workerId: "w" });
    declared.headers.set("content-length", "2049");
    expect((await POST(declared)).status).toBe(400);
    expect((await POST(request({ workerId: "w", padding: "x".repeat(4096) }))).status).toBe(400);
    expect(claim).not.toHaveBeenCalled();
  });
  it("returns an opaque lease only", async () => {
    claim.mockResolvedValue({ executionId: "e", workerId: "w", leaseToken: "t", attemptCount: 1, leaseExpiresAt: new Date(0) });
    const response = await POST(request({ workerId: "w" }));
    expect(await response.json()).toEqual({ claim: { executionId: "e", workerId: "w", leaseToken: "t", attemptCount: 1, leaseExpiresAt: new Date(0).toISOString() } });
  });
});
