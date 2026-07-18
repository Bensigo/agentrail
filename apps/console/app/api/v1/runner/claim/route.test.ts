import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  claimQueueEntry: vi.fn(),
  touchApiKeyLastUsed: vi.fn(),
  hasActiveSelfHostedRunner: vi.fn(),
  getMcpConnectorKeys: vi.fn(),
  getGithubToken: vi.fn(),
}));
vi.mock("@agentrail/db-clickhouse", () => ({
  recordRunLifecycleEvent: vi.fn(),
}));
vi.mock("../../../../../lib/bearer-auth", () => ({
  requireBearer: vi.fn(),
}));

import { GET } from "./route";
import {
  claimQueueEntry,
  touchApiKeyLastUsed,
  hasActiveSelfHostedRunner,
  getMcpConnectorKeys,
  getGithubToken,
} from "@agentrail/db-postgres";
import { recordRunLifecycleEvent } from "@agentrail/db-clickhouse";
import { requireBearer } from "../../../../../lib/bearer-auth";

const mockClaim = vi.mocked(claimQueueEntry);
const mockTouch = vi.mocked(touchApiKeyLastUsed);
const mockHasActiveSelfHosted = vi.mocked(hasActiveSelfHostedRunner);
const mockGetMcpKeys = vi.mocked(getMcpConnectorKeys);
const mockGetGithubToken = vi.mocked(getGithubToken);
const mockRecordLifecycle = vi.mocked(recordRunLifecycleEvent);
const mockRequireBearer = vi.mocked(requireBearer);

const WS = "ws-1";

function req(workspaceId?: string): NextRequest {
  const url =
    workspaceId === undefined
      ? "http://localhost/api/v1/runner/claim"
      : `http://localhost/api/v1/runner/claim?workspace_id=${workspaceId}`;
  return new NextRequest(url, {
    headers: { Authorization: "Bearer ar_test" },
  });
}

const WORK_ITEM = {
  id: "qe-1",
  workspace_id: WS,
  source: "cli",
  kind: "issue",
  external_id: "owner/repo#42",
  repo_url: "https://github.com/owner/repo",
  ref: "main",
  title: "Fix the thing",
  body: "body",
  repository_id: "repo-1",
  tier: 0,
};

function authResult(kind: "self_hosted" | "fleet" = "self_hosted") {
  return { apiKeyId: "key-1", workspaceId: WS, teamId: null, kind };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireBearer.mockResolvedValue(authResult() as never);
  mockTouch.mockResolvedValue(undefined as never);
  mockHasActiveSelfHosted.mockResolvedValue(false);
  mockClaim.mockResolvedValue(null);
  mockGetMcpKeys.mockResolvedValue({});
  mockGetGithubToken.mockResolvedValue("");
  mockRecordLifecycle.mockResolvedValue(undefined as never);
});

describe("GET /api/v1/runner/claim — baseline (pre-#1267 behavior)", () => {
  it("401 when requireBearer rejects", async () => {
    mockRequireBearer.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }) as never
    );

    const res = await GET(req(WS));

    expect(res.status).toBe(401);
    expect(mockTouch).not.toHaveBeenCalled();
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("400 when workspace_id query param is missing", async () => {
    const res = await GET(req(undefined));

    expect(res.status).toBe(400);
    expect(mockTouch).not.toHaveBeenCalled();
  });

  it("403 when the bearer's workspace differs from the requested workspace_id", async () => {
    mockRequireBearer.mockResolvedValue(authResult() as never);

    const res = await GET(req("some-other-ws"));

    expect(res.status).toBe(403);
    expect(mockTouch).not.toHaveBeenCalled();
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("touches api key last-used on every authorized request, before claiming", async () => {
    await GET(req(WS));

    expect(mockTouch).toHaveBeenCalledWith("key-1");
  });

  it("204 (empty) when nothing is queued", async () => {
    mockClaim.mockResolvedValue(null);

    const res = await GET(req(WS));

    expect(res.status).toBe(204);
    expect(mockRecordLifecycle).not.toHaveBeenCalled();
  });

  it("200 with the claimed item plus mcp_keys/github_token when something is queued", async () => {
    mockClaim.mockResolvedValue(WORK_ITEM as never);
    mockGetMcpKeys.mockResolvedValue({ linear: "mcp-key-1" });
    mockGetGithubToken.mockResolvedValue("gh-token-1");

    const res = await GET(req(WS));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ...WORK_ITEM, mcp_keys: { linear: "mcp-key-1" }, github_token: "gh-token-1" });
    expect(mockRecordLifecycle).toHaveBeenCalledWith(
      WS,
      WORK_ITEM.id,
      "run_started",
      expect.stringContaining(WORK_ITEM.external_id)
    );
  });

  it("still returns 200 (mcp_keys: {}) when getMcpConnectorKeys throws — best-effort, never fails the claim", async () => {
    mockClaim.mockResolvedValue(WORK_ITEM as never);
    mockGetMcpKeys.mockRejectedValue(new Error("decrypt failed"));

    const res = await GET(req(WS));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.mcp_keys).toEqual({});
  });

  it("still returns 200 (github_token: '') when getGithubToken throws — best-effort", async () => {
    mockClaim.mockResolvedValue(WORK_ITEM as never);
    mockGetGithubToken.mockRejectedValue(new Error("token fetch failed"));

    const res = await GET(req(WS));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.github_token).toBe("");
  });
});

describe("GET /api/v1/runner/claim — self-hosted precedence guard (#1267 PR ① Locked-5)", () => {
  it("kind='self_hosted' NEVER calls hasActiveSelfHostedRunner — byte-identical to pre-#1267", async () => {
    mockRequireBearer.mockResolvedValue(authResult("self_hosted") as never);
    mockClaim.mockResolvedValue(WORK_ITEM as never);

    await GET(req(WS));

    expect(mockHasActiveSelfHosted).not.toHaveBeenCalled();
    expect(mockClaim).toHaveBeenCalledWith(WS);
  });

  it("kind='self_hosted' still claims normally even if a self-hosted runner is (hypothetically) reported active — the guard is fleet-only", async () => {
    mockRequireBearer.mockResolvedValue(authResult("self_hosted") as never);
    mockHasActiveSelfHosted.mockResolvedValue(true);
    mockClaim.mockResolvedValue(WORK_ITEM as never);

    const res = await GET(req(WS));

    expect(res.status).toBe(200);
    expect(mockClaim).toHaveBeenCalledWith(WS);
  });

  it("kind='fleet' + an active self-hosted runner -> 204, never calls claimQueueEntry", async () => {
    mockRequireBearer.mockResolvedValue(authResult("fleet") as never);
    mockHasActiveSelfHosted.mockResolvedValue(true);

    const res = await GET(req(WS));

    expect(res.status).toBe(204);
    expect(mockHasActiveSelfHosted).toHaveBeenCalledWith(WS);
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("kind='fleet' + NO active self-hosted runner -> claims normally", async () => {
    mockRequireBearer.mockResolvedValue(authResult("fleet") as never);
    mockHasActiveSelfHosted.mockResolvedValue(false);
    mockClaim.mockResolvedValue(WORK_ITEM as never);

    const res = await GET(req(WS));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.id).toBe(WORK_ITEM.id);
    expect(mockClaim).toHaveBeenCalledWith(WS);
  });

  it("kind='fleet' + a gone-stale self-hosted runner (outside the presence window) -> claims normally", async () => {
    // hasActiveSelfHostedRunner itself owns the staleness window (last_used_at
    // within 1h); from the route's point of view this is indistinguishable
    // from "never had one" — both resolve false.
    mockRequireBearer.mockResolvedValue(authResult("fleet") as never);
    mockHasActiveSelfHosted.mockResolvedValue(false);
    mockClaim.mockResolvedValue(null);

    const res = await GET(req(WS));

    expect(mockHasActiveSelfHosted).toHaveBeenCalledWith(WS);
    expect(mockClaim).toHaveBeenCalledWith(WS);
    expect(res.status).toBe(204); // nothing queued, but reached via claimQueueEntry, not the guard
  });

  it("touches api key last-used even when the fleet guard subsequently returns 204", async () => {
    mockRequireBearer.mockResolvedValue(authResult("fleet") as never);
    mockHasActiveSelfHosted.mockResolvedValue(true);

    await GET(req(WS));

    expect(mockTouch).toHaveBeenCalledWith("key-1");
  });
});
