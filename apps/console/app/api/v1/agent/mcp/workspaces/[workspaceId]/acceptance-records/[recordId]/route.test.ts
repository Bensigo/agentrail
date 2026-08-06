import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/agent-mcp-auth", () => ({ requireAgentMcpWorkspace: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({
  readAcceptanceContracts: vi.fn(), readChangeRecordTimeline: vi.fn(),
}));

import { requireAgentMcpWorkspace } from "@/lib/agent-mcp-auth";
import { readAcceptanceContracts, readChangeRecordTimeline } from "@agentrail/db-postgres";
import { GET } from "./route";

const WS = "00000000-0000-0000-0000-000000000001";
const RECORD = "00000000-0000-0000-0000-000000000002";
function params() { return Promise.resolve({ workspaceId: WS, recordId: RECORD }); }

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAgentMcpWorkspace).mockResolvedValue({ apiKeyId: "mcp-key", workspaceId: WS } as never);
  vi.mocked(readChangeRecordTimeline).mockResolvedValue({ record: { id: RECORD, repo: "acme/web", state: "open" } } as never);
  vi.mocked(readAcceptanceContracts).mockResolvedValue([] as never);
});

describe("MCP acceptance record read", () => {
  it("reads only through the read-scoped guard", async () => {
    const response = await GET(new NextRequest("http://localhost"), { params: params() });
    expect(response.status).toBe(200);
    expect(requireAgentMcpWorkspace).toHaveBeenCalledWith(expect.any(NextRequest), WS, "acceptance:read");
    expect(readAcceptanceContracts).toHaveBeenCalledWith({ workspaceId: WS, recordId: RECORD });
  });

  it("returns a failed workspace guard without touching record data", async () => {
    vi.mocked(requireAgentMcpWorkspace).mockResolvedValue(new NextResponse(null, { status: 403 }) as never);
    const response = await GET(new NextRequest("http://localhost"), { params: params() });
    expect(response.status).toBe(403);
    expect(readChangeRecordTimeline).not.toHaveBeenCalled();
  });
});
