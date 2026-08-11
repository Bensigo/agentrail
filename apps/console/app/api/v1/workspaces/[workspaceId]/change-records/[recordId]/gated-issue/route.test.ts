import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const RECORD_ID = "33333333-3333-4333-8333-333333333333";
const BINDING_ID = "44444444-4444-4444-8444-444444444444";
const PUBLICATION_ID = "55555555-5555-4555-8555-555555555555";
const REPO = "acme/widgets";
const TITLE = "Acceptance corrections for pull request #42";
const BODY = "# Acceptance correction follow-up\n\nUseful bounded correction evidence.";

const {
  mockAuth,
  mockGetMembership,
  mockGetCredential,
  mockRead,
  mockReserve,
  mockReport,
  mockPublish,
  MockConflictError,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockGetMembership: vi.fn(),
  mockGetCredential: vi.fn(),
  mockRead: vi.fn(),
  mockReserve: vi.fn(),
  mockReport: vi.fn(),
  mockPublish: vi.fn(),
  MockConflictError: class extends Error {},
}));

vi.mock("@agentrail/auth", () => ({ auth: mockAuth }));
vi.mock("@agentrail/db-postgres", () => ({
  AcceptanceGatedGithubIssueConflictError: MockConflictError,
  getGithubCorrectionCarrierCredential: mockGetCredential,
  getWorkspaceMembership: mockGetMembership,
  readCurrentAcceptanceGatedGithubIssue: mockRead,
  reserveCurrentAcceptanceGatedGithubIssue: mockReserve,
  reportAcceptanceGatedGithubIssuePublication: mockReport,
}));
vi.mock("../../../../../../../../lib/github-gated-issue", () => ({ publishGithubGatedIssue: mockPublish }));

import { POST } from "./route";

const binding = {
  bindingId: BINDING_ID,
  workspaceId: WORKSPACE_ID,
  recordId: RECORD_ID,
  repo: REPO,
  prNumber: 42,
  headSha: "a".repeat(40),
  headCycleId: "66666666-6666-4666-8666-666666666666",
  authorityGeneration: 3,
  reviewJobId: "66666666-6666-4666-8666-666666666666",
  acceptanceContract: {
    id: "77777777-7777-4777-8777-777777777777",
    version: 1,
    sha256: "b".repeat(64),
  },
  criterionOutcomeBundle: {
    id: "88888888-8888-4888-8888-888888888888",
    eventId: "88888888-8888-4888-8888-888888888888",
    sha256: "c".repeat(64),
    postedAttestationEventId: "99999999-9999-4999-8999-999999999999",
  },
  packets: [{ packetId: `correction-${"d".repeat(48)}`, sha256: "e".repeat(64) }],
  packetSetSha256: "f".repeat(64),
  correctionPacketPayloadSetSha256: "1".repeat(64),
};

const reservedIssue = {
  id: PUBLICATION_ID,
  status: "reserved",
  requestIdentitySha256: "2".repeat(64),
  titleSha256: "3".repeat(64),
  bodySha256: "4".repeat(64),
  reservedBy: `user:${USER_ID}`,
  reservedRole: "owner",
  reservedAt: new Date("2026-08-11T10:00:00.000Z"),
  receipt: null,
  reportedAt: null,
};

const publishedIssue = {
  ...reservedIssue,
  status: "published",
  receipt: {
    kind: "github_201",
    httpStatus: 201,
    githubIssueId: "123456",
    githubIssueNumber: 17,
    githubApiUrl: `https://api.github.com/repos/${REPO}/issues/17`,
    githubIssueUrl: `https://github.com/${REPO}/issues/17`,
    githubRequestId: "REQ:1",
    responseTitleSha256: "3".repeat(64),
    responseBodySha256: "4".repeat(64),
    state: "open",
  },
  reportedAt: new Date("2026-08-11T10:00:01.000Z"),
};

const github201 = {
  kind: "github_201",
  httpStatus: 201,
  githubIssueId: "123456",
  githubIssueNumber: 17,
  githubApiUrl: `https://api.github.com/repos/${REPO}/issues/17`,
  githubIssueUrl: `https://github.com/${REPO}/issues/17`,
  githubRequestId: "REQ:1",
  responseTitleSha256: "3".repeat(64),
  responseBodySha256: "4".repeat(64),
  state: "open",
} as const;

function request(
  body: unknown = { bindingId: BINDING_ID },
  init: { contentType?: string; query?: string } = {},
): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/change-records/${RECORD_ID}/gated-issue${init.query ?? ""}`,
    {
      method: "POST",
      headers: { "content-type": init.contentType ?? "application/json" },
      body: JSON.stringify(body),
    },
  );
}

const params = { params: Promise.resolve({ workspaceId: WORKSPACE_ID, recordId: RECORD_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: USER_ID } });
  mockGetMembership.mockResolvedValue({ role: "owner" });
  mockRead.mockResolvedValue({ kind: "current", binding, issue: null });
  mockGetCredential.mockResolvedValue({
    ok: true,
    token: "ghs_scoped_token",
    expiresAt: "2026-08-11T11:00:00.000Z",
    permissionBasis: { repository: "scoped_installation_token", issues: "write", pullRequests: "write" },
  });
  mockReserve.mockResolvedValue({
    kind: "reserved",
    inserted: true,
    binding,
    issue: reservedIssue,
    request: { title: TITLE, body: BODY },
  });
  mockPublish.mockResolvedValue(github201);
  mockReport.mockResolvedValue({ kind: "reported", current: true, issue: publishedIssue });
});

describe("POST current Acceptance gated GitHub issue", () => {
  it("reserves after a strict current read and scoped credential, then publishes and reports once", async () => {
    const response = await POST(request(), params);
    expect(response.status).toBe(201);
    const responseBody = await response.json();
    expect(responseBody).toMatchObject({ kind: "reported", current: true, issue: { status: "published" } });
    expect(JSON.stringify(responseBody)).not.toContain(TITLE);
    expect(JSON.stringify(responseBody)).not.toContain(BODY);
    expect(JSON.stringify(responseBody)).not.toContain("ghs_scoped_token");
    expect(mockRead).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID, recordId: RECORD_ID });
    expect(mockGetCredential).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID, repo: REPO });
    expect(mockReserve).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      recordId: RECORD_ID,
      bindingId: BINDING_ID,
      reservedBy: `user:${USER_ID}`,
    });
    expect(mockPublish).toHaveBeenCalledWith({
      token: "ghs_scoped_token",
      repo: REPO,
      title: TITLE,
      body: BODY,
    });
    expect(mockReport).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      publicationId: PUBLICATION_ID,
      outcome: github201,
    });
    expect(mockGetCredential.mock.invocationCallOrder[0]).toBeLessThan(mockReserve.mock.invocationCallOrder[0]!);
    expect(mockReserve.mock.invocationCallOrder[0]).toBeLessThan(mockPublish.mock.invocationCallOrder[0]!);
  });

  it("authenticates owner/admin before parsing any caller body", async () => {
    mockGetMembership.mockResolvedValueOnce({ role: "member" });
    const response = await POST(request({ title: "caller", body: "caller", labels: ["ready-for-agent"] }), params);
    expect(response.status).toBe(403);
    expect(mockRead).not.toHaveBeenCalled();
    expect(mockReserve).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("returns 401 before membership, parsing, or storage for a missing session", async () => {
    mockAuth.mockResolvedValueOnce(null);
    const response = await POST(request({ title: "caller", labels: ["ready-for-agent"] }), params);
    expect(response.status).toBe(401);
    expect(mockGetMembership).not.toHaveBeenCalled();
    expect(mockRead).not.toHaveBeenCalled();
    expect(mockReserve).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("accepts only exact bounded {bindingId} JSON with no query authority", async () => {
    for (const candidate of [
      { bindingId: BINDING_ID, title: "caller" },
      { bindingId: "not-a-uuid" },
      { title: TITLE, body: BODY },
    ]) {
      const response = await POST(request(candidate), params);
      expect(response.status).toBe(400);
    }
    expect((await POST(request(undefined, { query: "?repo=other/repo" }), params)).status).toBe(400);
    expect(mockRead).not.toHaveBeenCalled();
    expect(mockReserve).not.toHaveBeenCalled();
  });

  it("rejects wrong media type and oversized JSON before any current read or reservation", async () => {
    const wrongMedia = await POST(request({ bindingId: BINDING_ID }, {
      contentType: "text/plain",
    }), params);
    expect(wrongMedia.status).toBe(400);

    const oversized = new NextRequest(
      `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/change-records/${RECORD_ID}/gated-issue`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bindingId: BINDING_ID, padding: "x".repeat(4 * 1024) }),
      },
    );
    expect((await POST(oversized, params)).status).toBe(400);
    expect(mockRead).not.toHaveBeenCalled();
    expect(mockReserve).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("fails a stale binding before resolving credentials or reserving", async () => {
    const response = await POST(request({ bindingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }), params);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ kind: "not_current" });
    expect(mockGetCredential).not.toHaveBeenCalled();
    expect(mockReserve).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("distinguishes known credential denial from indeterminate credential custody", async () => {
    mockGetCredential.mockResolvedValueOnce({
      ok: false,
      kind: "unavailable",
      reason: "installation_or_permission_denied",
    });
    const unavailable = await POST(request(), params);
    expect(unavailable.status).toBe(409);
    expect(await unavailable.json()).toEqual({
      kind: "not_ready",
      reason: "github_credentials_unavailable",
    });
    expect(mockReserve).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: USER_ID } });
    mockGetMembership.mockResolvedValue({ role: "owner" });
    mockRead.mockResolvedValue({ kind: "current", binding, issue: null });
    mockGetCredential.mockResolvedValue({
      ok: false,
      kind: "indeterminate",
      reason: "github_unavailable",
    });
    const indeterminate = await POST(request(), params);
    expect(indeterminate.status).toBe(503);
    expect(await indeterminate.json()).toEqual({ error: "Gated issue publication unavailable" });
    expect(mockReserve).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("lets the reservation transaction reject a head or membership race before GitHub", async () => {
    mockReserve.mockResolvedValueOnce({ kind: "not_current" });
    const response = await POST(request(), params);
    expect(response.status).toBe(409);
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockReport).not.toHaveBeenCalled();
  });

  it("returns a pre-existing reservation as held with no request bytes and never retries GitHub", async () => {
    mockRead.mockResolvedValueOnce({ kind: "current", binding, issue: reservedIssue });
    mockReserve.mockResolvedValueOnce({ kind: "held", binding, issue: reservedIssue });
    const response = await POST(request(), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: "held", issue: { status: "reserved" } });
    expect(mockGetCredential).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockReport).not.toHaveBeenCalled();
  });

  it("replays a terminal publication without credentials, GitHub, or reporting", async () => {
    mockRead.mockResolvedValueOnce({ kind: "current", binding, issue: publishedIssue });
    mockReserve.mockResolvedValueOnce({ kind: "terminal", binding, issue: publishedIssue });
    const response = await POST(request(), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: "terminal", issue: { status: "published" } });
    expect(mockGetCredential).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockReport).not.toHaveBeenCalled();
  });

  it("reports bounded and ambiguous GitHub outcomes instead of retrying", async () => {
    for (const outcome of [
      { kind: "bounded_failed", reason: "github_rejected" },
      { kind: "ambiguous_hold", reason: "github_unavailable" },
    ]) {
      vi.clearAllMocks();
      mockAuth.mockResolvedValue({ user: { id: USER_ID } });
      mockGetMembership.mockResolvedValue({ role: "admin" });
      mockRead.mockResolvedValue({ kind: "current", binding, issue: null });
      mockGetCredential.mockResolvedValue({ ok: true, token: "ghs_scoped_token" });
      mockReserve.mockResolvedValue({
        kind: "reserved", inserted: true, binding, issue: reservedIssue, request: { title: TITLE, body: BODY },
      });
      mockPublish.mockResolvedValue(outcome);
      mockReport.mockResolvedValue({ kind: "reported", current: true, issue: {
        ...reservedIssue, status: outcome.kind, receipt: outcome, reportedAt: new Date(),
      } });
      const response = await POST(request(), params);
      expect(response.status).toBe(200);
      expect(mockPublish).toHaveBeenCalledOnce();
      expect(mockReport).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID, publicationId: PUBLICATION_ID, outcome });
    }
  });

  it("persists and returns a terminal result even after the current head advances", async () => {
    mockReport.mockResolvedValueOnce({ kind: "reported", current: false, issue: publishedIssue });
    const response = await POST(request(), params);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ kind: "reported", current: false, issue: { status: "published" } });
  });

  it("holds a known GitHub 201 when terminal persistence fails and never exposes raw error details", async () => {
    mockReport.mockRejectedValueOnce(new Error("database secret detail"));
    const response = await POST(request(), params);
    expect(response.status).toBe(503);
    const result = await response.json();
    expect(result).toEqual({ kind: "held", reason: "publication_outcome_not_persisted" });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(mockPublish).toHaveBeenCalledOnce();
  });
});
