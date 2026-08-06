import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/agent-mcp-auth", () => ({ requireAgentMcpWorkspace: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({ acknowledgeEvidenceReviewCorrectionDelivery: vi.fn() }));
import { requireAgentMcpWorkspace } from "@/lib/agent-mcp-auth";
import { acknowledgeEvidenceReviewCorrectionDelivery } from "@agentrail/db-postgres";
import { POST } from "./route";

const WS = "00000000-0000-0000-0000-000000000001";
const DELIVERY = "00000000-0000-0000-0000-000000000002";
function params() { return Promise.resolve({ workspaceId: WS, deliveryId: DELIVERY }); }
function request(body: unknown) { return new NextRequest("http://localhost", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAgentMcpWorkspace).mockResolvedValue({ workspaceId: WS, apiKeyId: "mcp-key" } as never);
  vi.mocked(acknowledgeEvidenceReviewCorrectionDelivery).mockResolvedValue({ id: DELIVERY, outcome: "acknowledged", confirmedAt: new Date("2026-08-06T00:00:00.000Z") } as never);
});
describe("MCP correction acknowledgement", () => {
  it("requires the dedicated acknowledgement scope and records agent confirmation", async () => {
    const response = await POST(request({ detail: "I have the packet" }), { params: params() });
    expect(response.status).toBe(200);
    expect(requireAgentMcpWorkspace).toHaveBeenCalledWith(expect.any(NextRequest), WS, "acceptance:correction:ack");
    expect(acknowledgeEvidenceReviewCorrectionDelivery).toHaveBeenCalledWith({ workspaceId: WS, deliveryId: DELIVERY, detail: "I have the packet" });
  });
  it("does not claim delivery when the scoped MCP guard fails", async () => {
    vi.mocked(requireAgentMcpWorkspace).mockResolvedValue(new NextResponse(null, { status: 403 }) as never);
    const response = await POST(request({}), { params: params() });
    expect(response.status).toBe(403);
    expect(acknowledgeEvidenceReviewCorrectionDelivery).not.toHaveBeenCalled();
  });
});
