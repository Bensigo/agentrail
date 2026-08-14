import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("../../../../../../lib/acceptance-context-pack-regeneration-execution", () => ({
  executeAcceptanceContextPackRegeneration: vi.fn(),
}));
import { executeAcceptanceContextPackRegeneration } from "../../../../../../lib/acceptance-context-pack-regeneration-execution";
import { POST } from "./route";

const execute = vi.mocked(executeAcceptanceContextPackRegeneration);
const token = "context-regeneration-secret";
const body = { executionId: "11111111-1111-4111-8111-111111111111", workerId: "w", leaseToken: "a".repeat(43) };
function request(value: unknown, authorized = true) {
  return new NextRequest("http://localhost/api/v1/runner/context-pack-regenerations/execute", {
    method: "POST",
    headers: { "content-type": "application/json", ...(authorized ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(value),
  });
}

describe("Context Pack regeneration execute route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JACE_CONTEXT_PACK_REGENERATION_WORKER_TOKEN = token;
    process.env.JACE_CONSOLE_TOKEN = "central-jace-secret";
  });
  it("fails closed before executing", async () => {
    expect((await POST(request(body, false))).status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });
  it("rejects the deployment-wide Jace token at the regeneration door", async () => {
    const central = request(body);
    central.headers.set("authorization", `Bearer ${process.env.JACE_CONSOLE_TOKEN}`);
    expect((await POST(central)).status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });
  it("rejects tenant or source coordinates", async () => {
    expect((await POST(request({ ...body, workspaceId: "chosen" }))).status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });
  it("rejects declared and streamed oversized bodies before execution", async () => {
    const declared = request(body);
    declared.headers.set("content-length", "2049");
    expect((await POST(declared)).status).toBe(400);
    expect((await POST(request({ ...body, padding: "x".repeat(4096) }))).status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });
  it("passes only the opaque lease to the trusted executor", async () => {
    execute.mockResolvedValue({ kind: "not_current" });
    const response = await POST(request(body));
    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalledWith(body);
    expect(await response.json()).toEqual({ result: { kind: "not_current" } });
  });
  it("returns only a terminal acknowledgement, never tenant or Pack custody", async () => {
    execute.mockResolvedValue({
      kind: "completed",
      execution: {
        status: "replaced",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        recordId: "33333333-3333-4333-8333-333333333333",
        replacementCompiledPackId: "44444444-4444-4444-8444-444444444444",
        headSha: "f".repeat(40),
      },
    } as never);
    const response = await POST(request(body));
    expect(await response.json()).toEqual({ result: { kind: "completed", status: "replaced" } });
  });
});
