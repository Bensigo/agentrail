import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  mintGithubInstallState: vi.fn(),
}));
vi.mock("@agentrail/github-app", () => ({
  resolveGithubAppConfig: vi.fn(),
}));

import { POST } from "./route";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, mintGithubInstallState } from "@agentrail/db-postgres";
import { resolveGithubAppConfig } from "@agentrail/github-app";

const WS = "ws-1";
const USER = "user-1";

function req(): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WS}/connectors/github/install-link`,
    { method: "POST" }
  );
}
function params() {
  return { params: Promise.resolve({ workspaceId: WS }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({
    id: "m1",
    role: "owner",
  } as never);
});

describe("POST /api/v1/workspaces/[workspaceId]/connectors/github/install-link", () => {
  it("401 when unauthenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await POST(req(), params());
    expect(res.status).toBe(401);
  });

  it("403 when membership role is member (not owner/admin)", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue({
      id: "m1",
      role: "member",
    } as never);
    const res = await POST(req(), params());
    expect(res.status).toBe(403);
  });

  it("503 when the GitHub App is not configured on this deployment", async () => {
    vi.mocked(resolveGithubAppConfig).mockReturnValue({
      ok: false,
      missing: ["GITHUB_APP_ID"],
    } as never);
    const res = await POST(req(), params());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("GitHub App is not configured on this deployment");
  });

  it("200 with the install URL on the happy path", async () => {
    vi.mocked(resolveGithubAppConfig).mockReturnValue({
      ok: true,
      appId: "1",
      privateKey: "pk",
      slug: "jace",
      botUserId: "999",
    } as never);
    vi.mocked(mintGithubInstallState).mockResolvedValue("abc123");

    const res = await POST(req(), params());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      url: "https://github.com/apps/jace/installations/new?state=abc123",
    });
    expect(mintGithubInstallState).toHaveBeenCalledWith(WS);
  });
});
