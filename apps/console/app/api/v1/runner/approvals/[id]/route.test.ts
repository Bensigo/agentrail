import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getApprovalById: vi.fn(),
}));
vi.mock("../../../../../../lib/bearer-auth", () => ({
  requireBearer: vi.fn(),
}));

import { GET } from "./route";
import { getApprovalById } from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../../lib/bearer-auth";

const mockGetById = vi.mocked(getApprovalById);
const mockRequireBearer = vi.mocked(requireBearer);

const NOW = new Date("2026-07-18T00:00:00.000Z");
const RESOLVED = new Date("2026-07-18T00:05:00.000Z");

function req(): NextRequest {
  return new NextRequest("http://localhost/api/v1/runner/approvals/approval-1", {
    method: "GET",
    headers: { Authorization: "Bearer ar_test" },
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

const MOCK_APPROVAL = {
  id: "approval-1",
  workspaceId: "ws-1",
  chatIdentityId: "chat-identity-1",
  sessionId: "session-1",
  eveSessionId: "eve-session-1",
  requestId: "req-1",
  callbackToken: "cbtoken123456",
  toolName: "create_issue",
  toolInput: { title: "x" },
  approveOptionId: "approve",
  denyOptionId: "deny",
  status: "pending",
  publishedIssueUrl: null,
  createdAt: NOW,
  resolvedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireBearer.mockResolvedValue({
    apiKeyId: "key-1",
    workspaceId: "ws-1",
    teamId: null,
  } as never);
});

describe("GET /api/v1/runner/approvals/[id]", () => {
  it("401 when requireBearer rejects, and never touches the db", async () => {
    const { NextResponse } = await import("next/server");
    mockRequireBearer.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }) as never
    );

    const res = await GET(req(), params("approval-1"));

    expect(res.status).toBe(401);
    expect(mockGetById).not.toHaveBeenCalled();
  });

  it("404 when no approval exists for this id", async () => {
    mockGetById.mockResolvedValue(null);

    const res = await GET(req(), params("unknown-id"));

    expect(res.status).toBe(404);
    expect(mockGetById).toHaveBeenCalledWith("unknown-id");
  });

  it("200 { status, resolvedAt } ONLY — never leaks toolInput/toolName/tokens", async () => {
    mockGetById.mockResolvedValue(MOCK_APPROVAL as never);

    const res = await GET(req(), params("approval-1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ status: "pending", resolvedAt: null });
  });

  it("returns the resolvedAt timestamp once the approval is resolved", async () => {
    mockGetById.mockResolvedValue({
      ...MOCK_APPROVAL,
      status: "approved",
      resolvedAt: RESOLVED,
    } as never);

    const res = await GET(req(), params("approval-1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ status: "approved", resolvedAt: RESOLVED.toISOString() });
  });
});
