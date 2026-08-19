import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  renewAcceptanceContextPackRegenerationExecutionLease: vi.fn(),
}));
import { renewAcceptanceContextPackRegenerationExecutionLease } from "@agentrail/db-postgres";
import { POST } from "./route";

const renew = vi.mocked(renewAcceptanceContextPackRegenerationExecutionLease);
const token = "context-regeneration-secret";
const body = {
  executionId: "11111111-1111-4111-8111-111111111111",
  workerId: "w",
  leaseToken: "a".repeat(43),
};
function request(value: unknown, authorized = true) {
  return new NextRequest("http://localhost/api/v1/runner/context-pack-regenerations/renew", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorized ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(value),
  });
}

describe("Context Pack regeneration lease renewal route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JACE_CONTEXT_PACK_REGENERATION_WORKER_TOKEN = token;
    process.env.JACE_CONSOLE_TOKEN = "central-jace-secret";
  });

  it("fails closed before renewing", async () => {
    expect((await POST(request(body, false))).status).toBe(401);
    expect(renew).not.toHaveBeenCalled();
  });

  it("rejects tenant or source coordinates", async () => {
    expect((await POST(request({ ...body, workspaceId: "chosen" }))).status).toBe(400);
    expect(renew).not.toHaveBeenCalled();
  });

  it("renews only the opaque owned lease", async () => {
    const leaseExpiresAt = new Date("2026-08-19T10:00:00.000Z");
    renew.mockResolvedValue({ kind: "renewed", leaseExpiresAt });
    const response = await POST(request(body));
    expect(response.status).toBe(200);
    expect(renew).toHaveBeenCalledWith(body);
    expect(await response.json()).toEqual({ renewed: { leaseExpiresAt: leaseExpiresAt.toISOString() } });
  });

  it("rejects a lease that is no longer owned", async () => {
    renew.mockResolvedValue({ kind: "not_owned" });
    expect((await POST(request(body))).status).toBe(409);
  });
});
