import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getApprovalById: vi.fn(),
}));

import { GET } from "./route";
import { getApprovalById } from "@agentrail/db-postgres";

const mockGetById = vi.mocked(getApprovalById);

const NOW = new Date("2026-07-18T00:00:00.000Z");
const RESOLVED = new Date("2026-07-18T00:05:00.000Z");

// Central-secret auth (2026-07-20 fix): the route now authenticates via
// requireJaceConsoleSecret / JACE_CONSOLE_TOKEN instead of a per-workspace
// bearer api_key. Real helper, real env var, real header — same idiom as
// fleet/workspace-tokens/sync/route.test.ts uses for its own shared secret.
const ENV_KEY = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-shared-secret-abc123";
const ORIGINAL_ENV = process.env[ENV_KEY];

// No default value on `token` (matches fleet/workspace-tokens/sync's own
// `req` helper): req() with no args sends no Authorization header at all;
// callers pass the secret explicitly, e.g. req(SECRET), for the valid case.
//
// `eveSessionId` (issue #1295, PR ③): defaults to the mock approval's own
// eveSessionId so every pre-existing test keeps exercising the legitimate,
// matching-session path unless it deliberately overrides it (e.g. the
// cross-tenant probe below passes a DIFFERENT session id on purpose).
function req(
  token?: string,
  eveSessionId: string | null = MOCK_APPROVAL.eveSessionId
): NextRequest {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers["Authorization"] = `Bearer ${token}`;
  const url = new URL("http://localhost/api/v1/runner/approvals/approval-1");
  if (eveSessionId !== null) url.searchParams.set("eveSessionId", eveSessionId);
  return new NextRequest(url, {
    method: "GET",
    headers,
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
  process.env[ENV_KEY] = SECRET;
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_ENV;
});

describe("GET /api/v1/runner/approvals/[id]", () => {
  describe("auth (central JACE_CONSOLE_TOKEN secret, 2026-07-20)", () => {
    it("401 when JACE_CONSOLE_TOKEN is unset (fail closed, never 'open') — even the objectively correct secret is rejected, and never touches the db", async () => {
      delete process.env[ENV_KEY];

      const res = await GET(req(SECRET), params("approval-1"));

      expect(res.status).toBe(401);
      expect(mockGetById).not.toHaveBeenCalled();
    });

    it("401 when no Authorization header is sent, and never touches the db", async () => {
      const res = await GET(req(), params("approval-1"));

      expect(res.status).toBe(401);
      expect(mockGetById).not.toHaveBeenCalled();
    });

    it("401 on a wrong secret, and never touches the db", async () => {
      const res = await GET(req("wrong-secret"), params("approval-1"));

      expect(res.status).toBe(401);
      expect(mockGetById).not.toHaveBeenCalled();
    });
  });

  it("404 when no approval exists for this id", async () => {
    mockGetById.mockResolvedValue(null);

    const res = await GET(req(SECRET), params("unknown-id"));

    expect(res.status).toBe(404);
    expect(mockGetById).toHaveBeenCalledWith("unknown-id");
  });

  it("200 { status, resolvedAt } ONLY — never leaks toolInput/toolName/tokens", async () => {
    mockGetById.mockResolvedValue(MOCK_APPROVAL as never);

    const res = await GET(req(SECRET), params("approval-1"));
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

    const res = await GET(req(SECRET), params("approval-1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ status: "approved", resolvedAt: RESOLVED.toISOString() });
  });

  // Issue #1295 (#1273 PR① review item): "GET .../approvals/[id] returns
  // {status, resolvedAt} to ANY valid bearer that learns an approval id —
  // no cross-tenant check." JACE_CONSOLE_TOKEN is a single shared secret for
  // the whole deployment (no per-caller workspaceId to compare against — see
  // the route's own doc-comment), so the fix is a caller-supplied
  // eveSessionId cross-checked against the approval's OWN stored
  // eveSessionId, mirroring the identity resolution POST /approvals and
  // POST /approvals/[id]/published already use.
  describe("cross-tenant scoping via eveSessionId (issue #1295)", () => {
    it("400 when eveSessionId query param is missing — never touches the db", async () => {
      const res = await GET(req(SECRET, null), params("approval-1"));

      expect(res.status).toBe(400);
      expect(mockGetById).not.toHaveBeenCalled();
    });

    it("400 when eveSessionId query param is present but blank — never touches the db", async () => {
      const res = await GET(req(SECRET, "   "), params("approval-1"));

      expect(res.status).toBe(400);
      expect(mockGetById).not.toHaveBeenCalled();
    });

    it("FAIL CLOSED (the negative probe): a caller supplying a DIFFERENT session's eveSessionId gets the SAME 404 as an unknown id — byte-identical body, no {status, resolvedAt} leak, so a cross-tenant caller learns nothing about whether the id exists", async () => {
      mockGetById.mockResolvedValue(MOCK_APPROVAL as never); // real row, owned by "eve-session-1"

      const crossTenantReq = req(SECRET, "eve-session-BELONGS-TO-WORKSPACE-B");
      const unknownIdReq = req(SECRET, "eve-session-BELONGS-TO-WORKSPACE-B");

      const crossTenantRes = await GET(crossTenantReq, params("approval-1"));
      const crossTenantBody = await crossTenantRes.json();

      mockGetById.mockResolvedValue(null); // the genuinely-unknown-id case
      const unknownIdRes = await GET(unknownIdReq, params("some-other-id"));
      const unknownIdBody = await unknownIdRes.json();

      expect(crossTenantRes.status).toBe(404);
      expect(crossTenantBody).toEqual({ error: "Approval not found" });
      // Byte-identical to the unknown-id response — no oracle distinguishes
      // "wrong session" from "no such approval".
      expect(crossTenantBody).toEqual(unknownIdBody);
      expect(unknownIdRes.status).toBe(404);
      // Never the narrow, otherwise-legitimate success shape.
      expect(crossTenantBody).not.toHaveProperty("status");
      expect(crossTenantBody).not.toHaveProperty("resolvedAt");
    });

    it("POSITIVE (the legitimate-access probe): the SAME eveSessionId that owns the approval still gets {status, resolvedAt} — no regression", async () => {
      mockGetById.mockResolvedValue(MOCK_APPROVAL as never);

      const res = await GET(req(SECRET, MOCK_APPROVAL.eveSessionId), params("approval-1"));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ status: "pending", resolvedAt: null });
    });
  });
});
