import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getApprovalById: vi.fn(),
  getJaceSessionByEveSessionId: vi.fn(),
  stampPublishedIssueUrl: vi.fn(),
}));

import { POST } from "./route";
import {
  getApprovalById,
  getJaceSessionByEveSessionId,
  stampPublishedIssueUrl,
} from "@agentrail/db-postgres";

const mockGetById = vi.mocked(getApprovalById);
const mockGetSession = vi.mocked(getJaceSessionByEveSessionId);
const mockStamp = vi.mocked(stampPublishedIssueUrl);

const NOW = new Date("2026-07-19T00:00:00.000Z");
const REAL_URL = "https://github.com/acme/widgets/issues/42";

// Central-secret auth (2026-07-20 fix): the route now authenticates via
// requireJaceConsoleSecret / JACE_CONSOLE_TOKEN instead of a per-workspace
// bearer api_key. Real helper, real env var, real header — same idiom as
// fleet/workspace-tokens/sync/route.test.ts uses for its own shared secret.
const ENV_KEY = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-shared-secret-abc123";
const ORIGINAL_ENV = process.env[ENV_KEY];

function req(body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/runner/approvals/approval-1/published", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${SECRET}` },
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
  process.env[ENV_KEY] = SECRET;
  mockGetById.mockResolvedValue(MOCK_APPROVAL as never);
  mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
  mockStamp.mockResolvedValue("stamped" as never);
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_ENV;
});

describe("POST /api/v1/runner/approvals/[id]/published — auth + body validation", () => {
  it("401 when no Authorization header is sent, and never touches the db", async () => {
    const request = new NextRequest(
      "http://localhost/api/v1/runner/approvals/approval-1/published",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: REAL_URL }),
      }
    );
    const res = await POST(request, params("approval-1"));

    expect(res.status).toBe(401);
    expect(mockGetById).not.toHaveBeenCalled();
    expect(mockStamp).not.toHaveBeenCalled();
  });

  it("401 when JACE_CONSOLE_TOKEN is unset (fail closed, never 'open') — even the objectively correct secret is rejected", async () => {
    delete process.env[ENV_KEY];

    const res = await POST(req({ url: REAL_URL }), params("approval-1"));

    expect(res.status).toBe(401);
    expect(mockGetById).not.toHaveBeenCalled();
  });

  it("401 on a wrong secret", async () => {
    const request = new NextRequest(
      "http://localhost/api/v1/runner/approvals/approval-1/published",
      {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer wrong-secret" },
        body: JSON.stringify({ url: REAL_URL }),
      }
    );
    const res = await POST(request, params("approval-1"));

    expect(res.status).toBe(401);
    expect(mockGetById).not.toHaveBeenCalled();
  });

  it("400 on invalid JSON body", async () => {
    const request = new NextRequest(
      "http://localhost/api/v1/runner/approvals/approval-1/published",
      {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${SECRET}` },
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

describe("POST /api/v1/runner/approvals/[id]/published — create_issue-only (#1274 PR ② fix round, I1)", () => {
  it("404 (byte-identical to unknown-id) for an APPROVED alignment_brief approval — the reviewer's exact attack row; session lookup and stamp never touched", async () => {
    mockGetById.mockResolvedValue({
      ...MOCK_APPROVAL,
      toolName: "alignment_brief",
      status: "approved",
    } as never);

    const res = await POST(req({ url: REAL_URL }), params("approval-1"));
    const text = await res.text();

    expect(res.status).toBe(404);
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockStamp).not.toHaveBeenCalled();

    mockGetById.mockResolvedValue(null);
    const unknownRes = await POST(req({ url: REAL_URL }), params("unknown-id"));
    expect(await unknownRes.text()).toBe(text);
  });

  it("404 for every other non-create_issue tool (create_repo, create_workspace) regardless of status", async () => {
    for (const toolName of ["create_repo", "create_workspace"]) {
      mockGetById.mockResolvedValue({
        ...MOCK_APPROVAL,
        toolName,
        status: "approved",
      } as never);
      const res = await POST(req({ url: REAL_URL }), params("approval-1"));
      expect(res.status).toBe(404);
      expect(mockStamp).not.toHaveBeenCalled();
    }
  });

  it("positive control: a create_issue approval still stamps (200) — the toolName gate isn't over-broad", async () => {
    const res = await POST(req({ url: REAL_URL }), params("approval-1"));
    expect(res.status).toBe(200);
    expect(mockStamp).toHaveBeenCalledWith("approval-1", REAL_URL);
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

  it("BEHAVIOR CHANGE (accepted, central-secret model, M3 update — see route doc-comment): the approval's session workspace no longer needs to match anything — there is no bearer-own workspace left to cross-check against (JACE_CONSOLE_TOKEN is ONE shared secret for the whole deployment). A resolved-workspace session that differs from some other value now stamps successfully (200), where the old per-workspace-bearer model would have refused it (404).", async () => {
    mockGetSession.mockResolvedValue({
      ...MOCK_SESSION_WS,
      workspaceId: "ws-some-other-tenant",
    } as never);

    const res = await POST(req({ url: REAL_URL }), params("approval-1"));

    expect(res.status).toBe(200);
    expect(mockStamp).toHaveBeenCalledWith("approval-1", REAL_URL);
  });

  it("resolves the session via the APPROVAL's OWN stored eveSessionId, not any caller-supplied value", async () => {
    await POST(req({ url: REAL_URL }), params("approval-1"));
    expect(mockGetSession).toHaveBeenCalledWith(MOCK_APPROVAL.eveSessionId);
  });

  it("200 for the common case — the approval's session has a normal resolved workspace", async () => {
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
