import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({ auth: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({
  DependencyWatchAuthorizationError: class extends Error {},
  DependencyWatchValidationError: class extends Error {},
  getDependencyWatch: vi.fn(),
  getWorkspaceMembership: vi.fn(),
  triggerDependencyWatch: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import { getDependencyWatch, getWorkspaceMembership, triggerDependencyWatch } from "@agentrail/db-postgres";
import { GET, POST } from "./route";

const workspaceId = "ws-1";
const watchId = "watch-1";
const watch = { id: watchId, workspaceId, repositoryId: "repo-1", status: "checking", lastTrigger: "manual" };

function params() { return { params: Promise.resolve({ workspaceId, watchId }) }; }
function request(body: unknown = {}) {
  return new NextRequest("http://localhost/api/v1/workspaces/ws-1/dependency-watches/watch-1", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ userId: "user-1", workspaceId, role: "member" } as never);
  vi.mocked(getDependencyWatch).mockResolvedValue(watch as never);
  vi.mocked(triggerDependencyWatch).mockResolvedValue(watch as never);
});

describe("dependency watch manual trigger API", () => {
  it("queues an observation-only manual trigger for the heartbeat", async () => {
    const response = await POST(request(), params());
    expect(response.status).toBe(202);
    expect(triggerDependencyWatch).toHaveBeenCalledWith(workspaceId, watchId, "manual");
    await expect(response.json()).resolves.toEqual({ watch, dispatched: true });
  });

  it("rejects a cross-workspace lookup without triggering it", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const response = await POST(request(), params());
    expect(response.status).toBe(403);
    expect(triggerDependencyWatch).not.toHaveBeenCalled();
  });

  it("reads a watch only through the requesting workspace", async () => {
    const response = await GET(new NextRequest("http://localhost"), params());
    expect(response.status).toBe(200);
    expect(getDependencyWatch).toHaveBeenCalledWith(workspaceId, watchId);
  });
});
