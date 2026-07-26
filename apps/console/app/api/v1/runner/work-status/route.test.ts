import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getJaceSessionByEveSessionId: vi.fn(),
  getChatIdentityById: vi.fn(),
  getWorkspaceRuns: vi.fn(),
  getWorkspaceQueueEntries: vi.fn(),
  findWorkspaceWorkByRef: vi.fn(),
}));
import { GET } from "./route";
import {
  getJaceSessionByEveSessionId,
  getChatIdentityById,
  getWorkspaceRuns,
  getWorkspaceQueueEntries,
  findWorkspaceWorkByRef,
} from "@agentrail/db-postgres";

const NOW = new Date("2026-07-26T00:00:00.000Z");

// Central-secret auth — same idiom as pr-review/route.test.ts.
const ENV_KEY = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-shared-secret-abc123";
const ORIGINAL_ENV = process.env[ENV_KEY];

function getReq(qs: Record<string, string>, withAuth = true): NextRequest {
  const params = new URLSearchParams(qs);
  return new NextRequest(`http://localhost/api/v1/runner/work-status?${params.toString()}`, {
    method: "GET",
    headers: withAuth ? { Authorization: `Bearer ${SECRET}` } : {},
  });
}

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

const SAMPLE_RUN = {
  id: "run-1",
  title: "Fix the thing",
  status: "running",
  phase: "implement",
  branch: "feat/x",
  agent: "claude",
  prUrl: null,
  costUsd: 1.23,
  startedAt: NOW,
  finishedAt: null,
  createdAt: NOW,
};

const SAMPLE_QUEUE_ENTRY = {
  id: "qe-1",
  externalId: "1468",
  title: "Some issue",
  state: "queued",
  tier: 1,
  kind: "issue",
  createdAt: NOW,
  updatedAt: NOW,
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env[ENV_KEY] = SECRET;
  vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(PINNED_SESSION as never);
  vi.mocked(getChatIdentityById).mockResolvedValue(BOUND_IDENTITY as never);
  vi.mocked(getWorkspaceRuns).mockResolvedValue([SAMPLE_RUN] as never);
  vi.mocked(getWorkspaceQueueEntries).mockResolvedValue([SAMPLE_QUEUE_ENTRY] as never);
  vi.mocked(findWorkspaceWorkByRef).mockResolvedValue({
    runs: [SAMPLE_RUN],
    queueEntries: [SAMPLE_QUEUE_ENTRY],
  } as never);
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_ENV;
});

describe("GET /api/v1/runner/work-status", () => {
  // ---------------------------------------------------------------------
  // auth
  // ---------------------------------------------------------------------

  it("401 when no Authorization header is sent, and never touches session/db", async () => {
    const res = await GET(getReq({ eveSessionId: "eve-session-1" }, false));
    expect(res.status).toBe(401);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("401 when JACE_CONSOLE_TOKEN is unset (fail closed)", async () => {
    delete process.env[ENV_KEY];
    const res = await GET(getReq({ eveSessionId: "eve-session-1" }));
    expect(res.status).toBe(401);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("401 on a wrong secret", async () => {
    const res = await GET(
      new NextRequest("http://localhost/api/v1/runner/work-status?eveSessionId=eve-session-1", {
        headers: { Authorization: "Bearer wrong-secret" },
      })
    );
    expect(res.status).toBe(401);
  });

  // ---------------------------------------------------------------------
  // cheap validation (400)
  // ---------------------------------------------------------------------

  it("400 when eveSessionId is missing", async () => {
    const res = await GET(getReq({}));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "eveSessionId is required" });
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // tenant resolution (404 / 409)
  // ---------------------------------------------------------------------

  it("404 when no jace_sessions row is bound to this eveSessionId", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(null as never);
    const res = await GET(getReq({ eveSessionId: "unknown" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Chat identity not found" });
  });

  it("409 when neither the session nor the identity has a workspace", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({
      ...PINNED_SESSION,
      workspaceId: null,
    } as never);
    vi.mocked(getChatIdentityById).mockResolvedValue({ ...BOUND_IDENTITY, workspaceId: null } as never);

    const res = await GET(getReq({ eveSessionId: "eve-session-1" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "this conversation has no workspace yet — create one first",
    });
    expect(getWorkspaceRuns).not.toHaveBeenCalled();
    expect(getWorkspaceQueueEntries).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // happy path — no ref
  // ---------------------------------------------------------------------

  it("200: no ref — returns runs[] and queueEntries[] for the RESOLVED workspace, ignoring a caller-supplied workspaceId", async () => {
    const res = await GET(
      getReq({ eveSessionId: "eve-session-1", workspaceId: "attacker-supplied-ws" })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(getWorkspaceRuns).toHaveBeenCalledWith("ws-1");
    expect(getWorkspaceQueueEntries).toHaveBeenCalledWith("ws-1");
    expect(getWorkspaceRuns).not.toHaveBeenCalledWith("attacker-supplied-ws");
    expect(findWorkspaceWorkByRef).not.toHaveBeenCalled();

    expect(json.ref).toBeNull();
    expect(json.runs).toEqual([
      {
        ...SAMPLE_RUN,
        startedAt: NOW.toISOString(),
        finishedAt: null,
        createdAt: NOW.toISOString(),
      },
    ]);
    expect(json.queueEntries).toEqual([
      {
        ...SAMPLE_QUEUE_ENTRY,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      },
    ]);
  });

  // ---------------------------------------------------------------------
  // happy path — with ref
  // ---------------------------------------------------------------------

  it("200: with ref — findWorkspaceWorkByRef called with (resolvedWorkspaceId, ref)", async () => {
    const res = await GET(getReq({ eveSessionId: "eve-session-1", ref: "1468" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(findWorkspaceWorkByRef).toHaveBeenCalledWith("ws-1", "1468");
    expect(getWorkspaceRuns).not.toHaveBeenCalled();
    expect(getWorkspaceQueueEntries).not.toHaveBeenCalled();
    expect(json.ref).toBe("1468");
    expect(json.runs).toHaveLength(1);
    expect(json.queueEntries).toHaveLength(1);
  });

  it("200: ref matching nothing in this workspace returns empty arrays, NOT 404", async () => {
    vi.mocked(findWorkspaceWorkByRef).mockResolvedValue({ runs: [], queueEntries: [] } as never);

    const res = await GET(getReq({ eveSessionId: "eve-session-1", ref: "does-not-exist" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ref).toBe("does-not-exist");
    expect(json.runs).toEqual([]);
    expect(json.queueEntries).toEqual([]);
  });
});
