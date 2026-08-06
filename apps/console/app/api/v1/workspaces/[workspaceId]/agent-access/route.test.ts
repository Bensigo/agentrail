import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({ auth: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({
  createApiKey: vi.fn(),
  getWorkspaceMembership: vi.fn(),
  listAgentMcpApiKeys: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import { createApiKey, getWorkspaceMembership, listAgentMcpApiKeys } from "@agentrail/db-postgres";
import { GET, POST } from "./route";

const WS = "00000000-0000-0000-0000-000000000001";
function params() { return Promise.resolve({ workspaceId: WS }); }
function post(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/workspaces/${WS}/agent-access`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: "lead-1" } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1", role: "owner" } as never);
  vi.mocked(listAgentMcpApiKeys).mockResolvedValue([] as never);
  vi.mocked(createApiKey).mockResolvedValue({
    id: "key-1", name: "Codex", keyPrefix: "jace_mcp_deadbeef", scopes: ["acceptance:read"],
    createdAt: new Date("2026-08-06T00:00:00.000Z"), lastUsedAt: null, revokedAt: null,
  } as never);
});

describe("agent access credentials", () => {
  it("requires a logged-in owner or admin to list metadata", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1", role: "member" } as never);
    const response = await GET(new NextRequest("http://localhost"), { params: params() });
    expect(response.status).toBe(403);
    expect(listAgentMcpApiKeys).not.toHaveBeenCalled();
  });

  it("mints only a scoped agent_mcp secret and returns it once", async () => {
    const response = await POST(post({ name: "Codex", scopes: ["acceptance:read", "acceptance:intake:write", "acceptance:read"] }), { params: params() });
    expect(response.status).toBe(201);
    expect(createApiKey).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WS, teamId: null, name: "Codex", kind: "agent_mcp", scopes: ["acceptance:read", "acceptance:intake:write"],
      keyPrefix: expect.stringMatching(/^jace_mcp_/),
    }));
    expect((await response.json()).secret).toMatch(/^jace_mcp_[a-f0-9]{64}$/);
  });

  it("rejects empty, malformed, or out-of-scope capability requests", async () => {
    for (const body of [
      { name: "Codex", scopes: [] },
      { name: "Codex", scopes: "acceptance:read" },
      { name: "Codex", scopes: ["acceptance:draft:write"] },
      { name: "Codex", scopes: ["merge:write"] },
    ]) {
      const response = await POST(post(body), { params: params() });
      expect(response.status).toBe(400);
    }
    expect(createApiKey).not.toHaveBeenCalled();
  });
});
