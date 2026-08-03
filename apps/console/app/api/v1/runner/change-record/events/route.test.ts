import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  appendChangeRecordEvent: vi.fn(),
  findOrCreateChangeRecord: vi.fn(),
  getChatIdentityById: vi.fn(),
  getJaceSessionByEveSessionId: vi.fn(),
  getRepositoryByName: vi.fn(),
}));
import {
  appendChangeRecordEvent,
  findOrCreateChangeRecord,
  getChatIdentityById,
  getJaceSessionByEveSessionId,
  getRepositoryByName,
} from "@agentrail/db-postgres";
import { POST } from "./route";

const AUTH_ENV_KEY = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-shared-secret-abc123";
const ORIGINAL_SECRET = process.env[AUTH_ENV_KEY];
const NOW = new Date("2026-08-03T12:00:00.000Z");

const mockGetSession = vi.mocked(getJaceSessionByEveSessionId);
const mockGetIdentity = vi.mocked(getChatIdentityById);
const mockGetRepo = vi.mocked(getRepositoryByName);
const mockFindOrCreate = vi.mocked(findOrCreateChangeRecord);
const mockAppend = vi.mocked(appendChangeRecordEvent);

const PINNED_SESSION = {
  id: "session-1",
  workspaceId: "ws-1",
  chatIdentityId: "chat-identity-1",
  channel: "telegram",
  conversationKey: "tg-chat-42",
  eveSessionId: "eve-session-1",
  status: "active",
  lastActivityAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
};

const BOUND_IDENTITY = {
  id: "chat-identity-1",
  platform: "telegram",
  platformUserId: "tg-123",
  displayName: "Ada",
  userId: "user-1",
  workspaceId: "ws-1",
  linkToken: null,
  linkTokenExpiresAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const CONNECTED_REPO = {
  id: "repo-1",
  workspaceId: "ws-1",
  name: "ada/widgets",
  url: "https://github.com/ada/widgets",
  defaultBranch: "main",
  createdAt: NOW,
  updatedAt: NOW,
};

const RECORD = {
  id: "record-1",
  workspaceId: "ws-1",
  repo: "ada/widgets",
  issueNumber: 42,
  prNumber: 98,
  headShas: ["deadbeef"],
  mergedSha: null,
  state: "open",
  createdAt: NOW,
  updatedAt: NOW,
};

const EVENT = {
  id: "event-1",
  recordId: "record-1",
  eventKey: "review:posted:deadbeef",
  stage: "review",
  at: NOW,
  actor: "reviewer-of-record",
  payloadRef: { kind: "review_job", jobId: "job-1" },
  createdAt: NOW,
};

const VALID_BODY = {
  eveSessionId: "eve-session-1",
  repo: "ada/widgets",
  issueNumber: 42,
  prNumber: 98,
  eventKey: "review:posted:deadbeef",
  stage: "review",
  actor: "reviewer-of-record",
  payloadRef: { kind: "review_job", jobId: "job-1" },
  headShas: ["deadbeef"],
};

function postReq(body: unknown, withAuth = true): NextRequest {
  return new NextRequest("http://localhost/api/v1/runner/change-record/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(withAuth ? { Authorization: `Bearer ${SECRET}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function rawReq(rawBody: string): NextRequest {
  return new NextRequest("http://localhost/api/v1/runner/change-record/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${SECRET}`,
    },
    body: rawBody,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env[AUTH_ENV_KEY] = SECRET;
  mockGetSession.mockResolvedValue(PINNED_SESSION as never);
  mockGetIdentity.mockResolvedValue(BOUND_IDENTITY as never);
  mockGetRepo.mockResolvedValue(CONNECTED_REPO as never);
  mockFindOrCreate.mockResolvedValue(RECORD as never);
  mockAppend.mockResolvedValue({ event: EVENT, inserted: true } as never);
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env[AUTH_ENV_KEY];
  else process.env[AUTH_ENV_KEY] = ORIGINAL_SECRET;
});

describe("POST /api/v1/runner/change-record/events", () => {
  describe("auth", () => {
    it("401 when no Authorization header is sent, before any DB lookup", async () => {
      const res = await POST(postReq(VALID_BODY, false));
      expect(res.status).toBe(401);
      expect(mockGetSession).not.toHaveBeenCalled();
      expect(mockFindOrCreate).not.toHaveBeenCalled();
    });

    it("401 when JACE_CONSOLE_TOKEN is unset", async () => {
      delete process.env[AUTH_ENV_KEY];
      const res = await POST(postReq(VALID_BODY));
      expect(res.status).toBe(401);
    });
  });

  describe("body validation", () => {
    it("400 on invalid JSON", async () => {
      const res = await POST(rawReq("{not valid json"));
      expect(res.status).toBe(400);
      expect(mockGetSession).not.toHaveBeenCalled();
    });

    it("400 when neither issueNumber nor prNumber is present", async () => {
      const { issueNumber, prNumber, ...body } = VALID_BODY;
      const res = await POST(postReq(body));
      expect(res.status).toBe(400);
      expect(mockGetSession).not.toHaveBeenCalled();
      void issueNumber;
      void prNumber;
    });

    it("400 when payloadRef is not an object", async () => {
      const res = await POST(postReq({ ...VALID_BODY, payloadRef: "review-job/job-1" }));
      expect(res.status).toBe(400);
      expect(mockGetSession).not.toHaveBeenCalled();
    });

    it("413 when payloadRef exceeds the bounded reference cap", async () => {
      const res = await POST(
        postReq({
          ...VALID_BODY,
          payloadRef: { key: "x".repeat(9 * 1024) },
        })
      );
      expect(res.status).toBe(413);
      expect(mockGetSession).not.toHaveBeenCalled();
    });

    it("400 on malformed repo coordinates", async () => {
      const res = await POST(postReq({ ...VALID_BODY, repo: "../widgets" }));
      expect(res.status).toBe(400);
      expect(mockGetSession).not.toHaveBeenCalled();
    });

    it("400 on caller-supplied recordId because this route only accepts anchors", async () => {
      const res = await POST(
        postReq({
          ...VALID_BODY,
          recordId: "some-other-workspace-record-id",
          issueNumber: undefined,
          prNumber: undefined,
        })
      );
      expect(res.status).toBe(400);
      expect(mockFindOrCreate).not.toHaveBeenCalled();
    });
  });

  describe("tenant resolution", () => {
    it("404 when no session exists for the eveSessionId", async () => {
      mockGetSession.mockResolvedValue(null as never);
      const res = await POST(postReq(VALID_BODY));
      expect(res.status).toBe(404);
      expect(mockGetRepo).not.toHaveBeenCalled();
    });

    it("409 when the session has no resolvable workspace", async () => {
      mockGetSession.mockResolvedValue({ ...PINNED_SESSION, workspaceId: null } as never);
      mockGetIdentity.mockResolvedValue(null as never);
      const res = await POST(postReq(VALID_BODY));
      expect(res.status).toBe(409);
      expect(mockGetRepo).not.toHaveBeenCalled();
    });

    it("404 when the repo is not connected to this workspace", async () => {
      mockGetRepo.mockResolvedValue(null as never);
      const res = await POST(postReq(VALID_BODY));
      expect(res.status).toBe(404);
      expect(mockGetRepo).toHaveBeenCalledWith("ws-1", "ada/widgets");
      expect(mockFindOrCreate).not.toHaveBeenCalled();
    });

    it("supports identity-less sessions with workspaceId already pinned", async () => {
      mockGetSession.mockResolvedValue({ ...PINNED_SESSION, chatIdentityId: null } as never);
      const res = await POST(postReq(VALID_BODY));
      expect(res.status).toBe(200);
      expect(mockGetIdentity).not.toHaveBeenCalled();
    });
  });

  describe("append behavior", () => {
    it("finds or creates a workspace-scoped record, then appends the event by key", async () => {
      const res = await POST(postReq(VALID_BODY));
      expect(res.status).toBe(200);
      expect(mockFindOrCreate).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        repo: "ada/widgets",
        issueNumber: 42,
        prNumber: 98,
        headShas: ["deadbeef"],
        mergedSha: null,
        state: undefined,
      });
      expect(mockAppend).toHaveBeenCalledWith({
        recordId: "record-1",
        eventKey: "review:posted:deadbeef",
        stage: "review",
        actor: "reviewer-of-record",
        payloadRef: { kind: "review_job", jobId: "job-1" },
        at: undefined,
      });
    });

    it("returns stable record/event/insertion result", async () => {
      const res = await POST(postReq(VALID_BODY));
      expect(await res.json()).toEqual({
        ok: true,
        record: {
          id: "record-1",
          workspaceId: "ws-1",
          repo: "ada/widgets",
          issueNumber: 42,
          prNumber: 98,
          state: "open",
        },
        event: {
          id: "event-1",
          recordId: "record-1",
          eventKey: "review:posted:deadbeef",
          stage: "review",
          actor: "reviewer-of-record",
          payloadRef: { kind: "review_job", jobId: "job-1" },
          at: "2026-08-03T12:00:00.000Z",
        },
        inserted: true,
      });
    });

    it("surfaces idempotent replays as inserted false", async () => {
      mockAppend.mockResolvedValue({ event: EVENT, inserted: false } as never);
      const res = await POST(postReq(VALID_BODY));
      expect(res.status).toBe(200);
      expect((await res.json()).inserted).toBe(false);
    });

    it("503 when storage append fails", async () => {
      mockAppend.mockRejectedValue(new Error("db down"));
      const res = await POST(postReq(VALID_BODY));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "failed to append change record event" });
    });
  });
});
