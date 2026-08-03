import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({ auth: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({
  auth: vi.fn(),
  createDependencyWatch: vi.fn(),
  DependencyWatchAuthorizationError: class extends Error {},
  DependencyWatchValidationError: class extends Error {},
  getWorkspaceMembership: vi.fn(),
  listDependencyWatches: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import { createDependencyWatch, getWorkspaceMembership, listDependencyWatches } from "@agentrail/db-postgres";
import { GET, POST } from "./route";

const workspaceId = "ws-1";
const member = { userId: "user-1", workspaceId, role: "owner" };
const watch = { id: "watch-1", workspaceId, repositoryId: "repo-1", manifestPath: "package.json", lockfilePath: "pnpm-lock.yaml" };

function params() { return { params: Promise.resolve({ workspaceId }) }; }
function request(body?: unknown) {
  return new NextRequest("http://localhost/api/v1/workspaces/ws-1/dependency-watches", {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue(member as never);
  vi.mocked(listDependencyWatches).mockResolvedValue([watch] as never);
  vi.mocked(createDependencyWatch).mockResolvedValue(watch as never);
});

describe("dependency watch configuration API", () => {
  it("lists only the authenticated workspace's watches", async () => {
    const response = await GET(request(), params());
    expect(response.status).toBe(200);
    expect(listDependencyWatches).toHaveBeenCalledWith(workspaceId);
  });

  it("creates a workspace-scoped watch with selected files, dependencies, and cadence", async () => {
    const response = await POST(request({
      repository_id: "repo-1",
      manifest_path: "package.json",
      lockfile_path: "pnpm-lock.yaml",
      dependencies: ["react", "react"],
      cadence_seconds: 3600,
    }), params());
    expect(response.status).toBe(201);
    expect(createDependencyWatch).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId,
      repositoryId: "repo-1",
      cadenceSeconds: 3600,
    }));
  });

  it("does not allow a non-member to read or configure watches", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    expect((await GET(request(), params())).status).toBe(403);
    expect((await POST(request({ repository_id: "repo-1" }), params())).status).toBe(403);
    expect(createDependencyWatch).not.toHaveBeenCalled();
  });

  it("does not allow a regular member to change watch configuration", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ ...member, role: "member" } as never);
    expect((await POST(request({ repository_id: "repo-1" }), params())).status).toBe(403);
  });
});
