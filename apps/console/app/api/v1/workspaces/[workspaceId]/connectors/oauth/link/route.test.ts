import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({ auth: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  isConnectorProvider: vi.fn(),
  mintConnectorOauthState: vi.fn(),
}));
vi.mock("../../../../../../../../lib/oauth/types", () => ({
  oauthAdapterFor: vi.fn(),
  oauthConfigFor: vi.fn(),
}));

import { POST } from "./route";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  isConnectorProvider,
  mintConnectorOauthState,
} from "@agentrail/db-postgres";
import { oauthAdapterFor, oauthConfigFor } from "../../../../../../../../lib/oauth/types";

/**
 * POST /api/v1/workspaces/[workspaceId]/connectors/oauth/link (W3-T1, OAuth
 * Connect Wave 3). Mirrors `connectors/github/install-link/route.test.ts`'s
 * own structure (auth/membership gating, happy-path URL assembly) — the
 * generalization here is `provider` traveling in the BODY (not the URL:
 * this route is generic across every OAuth-capable provider) and the closed
 * 409-on-env-unset branch the plan pins.
 */

const WS = "ws-1";
const USER = "user-1";

function req(body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WS}/connectors/oauth/link`,
    { method: "POST", body: JSON.stringify(body) }
  );
}
function invalidJsonReq(): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WS}/connectors/oauth/link`,
    { method: "POST", body: "not json" }
  );
}
function params() {
  return { params: Promise.resolve({ workspaceId: WS }) };
}

const fakeAdapter = {
  provider: "railway",
  authorizeUrl: ({ state, redirectUri }: { state: string; redirectUri: string }) =>
    `https://railway.com/oauth/authorize?client_id=cid&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`,
  exchange: vi.fn(),
  refresh: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1", role: "owner" } as never);
  vi.mocked(isConnectorProvider).mockReturnValue(true);
  vi.mocked(oauthAdapterFor).mockReturnValue(fakeAdapter as never);
  vi.mocked(oauthConfigFor).mockReturnValue({ clientId: "cid", clientSecret: "csecret" });
  vi.mocked(mintConnectorOauthState).mockResolvedValue("state-abc");
  process.env["CONSOLE_PUBLIC_URL"] = "https://heyjace.com";
});

describe("POST /api/v1/workspaces/[workspaceId]/connectors/oauth/link", () => {
  it("401 when unauthenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await POST(req({ provider: "railway" }), params());
    expect(res.status).toBe(401);
  });

  it("403 when not a workspace member", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const res = await POST(req({ provider: "railway" }), params());
    expect(res.status).toBe(403);
  });

  it("403 when membership role is member (not owner/admin)", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1", role: "member" } as never);
    const res = await POST(req({ provider: "railway" }), params());
    expect(res.status).toBe(403);
    expect(mintConnectorOauthState).not.toHaveBeenCalled();
  });

  it("400 on invalid JSON body", async () => {
    const res = await POST(invalidJsonReq(), params());
    expect(res.status).toBe(400);
  });

  it("400 when provider is not a recognized connector provider", async () => {
    vi.mocked(isConnectorProvider).mockReturnValue(false);
    const res = await POST(req({ provider: "not-a-real-provider" }), params());
    expect(res.status).toBe(400);
    expect(mintConnectorOauthState).not.toHaveBeenCalled();
  });

  it("400 when the provider has no registered OAuth adapter (not OAuth-capable, e.g. linear)", async () => {
    vi.mocked(oauthAdapterFor).mockReturnValue(null);
    const res = await POST(req({ provider: "linear" }), params());
    expect(res.status).toBe(400);
    expect(mintConnectorOauthState).not.toHaveBeenCalled();
  });

  it("409 with a clear message when the provider's OAuth env is unset (the plan's pinned status code)", async () => {
    vi.mocked(oauthConfigFor).mockReturnValue(null);
    const res = await POST(req({ provider: "railway" }), params());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/oauth/i);
    expect(body.error).toMatch(/api token instead/i);
    expect(mintConnectorOauthState).not.toHaveBeenCalled();
  });

  it("500 when CONSOLE_PUBLIC_URL is unset on this deployment — fails closed, never a half-built redirect_uri", async () => {
    delete process.env["CONSOLE_PUBLIC_URL"];
    const res = await POST(req({ provider: "railway" }), params());
    expect(res.status).toBe(500);
    expect(mintConnectorOauthState).not.toHaveBeenCalled();
  });

  it("200 with the authorize URL on the happy path: mints state, builds redirect_uri from CONSOLE_PUBLIC_URL, delegates URL-building to the adapter", async () => {
    const res = await POST(req({ provider: "railway" }), params());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toContain("state=state-abc");
    expect(body.url).toContain(
      encodeURIComponent("https://heyjace.com/api/v1/connectors/oauth/callback/railway")
    );
    expect(mintConnectorOauthState).toHaveBeenCalledWith(WS, "railway");
  });
});
