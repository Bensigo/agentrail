import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  getInvestigationBySlug: vi.fn(),
  insertMemoryItems: vi.fn(),
  updateInvestigationItemAsHuman: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import {
  getInvestigationBySlug,
  getWorkspaceMembership,
  insertMemoryItems,
  updateInvestigationItemAsHuman,
} from "@agentrail/db-postgres";

const WORKSPACE_ID = "ws-123";
const SLUG = "checkout-500s";
const USER_ID = "user-1";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/investigations/${SLUG}/promote`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
}

function makeParams() {
  return { params: Promise.resolve({ workspaceId: WORKSPACE_ID, slug: SLUG }) };
}

const lessonItem = {
  id: "lesson-1",
  investigationId: "inv-1",
  kind: "lesson_candidate",
  body: "connection pool starves under bursty checkout traffic — size it to peak, not average",
  data: {},
};

const hypothesisItem = {
  id: "hyp-1",
  investigationId: "inv-1",
  kind: "hypothesis",
  body: "connection pool exhaustion",
  data: {},
};

function investigationRow(items: unknown[] = [lessonItem]) {
  return {
    investigation: { id: "inv-1", workspaceId: WORKSPACE_ID, slug: SLUG, repositoryId: null },
    items,
  };
}

function mockMember(role: string) {
  vi.mocked(auth).mockResolvedValue({ user: { id: USER_ID } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    role,
  } as never);
}

describe("POST /api/v1/workspaces/:workspaceId/investigations/:slug/promote", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await POST(makeRequest({ itemId: "lesson-1" }), makeParams());
    expect(res.status).toBe(401);
  });

  it("returns 403 when the caller is not a workspace member", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER_ID } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const res = await POST(makeRequest({ itemId: "lesson-1" }), makeParams());
    expect(res.status).toBe(403);
  });

  it("returns 403 for a member (non-admin) role", async () => {
    mockMember("member");
    const res = await POST(makeRequest({ itemId: "lesson-1" }), makeParams());
    expect(res.status).toBe(403);
    expect(getInvestigationBySlug).not.toHaveBeenCalled();
  });

  it("returns 403 for a viewer role", async () => {
    mockMember("viewer");
    const res = await POST(makeRequest({ itemId: "lesson-1" }), makeParams());
    expect(res.status).toBe(403);
    expect(insertMemoryItems).not.toHaveBeenCalled();
  });

  it("returns 404 when the slug doesn't resolve in this workspace", async () => {
    mockMember("owner");
    vi.mocked(getInvestigationBySlug).mockResolvedValue(null);

    const res = await POST(makeRequest({ itemId: "lesson-1" }), makeParams());

    expect(res.status).toBe(404);
    expect(getInvestigationBySlug).toHaveBeenCalledWith(WORKSPACE_ID, SLUG);
    expect(insertMemoryItems).not.toHaveBeenCalled();
  });

  it("returns 400 when itemId is missing", async () => {
    mockMember("owner");
    vi.mocked(getInvestigationBySlug).mockResolvedValue(investigationRow() as never);

    const res = await POST(makeRequest({}), makeParams());

    expect(res.status).toBe(400);
    expect(insertMemoryItems).not.toHaveBeenCalled();
  });

  it("returns 400 when itemId does not belong to this investigation (foreign item)", async () => {
    mockMember("owner");
    vi.mocked(getInvestigationBySlug).mockResolvedValue(investigationRow([lessonItem]) as never);

    const res = await POST(makeRequest({ itemId: "item-from-a-different-investigation" }), makeParams());
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/not found/i);
    expect(insertMemoryItems).not.toHaveBeenCalled();
  });

  it("returns 400 when the item is not kind:'lesson_candidate' (wrong-kind)", async () => {
    mockMember("owner");
    vi.mocked(getInvestigationBySlug).mockResolvedValue(investigationRow([hypothesisItem]) as never);

    const res = await POST(makeRequest({ itemId: "hyp-1" }), makeParams());
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/lesson_candidate/i);
    expect(insertMemoryItems).not.toHaveBeenCalled();
  });

  it("returns 409 when the item was already promoted, without inserting a memory item", async () => {
    mockMember("owner");
    const alreadyPromoted = { ...lessonItem, data: { promotedAt: "2026-07-28T00:00:00.000Z" } };
    vi.mocked(getInvestigationBySlug).mockResolvedValue(investigationRow([alreadyPromoted]) as never);

    const res = await POST(makeRequest({ itemId: "lesson-1" }), makeParams());

    expect(res.status).toBe(409);
    expect(insertMemoryItems).not.toHaveBeenCalled();
    expect(updateInvestigationItemAsHuman).not.toHaveBeenCalled();
  });

  it("creates exactly one memory item, carrying provenance in source/writtenBy/tags, then marks data.promotedAt", async () => {
    mockMember("owner");
    vi.mocked(getInvestigationBySlug).mockResolvedValue(investigationRow([lessonItem]) as never);
    vi.mocked(insertMemoryItems).mockResolvedValue(undefined as never);
    vi.mocked(updateInvestigationItemAsHuman).mockResolvedValue({
      item: { ...lessonItem, data: { promotedAt: "2026-07-29T00:00:00.000Z" }, authority: "human" },
      refusedEvidenceImmutable: false,
      refusedHypothesisNeedsEvidence: false,
    } as never);

    const res = await POST(makeRequest({ itemId: "lesson-1" }), makeParams());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(insertMemoryItems).toHaveBeenCalledTimes(1);
    expect(insertMemoryItems).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        source: "investigation",
        writtenBy: `investigation:${SLUG}`,
        items: [
          expect.objectContaining({
            content: lessonItem.body,
            tags: expect.arrayContaining([`investigation:${SLUG}`, "lesson_candidate"]),
          }),
        ],
      })
    );
    expect(updateInvestigationItemAsHuman).toHaveBeenCalledWith(
      "lesson-1",
      expect.objectContaining({ data: expect.objectContaining({ promotedAt: expect.any(String) }) })
    );
    expect(body.item.data.promotedAt).toBeTruthy();
  });

  it("a second promote of the same item returns 409 without inserting a second memory item", async () => {
    mockMember("owner");
    const promoted = { ...lessonItem, data: { promotedAt: "2026-07-29T00:00:00.000Z" } };
    vi.mocked(getInvestigationBySlug).mockResolvedValue(investigationRow([promoted]) as never);

    const res = await POST(makeRequest({ itemId: "lesson-1" }), makeParams());

    expect(res.status).toBe(409);
    expect(insertMemoryItems).not.toHaveBeenCalled();
  });
});
