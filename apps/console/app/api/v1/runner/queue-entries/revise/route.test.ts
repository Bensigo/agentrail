import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getJaceSessionByEveSessionId: vi.fn(),
  findQueueEntryByExternalId: vi.fn(),
  reviseAlignmentBrief: vi.fn(),
}));
vi.mock("../../../../../../lib/alignment-reconciler", () => ({
  postAlignmentBrief: vi.fn(),
}));

import { POST } from "./route";
import {
  getJaceSessionByEveSessionId,
  findQueueEntryByExternalId,
  reviseAlignmentBrief,
} from "@agentrail/db-postgres";
import { postAlignmentBrief } from "../../../../../../lib/alignment-reconciler";

const mockGetSession = vi.mocked(getJaceSessionByEveSessionId);
const mockFindEntry = vi.mocked(findQueueEntryByExternalId);
const mockRevise = vi.mocked(reviseAlignmentBrief);
const mockPostBrief = vi.mocked(postAlignmentBrief);

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
const LATER = new Date("2026-07-21T00:05:00.000Z");

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
    expect(mockRevise).not.toHaveBeenCalled();
  });

  it("200 { revised: false, reason: 'not_denied' } when the entry exists but isn't currently denied — never posts a brief", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    mockFindEntry.mockResolvedValue(MOCK_ENTRY as never);
    mockRevise.mockResolvedValue({ ok: false, reason: "not_denied" });
    const res = await POST(req(MOCK_BODY));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ revised: false, reason: "not_denied" });
    expect(mockPostBrief).not.toHaveBeenCalled();
  });

  it("200 { revised: true, outcome } and posts a FRESH brief with a request id derived from the transition's updatedAt when the entry WAS denied", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    mockFindEntry.mockResolvedValue(MOCK_ENTRY as never);
    mockRevise.mockResolvedValue({ ok: true, updatedAt: LATER });
    mockPostBrief.mockResolvedValue("posted");

    const res = await POST(req(MOCK_BODY));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ revised: true, outcome: "posted" });

    expect(mockRevise).toHaveBeenCalledWith({
      queueEntryId: "queue-entry-1",
      title: "Cheaper version",
      body: MOCK_BODY.body,
    });

    expect(mockPostBrief).toHaveBeenCalledTimes(1);
    const call = mockPostBrief.mock.calls[0]![0];
    expect(call.workspaceId).toBe("ws-1");
    expect(call.queueEntryId).toBe("queue-entry-1");
    expect(call.title).toBe("Cheaper version");
    expect(call.body).toBe(MOCK_BODY.body);
    expect(call.repoFullName).toBe("acme/widgets");
    expect(call.number).toBe(42);
    // The request id embeds the revision's own updatedAt timestamp — never
    // the bare `alignment-brief:${queueEntryId}` the DENIED approval already
    // used, so this creates a NEW jace_approvals row instead of colliding.
    expect(call.requestId).toBe(`alignment-brief:queue-entry-1:revise-${LATER.getTime()}`);
  });

  it("two separate revise rounds for the SAME queue entry get DIFFERENT request ids (never collide)", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    mockFindEntry.mockResolvedValue(MOCK_ENTRY as never);
    mockPostBrief.mockResolvedValue("posted");

    mockRevise.mockResolvedValueOnce({ ok: true, updatedAt: NOW });
    await POST(req(MOCK_BODY));
    const firstRequestId = mockPostBrief.mock.calls[0]![0].requestId;

    mockRevise.mockResolvedValueOnce({ ok: true, updatedAt: LATER });
    await POST(req(MOCK_BODY));
    const secondRequestId = mockPostBrief.mock.calls[1]![0].requestId;

    expect(firstRequestId).not.toBe(secondRequestId);
  });
});
