import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getApprovalById: vi.fn(),
  getJaceSessionByEveSessionId: vi.fn(),
  stampPublishedIssueUrl: vi.fn(),
}));
vi.mock("../../../../../../../lib/bearer-auth", () => ({
  requireBearer: vi.fn(),
}));

import { POST } from "./route";
import {
  getApprovalById,
  getJaceSessionByEveSessionId,
  stampPublishedIssueUrl,
} from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../../../lib/bearer-auth";

const mockGetById = vi.mocked(getApprovalById);
const mockGetSession = vi.mocked(getJaceSessionByEveSessionId);
const mockStamp = vi.mocked(stampPublishedIssueUrl);
const mockRequireBearer = vi.mocked(requireBearer);

const NOW = new Date("2026-07-19T00:00:00.000Z");
const REAL_URL = "https://github.com/acme/widgets/issues/42";

function req(body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/runner/approvals/approval-1/published", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: "Bearer ar_test" },
    body: body === undefined ? undefined : JSON.stringify(body),
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
  toolInput: { title: "x", _brief: { estimateUsd: 1.35, suggestedModel: { slug: "anthropic/claude-sonnet-5" } } },
  approveOptionId: "approve",
  denyOptionId: "deny",
  status: "approved",
  publishedIssueUrl: null,
  createdAt: NOW,
  resolvedAt: NOW,
};

const MOCK_SESSION_WS = {
  id: "session-1",
  workspaceId: "ws-1",
  chatIdentityId: "chat-identity-1",
  channel: "telegram",
  conversationKey: "-100123",
  eveSessionId: "eve-session-1",
  status: "active",
  lastActivityAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireBearer.mockResolvedValue({
    apiKeyId: "key-1",
    workspaceId: "ws-1",
    teamId: null,
  } as never);
  mockGetById.mockResolvedValue(MOCK_APPROVAL as never);
  mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
  mockStamp.mockResolvedValue("stamped" as never);
});

describe("POST /api/v1/runner/approvals/[id]/published — auth + body validation", () => {
  it("401 when requireBearer rejects, and never touches the db", async () => {
    const { NextResponse } = await import("next/server");
    mockRequireBearer.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }) as never
    );

    const res = await POST(req({ url: REAL_URL }), params("approval-1"));

    expect(res.status).toBe(401);
    expect(mockGetById).not.toHaveBeenCalled();
    expect(mockStamp).not.toHaveBeenCalled();
  });

  it("400 on invalid JSON body", async () => {
    const request = new NextRequest(
      "http://localhost/api/v1/runner/approvals/approval-1/published",
      {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer ar_test" },
        body: "{not valid json",
      }
    );
    const res = await POST(request, params("approval-1"));
    expect(res.status).toBe(400);
    expect(mockGetById).not.toHaveBeenCalled();
  });

  it("400 when url is missing", async () => {
    const res = await POST(req({}), params("approval-1"));
    expect(res.status).toBe(400);
    expect(mockGetById).not.toHaveBeenCalled();
  });

  it("400 when url is an empty string", async () => {
    const res = await POST(req({ url: "" }), params("approval-1"));
    expect(res.status).toBe(400);
  });

  it("400 (URL-normalization tighten) when url is not a canonical GitHub issue URL — wrong host", async () => {
    const res = await POST(
      req({ url: "https://not-github.com/acme/widgets/issues/42" }),
      params("approval-1")
    );
    expect(res.status).toBe(400);
    expect(mockGetById).not.toHaveBeenCalled();
  });

  it("400 (URL-normalization tighten) when url has extra path segments after the issue number", async () => {
    const res = await POST(
      req({ url: "https://github.com/acme/widgets/issues/42/comments" }),
      params("approval-1")
    );
    expect(res.status).toBe(400);
  });

  it("400 (URL-normalization tighten) when url carries a query string or fragment", async () => {
    const res1 = await POST(
      req({ url: "https://github.com/acme/widgets/issues/42?tab=comments" }),
      params("approval-1")
    );
    expect(res1.status).toBe(400);
    const res2 = await POST(
      req({ url: "https://github.com/acme/widgets/issues/42#issuecomment-1" }),
      params("approval-1")
    );
    expect(res2.status).toBe(400);
  });

  it("400 (URL-normalization tighten) when the issue number is not numeric — a forged/fragment-shaped value", async () => {
    const res = await POST(
      req({ url: "https://github.com/acme/widgets/issues/forty-two" }),
      params("approval-1")
    );
    expect(res.status).toBe(400);
  });

  it("400 when url is a PULL request URL, not an issue URL (github serves both under /issues/ AND /pull/ — only /issues/ is canonical here)", async () => {
    const res = await POST(
      req({ url: "https://github.com/acme/widgets/pull/42" }),
      params("approval-1")
    );
    expect(res.status).toBe(400);
  });

  it("accepts the canonical shape (regression control — proves the regex isn't over-tight)", async () => {
    const res = await POST(req({ url: REAL_URL }), params("approval-1"));
    expect(res.status).toBe(200);
  });
});

describe("POST /api/v1/runner/approvals/[id]/published — resolution chain (404-indistinguishable)", () => {
  it("404 when no approval exists for this id", async () => {
    mockGetById.mockResolvedValue(null);

    const res = await POST(req({ url: REAL_URL }), params("unknown-id"));

    expect(res.status).toBe(404);
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockStamp).not.toHaveBeenCalled();
  });

  it("404 when the approval's owning session has no anchor (defensive, unreachable in practice) — byte-identical to the unknown-id 404", async () => {
    mockGetSession.mockResolvedValue({
      ...MOCK_SESSION_WS,
      workspaceId: null,
      chatIdentityId: null,
    } as never);

    const res = await POST(req({ url: REAL_URL }), params("approval-1"));
    const text = await res.text();

    expect(res.status).toBe(404);
    expect(mockStamp).not.toHaveBeenCalled();

    mockGetById.mockResolvedValue(null);
    const unknownRes = await POST(req({ url: REAL_URL }), params("unknown-id"));
    expect(await unknownRes.text()).toBe(text);
  });

  it("404 when the approval's session belongs to a DIFFERENT workspace than the bearer's own — cross-tenant refusal, byte-identical to the unknown-id 404", async () => {
    mockGetSession.mockResolvedValue({
      ...MOCK_SESSION_WS,
      workspaceId: "ws-other-tenant",
    } as never);

    const res = await POST(req({ url: REAL_URL }), params("approval-1"));
    const text = await res.text();

    expect(res.status).toBe(404);
    expect(mockStamp).not.toHaveBeenCalled();

    mockGetById.mockResolvedValue(null);
    const unknownRes = await POST(req({ url: REAL_URL }), params("unknown-id"));
    expect(await unknownRes.text()).toBe(text);
  });

  it("resolves the session via the APPROVAL's OWN stored eveSessionId, not any caller-supplied value", async () => {
    await POST(req({ url: REAL_URL }), params("approval-1"));
    expect(mockGetSession).toHaveBeenCalledWith(MOCK_APPROVAL.eveSessionId);
  });

  it("200 when the approval's session workspace matches the bearer's own", async () => {
    const res = await POST(req({ url: REAL_URL }), params("approval-1"));
    expect(res.status).toBe(200);
  });
});

describe("POST /api/v1/runner/approvals/[id]/published — approved-only + idempotent + conflict", () => {
  it("calls stampPublishedIssueUrl with the id and url, and 200s on success", async () => {
    const res = await POST(req({ url: REAL_URL }), params("approval-1"));

    expect(mockStamp).toHaveBeenCalledWith("approval-1", REAL_URL);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it("idempotent: a second stamp with the SAME url still 200s (stampPublishedIssueUrl itself reports 'stamped' on a same-value replay)", async () => {
    mockStamp.mockResolvedValue("stamped" as never);
    const res = await POST(req({ url: REAL_URL }), params("approval-1"));
    expect(res.status).toBe(200);
  });

  it("409 when the approval is not approved (still pending, denied, or expired)", async () => {
    mockStamp.mockResolvedValue("not_approved" as never);
    mockGetById.mockResolvedValue({ ...MOCK_APPROVAL, status: "pending" } as never);

    const res = await POST(req({ url: REAL_URL }), params("approval-1"));

    expect(res.status).toBe(409);
  });

  it("409 when the approval is already stamped with a DIFFERENT url (conflict, never silently overwritten)", async () => {
    mockStamp.mockResolvedValue("conflict" as never);
    mockGetById.mockResolvedValue({
      ...MOCK_APPROVAL,
      publishedIssueUrl: "https://github.com/acme/widgets/issues/99",
    } as never);

    const res = await POST(req({ url: REAL_URL }), params("approval-1"));

    expect(res.status).toBe(409);
  });
});
