import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { PATCH } from "./route";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));

// Real enums come through `importActual` (mirrors
// `app/api/v1/runner/result/route.test.ts`'s own precedent) — `briefStatusEnum`
// is the actual source of truth this route validates `status` against, so a
// hand-copied literal list here could silently drift from the schema.
vi.mock("@agentrail/db-postgres", async (importActual) => {
  const actual = await importActual<typeof import("@agentrail/db-postgres")>();
  return {
    briefStatusEnum: actual.briefStatusEnum,
    getWorkspaceMembership: vi.fn(),
    getBriefBySlug: vi.fn(),
    setBriefStatus: vi.fn(),
  };
});

import { auth } from "@agentrail/auth";
import { getBriefBySlug, getWorkspaceMembership, setBriefStatus } from "@agentrail/db-postgres";

const WORKSPACE_ID = "ws-123";
const SLUG = "blog";
const USER_ID = "user-1";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/briefs/${SLUG}/status`,
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
}

function makeParams() {
  return { params: Promise.resolve({ workspaceId: WORKSPACE_ID, slug: SLUG }) };
}

const briefRow = {
  id: "brief-1",
  workspaceId: WORKSPACE_ID,
  slug: SLUG,
  title: "Add a blog",
  status: "draft",
  items: [],
};

function mockMember(role: string) {
  vi.mocked(auth).mockResolvedValue({ user: { id: USER_ID } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    role,
  } as never);
}

describe("PATCH /api/v1/workspaces/:workspaceId/briefs/:slug/status", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await PATCH(makeRequest({ status: "ready" }), makeParams());
    expect(res.status).toBe(401);
  });

  it("returns 403 when the caller is not a workspace member", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER_ID } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const res = await PATCH(makeRequest({ status: "ready" }), makeParams());
    expect(res.status).toBe(403);
  });

  it("returns 403 for a member role — this is a workspace-configuration mutation, not a content read", async () => {
    mockMember("member");
    const res = await PATCH(makeRequest({ status: "ready" }), makeParams());
    expect(res.status).toBe(403);
    expect(getBriefBySlug).not.toHaveBeenCalled();
  });

  it("returns 403 for a viewer role", async () => {
    mockMember("viewer");
    const res = await PATCH(makeRequest({ status: "ready" }), makeParams());
    expect(res.status).toBe(403);
    expect(setBriefStatus).not.toHaveBeenCalled();
  });

  it("allows an owner to flip status to ready", async () => {
    mockMember("owner");
    vi.mocked(getBriefBySlug).mockResolvedValue(briefRow as never);
    vi.mocked(setBriefStatus).mockResolvedValue({ ...briefRow, status: "ready" } as never);

    const res = await PATCH(makeRequest({ status: "ready" }), makeParams());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("ready");
    expect(setBriefStatus).toHaveBeenCalledWith("brief-1", "ready");
  });

  it("allows an admin to flip status to draft", async () => {
    mockMember("admin");
    vi.mocked(getBriefBySlug).mockResolvedValue({ ...briefRow, status: "ready" } as never);
    vi.mocked(setBriefStatus).mockResolvedValue(briefRow as never);

    const res = await PATCH(makeRequest({ status: "draft" }), makeParams());
    expect(res.status).toBe(200);
    expect(setBriefStatus).toHaveBeenCalledWith("brief-1", "draft");
  });

  it("returns 404 when the slug doesn't resolve in this workspace — the workspace segment of the URL scopes the lookup, not just the slug", async () => {
    mockMember("owner");
    vi.mocked(getBriefBySlug).mockResolvedValue(null);

    const res = await PATCH(makeRequest({ status: "ready" }), makeParams());

    expect(res.status).toBe(404);
    expect(getBriefBySlug).toHaveBeenCalledWith(WORKSPACE_ID, SLUG);
    expect(setBriefStatus).not.toHaveBeenCalled();
  });

  it("returns 400 for a status value outside the enum", async () => {
    mockMember("owner");
    vi.mocked(getBriefBySlug).mockResolvedValue(briefRow as never);

    const res = await PATCH(makeRequest({ status: "archived" }), makeParams());

    expect(res.status).toBe(400);
    expect(setBriefStatus).not.toHaveBeenCalled();
  });

  it("returns 404 when setBriefStatus finds nothing to update (raced with a delete)", async () => {
    mockMember("owner");
    vi.mocked(getBriefBySlug).mockResolvedValue(briefRow as never);
    vi.mocked(setBriefStatus).mockResolvedValue(null);

    const res = await PATCH(makeRequest({ status: "ready" }), makeParams());
    expect(res.status).toBe(404);
  });
});
