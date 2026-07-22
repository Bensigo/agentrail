import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  isGoalLoopEnabled: vi.fn(),
  getRepository: vi.fn(),
  findActiveGoalBySlug: vi.fn(),
  createGoal: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  isGoalLoopEnabled,
  getRepository,
  findActiveGoalBySlug,
  createGoal,
} from "@agentrail/db-postgres";

const WORKSPACE_ID = "ws-123";
const USER_ID = "user-1";
const REPOSITORY_ID = "repo-1";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/v1/workspaces/${WORKSPACE_ID}/goals`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeParams() {
  return { params: Promise.resolve({ workspaceId: WORKSPACE_ID }) };
}

const validBody = {
  objective: "reach 80% test coverage",
  repository_id: REPOSITORY_ID,
  check_threshold: 5,
};

const repositoryRow = {
  id: REPOSITORY_ID,
  workspaceId: WORKSPACE_ID,
  name: "bensigo/agentrail",
};

const createdGoal = {
  id: "goal-1",
  workspaceId: WORKSPACE_ID,
  repositoryId: REPOSITORY_ID,
  objective: "reach 80% test coverage",
  slug: "reach-80-test-coverage",
  checkType: "metric" as const,
  checkMetric: "green_run_count",
  checkThreshold: 5,
  checkCommand: null,
  status: "active" as const,
  statusReason: null,
  maxIssues: 10,
  maxSpendUsd: 50,
  issuesFiled: 0,
  spendUsd: 0,
  stuckThreshold: 2,
  consecutiveNonGreen: 0,
  greenCount: 0,
  createdByEveSessionId: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

function mockMember(role: string) {
  vi.mocked(auth).mockResolvedValue({ user: { id: USER_ID } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    role,
  } as never);
}

describe("POST /api/v1/workspaces/:workspaceId/goals", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await POST(makeRequest(validBody), makeParams());
    expect(res.status).toBe(401);
    expect(getWorkspaceMembership).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller is not a workspace member", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER_ID } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const res = await POST(makeRequest(validBody), makeParams());
    expect(res.status).toBe(403);
    expect(isGoalLoopEnabled).not.toHaveBeenCalled();
  });

  it("returns 403 for a member role (owner/admin required — a goal commits real spend)", async () => {
    mockMember("member");
    const res = await POST(makeRequest(validBody), makeParams());
    expect(res.status).toBe(403);
    expect(isGoalLoopEnabled).not.toHaveBeenCalled();
    expect(createGoal).not.toHaveBeenCalled();
  });

  it("returns 403 for a viewer role", async () => {
    mockMember("viewer");
    const res = await POST(makeRequest(validBody), makeParams());
    expect(res.status).toBe(403);
    expect(createGoal).not.toHaveBeenCalled();
  });

  it("returns 404 when isGoalLoopEnabled is false (never 403 — the feature doesn't exist yet, same posture as console chat)", async () => {
    mockMember("owner");
    vi.mocked(isGoalLoopEnabled).mockResolvedValue(false);
    const res = await POST(makeRequest(validBody), makeParams());
    expect(res.status).toBe(404);
    expect(getRepository).not.toHaveBeenCalled();
    expect(createGoal).not.toHaveBeenCalled();
  });

  it("returns 400 when objective is missing", async () => {
    mockMember("admin");
    vi.mocked(isGoalLoopEnabled).mockResolvedValue(true);
    const res = await POST(
      makeRequest({ ...validBody, objective: "" }),
      makeParams()
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors.objective).toBeTruthy();
    expect(createGoal).not.toHaveBeenCalled();
  });

  it("returns 400 when repository_id is missing", async () => {
    mockMember("owner");
    vi.mocked(isGoalLoopEnabled).mockResolvedValue(true);
    const res = await POST(
      makeRequest({ objective: "reach 80% coverage" }),
      makeParams()
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors.repository_id).toBeTruthy();
    expect(getRepository).not.toHaveBeenCalled();
  });

  it("returns 400 when the repository does not belong to this workspace (repo-required rule, server-side half)", async () => {
    mockMember("owner");
    vi.mocked(isGoalLoopEnabled).mockResolvedValue(true);
    vi.mocked(getRepository).mockResolvedValue(null as never);
    const res = await POST(makeRequest(validBody), makeParams());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors.repository_id).toMatch(/not found/i);
    expect(getRepository).toHaveBeenCalledWith(WORKSPACE_ID, REPOSITORY_ID);
    expect(createGoal).not.toHaveBeenCalled();
  });

  it("returns 400 for an out-of-range max_issues", async () => {
    mockMember("owner");
    vi.mocked(isGoalLoopEnabled).mockResolvedValue(true);
    const res = await POST(
      makeRequest({ ...validBody, max_issues: 0 }),
      makeParams()
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors.max_issues).toBeTruthy();
  });

  it("returns 400 for an out-of-range max_spend_usd", async () => {
    mockMember("owner");
    vi.mocked(isGoalLoopEnabled).mockResolvedValue(true);
    const res = await POST(
      makeRequest({ ...validBody, max_spend_usd: 5000 }),
      makeParams()
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors.max_spend_usd).toBeTruthy();
  });

  it("returns 400 for a command check with no check_command", async () => {
    mockMember("owner");
    vi.mocked(isGoalLoopEnabled).mockResolvedValue(true);
    const res = await POST(
      makeRequest({
        objective: "burn down flaky tests",
        repository_id: REPOSITORY_ID,
        check_type: "command",
      }),
      makeParams()
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors.check_command).toBeTruthy();
  });

  it("201s on the happy path (owner) and creates the goal via createGoal with a derived slug", async () => {
    mockMember("owner");
    vi.mocked(isGoalLoopEnabled).mockResolvedValue(true);
    vi.mocked(getRepository).mockResolvedValue(repositoryRow as never);
    vi.mocked(findActiveGoalBySlug).mockResolvedValue(null);
    vi.mocked(createGoal).mockResolvedValue(createdGoal as never);

    const res = await POST(makeRequest(validBody), makeParams());

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.goal.id).toBe("goal-1");
    expect(body.goal.slug).toBe("reach-80-test-coverage");
    expect(createGoal).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        repositoryId: REPOSITORY_ID,
        objective: "reach 80% test coverage",
        slug: "reach-80-test-coverage",
        checkType: "metric",
        checkMetric: "green_run_count",
        checkThreshold: 5,
        maxIssues: 10,
        maxSpendUsd: 50,
      })
    );
  });

  it("201s for an admin (not just owner)", async () => {
    mockMember("admin");
    vi.mocked(isGoalLoopEnabled).mockResolvedValue(true);
    vi.mocked(getRepository).mockResolvedValue(repositoryRow as never);
    vi.mocked(findActiveGoalBySlug).mockResolvedValue(null);
    vi.mocked(createGoal).mockResolvedValue(createdGoal as never);

    const res = await POST(makeRequest(validBody), makeParams());
    expect(res.status).toBe(201);
  });

  it("disambiguates the slug when an ACTIVE goal already owns it (findActiveGoalBySlug scoping)", async () => {
    mockMember("owner");
    vi.mocked(isGoalLoopEnabled).mockResolvedValue(true);
    vi.mocked(getRepository).mockResolvedValue(repositoryRow as never);
    vi.mocked(findActiveGoalBySlug).mockResolvedValue({ id: "some-other-goal" } as never);
    vi.mocked(createGoal).mockResolvedValue(createdGoal as never);

    await POST(makeRequest(validBody), makeParams());

    const callArgs = vi.mocked(createGoal).mock.calls[0]![0];
    expect(callArgs.slug).not.toBe("reach-80-test-coverage");
    expect(callArgs.slug.startsWith("reach-80-test-coverage-")).toBe(true);
  });

  it("passes check_command through for a command-type goal and leaves checkMetric undefined", async () => {
    mockMember("owner");
    vi.mocked(isGoalLoopEnabled).mockResolvedValue(true);
    vi.mocked(getRepository).mockResolvedValue(repositoryRow as never);
    vi.mocked(findActiveGoalBySlug).mockResolvedValue(null);
    vi.mocked(createGoal).mockResolvedValue({ ...createdGoal, checkType: "command" } as never);

    await POST(
      makeRequest({
        objective: "burn down flaky tests",
        repository_id: REPOSITORY_ID,
        check_type: "command",
        check_command: "pnpm test --filter flaky",
      }),
      makeParams()
    );

    expect(createGoal).toHaveBeenCalledWith(
      expect.objectContaining({
        checkType: "command",
        checkCommand: "pnpm test --filter flaky",
        checkMetric: undefined,
        checkThreshold: undefined,
      })
    );
  });

  it("returns 400 for invalid JSON", async () => {
    mockMember("owner");
    vi.mocked(isGoalLoopEnabled).mockResolvedValue(true);
    const req = new NextRequest(`http://localhost/api/v1/workspaces/${WORKSPACE_ID}/goals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    const res = await POST(req, makeParams());
    expect(res.status).toBe(400);
  });
});
