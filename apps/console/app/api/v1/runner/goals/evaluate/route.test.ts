import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  isGoalLoopEnabled: vi.fn(),
  recordOutcomeAndTransition: vi.fn(),
}));
import { POST } from "./route";
import { isGoalLoopEnabled, recordOutcomeAndTransition } from "@agentrail/db-postgres";

const ENV_KEY = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-shared-secret-abc123";
const ORIGINAL_ENV = process.env[ENV_KEY];

function req(body?: unknown, withAuth = true): NextRequest {
  return new NextRequest("http://localhost/api/v1/runner/goals/evaluate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(withAuth ? { Authorization: `Bearer ${SECRET}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env[ENV_KEY] = SECRET;
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_ENV;
});

describe("POST /api/v1/runner/goals/evaluate", () => {
  it("401 when no Authorization header is sent, and never reads the flag or evaluates", async () => {
    const res = await POST(
      req({ workspaceId: "ws-1", issueExternalId: "42", outcome: "green" }, false)
    );
    expect(res.status).toBe(401);
    expect(isGoalLoopEnabled).not.toHaveBeenCalled();
    expect(recordOutcomeAndTransition).not.toHaveBeenCalled();
  });

  it("400 on a malformed body (missing fields)", async () => {
    const res = await POST(req({ workspaceId: "ws-1" }));
    expect(res.status).toBe(400);
    expect(isGoalLoopEnabled).not.toHaveBeenCalled();
  });

  it("400 on an unrecognized outcome value", async () => {
    const res = await POST(req({ workspaceId: "ws-1", issueExternalId: "42", outcome: "success" }));
    expect(res.status).toBe(400);
  });

  it("flag OFF: returns {matched:false} WITHOUT ever calling recordOutcomeAndTransition — the rollout-safety no-op", async () => {
    vi.mocked(isGoalLoopEnabled).mockResolvedValue(false);
    const res = await POST(req({ workspaceId: "ws-1", issueExternalId: "42", outcome: "green", costUsd: 3 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ matched: false });
    expect(recordOutcomeAndTransition).not.toHaveBeenCalled();
  });

  it("flag ON, no matching goal: returns {matched:false}", async () => {
    vi.mocked(isGoalLoopEnabled).mockResolvedValue(true);
    vi.mocked(recordOutcomeAndTransition).mockResolvedValue({ matched: false });
    const res = await POST(req({ workspaceId: "ws-1", issueExternalId: "42", outcome: "blocked" }));
    expect(await res.json()).toEqual({ matched: false });
  });

  it("flag ON, matched: returns action + trimmed goal fields", async () => {
    vi.mocked(isGoalLoopEnabled).mockResolvedValue(true);
    vi.mocked(recordOutcomeAndTransition).mockResolvedValue({
      matched: true,
      action: "refill",
      reason: "goal still active",
      goal: {
        id: "goal-1",
        workspaceId: "ws-1",
        repositoryId: "repo-1",
        objective: "reach 80% coverage",
        slug: "reach-80-coverage",
        checkType: "metric",
        status: "active",
        maxIssues: 10,
        maxSpendUsd: 50,
        issuesFiled: 2,
        spendUsd: 12,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never,
    });

    const res = await POST(req({ workspaceId: "ws-1", issueExternalId: "42", outcome: "green", costUsd: 1 }));
    const body = await res.json();
    expect(body.matched).toBe(true);
    expect(body.action).toBe("refill");
    expect(body.goal).toEqual(
      expect.objectContaining({
        id: "goal-1",
        objective: "reach 80% coverage",
        slug: "reach-80-coverage",
        status: "active",
        issuesFiled: 2,
        maxIssues: 10,
        spendUsd: 12,
        maxSpendUsd: 50,
      })
    );
  });

  it("defaults costUsd to 0 when omitted", async () => {
    vi.mocked(isGoalLoopEnabled).mockResolvedValue(true);
    vi.mocked(recordOutcomeAndTransition).mockResolvedValue({ matched: false });
    await POST(req({ workspaceId: "ws-1", issueExternalId: "42", outcome: "green" }));
    expect(recordOutcomeAndTransition).toHaveBeenCalledWith(
      expect.objectContaining({ costUsd: 0 })
    );
  });
});
