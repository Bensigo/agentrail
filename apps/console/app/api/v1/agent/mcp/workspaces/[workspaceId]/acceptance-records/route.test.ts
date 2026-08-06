import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/agent-mcp-auth", () => ({ requireAgentMcpWorkspace: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({ createDraftAcceptanceRecord: vi.fn(), getRepositoryByName: vi.fn() }));

import { requireAgentMcpWorkspace } from "@/lib/agent-mcp-auth";
import { createDraftAcceptanceRecord, getRepositoryByName } from "@agentrail/db-postgres";
import { POST } from "./route";

const WS = "00000000-0000-0000-0000-000000000001";
const validContract = {
  originalUserWording: "Add a visible save button", goal: "Save a draft",
  acceptanceCriteria: [{ id: "save", text: "The button saves the draft", required: true }],
};
function params() { return Promise.resolve({ workspaceId: WS }); }
function post(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/agent/mcp/workspaces/${WS}/acceptance-records`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAgentMcpWorkspace).mockResolvedValue({ apiKeyId: "mcp-key", workspaceId: WS } as never);
  vi.mocked(getRepositoryByName).mockResolvedValue({ id: "repo-1" } as never);
  vi.mocked(createDraftAcceptanceRecord).mockResolvedValue({
    record: { id: "record-1", workspaceId: WS, repo: "acme/web", state: "open" },
    contract: { id: "contract-1", version: 1, status: "draft", contract: validContract },
  } as never);
});

describe("MCP acceptance record creation", () => {
  it("uses the draft scope and records the MCP credential as the actor", async () => {
    const response = await POST(post({ repo: "acme/web", contract: validContract }), { params: params() });
    expect(response.status).toBe(201);
    expect(requireAgentMcpWorkspace).toHaveBeenCalledWith(expect.any(NextRequest), WS, "acceptance:draft:write");
    expect(createDraftAcceptanceRecord).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WS, createdBy: "agent-mcp:mcp-key", originChannel: "mcp",
    }));
  });

  it("does not bypass a failed workspace-bound MCP guard", async () => {
    vi.mocked(requireAgentMcpWorkspace).mockResolvedValue(new NextResponse(null, { status: 403 }) as never);
    const response = await POST(post({ repo: "acme/web", contract: validContract }), { params: params() });
    expect(response.status).toBe(403);
    expect(getRepositoryByName).not.toHaveBeenCalled();
  });

  it("rejects invalid contracts before writing a record", async () => {
    const response = await POST(post({ repo: "acme/web", contract: { goal: "missing criteria" } }), { params: params() });
    expect(response.status).toBe(400);
    expect(createDraftAcceptanceRecord).not.toHaveBeenCalled();
  });
});
