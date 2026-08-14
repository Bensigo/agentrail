import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({ auth: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({
  createApiKey: vi.fn(),
  getWorkspaceMembership: vi.fn(),
  listApiKeys: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import { createApiKey, getWorkspaceMembership, listApiKeys } from "@agentrail/db-postgres";
import { GET, POST } from "./route";

const params = { params: Promise.resolve({ workspaceId: "workspace-1" }) };

function request(body: unknown) {
  return new NextRequest("http://localhost/api/v1/workspaces/workspace-1/api-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ role: "owner" } as never);
  vi.mocked(createApiKey).mockResolvedValue({
    id: "key-1",
    name: "Codex to Jace",
    keyPrefix: "ar_12345678",
    teamId: null,
    kind: "agent_mcp",
    createdAt: new Date("2026-08-14T00:00:00Z"),
  } as never);
});

describe("workspace API-key issuance", () => {
  it("lets an owner issue a dedicated workspace-level agent_mcp key", async () => {
    const response = await POST(request({ name: "Codex to Jace", kind: "agent_mcp" }), params);

    expect(response.status).toBe(201);
    expect(createApiKey).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      teamId: null,
      name: "Codex to Jace",
      kind: "agent_mcp",
    }));
    await expect(response.json()).resolves.toMatchObject({
      api_key: { kind: "agent_mcp", team_id: null },
      secret: expect.stringMatching(/^ar_[0-9a-f]{64}$/),
    });
  });

  it("fails closed instead of pretending a team-scoped MCP key is enforced", async () => {
    const response = await POST(request({
      name: "Team Codex to Jace",
      kind: "agent_mcp",
      team_id: "team-1",
    }), params);

    expect(response.status).toBe(400);
    expect(createApiKey).not.toHaveBeenCalled();
  });

  it("preserves self_hosted as the default for existing issuance callers", async () => {
    vi.mocked(createApiKey).mockResolvedValueOnce({
      id: "key-2",
      name: "Runner",
      keyPrefix: "ar_87654321",
      teamId: null,
      kind: "self_hosted",
      createdAt: new Date("2026-08-14T00:00:00Z"),
    } as never);

    const response = await POST(request({ name: "Runner" }), params);

    expect(response.status).toBe(201);
    expect(createApiKey).toHaveBeenCalledWith(expect.objectContaining({ kind: "self_hosted" }));
  });

  it("lists credential kinds so operators can distinguish least-authority keys", async () => {
    vi.mocked(listApiKeys).mockResolvedValue([{
      id: "key-1",
      name: "Codex to Jace",
      keyPrefix: "ar_12345678",
      teamId: null,
      kind: "agent_mcp",
      createdAt: new Date("2026-08-14T00:00:00Z"),
      lastUsedAt: null,
      revokedAt: null,
    }] as never);

    const response = await GET(request({}), params);

    await expect(response.json()).resolves.toMatchObject({
      api_keys: [{ kind: "agent_mcp" }],
    });
  });
});
