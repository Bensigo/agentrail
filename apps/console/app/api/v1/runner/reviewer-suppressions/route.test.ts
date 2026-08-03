import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getChatIdentityById: vi.fn(),
  getJaceSessionByEveSessionId: vi.fn(),
  getRepositoryByName: vi.fn(),
  listReviewerSuppressionRules: vi.fn(),
}));
vi.mock("../../../../../lib/jace-console-auth", () => ({
  requireJaceConsoleSecret: vi.fn(() => null),
}));

import {
  getChatIdentityById,
  getJaceSessionByEveSessionId,
  getRepositoryByName,
  listReviewerSuppressionRules,
} from "@agentrail/db-postgres";
import { GET } from "./route";

const WORKSPACE = "ws-1";
const SESSION = "eve-1";
const REPO = { id: "repo-1", workspaceId: WORKSPACE, name: "acme/widgets" };

function request(search: string) {
  return new NextRequest(`http://localhost/api/v1/runner/reviewer-suppressions?${search}`);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({
    workspaceId: WORKSPACE,
    chatIdentityId: null,
  } as never);
  vi.mocked(getChatIdentityById).mockResolvedValue(null as never);
  vi.mocked(getRepositoryByName).mockResolvedValue(REPO as never);
  vi.mocked(listReviewerSuppressionRules).mockResolvedValue([
    {
      findingClass: "legacy auth false positive",
      count: 3,
      reason: "dismissed three times",
      sourceEventIds: ["event-a", "event-b", "event-c"],
    },
  ] as never);
});

describe("GET /api/v1/runner/reviewer-suppressions", () => {
  it("resolves tenant from eveSessionId and returns repo-scoped rules", async () => {
    const response = await GET(request("eveSessionId=eve-1&repo=acme/widgets"));

    expect(response.status).toBe(200);
    expect(getJaceSessionByEveSessionId).toHaveBeenCalledWith(SESSION);
    expect(getRepositoryByName).toHaveBeenCalledWith(WORKSPACE, "acme/widgets");
    expect(listReviewerSuppressionRules).toHaveBeenCalledWith({
      workspaceId: WORKSPACE,
      repo: "acme/widgets",
    });
    expect(await response.json()).toEqual({
      repo: "acme/widgets",
      degraded: null,
      rules: [{
        findingClass: "legacy auth false positive",
        count: 3,
        reason: "dismissed three times",
        sourceEventIds: ["event-a", "event-b", "event-c"],
      }],
    });
  });

  it("rejects malformed repo before tenant lookup", async () => {
    const response = await GET(request("eveSessionId=eve-1&repo=not-a-full-name"));

    expect(response.status).toBe(400);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("rejects repos not connected to the resolved workspace", async () => {
    vi.mocked(getRepositoryByName).mockResolvedValue(null as never);

    const response = await GET(request("eveSessionId=eve-1&repo=acme/other"));

    expect(response.status).toBe(404);
    expect(listReviewerSuppressionRules).not.toHaveBeenCalled();
  });

  it("degrades storage failure to no suppression rules", async () => {
    vi.mocked(listReviewerSuppressionRules).mockRejectedValue(new Error("db down"));

    const response = await GET(request("eveSessionId=eve-1&repo=acme/widgets"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      repo: "acme/widgets",
      rules: [],
      degraded: { reason: "storage_error" },
    });
  });
});
