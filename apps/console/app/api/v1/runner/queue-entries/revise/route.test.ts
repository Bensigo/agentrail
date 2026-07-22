import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getJaceSessionByEveSessionId: vi.fn(),
  findQueueEntryByExternalId: vi.fn(),
}));
vi.mock("../../../../../../lib/alignment-reconciler", () => ({
  reviseAndRepostAlignmentBrief: vi.fn(),
}));

import { POST } from "./route";
import { getJaceSessionByEveSessionId, findQueueEntryByExternalId } from "@agentrail/db-postgres";
import { reviseAndRepostAlignmentBrief } from "../../../../../../lib/alignment-reconciler";

const mockGetSession = vi.mocked(getJaceSessionByEveSessionId);
const mockFindEntry = vi.mocked(findQueueEntryByExternalId);
const mockReviseAndRepost = vi.mocked(reviseAndRepostAlignmentBrief);

const ENV_KEY = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-shared-secret-abc123";
const ORIGINAL_ENV = process.env[ENV_KEY];

function req(body?: unknown, withAuth = true): NextRequest {
  return new NextRequest("http://localhost/api/v1/runner/queue-entries/revise", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(withAuth ? { Authorization: `Bearer ${SECRET}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const MOCK_BODY = {
  eveSessionId: "eve-session-1",
  repoFullName: "acme/widgets",
  number: 42,
  title: "Cheaper version",
  body: "## Acceptance criteria\n- [ ] AC1: narrower scope\n",
};

const NOW = new Date("2026-07-21T00:00:00.000Z");

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

const MOCK_SESSION_INTRO = { ...MOCK_SESSION_WS, id: "session-intro-1", workspaceId: null };

const MOCK_ENTRY = {
  id: "queue-entry-1",
  state: "parked",
  parkReason: "alignment denied — open a new issue to try again",
  title: "Old title",
  body: "old body",
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env[ENV_KEY] = SECRET;
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_ENV;
});

describe("POST /api/v1/runner/queue-entries/revise — auth + body validation", () => {
  it("401 when no Authorization header is sent, and never touches the session lookup", async () => {
    const res = await POST(req(MOCK_BODY, false));
    expect(res.status).toBe(401);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("401 when JACE_CONSOLE_TOKEN is unset (fail closed)", async () => {
    delete process.env[ENV_KEY];
    const res = await POST(req(MOCK_BODY, true));
    expect(res.status).toBe(401);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("401 on a wrong secret", async () => {
    const request = new NextRequest("http://localhost/api/v1/runner/queue-entries/revise", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer wrong-secret" },
      body: JSON.stringify(MOCK_BODY),
    });
    const res = await POST(request);
    expect(res.status).toBe(401);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("400 on invalid JSON body", async () => {
    const request = new NextRequest("http://localhost/api/v1/runner/queue-entries/revise", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${SECRET}` },
      body: "{not valid json",
    });
    const res = await POST(request);
    expect(res.status).toBe(400);
  });

  it("400 when eveSessionId is missing", async () => {
    const res = await POST(req({ ...MOCK_BODY, eveSessionId: undefined }));
    expect(res.status).toBe(400);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("400 when repoFullName is missing", async () => {
    const res = await POST(req({ ...MOCK_BODY, repoFullName: undefined }));
    expect(res.status).toBe(400);
  });

  it("400 when number is missing or not a number", async () => {
    const res1 = await POST(req({ ...MOCK_BODY, number: undefined }));
    expect(res1.status).toBe(400);
    const res2 = await POST(req({ ...MOCK_BODY, number: "42" }));
    expect(res2.status).toBe(400);
  });

  it("400 when title or body is not a string", async () => {
    const res1 = await POST(req({ ...MOCK_BODY, title: undefined }));
    expect(res1.status).toBe(400);
    const res2 = await POST(req({ ...MOCK_BODY, body: undefined }));
    expect(res2.status).toBe(400);
  });
});

describe("POST /api/v1/runner/queue-entries/revise — resolution chain", () => {
  it("200 { revised: false, reason: 'no_workspace' } when the session has no workspace (intro session), and never looks up a queue entry", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_INTRO as never);
    const res = await POST(req(MOCK_BODY));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ revised: false, reason: "no_workspace" });
    expect(mockFindEntry).not.toHaveBeenCalled();
  });

  it("200 { revised: false, reason: 'no_workspace' } when no session is found at all", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await POST(req(MOCK_BODY));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.revised).toBe(false);
  });

  it("200 { revised: false, reason: 'not_found' } when no queue entry matches — the common case for a plain house-format edit unrelated to the alignment gate", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    mockFindEntry.mockResolvedValue(null);
    const res = await POST(req(MOCK_BODY));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ revised: false, reason: "not_found" });
    expect(mockFindEntry).toHaveBeenCalledWith("ws-1", "acme/widgets", 42);
    expect(mockReviseAndRepost).not.toHaveBeenCalled();
  });

  it("200 { revised: false, reason: 'not_denied' } when the entry exists but isn't currently denied — the shared helper's own no-op, forwarded verbatim", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    mockFindEntry.mockResolvedValue(MOCK_ENTRY as never);
    mockReviseAndRepost.mockResolvedValue({ revised: false, reason: "not_denied" });
    const res = await POST(req(MOCK_BODY));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ revised: false, reason: "not_denied" });
  });

  it("calls the shared reviseAndRepostAlignmentBrief helper with the resolved workspace/entry and the edited title/body, and forwards its result verbatim (#1345 PR③ refactor: the revise+repost core now lives in ONE shared helper, reused by the github-webhook edited branch too)", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    mockFindEntry.mockResolvedValue(MOCK_ENTRY as never);
    mockReviseAndRepost.mockResolvedValue({ revised: true, outcome: "posted" });

    const res = await POST(req(MOCK_BODY));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ revised: true, outcome: "posted" });

    expect(mockReviseAndRepost).toHaveBeenCalledTimes(1);
    expect(mockReviseAndRepost).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      queueEntryId: "queue-entry-1",
      title: "Cheaper version",
      body: MOCK_BODY.body,
      repoFullName: "acme/widgets",
      number: 42,
    });
  });
});
