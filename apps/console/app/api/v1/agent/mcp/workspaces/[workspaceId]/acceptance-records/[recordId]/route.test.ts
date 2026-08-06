import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/agent-mcp-auth", () => ({ requireAgentMcpWorkspace: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({
  createDraftAcceptanceContract: vi.fn(), readAcceptanceContracts: vi.fn(), readChangeRecordTimeline: vi.fn(),
}));

import { requireAgentMcpWorkspace } from "@/lib/agent-mcp-auth";
import { createDraftAcceptanceContract, readAcceptanceContracts, readChangeRecordTimeline } from "@agentrail/db-postgres";
import { GET, PATCH } from "./route";

const WS = "00000000-0000-0000-0000-000000000001";
const RECORD = "00000000-0000-0000-0000-000000000002";
const validContract = {
  originalUserWording: "Add a visible save button", goal: "Save a draft",
  acceptanceCriteria: [{ id: "save", text: "The button saves the draft", required: true }],
};
function params() { return Promise.resolve({ workspaceId: WS, recordId: RECORD }); }
function patch(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/agent/mcp/workspaces/${WS}/acceptance-records/${RECORD}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAgentMcpWorkspace).mockResolvedValue({ apiKeyId: "mcp-key", workspaceId: WS } as never);
  vi.mocked(readChangeRecordTimeline).mockResolvedValue({ record: { id: RECORD, repo: "acme/web", state: "open" } } as never);
  vi.mocked(readAcceptanceContracts).mockResolvedValue([] as never);
  vi.mocked(createDraftAcceptanceContract).mockResolvedValue({
    id: "contract-2", recordId: RECORD, version: 2, status: "draft", contract: validContract,
  } as never);
});

describe("MCP acceptance record read and draft revision", () => {
  it("reads only through the read-scoped guard", async () => {
    const response = await GET(new NextRequest("http://localhost"), { params: params() });
    expect(response.status).toBe(200);
    expect(requireAgentMcpWorkspace).toHaveBeenCalledWith(expect.any(NextRequest), WS, "acceptance:read");
    expect(readAcceptanceContracts).toHaveBeenCalledWith({ workspaceId: WS, recordId: RECORD });
  });

  it("writes a new immutable draft version and cannot confirm", async () => {
    const response = await PATCH(patch({ action: "create_draft_version", contract: validContract }), { params: params() });
    expect(response.status).toBe(201);
    expect(createDraftAcceptanceContract).toHaveBeenCalledWith(expect.objectContaining({
      recordId: RECORD, createdBy: "agent-mcp:mcp-key",
    }));

    const confirmResponse = await PATCH(patch({ action: "confirm_contract", contract: validContract }), { params: params() });
    expect(confirmResponse.status).toBe(400);
  });

  it("refuses revisions after human confirmation", async () => {
    vi.mocked(readAcceptanceContracts).mockResolvedValue([{ status: "confirmed" }] as never);
    const response = await PATCH(patch({ action: "create_draft_version", contract: validContract }), { params: params() });
    expect(response.status).toBe(409);
    expect(createDraftAcceptanceContract).not.toHaveBeenCalled();
  });

  it("returns a failed workspace guard without touching record data", async () => {
    vi.mocked(requireAgentMcpWorkspace).mockResolvedValue(new NextResponse(null, { status: 403 }) as never);
    const response = await GET(new NextRequest("http://localhost"), { params: params() });
    expect(response.status).toBe(403);
    expect(readChangeRecordTimeline).not.toHaveBeenCalled();
  });
});
