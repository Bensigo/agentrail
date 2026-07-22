import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

// ── Module mocks ───────────────────────────────────────────────────────────
vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  listWorkspaceRepositories: vi.fn(),
  getRepositoryByName: vi.fn(),
  createRepository: vi.fn(),
  enqueueOnboard: vi.fn(),
  workspaceHasExecutionPath: vi.fn(),
  getUserGithubAccessToken: vi.fn(),
}));

vi.mock("@agentrail/db-clickhouse", () => ({
  getLatestIndexSnapshotsForWorkspace: vi.fn().mockResolvedValue([]),
}));

import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  getRepositoryByName,
  createRepository,
  enqueueOnboard,
  workspaceHasExecutionPath,
  getUserGithubAccessToken,
} from "@agentrail/db-postgres";

// ── Helpers ────────────────────────────────────────────────────────────────
const WORKSPACE_ID = "ws-123";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/repos`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

function makeParams() {
  return { params: Promise.resolve({ workspaceId: WORKSPACE_ID }) };
}

const validBody = {
  name: "bensigo/agentrail",
  url: "https://github.com/bensigo/agentrail",
  default_branch: "main",
};

const createdRepo = {
  id: "repo-1",
  workspaceId: WORKSPACE_ID,
  name: "bensigo/agentrail",
  url: "https://github.com/bensigo/agentrail",
  defaultBranch: "main",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

// ── Tests ──────────────────────────────────────────────────────────────────
/** Minimal GitHub `GET /repos/{owner}/{repo}` response for checkRepoAccess. */
function ghRepoResponse(
  status: number,
  permissions?: { push?: boolean; admin?: boolean; maintain?: boolean }
) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ permissions }),
  };
}

describe("POST /api/v1/workspaces/:workspaceId/repos", () => {
  const savedOnboardFlag = process.env.AGENTRAIL_ONBOARD_ON_CONNECT;
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.AGENTRAIL_ONBOARD_ON_CONNECT;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (savedOnboardFlag === undefined) {
      delete process.env.AGENTRAIL_ONBOARD_ON_CONNECT;
    } else {
      process.env.AGENTRAIL_ONBOARD_ON_CONNECT = savedOnboardFlag;
    }
  });

  it("returns 201 and the new repository on success", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({
      userId: "user-1",
      workspaceId: WORKSPACE_ID,
      role: "owner",
    } as never);
    vi.mocked(getRepositoryByName).mockResolvedValue(null as never);
    vi.mocked(createRepository).mockResolvedValue(createdRepo as never);

    const res = await POST(makeRequest(validBody), makeParams());
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.repository.name).toBe("bensigo/agentrail");
    expect(json.repository.health_status).toBe("critical");
    expect(json.repository.last_indexed_at).toBeNull();
  });

  // The gate is workspaceHasExecutionPath (#1268, swapped in from the former
  // kind-agnostic hasActiveRunner) — this route only ever sees its single
  // boolean result, so "true → enqueues" below covers BOTH the hosted-only
  // case and the pre-existing active-self-hosted case identically (the
  // route can't and needn't distinguish which sub-condition made it true).
  // The sub-cases behind that boolean are unit-tested directly on the
  // predicate itself in
  // packages/db-postgres/src/__tests__/workspace-has-execution-path.test.ts.
  it("#1268: enqueues an onboard entry for a hosted-only workspace (no runner has EVER claimed anything)", async () => {
    process.env.AGENTRAIL_ONBOARD_ON_CONNECT = "1";
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({
      userId: "user-1",
      workspaceId: WORKSPACE_ID,
      role: "owner",
    } as never);
    vi.mocked(getRepositoryByName).mockResolvedValue(null as never);
    vi.mocked(createRepository).mockResolvedValue(createdRepo as never);
    // Stands in for the exact regression #1268 fixes: hostedExecution=true,
    // zero api_keys rows ever touched — the old hasActiveRunner gate would
    // have read false forever for a workspace like this.
    vi.mocked(workspaceHasExecutionPath).mockResolvedValue(true);

    const res = await POST(makeRequest(validBody), makeParams());

    expect(res.status).toBe(201);
    expect(workspaceHasExecutionPath).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(enqueueOnboard).toHaveBeenCalledTimes(1);
    expect(enqueueOnboard).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      repoFullName: createdRepo.name,
    });
  });

  it("does not enqueue an onboard entry when the flag is OFF (unset)", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({
      userId: "user-1",
      workspaceId: WORKSPACE_ID,
      role: "owner",
    } as never);
    vi.mocked(getRepositoryByName).mockResolvedValue(null as never);
    vi.mocked(createRepository).mockResolvedValue(createdRepo as never);

    const res = await POST(makeRequest(validBody), makeParams());

    expect(res.status).toBe(201);
    expect(workspaceHasExecutionPath).not.toHaveBeenCalled();
    expect(enqueueOnboard).not.toHaveBeenCalled();
  });

  it("stays gated when workspaceHasExecutionPath is false (hostedExecution=false + no active self-hosted runner)", async () => {
    process.env.AGENTRAIL_ONBOARD_ON_CONNECT = "1";
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({
      userId: "user-1",
      workspaceId: WORKSPACE_ID,
      role: "owner",
    } as never);
    vi.mocked(getRepositoryByName).mockResolvedValue(null as never);
    vi.mocked(createRepository).mockResolvedValue(createdRepo as never);
    vi.mocked(workspaceHasExecutionPath).mockResolvedValue(false);

    const res = await POST(makeRequest(validBody), makeParams());

    expect(res.status).toBe(201);
    expect(enqueueOnboard).not.toHaveBeenCalled();
  });

  it("still returns 201 when the onboard enqueue throws (best-effort)", async () => {
    process.env.AGENTRAIL_ONBOARD_ON_CONNECT = "1";
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({
      userId: "user-1",
      workspaceId: WORKSPACE_ID,
      role: "owner",
    } as never);
    vi.mocked(getRepositoryByName).mockResolvedValue(null as never);
    vi.mocked(createRepository).mockResolvedValue(createdRepo as never);
    vi.mocked(workspaceHasExecutionPath).mockResolvedValue(true);
    vi.mocked(enqueueOnboard).mockRejectedValue(new Error("db down"));

    const res = await POST(makeRequest(validBody), makeParams());

    expect(res.status).toBe(201);
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const res = await POST(makeRequest(validBody), makeParams());
    expect(res.status).toBe(401);
  });

  it("returns 403 when user is not a workspace member", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);

    const res = await POST(makeRequest(validBody), makeParams());
    expect(res.status).toBe(403);
  });

  it("returns 403 when user has member role (not owner/admin)", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({
      userId: "user-1",
      workspaceId: WORKSPACE_ID,
      role: "member",
    } as never);

    const res = await POST(makeRequest(validBody), makeParams());
    expect(res.status).toBe(403);
  });

  it("returns 400 with per-field errors on invalid input", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({
      userId: "user-1",
      workspaceId: WORKSPACE_ID,
      role: "admin",
    } as never);

    const res = await POST(
      makeRequest({
        name: "invalid-no-slash",
        url: "https://notgithub.com/foo/bar",
        default_branch: "",
      }),
      makeParams()
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.errors).toBeDefined();
    expect(json.errors.name).toBeDefined();
    expect(json.errors.url).toBeDefined();
    expect(json.errors.default_branch).toBeDefined();
  });

  it("returns 409 when a repository with the same name already exists", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({
      userId: "user-1",
      workspaceId: WORKSPACE_ID,
      role: "owner",
    } as never);
    vi.mocked(getRepositoryByName).mockResolvedValue(createdRepo as never);

    const res = await POST(makeRequest(validBody), makeParams());
    expect(res.status).toBe(409);
  });

  // ── AC2 (#1293): existence + push-access validation via the user's token ──
  it("validates the picked repo against GitHub and creates it when the user has push access", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({
      userId: "user-1",
      workspaceId: WORKSPACE_ID,
      role: "admin",
    } as never);
    vi.mocked(getRepositoryByName).mockResolvedValue(null as never);
    vi.mocked(getUserGithubAccessToken).mockResolvedValue("gho_token");
    vi.mocked(createRepository).mockResolvedValue(createdRepo as never);
    const fetchMock = vi.fn().mockResolvedValue(ghRepoResponse(200, { push: true }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await POST(makeRequest(validBody), makeParams());

    expect(res.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "https://api.github.com/repos/bensigo/agentrail"
    );
    expect(createRepository).toHaveBeenCalledTimes(1);
  });

  it("returns 404 with a name field error when the repo does not exist / is inaccessible", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({
      userId: "user-1",
      workspaceId: WORKSPACE_ID,
      role: "admin",
    } as never);
    vi.mocked(getRepositoryByName).mockResolvedValue(null as never);
    vi.mocked(getUserGithubAccessToken).mockResolvedValue("gho_token");
    global.fetch = vi
      .fn()
      .mockResolvedValue(ghRepoResponse(404)) as unknown as typeof fetch;

    const res = await POST(makeRequest(validBody), makeParams());
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.errors.name).toBeDefined();
    expect(createRepository).not.toHaveBeenCalled();
  });

  it("returns 403 with a name field error when the user lacks push access", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({
      userId: "user-1",
      workspaceId: WORKSPACE_ID,
      role: "admin",
    } as never);
    vi.mocked(getRepositoryByName).mockResolvedValue(null as never);
    vi.mocked(getUserGithubAccessToken).mockResolvedValue("gho_token");
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        ghRepoResponse(200, { push: false, admin: false, maintain: false })
      ) as unknown as typeof fetch;

    const res = await POST(makeRequest(validBody), makeParams());
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.errors.name).toBeDefined();
    expect(createRepository).not.toHaveBeenCalled();
  });

  it("does not block the connect on a transient GitHub failure (indeterminate)", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({
      userId: "user-1",
      workspaceId: WORKSPACE_ID,
      role: "admin",
    } as never);
    vi.mocked(getRepositoryByName).mockResolvedValue(null as never);
    vi.mocked(getUserGithubAccessToken).mockResolvedValue("gho_token");
    // 401 from GitHub → indeterminate → fall through to regex-only, still creates.
    global.fetch = vi
      .fn()
      .mockResolvedValue(ghRepoResponse(401)) as unknown as typeof fetch;
    vi.mocked(createRepository).mockResolvedValue(createdRepo as never);

    const res = await POST(makeRequest(validBody), makeParams());

    expect(res.status).toBe(201);
    expect(createRepository).toHaveBeenCalledTimes(1);
  });

  it("skips the GitHub check entirely when the user has no linked token (manual fallback)", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({
      userId: "user-1",
      workspaceId: WORKSPACE_ID,
      role: "admin",
    } as never);
    vi.mocked(getRepositoryByName).mockResolvedValue(null as never);
    vi.mocked(getUserGithubAccessToken).mockResolvedValue(null);
    vi.mocked(createRepository).mockResolvedValue(createdRepo as never);
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await POST(makeRequest(validBody), makeParams());

    expect(res.status).toBe(201);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createRepository).toHaveBeenCalledTimes(1);
  });
});
