import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

// ── Module mocks ───────────────────────────────────────────────────────────
vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  getRepositoryByName: vi.fn(),
  enqueueOnboard: vi.fn(),
  ONBOARD_ALREADY_PENDING_REASON: "already_pending",
}));

import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  getRepositoryByName,
  enqueueOnboard,
} from "@agentrail/db-postgres";

// ── Helpers ────────────────────────────────────────────────────────────────
const WORKSPACE_ID = "ws-123";
const USER_ID = "user-1";

function makeRequest(body: unknown = { repoFullName: "bensigo/agentrail" }): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/wiki/recompile`,
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

function mockMember(role: string) {
  vi.mocked(auth).mockResolvedValue({ user: { id: USER_ID } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    role,
  } as never);
}

const repoA = {
  id: "repo-a",
  workspaceId: WORKSPACE_ID,
  name: "bensigo/agentrail",
  url: "https://github.com/bensigo/agentrail",
  defaultBranch: "main",
};

describe("POST /api/v1/workspaces/:workspaceId/wiki/recompile", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(401);
    expect(enqueueOnboard).not.toHaveBeenCalled();
  });

  it("returns 403 for a non-member", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER_ID } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(403);
    expect(enqueueOnboard).not.toHaveBeenCalled();
  });

  it("returns 403 for a plain member role", async () => {
    mockMember("member");
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(403);
    expect(enqueueOnboard).not.toHaveBeenCalled();
  });

  it("returns 403 for a viewer role", async () => {
    mockMember("viewer");
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(403);
  });

  it("returns 400 when repoFullName is missing", async () => {
    mockMember("owner");
    const res = await POST(makeRequest({}), makeParams());
    expect(res.status).toBe(400);
    expect(getRepositoryByName).not.toHaveBeenCalled();
  });

  it("returns 400 when repoFullName is blank", async () => {
    mockMember("owner");
    const res = await POST(makeRequest({ repoFullName: "   " }), makeParams());
    expect(res.status).toBe(400);
  });

  it("returns 404 for a repo not connected to this workspace", async () => {
    mockMember("owner");
    vi.mocked(getRepositoryByName).mockResolvedValue(null as never);
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(404);
    expect(enqueueOnboard).not.toHaveBeenCalled();
  });

  it("owner: a fresh/rearmed enqueue returns 202 queued", async () => {
    mockMember("owner");
    vi.mocked(getRepositoryByName).mockResolvedValue(repoA as never);
    vi.mocked(enqueueOnboard).mockResolvedValue({
      enqueued: true,
      id: "queue-entry-1",
      state: "queued",
      blockedBy: [],
    });

    const res = await POST(makeRequest(), makeParams());
    const json = await res.json();

    expect(res.status).toBe(202);
    expect(json).toEqual({ status: "queued" });
    expect(enqueueOnboard).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      repoFullName: repoA.name,
      force: true,
    });
  });

  it("admin: also allowed", async () => {
    mockMember("admin");
    vi.mocked(getRepositoryByName).mockResolvedValue(repoA as never);
    vi.mocked(enqueueOnboard).mockResolvedValue({
      enqueued: true,
      id: "queue-entry-1",
      state: "queued",
      blockedBy: [],
    });

    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(202);
  });

  it("reports already_pending honestly when the dedupe hits an active row — never claims queued", async () => {
    mockMember("owner");
    vi.mocked(getRepositoryByName).mockResolvedValue(repoA as never);
    vi.mocked(enqueueOnboard).mockResolvedValue({
      enqueued: false,
      reason: "already_pending",
    });

    const res = await POST(makeRequest(), makeParams());
    const json = await res.json();

    expect(res.status).toBe(202);
    expect(json).toEqual({ status: "already_pending" });
  });

  it("resolves repoFullName within the workspace via getRepositoryByName, not a raw string pass-through", async () => {
    mockMember("owner");
    vi.mocked(getRepositoryByName).mockResolvedValue(repoA as never);
    vi.mocked(enqueueOnboard).mockResolvedValue({
      enqueued: true,
      id: "id",
      state: "queued",
      blockedBy: [],
    });

    await POST(makeRequest({ repoFullName: "  bensigo/agentrail  " }), makeParams());

    expect(getRepositoryByName).toHaveBeenCalledWith(WORKSPACE_ID, "bensigo/agentrail");
  });

  it("returns 500 when enqueueOnboard throws", async () => {
    mockMember("owner");
    vi.mocked(getRepositoryByName).mockResolvedValue(repoA as never);
    vi.mocked(enqueueOnboard).mockRejectedValue(new Error("db down"));

    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(500);
  });

  it("returns 500 (never a fabricated queued) on an unexpected enqueueOnboard reason", async () => {
    mockMember("owner");
    vi.mocked(getRepositoryByName).mockResolvedValue(repoA as never);
    vi.mocked(enqueueOnboard).mockResolvedValue({
      enqueued: false,
      reason: "already onboarded (deduped)",
    });

    const res = await POST(makeRequest(), makeParams());
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.status).toBeUndefined();
  });
});
