import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { DELETE, PATCH } from "./route";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));

// Real enums via `importActual` (see the sibling `status`/`items` route tests
// for why) — this route validates every patchable field against the actual
// schema enums.
vi.mock("@agentrail/db-postgres", async (importActual) => {
  const actual = await importActual<typeof import("@agentrail/db-postgres")>();
  return {
    briefAreaEnum: actual.briefAreaEnum,
    briefItemKindEnum: actual.briefItemKindEnum,
    briefItemResolutionEnum: actual.briefItemResolutionEnum,
    briefItemStateEnum: actual.briefItemStateEnum,
    getWorkspaceMembership: vi.fn(),
    getBriefBySlug: vi.fn(),
    updateBriefItemAsHuman: vi.fn(),
    deleteBriefItem: vi.fn(),
  };
});

import { auth } from "@agentrail/auth";
import {
  deleteBriefItem,
  getBriefBySlug,
  getWorkspaceMembership,
  updateBriefItemAsHuman,
} from "@agentrail/db-postgres";

const WORKSPACE_ID = "ws-123";
const SLUG = "blog";
const ITEM_ID = "item-1";
const USER_ID = "user-1";

function makeRequest(method: "PATCH" | "DELETE", body?: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/briefs/${SLUG}/items/${ITEM_ID}`,
    {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }
  );
}

function makeParams() {
  return { params: Promise.resolve({ workspaceId: WORKSPACE_ID, slug: SLUG, itemId: ITEM_ID }) };
}

const briefRow = { id: "brief-1", workspaceId: WORKSPACE_ID, slug: SLUG, items: [] };

const updatedItem = {
  id: ITEM_ID,
  briefId: "brief-1",
  area: "scope",
  statement: "single approver model (typo fixed)",
  evidence: "for now since am the only one approve to publish it",
  kind: "required",
  state: "resolved",
  resolution: "implemented",
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

describe("PATCH /api/v1/workspaces/:workspaceId/briefs/:slug/items/:itemId", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await PATCH(makeRequest("PATCH", { statement: "x" }), makeParams());
    expect(res.status).toBe(401);
  });

  it("returns 403 when the caller is not a workspace member", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER_ID } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const res = await PATCH(makeRequest("PATCH", { statement: "x" }), makeParams());
    expect(res.status).toBe(403);
  });

  it("returns 403 for a member role", async () => {
    mockMember("member");
    const res = await PATCH(makeRequest("PATCH", { statement: "x" }), makeParams());
    expect(res.status).toBe(403);
    expect(getBriefBySlug).not.toHaveBeenCalled();
  });

  it("returns 403 for a viewer role", async () => {
    mockMember("viewer");
    const res = await PATCH(makeRequest("PATCH", { statement: "x" }), makeParams());
    expect(res.status).toBe(403);
    expect(updateBriefItemAsHuman).not.toHaveBeenCalled();
  });

  it("returns 404 when the slug doesn't resolve in this workspace — the workspace segment of the URL scopes the lookup, not just the slug", async () => {
    mockMember("owner");
    vi.mocked(getBriefBySlug).mockResolvedValue(null);

    const res = await PATCH(makeRequest("PATCH", { statement: "x" }), makeParams());

    expect(res.status).toBe(404);
    expect(getBriefBySlug).toHaveBeenCalledWith(WORKSPACE_ID, SLUG);
    expect(updateBriefItemAsHuman).not.toHaveBeenCalled();
  });

  it("allows an owner to patch an item, forwarding the brief id resolved from the slug", async () => {
    mockMember("owner");
    vi.mocked(getBriefBySlug).mockResolvedValue(briefRow as never);
    vi.mocked(updateBriefItemAsHuman).mockResolvedValue({
      item: updatedItem,
      refusedUnknownResolved: false,
    } as never);

    const res = await PATCH(makeRequest("PATCH", { statement: "single approver model (typo fixed)" }), makeParams());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.item).toEqual(updatedItem);
    expect(updateBriefItemAsHuman).toHaveBeenCalledWith("brief-1", ITEM_ID, {
      statement: "single approver model (typo fixed)",
    });
  });

  it("allows an admin to patch an item", async () => {
    mockMember("admin");
    vi.mocked(getBriefBySlug).mockResolvedValue(briefRow as never);
    vi.mocked(updateBriefItemAsHuman).mockResolvedValue({
      item: updatedItem,
      refusedUnknownResolved: false,
    } as never);

    const res = await PATCH(makeRequest("PATCH", { statement: "x" }), makeParams());
    expect(res.status).toBe(200);
  });

  // The exact bug class the store slice already shipped once
  // (`patchBriefItems`' own regression test): a partial patch must only
  // forward the fields the caller actually supplied, never fill in the
  // omitted ones with a default — that's what lets evidence/state/resolution
  // survive untouched on the store side. This pins the ROUTE's half of that
  // contract: it must not invent keys the request body never mentioned.
  it("forwards only the fields present in the request body — an omitted field must not appear in the call at all", async () => {
    mockMember("owner");
    vi.mocked(getBriefBySlug).mockResolvedValue(briefRow as never);
    vi.mocked(updateBriefItemAsHuman).mockResolvedValue({
      item: updatedItem,
      refusedUnknownResolved: false,
    } as never);

    await PATCH(makeRequest("PATCH", { statement: "only this changed" }), makeParams());

    const [, , fields] = vi.mocked(updateBriefItemAsHuman).mock.calls[0]!;
    expect(fields).toEqual({ statement: "only this changed" });
    expect(fields).not.toHaveProperty("evidence");
    expect(fields).not.toHaveProperty("state");
    expect(fields).not.toHaveProperty("resolution");
    expect(fields).not.toHaveProperty("kind");
    expect(fields).not.toHaveProperty("area");
  });

  it("forwards an explicit resolution: null when the caller supplies it (still counts as 'supplied', not omitted)", async () => {
    mockMember("owner");
    vi.mocked(getBriefBySlug).mockResolvedValue(briefRow as never);
    vi.mocked(updateBriefItemAsHuman).mockResolvedValue({
      item: updatedItem,
      refusedUnknownResolved: false,
    } as never);

    await PATCH(makeRequest("PATCH", { state: "open", resolution: null }), makeParams());

    const [, , fields] = vi.mocked(updateBriefItemAsHuman).mock.calls[0]!;
    expect(fields).toEqual({ state: "open", resolution: null });
  });

  // The single most important invariant in this PR: an `unknown` item is
  // not a requirement yet, so there is nothing to resolve — not even via a
  // human console edit. This must be refused with an explanation, not
  // silently accepted, or the human path becomes the bypass for the agent
  // path's own gate.
  it("returns 400 when the patch would land as kind: unknown + state: resolved, with an explanation of why", async () => {
    mockMember("owner");
    vi.mocked(getBriefBySlug).mockResolvedValue(briefRow as never);
    vi.mocked(updateBriefItemAsHuman).mockResolvedValue({
      item: null,
      refusedUnknownResolved: true,
    } as never);

    const res = await PATCH(
      makeRequest("PATCH", { kind: "unknown", state: "resolved", resolution: "deferred" }),
      makeParams()
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/unknown/i);
    expect(body.error).toMatch(/resolve/i);
  });

  it("returns 404 when the item doesn't exist under this brief (and it wasn't a refusal)", async () => {
    mockMember("owner");
    vi.mocked(getBriefBySlug).mockResolvedValue(briefRow as never);
    vi.mocked(updateBriefItemAsHuman).mockResolvedValue({
      item: null,
      refusedUnknownResolved: false,
    } as never);

    const res = await PATCH(makeRequest("PATCH", { statement: "x" }), makeParams());
    expect(res.status).toBe(404);
  });

  it("returns 400 for a kind outside the enum", async () => {
    mockMember("owner");
    vi.mocked(getBriefBySlug).mockResolvedValue(briefRow as never);

    const res = await PATCH(makeRequest("PATCH", { kind: "maybe" }), makeParams());
    expect(res.status).toBe(400);
    expect(updateBriefItemAsHuman).not.toHaveBeenCalled();
  });

  it("returns 400 for an empty statement", async () => {
    mockMember("owner");
    vi.mocked(getBriefBySlug).mockResolvedValue(briefRow as never);

    const res = await PATCH(makeRequest("PATCH", { statement: "   " }), makeParams());
    expect(res.status).toBe(400);
    expect(updateBriefItemAsHuman).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/v1/workspaces/:workspaceId/briefs/:slug/items/:itemId", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await DELETE(makeRequest("DELETE"), makeParams());
    expect(res.status).toBe(401);
  });

  it("returns 403 when the caller is not a workspace member", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER_ID } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const res = await DELETE(makeRequest("DELETE"), makeParams());
    expect(res.status).toBe(403);
  });

  it("returns 403 for a member role", async () => {
    mockMember("member");
    const res = await DELETE(makeRequest("DELETE"), makeParams());
    expect(res.status).toBe(403);
    expect(deleteBriefItem).not.toHaveBeenCalled();
  });

  it("returns 403 for a viewer role", async () => {
    mockMember("viewer");
    const res = await DELETE(makeRequest("DELETE"), makeParams());
    expect(res.status).toBe(403);
    expect(deleteBriefItem).not.toHaveBeenCalled();
  });

  it("returns 404 when the slug doesn't resolve in this workspace", async () => {
    mockMember("owner");
    vi.mocked(getBriefBySlug).mockResolvedValue(null);

    const res = await DELETE(makeRequest("DELETE"), makeParams());

    expect(res.status).toBe(404);
    expect(getBriefBySlug).toHaveBeenCalledWith(WORKSPACE_ID, SLUG);
    expect(deleteBriefItem).not.toHaveBeenCalled();
  });

  it("allows an owner to delete an item, forwarding the brief id resolved from the slug", async () => {
    mockMember("owner");
    vi.mocked(getBriefBySlug).mockResolvedValue(briefRow as never);
    vi.mocked(deleteBriefItem).mockResolvedValue(true);

    const res = await DELETE(makeRequest("DELETE"), makeParams());

    expect(res.status).toBe(200);
    expect(deleteBriefItem).toHaveBeenCalledWith("brief-1", ITEM_ID);
  });

  it("allows an admin to delete an item", async () => {
    mockMember("admin");
    vi.mocked(getBriefBySlug).mockResolvedValue(briefRow as never);
    vi.mocked(deleteBriefItem).mockResolvedValue(true);

    const res = await DELETE(makeRequest("DELETE"), makeParams());
    expect(res.status).toBe(200);
  });

  it("returns 404 when nothing matched (wrong item, or already deleted)", async () => {
    mockMember("owner");
    vi.mocked(getBriefBySlug).mockResolvedValue(briefRow as never);
    vi.mocked(deleteBriefItem).mockResolvedValue(false);

    const res = await DELETE(makeRequest("DELETE"), makeParams());
    expect(res.status).toBe(404);
  });
});
