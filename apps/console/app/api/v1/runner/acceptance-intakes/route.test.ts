import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({ recordAcceptanceInboundIntake: vi.fn() }));
import { recordAcceptanceInboundIntake } from "@agentrail/db-postgres";
import { POST } from "./route";

const secret = "test-secret";
function request(body: unknown, authorized = true) {
  return new NextRequest("http://localhost/api/v1/runner/acceptance-intakes", { method: "POST", headers: { "Content-Type": "application/json", ...(authorized ? { Authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify(body) });
}
const payload = { workspaceId: "00000000-0000-0000-0000-000000000001", originChannel: "slack", conversationKey: "thread-1", sourceKey: "inbox-1", text: "Add save", sourceReferences: [{ kind: "hosted_channel_message" }] };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JACE_CONSOLE_TOKEN = secret;
  vi.mocked(recordAcceptanceInboundIntake).mockResolvedValue({ intake: { id: "intake-1", status: "collecting_context" }, message: { id: "message-1", sourceKey: "inbox-1" }, inserted: true } as never);
});

describe("POST /api/v1/runner/acceptance-intakes", () => {
  it("requires Jace auth before writing", async () => {
    expect((await POST(request(payload, false))).status).toBe(401);
    expect(recordAcceptanceInboundIntake).not.toHaveBeenCalled();
  });
  it("records provenance only and never authorizes implementation", async () => {
    const response = await POST(request(payload));
    expect(response.status).toBe(201);
    expect(recordAcceptanceInboundIntake).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: payload.workspaceId, originChannel: "slack", sourceKey: "inbox-1", text: "Add save" }));
    await expect(response.json()).resolves.toMatchObject({ intake: { id: "intake-1", status: "collecting_context" }, inserted: true });
  });
});
