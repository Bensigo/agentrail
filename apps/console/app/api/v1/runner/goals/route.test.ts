import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getJaceSessionByEveSessionId: vi.fn(),
  getChatIdentityById: vi.fn(),
  listWorkspaceRepositories: vi.fn(),
  createGoal: vi.fn(),
}));
import { POST } from "./route";
import {
  getJaceSessionByEveSessionId,
  getChatIdentityById,
  listWorkspaceRepositories,
  createGoal,
} from "@agentrail/db-postgres";

const NOW = new Date("2026-07-22T00:00:00.000Z");
const ENV_KEY = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-shared-secret-abc123";
const ORIGINAL_ENV = process.env[ENV_KEY];

function req(body?: unknown, withAuth = true): NextRequest {
  return new NextRequest("http://localhost/api/v1/runner/goals", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(withAuth ? { Authorization: `Bearer ${SECRET}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
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

const CONNECTED_REPO = {
  id: "repo-1",
  workspaceId: "ws-1",
  name: "agentrail",
  url: "https://github.com/agentrail/agentrail",
  defaultBranch: "main",
  createdAt: NOW,
  updatedAt: NOW,
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env[ENV_KEY] = SECRET;
  vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(PINNED_SESSION as never);
  vi.mocked(getChatIdentityById).mockResolvedValue(BOUND_IDENTITY as never);
  vi.mocked(listWorkspaceRepositories).mockResolvedValue([CONNECTED_REPO] as never);
  vi.mocked(createGoal).mockResolvedValue({
    id: "goal-1",
    workspaceId: "ws-1",
    repositoryId: "repo-1",
    objective: "reach 80% coverage",
    slug: "reach-80-coverage",
    checkType: "metric",
    status: "active",
    maxIssues: 10,
    maxSpendUsd: 50,
    issuesFiled: 0,
    spendUsd: 0,
    createdAt: NOW,
    updatedAt: NOW,
  } as never);
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_ENV;
});

describe("POST /api/v1/runner/goals", () => {
  it("401 when no Authorization header is sent, and never touches the session/db", async () => {
    const res = await POST(req({ eveSessionId: "eve-session-1", objective: "reach 80% coverage" }, false));
    expect(res.status).toBe(401);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
    expect(createGoal).not.toHaveBeenCalled();
  });

  it("401 when JACE_CONSOLE_TOKEN is unset (fail closed)", async () => {
    delete process.env[ENV_KEY];
    const res = await POST(req({ eveSessionId: "eve-session-1", objective: "x" }, true));
    expect(res.status).toBe(401);
  });

  it("400 on malformed JSON body", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/v1/runner/goals", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${SECRET}` },
        body: "{not json",
      })
    );
    expect(res.status).toBe(400);
  });

  it("400 when objective is missing/blank", async () => {
    const res = await POST(req({ eveSessionId: "eve-session-1", objective: "   " }));
    expect(res.status).toBe(400);
    expect(createGoal).not.toHaveBeenCalled();
  });

  it("404 when the chat identity can't be resolved", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(null);
    const res = await POST(req({ eveSessionId: "unknown", objective: "reach 80% coverage" }));
    expect(res.status).toBe(404);
  });

  it("409 when the conversation has no workspace yet", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({
      ...PINNED_SESSION,
      workspaceId: null,
    } as never);
    vi.mocked(getChatIdentityById).mockResolvedValue({ ...BOUND_IDENTITY, workspaceId: null } as never);
    const res = await POST(req({ eveSessionId: "eve-session-1", objective: "reach 80% coverage" }));
    expect(res.status).toBe(409);
    expect(createGoal).not.toHaveBeenCalled();
  });

  it("409 with connected:false when the workspace has no connected repo", async () => {
    vi.mocked(listWorkspaceRepositories).mockResolvedValue([]);
    const res = await POST(req({ eveSessionId: "eve-session-1", objective: "reach 80% coverage" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.connected).toBe(false);
    expect(createGoal).not.toHaveBeenCalled();
  });

  it("201 creates the goal against the resolved workspace + first connected repo, deriving a slug from the objective", async () => {
    const res = await POST(
      req({ eveSessionId: "eve-session-1", objective: "Reach 80% Coverage!", checkThreshold: 5 })
    );
    expect(res.status).toBe(201);
    expect(createGoal).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        repositoryId: "repo-1",
        objective: "Reach 80% Coverage!",
        slug: "reach-80-coverage",
        checkThreshold: 5,
        createdByEveSessionId: "eve-session-1",
      })
    );
    const body = await res.json();
    expect(body).toEqual(
      expect.objectContaining({ goalId: "goal-1", objective: "reach 80% coverage", status: "active" })
    );
  });

  it("falls back to a random slug when the objective has no slugifiable characters", async () => {
    await POST(req({ eveSessionId: "eve-session-1", objective: "日本語のみ" }));
    const call = vi.mocked(createGoal).mock.calls[0]?.[0];
    expect(call?.slug).toMatch(/^goal-[0-9a-f]{6}$/);
  });
});
