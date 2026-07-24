import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@agentrail/db-postgres", () => ({
  consumeGithubInstallState: vi.fn(),
  bindWorkspaceGithubInstallation: vi.fn(),
  getWorkspaceMembership: vi.fn(),
  upsertConnector: vi.fn(),
}));
vi.mock("@agentrail/github-app", () => ({
  resolveGithubAppConfig: vi.fn(),
  getInstallationAccount: vi.fn(),
}));

import { GET } from "./route";
import { auth } from "@agentrail/auth";
import {
  consumeGithubInstallState,
  bindWorkspaceGithubInstallation,
  getWorkspaceMembership,
  upsertConnector,
} from "@agentrail/db-postgres";
import { resolveGithubAppConfig, getInstallationAccount } from "@agentrail/github-app";

const USER = "user-1";

function req(query: string): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/connectors/github/install-callback${query}`
  );
}

function locationOf(res: Response): string {
  return new URL(res.headers.get("location")!).pathname + new URL(res.headers.get("location")!).search;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(resolveGithubAppConfig).mockReturnValue({
    ok: true,
    appId: "1",
    privateKey: "pk",
    slug: "jace",
    botUserId: "999",
  } as never);
  vi.mocked(upsertConnector).mockResolvedValue({} as never);
});

describe("GET /api/v1/connectors/github/install-callback", () => {
  it("no state param → 302 to /dashboard?github_install=unlinked", async () => {
    const res = await GET(req("?installation_id=777"));
    expect(res.status).toBe(302);
    expect(locationOf(res)).toBe("/dashboard?github_install=unlinked");
    expect(consumeGithubInstallState).not.toHaveBeenCalled();
    expect(upsertConnector).not.toHaveBeenCalled();
  });

  it("unknown/expired state → 302 to /dashboard?github_install=expired, no bind", async () => {
    vi.mocked(consumeGithubInstallState).mockResolvedValue(null);
    const res = await GET(req("?installation_id=777&state=abc"));
    expect(res.status).toBe(302);
    expect(locationOf(res)).toBe("/dashboard?github_install=expired");
    expect(bindWorkspaceGithubInstallation).not.toHaveBeenCalled();
    expect(upsertConnector).not.toHaveBeenCalled();
  });

  it("signed-out visitor → 302 to /login, state NOT consumed", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET(req("?installation_id=777&state=abc"));
    expect(res.status).toBe(302);
    expect(locationOf(res)).toBe("/login");
    expect(consumeGithubInstallState).not.toHaveBeenCalled();
    expect(upsertConnector).not.toHaveBeenCalled();
  });

  it("membership re-check fails → 302 to /dashboard?github_install=forbidden, no bind", async () => {
    vi.mocked(consumeGithubInstallState).mockResolvedValue({ workspaceId: "ws-1" });
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const res = await GET(req("?installation_id=777&state=abc"));
    expect(res.status).toBe(302);
    expect(locationOf(res)).toBe("/dashboard?github_install=forbidden");
    expect(bindWorkspaceGithubInstallation).not.toHaveBeenCalled();
    expect(upsertConnector).not.toHaveBeenCalled();
  });

  it("happy path → binds installation, self-configures the github connector row, and redirects to the workspace connectors page", async () => {
    vi.mocked(consumeGithubInstallState).mockResolvedValue({ workspaceId: "ws-1" });
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1", role: "owner" } as never);
    vi.mocked(getInstallationAccount).mockResolvedValue({
      ok: true,
      login: "acme",
      type: "Organization",
    } as never);

    const res = await GET(req("?installation_id=777&state=abc"));
    expect(res.status).toBe(302);
    expect(locationOf(res)).toBe("/dashboard/ws-1/connectors?github_install=connected");
    expect(bindWorkspaceGithubInstallation).toHaveBeenCalledWith("ws-1", {
      installationId: "777",
      accountLogin: "acme",
      accountType: "Organization",
    });
    expect(upsertConnector).toHaveBeenCalledWith("ws-1", "github", {
      enabled: true,
    });
  });

  it("best-effort: a failed connector self-configure still redirects to connected (binding already succeeded)", async () => {
    vi.mocked(consumeGithubInstallState).mockResolvedValue({ workspaceId: "ws-1" });
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1", role: "owner" } as never);
    vi.mocked(getInstallationAccount).mockResolvedValue({
      ok: true,
      login: "acme",
      type: "Organization",
    } as never);
    vi.mocked(upsertConnector).mockRejectedValue(new Error("db unavailable"));

    const res = await GET(req("?installation_id=777&state=abc"));
    expect(res.status).toBe(302);
    expect(locationOf(res)).toBe("/dashboard/ws-1/connectors?github_install=connected");
    // The installation binding is the thing that matters — it must have gone
    // through even though the best-effort connector-row write blew up after.
    expect(bindWorkspaceGithubInstallation).toHaveBeenCalledWith("ws-1", {
      installationId: "777",
      accountLogin: "acme",
      accountType: "Organization",
    });
  });

  it("missing installation_id with valid state → 302 to /dashboard?github_install=error, no bind", async () => {
    vi.mocked(consumeGithubInstallState).mockResolvedValue({ workspaceId: "ws-1" });
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1", role: "owner" } as never);

    const res = await GET(req("?state=abc"));
    expect(res.status).toBe(302);
    expect(locationOf(res)).toBe("/dashboard?github_install=error");
    expect(bindWorkspaceGithubInstallation).not.toHaveBeenCalled();
    expect(upsertConnector).not.toHaveBeenCalled();
  });
});
