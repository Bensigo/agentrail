import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));

// Real enums via `importActual` (see `status/route.test.ts`'s own comment for
// why) — this route validates `area`/`kind`/`state`/`resolution` against the
// actual schema enums, not a hand-copied list.
vi.mock("@agentrail/db-postgres", async (importActual) => {
  const actual = await importActual<typeof import("@agentrail/db-postgres")>();
  return {
    briefAreaEnum: actual.briefAreaEnum,
    briefItemKindEnum: actual.briefItemKindEnum,
    briefItemResolutionEnum: actual.briefItemResolutionEnum,
    briefItemStateEnum: actual.briefItemStateEnum,
    getWorkspaceMembership: vi.fn(),
    getBriefBySlug: vi.fn(),
    createBriefItemAsHuman: vi.fn(),
  };
});

import { auth } from "@agentrail/auth";
import {
  createBriefItemAsHuman,
  getBriefBySlug,
  getWorkspaceMembership,
} from "@agentrail/db-postgres";

const WORKSPACE_ID = "ws-123";
const SLUG = "blog";
const USER_ID = "user-1";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/briefs/${SLUG}/items`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
}

function makeParams() {
  return { params: Promise.resolve({ workspaceId: WORKSPACE_ID, slug: SLUG }) };
}

const briefRow = { id: "brief-1", workspaceId: WORKSPACE_ID, slug: SLUG, items: [] };

const validBody = {
  area: "constraints",
  statement: "must run offline",
  evidence: "we can't rely on network access in the field",
  kind: "required",
};

const createdItem = {
  id: "item-new",
  briefId: "brief-1",
  area: "constraints",
  statement: "must run offline",
  evidence: "we can't rely on network access in the field",
  kind: "required",
  state: "open",
  resolution: null,
  authority: "human",
};

function mockMember(role: string) {
  vi.mocked(auth).mockResolvedValue({ user: { id: USER_ID } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    role,
  } as never);
}

describe("POST /api/v1/workspaces/:workspaceId/briefs/:slug/items", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await POST(makeRequest(validBody), makeParams());
    expect(res.status).toBe(401);
  });

  it("returns 403 when the caller is not a workspace member", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER_ID } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const res = await POST(makeRequest(validBody), makeParams());
    expect(res.status).toBe(403);
  });

  it("returns 403 for a member role", async () => {
    mockMember("member");
    const res = await POST(makeRequest(validBody), makeParams());
    expect(res.status).toBe(403);
    expect(getBriefBySlug).not.toHaveBeenCalled();
  });

  it("returns 403 for a viewer role", async () => {
    mockMember("viewer");
    const res = await POST(makeRequest(validBody), makeParams());
    expect(res.status).toBe(403);
    expect(createBriefItemAsHuman).not.toHaveBeenCalled();
  });

  it("returns 404 when the slug doesn't resolve in this workspace — the workspace segment of the URL scopes the lookup, not just the slug", async () => {
    mockMember("owner");
    vi.mocked(getBriefBySlug).mockResolvedValue(null);

    const res = await POST(makeRequest(validBody), makeParams());

    expect(res.status).toBe(404);
    expect(getBriefBySlug).toHaveBeenCalledWith(WORKSPACE_ID, SLUG);
    expect(createBriefItemAsHuman).not.toHaveBeenCalled();
  });

  it("allows an owner to create a human item and forwards the brief id resolved from the slug", async () => {
    mockMember("owner");
    vi.mocked(getBriefBySlug).mockResolvedValue(briefRow as never);
    vi.mocked(createBriefItemAsHuman).mockResolvedValue({
      item: createdItem,
      refusedUnknownResolved: false,
    } as never);

    const res = await POST(makeRequest(validBody), makeParams());
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.item).toEqual(createdItem);
    expect(createBriefItemAsHuman).toHaveBeenCalledWith("brief-1", {
      area: "constraints",
      statement: "must run offline",
      evidence: "we can't rely on network access in the field",
      kind: "required",
      state: undefined,
      resolution: undefined,
    });
  });

  it("allows an admin to create a human item", async () => {
    mockMember("admin");
    vi.mocked(getBriefBySlug).mockResolvedValue(briefRow as never);
    vi.mocked(createBriefItemAsHuman).mockResolvedValue({
      item: createdItem,
      refusedUnknownResolved: false,
    } as never);

    const res = await POST(makeRequest(validBody), makeParams());
    expect(res.status).toBe(201);
  });

  it("returns 400 when statement is missing", async () => {
    mockMember("owner");
    vi.mocked(getBriefBySlug).mockResolvedValue(briefRow as never);

    const res = await POST(makeRequest({ ...validBody, statement: "" }), makeParams());
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.errors.statement).toBeTruthy();
    expect(createBriefItemAsHuman).not.toHaveBeenCalled();
  });

  it("returns 400 for an area outside the enum", async () => {
    mockMember("owner");
    vi.mocked(getBriefBySlug).mockResolvedValue(briefRow as never);

    const res = await POST(makeRequest({ ...validBody, area: "not-a-real-area" }), makeParams());
    expect(res.status).toBe(400);
  });

  it("returns 400 for a kind outside the enum", async () => {
    mockMember("owner");
    vi.mocked(getBriefBySlug).mockResolvedValue(briefRow as never);

    const res = await POST(makeRequest({ ...validBody, kind: "maybe" }), makeParams());
    expect(res.status).toBe(400);
  });

  // The single most important invariant in this feature: an `unknown` item
  // is not a requirement yet, so there is nothing to resolve — not even a
  // brand-new one created straight from the console. This must be refused
  // with an explanation, not silently no-op, since a human filling out this
  // form needs to know WHY.
  it("returns 400 when a brand-new item would land as kind: unknown + state: resolved, with an explanation", async () => {
    mockMember("owner");
    vi.mocked(getBriefBySlug).mockResolvedValue(briefRow as never);
    vi.mocked(createBriefItemAsHuman).mockResolvedValue({
      item: null,
      refusedUnknownResolved: true,
    } as never);

    const res = await POST(
      makeRequest({
        area: "scope",
        statement: "nobody has answered this yet",
        kind: "unknown",
        state: "resolved",
        resolution: "deferred",
      }),
      makeParams()
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/unknown/i);
    expect(body.error).toMatch(/resolve/i);
  });
});
