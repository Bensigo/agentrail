import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  getInvestigationBySlug: vi.fn(),
  confirmVerdictAsHuman: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import { confirmVerdictAsHuman, getInvestigationBySlug, getWorkspaceMembership } from "@agentrail/db-postgres";

const WORKSPACE_ID = "ws-123";
const SLUG = "checkout-500s";
const USER_ID = "user-1";

function makeRequest(): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/investigations/${SLUG}/confirm`,
    { method: "POST" }
  );
}

function makeParams() {
  return { params: Promise.resolve({ workspaceId: WORKSPACE_ID, slug: SLUG }) };
}

const investigationRow = { investigation: { id: "inv-1", workspaceId: WORKSPACE_ID, slug: SLUG }, items: [] };

function mockMember(role: string) {
  vi.mocked(auth).mockResolvedValue({ user: { id: USER_ID } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    role,
  } as never);
}

describe("POST /api/v1/workspaces/:workspaceId/investigations/:slug/confirm", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(401);
  });

  it("returns 403 when the caller is not a workspace member", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER_ID } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(403);
  });

  it("returns 403 for a member (non-admin) role — this is a human confirmation gate, not a content read", async () => {
    mockMember("member");
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(403);
    expect(getInvestigationBySlug).not.toHaveBeenCalled();
  });

  it("returns 403 for a viewer role", async () => {
    mockMember("viewer");
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(403);
    expect(confirmVerdictAsHuman).not.toHaveBeenCalled();
  });

  it("returns 404 when the slug doesn't resolve in this workspace — the workspace segment of the URL scopes the lookup, not just the slug", async () => {
    mockMember("owner");
    vi.mocked(getInvestigationBySlug).mockResolvedValue(null);

    const res = await POST(makeRequest(), makeParams());

    expect(res.status).toBe(404);
    expect(getInvestigationBySlug).toHaveBeenCalledWith(WORKSPACE_ID, SLUG);
    expect(confirmVerdictAsHuman).not.toHaveBeenCalled();
  });

  it("returns 409 when the investigation has no verdict item yet (confirmVerdictAsHuman's no_verdict reason)", async () => {
    mockMember("owner");
    vi.mocked(getInvestigationBySlug).mockResolvedValue(investigationRow as never);
    vi.mocked(confirmVerdictAsHuman).mockResolvedValue({ ok: false, reason: "no_verdict" });

    const res = await POST(makeRequest(), makeParams());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBeTruthy();
    expect(confirmVerdictAsHuman).toHaveBeenCalledWith("inv-1");
  });

  it("allows an owner to confirm — flips humanConfirmed via confirmVerdictAsHuman and returns the updated item", async () => {
    mockMember("owner");
    vi.mocked(getInvestigationBySlug).mockResolvedValue(investigationRow as never);
    const confirmedItem = { id: "verdict-1", kind: "verdict", data: { humanConfirmed: true } };
    vi.mocked(confirmVerdictAsHuman).mockResolvedValue({ ok: true, item: confirmedItem } as never);

    const res = await POST(makeRequest(), makeParams());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.item).toEqual(confirmedItem);
    expect(confirmVerdictAsHuman).toHaveBeenCalledWith("inv-1");
  });

  it("allows an admin to confirm", async () => {
    mockMember("admin");
    vi.mocked(getInvestigationBySlug).mockResolvedValue(investigationRow as never);
    vi.mocked(confirmVerdictAsHuman).mockResolvedValue({
      ok: true,
      item: { id: "verdict-1", kind: "verdict", data: { humanConfirmed: true } },
    } as never);

    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(200);
  });
});
