import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({ auth: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  listWorkspaceRepositories: vi.fn(),
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
  getConnectors,
  getGithubInstallation,
  upsertConnector,
} from "@agentrail/db-postgres";
import { GET, PUT } from "./route";

// Minimal real implementations mirrored from db-postgres/queries/connectors.ts
// so the route's validation is genuinely exercised in this hermetic test.
// Task 7 adds "railway" to isConnectorProvider (connectorProviderEnum).
// Task P0 (Fix Round 1): the ROUTE's PUT handler no longer hand-lists
// `railwayProjectId` — it forwards any catalog-declared extraConfigFields
// key generically (`EXTRA_CONFIG_KEYS`, `route.ts`) to `validateConnectorUpdate`.
// This MOCK still validates `railwayProjectId` as its own named branch
// because it's a simplified stand-in for db-postgres's REAL
// `validateConnectorUpdate` (which itself validates each Wave 2 field by
// name, per `queries/connectors.ts` — the route's genericity is about which
// keys it FORWARDS, not about how the query layer validates them).
function realIsProvider(v: unknown): boolean {
  return v === "github" || v === "linear" || v === "discord" || v === "railway";
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
    if (c.railwayProjectId !== undefined) {
      const t = String(c.railwayProjectId).trim();
      if (!t || t.length > 64) return { ok: false, error: "bad railwayProjectId" };
      out.railwayProjectId = t;
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

  // Task 7 (debugging design spec): the railway connect card's project-id
  // field saves via THIS route (config path), not the secret route — see
  // connector-helpers.ts's ConnectorConnectMeta.extraConfigField doc-comment.
  it("saves railwayProjectId for owner/admin (Task 7 — config path, not the secret route)", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ role: "owner" } as never);
    const res = await PUT(
      putReq({ provider: "railway", railwayProjectId: "proj-123" }),
      { params: params() }
    );
    expect(res.status).toBe(200);
    expect(upsertConnector).toHaveBeenCalledWith(WS, "railway", {
      config: { railwayProjectId: "proj-123" },
    });
  });

  it("400 for railway with an out-of-bounds railwayProjectId", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ role: "admin" } as never);
    const res = await PUT(
      putReq({ provider: "railway", railwayProjectId: "x".repeat(65) }),
      { params: params() }
    );
    expect(res.status).toBe(400);
    expect(upsertConnector).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------
// GET — railway's projected row (Task 7): hasSecret + railwayProjectId must
// actually reach projectConnectors, or the card would always render
// disconnected regardless of a stored credential (the gap this task's
// "check the GET route's hand-enumerated secretConfig() calls" note warns
// about).
// -----------------------------------------------------------------------
describe("GET /connectors — railway row projection (Task 7)", () => {
  beforeEach(() => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ role: "owner" } as never);
  });

  function railwayRow() {
    return {
      provider: "railway" as const,
      enabled: true,
      config: {
        repos: [],
        triggerLabel: "ready-for-agent",
        pollIntervalSeconds: 60,
        railwayProjectId: "proj-abc",
      },
      hasSecret: true,
      updatedAt: "2026-07-29T00:00:00.000Z",
    };
  }

  it("is disconnected with no stored row (never silently 'connected')", async () => {
    const res = await GET(getReq(), { params: params() });
    const json = (await res.json()) as GetJson;
    const railway = json.connectors.find((c) => c.kind === "railway");
    expect(railway).toBeDefined();
    expect(railway!.status).toBe("disconnected");
  });

  it("shows connected once a railway connector row with hasSecret is stored", async () => {
    vi.mocked(getConnectors).mockResolvedValue([railwayRow()] as never);
    const res = await GET(getReq(), { params: params() });
    const json = (await res.json()) as GetJson;
    const railway = json.connectors.find((c) => c.kind === "railway");
    expect(railway!.status).toBe("connected");
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
