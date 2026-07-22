import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getJaceSessionByEveSessionId: vi.fn(),
  getChatIdentityById: vi.fn(),
  isGoalLoopEnabled: vi.fn(),
  findActiveGoalBySlug: vi.fn(),
  canFileNextIssue: vi.fn(),
}));
import { POST } from "./route";
import {
  getJaceSessionByEveSessionId,
  getChatIdentityById,
  isGoalLoopEnabled,
  findActiveGoalBySlug,
  canFileNextIssue,
} from "@agentrail/db-postgres";

const NOW = new Date("2026-07-22T00:00:00.000Z");
const ENV_KEY = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-shared-secret-abc123";
const ORIGINAL_ENV = process.env[ENV_KEY];

function req(body?: unknown, withAuth = true): NextRequest {
  return new NextRequest("http://localhost/api/v1/runner/goals/file-check", {
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

const GOAL = {
  id: "goal-1",
  workspaceId: "ws-1",
  repositoryId: "repo-1",
  objective: "reach 80% coverage",
  slug: "reach-80-coverage",
  status: "active",
  maxIssues: 10,
  maxSpendUsd: 50,
  issuesFiled: 3,
  spendUsd: 12,
  createdAt: NOW,
  updatedAt: NOW,
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env[ENV_KEY] = SECRET;
  vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(PINNED_SESSION as never);
  vi.mocked(getChatIdentityById).mockResolvedValue(BOUND_IDENTITY as never);
  vi.mocked(isGoalLoopEnabled).mockResolvedValue(true);
  vi.mocked(findActiveGoalBySlug).mockResolvedValue(GOAL as never);
  vi.mocked(canFileNextIssue).mockReturnValue({ allow: true, reason: "leash remains" });
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_ENV;
});

describe("POST /api/v1/runner/goals/file-check", () => {
  it("401 when no Authorization header is sent, and never touches the flag/goal lookup", async () => {
    const res = await POST(req({ eveSessionId: "eve-session-1", slug: "reach-80-coverage" }, false));
    expect(res.status).toBe(401);
    expect(isGoalLoopEnabled).not.toHaveBeenCalled();
    expect(findActiveGoalBySlug).not.toHaveBeenCalled();
  });

  it("400 on a malformed body", async () => {
    const res = await POST(req({ eveSessionId: "eve-session-1" }));
    expect(res.status).toBe(400);
  });

  it("allow:true UNCONDITIONALLY when the workspace's jaceGoalLoop flag is OFF — never even looks up a goal (a coincidental '(goal:x)' substring must never block a normal issue for an opted-out workspace)", async () => {
    vi.mocked(isGoalLoopEnabled).mockResolvedValue(false);
    const res = await POST(req({ eveSessionId: "eve-session-1", slug: "reach-80-coverage" }));
    expect(await res.json()).toEqual({ allow: true });
    expect(findActiveGoalBySlug).not.toHaveBeenCalled();
  });

  it("allow:false, fail-closed, when no workspace can be resolved for this conversation", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({
      ...PINNED_SESSION,
      workspaceId: null,
    } as never);
    vi.mocked(getChatIdentityById).mockResolvedValue({ ...BOUND_IDENTITY, workspaceId: null } as never);
    const res = await POST(req({ eveSessionId: "eve-session-1", slug: "reach-80-coverage" }));
    const body = await res.json();
    expect(body.allow).toBe(false);
    expect(isGoalLoopEnabled).not.toHaveBeenCalled();
  });

  it("allow:false when the flag is on but no active goal matches the slug", async () => {
    vi.mocked(findActiveGoalBySlug).mockResolvedValue(null);
    const res = await POST(req({ eveSessionId: "eve-session-1", slug: "unknown-slug" }));
    const body = await res.json();
    expect(body.allow).toBe(false);
    expect(body.reason).toMatch(/no active goal matches/);
    expect(canFileNextIssue).not.toHaveBeenCalled();
  });

  it("allow:false with the goalId + reason when the matched goal's leash is exhausted — THE core fix: this is what makes maxIssues real", async () => {
    vi.mocked(canFileNextIssue).mockReturnValue({
      allow: false,
      reason: "leash exhausted: issues filed 10/10",
    });
    const res = await POST(req({ eveSessionId: "eve-session-1", slug: "reach-80-coverage" }));
    const body = await res.json();
    expect(body).toEqual({
      allow: false,
      goalId: "goal-1",
      reason: "leash exhausted: issues filed 10/10",
    });
    expect(canFileNextIssue).toHaveBeenCalledWith(GOAL);
  });

  it("allow:true with the goalId when the flag is on, the goal is active, and the leash has room", async () => {
    const res = await POST(req({ eveSessionId: "eve-session-1", slug: "reach-80-coverage" }));
    const body = await res.json();
    expect(body).toEqual({ allow: true, goalId: "goal-1" });
  });
});
