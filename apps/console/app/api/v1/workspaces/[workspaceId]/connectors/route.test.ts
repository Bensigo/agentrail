import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({ auth: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  listWorkspaceRepositories: vi.fn(),
  listChatIdentitiesForWorkspace: vi.fn(),
  getConnectors: vi.fn(),
  getGithubInstallation: vi.fn(),
  upsertConnector: vi.fn(),
  // Re-export the pure validators/guards from the real package — the route
  // depends on their actual behavior, not a mock.
  validateConnectorUpdate: (u: { enabled?: unknown; config?: Record<string, unknown> }) =>
    realValidate(u),
  isConnectorProvider: (v: unknown) => realIsProvider(v),
}));

import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  listWorkspaceRepositories,
  listChatIdentitiesForWorkspace,
  getConnectors,
  getGithubInstallation,
  upsertConnector,
} from "@agentrail/db-postgres";
import { GET, PUT } from "./route";

// Minimal real implementations mirrored from db-postgres/queries/connectors.ts
// so the route's validation is genuinely exercised in this hermetic test.
function realIsProvider(v: unknown): boolean {
  return v === "github" || v === "linear" || v === "discord";
}
function realValidate(u: { enabled?: unknown; config?: Record<string, unknown> }) {
  const value: Record<string, unknown> = {};
  if (u.enabled !== undefined) {
    if (typeof u.enabled !== "boolean")
      return { ok: false, error: "enabled must be a boolean" };
    value.enabled = u.enabled;
  }
  if (u.config !== undefined) {
    const out: Record<string, unknown> = {};
    const c = u.config;
    if (c.pollIntervalSeconds !== undefined) {
      const n = c.pollIntervalSeconds;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 10 || n > 86400)
        return { ok: false, error: "bad interval" };
      out.pollIntervalSeconds = n;
    }
    if (c.triggerLabel !== undefined) {
      const t = String(c.triggerLabel).trim();
      if (!t || t.length > 50) return { ok: false, error: "bad label" };
      out.triggerLabel = t;
    }
    value.config = out;
  }
  return { ok: true, value };
}

const WS = "00000000-0000-0000-0000-000000000001";
const USER = "user-1";

function params() {
  return Promise.resolve({ workspaceId: WS });
}
function putReq(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/v1/workspaces/${WS}/connectors`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}
function getReq(): NextRequest {
  return new NextRequest(`http://localhost/api/v1/workspaces/${WS}/connectors`);
}

beforeEach(() => {
  vi.mocked(auth).mockReset();
  vi.mocked(getWorkspaceMembership).mockReset();
  vi.mocked(upsertConnector).mockReset();
  vi.mocked(upsertConnector).mockResolvedValue({
    provider: "github",
    enabled: true,
    config: { repos: [], triggerLabel: "afk", pollIntervalSeconds: 120 },
    updatedAt: "2026-06-16T00:00:00.000Z",
  } as never);
  vi.mocked(listWorkspaceRepositories).mockReset();
  vi.mocked(listWorkspaceRepositories).mockResolvedValue([] as never);
  vi.mocked(listChatIdentitiesForWorkspace).mockReset();
  vi.mocked(listChatIdentitiesForWorkspace).mockResolvedValue([] as never);
  vi.mocked(getConnectors).mockReset();
  vi.mocked(getConnectors).mockResolvedValue([] as never);
  vi.mocked(getGithubInstallation).mockReset();
  vi.mocked(getGithubInstallation).mockResolvedValue(null);
});

describe("PUT /connectors", () => {
  it("401 when unauthenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await PUT(putReq({ provider: "github", enabled: true }), {
      params: params(),
    });
    expect(res.status).toBe(401);
  });

  it("403 when not owner/admin", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ role: "member" } as never);
    const res = await PUT(putReq({ provider: "github", enabled: true }), {
      params: params(),
    });
    expect(res.status).toBe(403);
    expect(upsertConnector).not.toHaveBeenCalled();
  });

  it("400 for an unknown provider", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ role: "admin" } as never);
    const res = await PUT(putReq({ provider: "slack", enabled: true }), {
      params: params(),
    });
    expect(res.status).toBe(400);
    expect(upsertConnector).not.toHaveBeenCalled();
  });

  it("400 for an out-of-bounds poll interval", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ role: "admin" } as never);
    const res = await PUT(putReq({ provider: "github", pollIntervalSeconds: 1 }), {
      params: params(),
    });
    expect(res.status).toBe(400);
    expect(upsertConnector).not.toHaveBeenCalled();
  });

  it("saves trigger config (enabled + label + interval) for owner/admin (AC3)", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ role: "owner" } as never);
    const res = await PUT(
      putReq({
        provider: "github",
        enabled: true,
        triggerLabel: "afk",
        pollIntervalSeconds: 120,
      }),
      { params: params() }
    );
    expect(res.status).toBe(200);
    expect(upsertConnector).toHaveBeenCalledWith(WS, "github", {
      enabled: true,
      config: { triggerLabel: "afk", pollIntervalSeconds: 120 },
    });
    const json = (await res.json()) as { connector: { enabled: boolean } };
    expect(json.connector.enabled).toBe(true);
  });
});

// -----------------------------------------------------------------------
// GET — the github card's "connected" signal (install-flow fix).
// -----------------------------------------------------------------------
interface GetJson {
  connectors: Array<{
    kind: string;
    status: string;
    target: string | null;
    appInstalled?: boolean;
  }>;
}

function githubRow(json: GetJson) {
  return json.connectors.find((c) => c.kind === "github")!;
}

describe("GET /connectors — github connected signal", () => {
  beforeEach(() => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ role: "owner" } as never);
  });

  it("disconnected when there is no installation and no linked repo", async () => {
    const res = await GET(getReq(), { params: params() });
    expect(res.status).toBe(200);
    const json = (await res.json()) as GetJson;
    expect(githubRow(json).status).toBe("disconnected");
    expect(githubRow(json).target).toBeNull();
  });

  it("connected once the App is installed, even with zero repos linked yet (no visual dead-end)", async () => {
    vi.mocked(getGithubInstallation).mockResolvedValue({
      installationId: "777",
      accountLogin: "acme",
      accountType: "Organization",
    });
    const res = await GET(getReq(), { params: params() });
    const json = (await res.json()) as GetJson;
    expect(githubRow(json).status).toBe("connected");
    // Shows the installed account, never a misleading "0 repositories".
    expect(githubRow(json).target).toBe("acme");
  });

  it("stays connected via linked repos alone, for a pre-App-migration workspace with no installation row", async () => {
    vi.mocked(listWorkspaceRepositories).mockResolvedValue([
      { name: "acme/repo-a" },
    ] as never);
    const res = await GET(getReq(), { params: params() });
    const json = (await res.json()) as GetJson;
    expect(githubRow(json).status).toBe("connected");
    expect(githubRow(json).target).toBe("acme/repo-a");
  });

  // appInstalled — the granular signal (install-affordance fix): distinct
  // from `connected`, which stays true via repos alone even with no App
  // installation row. Both cases below hold `connected` true via repos.
  it("appInstalled is true once the App installation row exists", async () => {
    vi.mocked(listWorkspaceRepositories).mockResolvedValue([
      { name: "acme/repo-a" },
    ] as never);
    vi.mocked(getGithubInstallation).mockResolvedValue({
      installationId: "777",
      accountLogin: "acme",
      accountType: "Organization",
    });
    const res = await GET(getReq(), { params: params() });
    const json = (await res.json()) as GetJson;
    expect(githubRow(json).status).toBe("connected");
    expect(githubRow(json).appInstalled).toBe(true);
  });

  it("appInstalled is false for a pre-App workspace connected only via linked repos — the bug this fixes", async () => {
    vi.mocked(listWorkspaceRepositories).mockResolvedValue([
      { name: "acme/repo-a" },
    ] as never);
    // No installation row (default mock from beforeEach: null).
    const res = await GET(getReq(), { params: params() });
    const json = (await res.json()) as GetJson;
    expect(githubRow(json).status).toBe("connected");
    expect(githubRow(json).appInstalled).toBe(false);
  });
});

// -----------------------------------------------------------------------
// GET — channel identities (Gateway → Channels cutover). A channel kind
// (telegram/discord/slack) is connected once the workspace has ≥1 linked
// chat identity for its platform (`listChatIdentitiesForWorkspace`), never
// from a stored secret/webhook. The response must expose a display name
// only — never the raw platformUserId.
// -----------------------------------------------------------------------
interface ChannelGetJson {
  connectors: Array<{
    kind: string;
    status: string;
    linkedIdentities: Array<{ displayName: string | null }>;
  }>;
}

function channelRow(json: ChannelGetJson, kind: string) {
  return json.connectors.find((c) => c.kind === kind)!;
}

describe("GET /connectors — channel identities (Channels cutover)", () => {
  beforeEach(() => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ role: "owner" } as never);
  });

  it("projects a linked telegram identity as connected, exposing only its display name", async () => {
    vi.mocked(listChatIdentitiesForWorkspace).mockResolvedValue([
      { platform: "telegram", platformUserId: "999888777", displayName: "Ben" },
    ] as never);

    const res = await GET(getReq(), { params: params() });
    const json = (await res.json()) as ChannelGetJson;
    const telegram = channelRow(json, "telegram");
    expect(telegram.status).toBe("connected");
    expect(telegram.linkedIdentities).toEqual([{ displayName: "Ben" }]);
  });

  it("never leaks platformUserId into the response", async () => {
    vi.mocked(listChatIdentitiesForWorkspace).mockResolvedValue([
      { platform: "telegram", platformUserId: "999888777", displayName: "Ben" },
    ] as never);

    const res = await GET(getReq(), { params: params() });
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("999888777");
    expect(text).not.toContain("platformUserId");
  });

  it("stays disconnected, with empty linkedIdentities, when there is no linked identity", async () => {
    const res = await GET(getReq(), { params: params() });
    const json = (await res.json()) as ChannelGetJson;
    const telegram = channelRow(json, "telegram");
    expect(telegram.status).toBe("disconnected");
    expect(telegram.linkedIdentities).toEqual([]);
  });
});
