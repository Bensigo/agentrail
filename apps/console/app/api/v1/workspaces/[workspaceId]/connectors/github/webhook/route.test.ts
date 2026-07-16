import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  getConnector: vi.fn(),
  getGithubToken: vi.fn(),
  upsertConnector: vi.fn(),
}));

import { POST } from "./route";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  getConnector,
  getGithubToken,
  upsertConnector,
} from "@agentrail/db-postgres";

const WS = "ws-1";
const USER = "user-1";

function req(): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WS}/connectors/github/webhook`,
    { method: "POST" }
  );
}
function params() {
  return { params: Promise.resolve({ workspaceId: WS }) };
}

const originalFetch = global.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({
    id: "m1",
    role: "owner",
  } as never);
  vi.mocked(upsertConnector).mockResolvedValue({} as never);
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("POST /api/v1/workspaces/[workspaceId]/connectors/github/webhook", () => {
  it("401 when not authenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await POST(req(), params());
    expect(res.status).toBe(401);
  });

  it("403 when not a workspace member", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const res = await POST(req(), params());
    expect(res.status).toBe(403);
  });

  it("403 when a member but not owner/admin", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue({
      id: "m1",
      role: "member",
    } as never);
    const res = await POST(req(), params());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/owner or admin/i);
  });

  it("422 when the github connector has no repos", async () => {
    vi.mocked(getConnector).mockResolvedValue({
      provider: "github",
      enabled: true,
      config: { repos: [], triggerLabel: "ready-for-agent", pollIntervalSeconds: 60 },
      hasSecret: false,
      updatedAt: null,
    } as never);
    const res = await POST(req(), params());
    expect(res.status).toBe(422);
    expect(upsertConnector).not.toHaveBeenCalled();
  });

  it("creates a webhook for every configured repo and persists the secret on success (AC2)", async () => {
    vi.mocked(getConnector).mockResolvedValue({
      provider: "github",
      enabled: true,
      config: {
        repos: ["acme/repo-a", "acme/repo-b"],
        triggerLabel: "ready-for-agent",
        pollIntervalSeconds: 60,
      },
      hasSecret: false,
      updatedAt: null,
    } as never);
    vi.mocked(getGithubToken).mockResolvedValue("gho_token");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      text: async () => "",
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await POST(req(), params());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.secret).toMatch(/^[0-9a-f]{48}$/);
    expect(body.results).toEqual([
      { repo: "acme/repo-a", ok: true },
      { repo: "acme/repo-b", ok: true },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/repo-a/hooks",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer gho_token" }),
      })
    );

    // The secret is persisted on the connector row (AC2: "stored on the connector").
    expect(upsertConnector).toHaveBeenCalledWith(WS, "github", {
      config: { webhookSecret: body.secret },
    });
  });

  it("on GitHub API failure, still persists the secret and returns manual fallback instructions (AC2)", async () => {
    vi.mocked(getConnector).mockResolvedValue({
      provider: "github",
      enabled: true,
      config: {
        repos: ["acme/repo-a"],
        triggerLabel: "ready-for-agent",
        pollIntervalSeconds: 60,
      },
      hasSecret: false,
      updatedAt: null,
    } as never);
    vi.mocked(getGithubToken).mockResolvedValue("gho_token");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "insufficient permission",
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await POST(req(), params());
    // A GitHub-side failure is not a route error — it's a real, renderable
    // fallback state (AC2), so this is still a 200.
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.ok).toBe(false);
    expect(body.results).toEqual([
      {
        repo: "acme/repo-a",
        ok: false,
        error: expect.stringContaining("re-link GitHub"),
      },
    ]);
    expect(body.secret).toBeTruthy();
    expect(body.manual).toEqual({
      url: expect.stringContaining("/api/v1/connectors/github/webhook"),
      secret: body.secret,
      contentType: "application/json",
      events: ["issues"],
    });

    // Persisted even though every GitHub call failed.
    expect(upsertConnector).toHaveBeenCalledWith(WS, "github", {
      config: { webhookSecret: body.secret },
    });
  });

  it("falls back to manual instructions (no GitHub call) when there is no stored GitHub token", async () => {
    vi.mocked(getConnector).mockResolvedValue({
      provider: "github",
      enabled: true,
      config: {
        repos: ["acme/repo-a"],
        triggerLabel: "ready-for-agent",
        pollIntervalSeconds: 60,
      },
      hasSecret: false,
      updatedAt: null,
    } as never);
    vi.mocked(getGithubToken).mockResolvedValue(null);

    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await POST(req(), params());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(body.ok).toBe(false);
    expect(body.results[0].error).toMatch(/no github token/i);
    expect(upsertConnector).toHaveBeenCalledWith(WS, "github", {
      config: { webhookSecret: body.secret },
    });
  });
});
