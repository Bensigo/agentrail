import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({ auth: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({ getWorkspaceMembership: vi.fn(), revokeAgentMcpApiKey: vi.fn() }));

import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, revokeAgentMcpApiKey } from "@agentrail/db-postgres";
import { DELETE } from "./route";

const WS = "00000000-0000-0000-0000-000000000001";
const KEY = "00000000-0000-0000-0000-000000000002";
function params() { return Promise.resolve({ workspaceId: WS, keyId: KEY }); }

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: "lead-1" } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1", role: "admin" } as never);
  vi.mocked(revokeAgentMcpApiKey).mockResolvedValue({ id: KEY } as never);
});

describe("DELETE agent access credential", () => {
  it("requires an owner or admin and revokes only the scoped MCP key", async () => {
    const response = await DELETE(new NextRequest("http://localhost", { method: "DELETE" }), { params: params() });
    expect(response.status).toBe(204);
    expect(revokeAgentMcpApiKey).toHaveBeenCalledWith(WS, KEY);
  });

  it("does not let a member revoke a credential", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1", role: "member" } as never);
    const response = await DELETE(new NextRequest("http://localhost", { method: "DELETE" }), { params: params() });
    expect(response.status).toBe(403);
    expect(revokeAgentMcpApiKey).not.toHaveBeenCalled();
  });
});
