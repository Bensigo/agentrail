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
  claimLessonPromotion: vi.fn(),
  unclaimLessonPromotion: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import {
  claimLessonPromotion,
  getInvestigationBySlug,
  getWorkspaceMembership,
  insertMemoryItems,
  unclaimLessonPromotion,
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
    expect(claimLessonPromotion).not.toHaveBeenCalled();
  });

  it("returns 400 when itemId is missing", async () => {
    mockMember("owner");
    vi.mocked(getInvestigationBySlug).mockResolvedValue(investigationRow() as never);

    const res = await POST(makeRequest({}), makeParams());

    expect(res.status).toBe(400);
    expect(claimLessonPromotion).not.toHaveBeenCalled();
    expect(insertMemoryItems).not.toHaveBeenCalled();
  });

  it("returns 400 when itemId does not belong to this investigation (foreign item) — an honest 400 from the read, before any claim attempt", async () => {
    mockMember("owner");
    vi.mocked(getInvestigationBySlug).mockResolvedValue(investigationRow([lessonItem]) as never);

    const res = await POST(makeRequest({ itemId: "item-from-a-different-investigation" }), makeParams());
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/not found/i);
    expect(claimLessonPromotion).not.toHaveBeenCalled();
    expect(insertMemoryItems).not.toHaveBeenCalled();
  });

  it("returns 400 when the item is not kind:'lesson_candidate' (wrong-kind) — an honest 400 from the read, before any claim attempt", async () => {
    mockMember("owner");
    vi.mocked(getInvestigationBySlug).mockResolvedValue(investigationRow([hypothesisItem]) as never);

    const res = await POST(makeRequest({ itemId: "hyp-1" }), makeParams());
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/lesson_candidate/i);
    expect(claimLessonPromotion).not.toHaveBeenCalled();
    expect(insertMemoryItems).not.toHaveBeenCalled();
  });

  it("returns 409 when claimLessonPromotion reports the atomic claim was lost (already promoted), without inserting a memory item", async () => {
    mockMember("owner");
    vi.mocked(getInvestigationBySlug).mockResolvedValue(investigationRow([lessonItem]) as never);
    vi.mocked(claimLessonPromotion).mockResolvedValue({ claimed: false });

    const res = await POST(makeRequest({ itemId: "lesson-1" }), makeParams());

    expect(res.status).toBe(409);
    expect(claimLessonPromotion).toHaveBeenCalledWith("lesson-1");
    expect(insertMemoryItems).not.toHaveBeenCalled();
  });

  it("on a successful claim, creates exactly one memory item carrying provenance in source/writtenBy/tags, and returns the claimed item verbatim (no second read)", async () => {
    mockMember("owner");
    vi.mocked(getInvestigationBySlug).mockResolvedValue(investigationRow([lessonItem]) as never);
    const claimedItem = { ...lessonItem, data: { promotedAt: "2026-07-29T00:00:00.000Z" } };
    vi.mocked(claimLessonPromotion).mockResolvedValue({ claimed: true, item: claimedItem } as never);
    vi.mocked(insertMemoryItems).mockResolvedValue(undefined as never);

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
    expect(body.item).toEqual(claimedItem);
    expect(unclaimLessonPromotion).not.toHaveBeenCalled();
  });

  // Coordinator Fix round 1, required test (c): concurrent-shape — two
  // sequential calls modeling a race, where the first claim wins and the
  // second loses. Exactly one insertMemoryItems call; the second call 409s
  // without ever reaching insertMemoryItems.
  it("concurrent-shape: first call's claim succeeds and inserts; second call's claim reports claimed:false and 409s — exactly one insertMemoryItems call total", async () => {
    mockMember("owner");
    vi.mocked(getInvestigationBySlug).mockResolvedValue(investigationRow([lessonItem]) as never);
    vi.mocked(insertMemoryItems).mockResolvedValue(undefined as never);
    vi.mocked(claimLessonPromotion)
      .mockResolvedValueOnce({ claimed: true, item: { ...lessonItem, data: { promotedAt: "x" } } } as never)
      .mockResolvedValueOnce({ claimed: false });

    const first = await POST(makeRequest({ itemId: "lesson-1" }), makeParams());
    const second = await POST(makeRequest({ itemId: "lesson-1" }), makeParams());

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(claimLessonPromotion).toHaveBeenCalledTimes(2);
    expect(insertMemoryItems).toHaveBeenCalledTimes(1);
  });

  // Coordinator Fix round 1, required test (c): insert-failure path unclaims
  // and 502s.
  it("when insertMemoryItems fails after a successful claim, rolls back via unclaimLessonPromotion and returns 502 (retryable, not a permanent lockout)", async () => {
    mockMember("owner");
    vi.mocked(getInvestigationBySlug).mockResolvedValue(investigationRow([lessonItem]) as never);
    const claimedItem = { ...lessonItem, data: { promotedAt: "2026-07-29T00:00:00.000Z" } };
    vi.mocked(claimLessonPromotion).mockResolvedValue({ claimed: true, item: claimedItem } as never);
    vi.mocked(insertMemoryItems).mockRejectedValue(new Error("connection reset"));
    vi.mocked(unclaimLessonPromotion).mockResolvedValue(undefined as never);

    const res = await POST(makeRequest({ itemId: "lesson-1" }), makeParams());

    expect(res.status).toBe(502);
    expect(unclaimLessonPromotion).toHaveBeenCalledWith("lesson-1");
    expect(unclaimLessonPromotion).toHaveBeenCalledTimes(1);
  });

  it("when BOTH insertMemoryItems and the unclaim rollback fail, still returns 502 (the original failure, not an unrelated 500) rather than throwing", async () => {
    mockMember("owner");
    vi.mocked(getInvestigationBySlug).mockResolvedValue(investigationRow([lessonItem]) as never);
    const claimedItem = { ...lessonItem, data: { promotedAt: "2026-07-29T00:00:00.000Z" } };
    vi.mocked(claimLessonPromotion).mockResolvedValue({ claimed: true, item: claimedItem } as never);
    vi.mocked(insertMemoryItems).mockRejectedValue(new Error("connection reset"));
    vi.mocked(unclaimLessonPromotion).mockRejectedValue(new Error("db unreachable"));

    const res = await POST(makeRequest({ itemId: "lesson-1" }), makeParams());

    expect(res.status).toBe(502);
  });
});
