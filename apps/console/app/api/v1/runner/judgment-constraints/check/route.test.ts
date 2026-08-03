import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  evaluateJudgmentConstraints: vi.fn(),
  getChatIdentityById: vi.fn(),
  getJaceSessionByEveSessionId: vi.fn(),
  getRepositoryByName: vi.fn(),
  listJudgmentConstraints: vi.fn(),
  listWorkspaceRepositories: vi.fn(),
}));
vi.mock("../../../../../../lib/jace-console-auth", () => ({
  requireJaceConsoleSecret: vi.fn(() => null),
}));

import {
  evaluateJudgmentConstraints,
  getChatIdentityById,
  getJaceSessionByEveSessionId,
  getRepositoryByName,
  listJudgmentConstraints,
  listWorkspaceRepositories,
} from "@agentrail/db-postgres";
import { POST } from "./route";

const WORKSPACE = "ws-1";
const SESSION = "eve-1";
const REPO = { id: "repo-1", workspaceId: WORKSPACE, name: "acme/widgets" };

function request(body: unknown) {
  return new NextRequest("http://localhost/api/v1/runner/judgment-constraints/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({
    workspaceId: WORKSPACE,
    chatIdentityId: null,
  } as never);
  vi.mocked(getChatIdentityById).mockResolvedValue(null as never);
  vi.mocked(getRepositoryByName).mockResolvedValue(REPO as never);
  vi.mocked(listWorkspaceRepositories).mockResolvedValue([REPO] as never);
  vi.mocked(listJudgmentConstraints).mockResolvedValue([]);
  vi.mocked(evaluateJudgmentConstraints).mockReturnValue({
    allowed: true,
    blocks: [],
    warnings: [],
  });
});

describe("POST /api/v1/runner/judgment-constraints/check", () => {
  it("resolves the workspace from the Jace session and allows no matching constraint", async () => {
    const response = await POST(request({
      eveSessionId: SESSION,
      repo: "acme/widgets",
      text: "Use the existing queue",
    }));

    expect(response.status).toBe(200);
    expect(getJaceSessionByEveSessionId).toHaveBeenCalledWith(SESSION);
    expect(getRepositoryByName).toHaveBeenCalledWith(WORKSPACE, "acme/widgets");
    expect(await response.json()).toEqual({
      repo: "acme/widgets",
      allowed: true,
      blocks: [],
      warnings: [],
    });
  });

  it("returns a deterministic block without making any write", async () => {
    vi.mocked(evaluateJudgmentConstraints).mockReturnValue({
      allowed: false,
      blocks: [{
        eventId: "event-1",
        eventKey: "rejected:redis",
        terms: ["redis"],
        reason: "Redis was rejected.",
        matched: true,
      }],
      warnings: [],
    });

    const response = await POST(request({
      eveSessionId: SESSION,
      repo: "acme/widgets",
      text: "Add Redis",
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      repo: "acme/widgets",
      allowed: false,
      blocks: [{ eventKey: "rejected:redis", reason: "Redis was rejected." }],
    });
  });

  it("can resolve the sole connected repo when the caller omits repo", async () => {
    const response = await POST(request({
      eveSessionId: SESSION,
      text: "Use the existing queue",
    }));

    expect(response.status).toBe(200);
    expect(listWorkspaceRepositories).toHaveBeenCalledWith(WORKSPACE);
    expect(await response.json()).toMatchObject({ repo: "acme/widgets", allowed: true });
  });

  it("returns 404 for an unresolvable session", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(null as never);
    const response = await POST(request({ eveSessionId: SESSION, repo: "acme/widgets", text: "x" }));
    expect(response.status).toBe(404);
    expect(listJudgmentConstraints).not.toHaveBeenCalled();
  });

  it("returns 503 when constraint storage fails", async () => {
    vi.mocked(listJudgmentConstraints).mockRejectedValue(new Error("db down"));
    const response = await POST(request({ eveSessionId: SESSION, repo: "acme/widgets", text: "x" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Failed to verify judgment constraints" });
  });
});
