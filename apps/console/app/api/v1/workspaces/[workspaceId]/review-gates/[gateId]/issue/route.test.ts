import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({ auth: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({
  appendJudgmentEvent: vi.fn(),
  getWorkspaceMembership: vi.fn(),
  getInstallationToken: vi.fn(),
  getRepository: vi.fn(),
  getConnector: vi.fn(),
  getConnectorSecret: vi.fn(),
  getReviewGate: vi.fn(),
  getRun: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import {
  appendJudgmentEvent,
  getWorkspaceMembership,
  getInstallationToken,
  getRepository,
  getConnector,
  getReviewGate,
  getRun,
} from "@agentrail/db-postgres";
import { POST } from "./route";

const mockAuth = vi.mocked(auth);
const mockAppend = vi.mocked(appendJudgmentEvent);
const mockMembership = vi.mocked(getWorkspaceMembership);
const mockToken = vi.mocked(getInstallationToken);
const mockRepository = vi.mocked(getRepository);
const mockConnector = vi.mocked(getConnector);
const mockGate = vi.mocked(getReviewGate);
const mockRun = vi.mocked(getRun);

function request(body: unknown): NextRequest {
  return new NextRequest(
    "http://localhost/api/v1/workspaces/ws-1/review-gates/gate-1/issue",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "user-1" } } as never);
  mockMembership.mockResolvedValue({ userId: "user-1" } as never);
  mockGate.mockResolvedValue({
    runId: "run-1",
    findings: [{ category: "tests", description: "Missing test", suggested_fix: "Add one" }],
  } as never);
  mockRun.mockResolvedValue({ repositoryId: "repo-1" } as never);
  mockRepository.mockResolvedValue({ name: "acme/widgets", url: "https://github.com/acme/widgets" } as never);
  mockToken.mockResolvedValue("github-token");
  mockAppend.mockResolvedValue({ event: {}, inserted: true } as never);
  mockConnector.mockResolvedValue(null);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ html_url: "https://github.com/acme/widgets/issues/9", number: 9 }), {
        status: 201,
        headers: { "content-type": "application/json" },
      })
    )
  );
});

describe("POST review gate finding issue", () => {
  it("captures an accepted review outcome after a human creates a GitHub issue", async () => {
    const response = await POST(request({ findingIndex: 0, target: "github" }), {
      params: Promise.resolve({ workspaceId: "ws-1", gateId: "gate-1" }),
    });

    expect(response.status).toBe(200);
    expect(mockAppend).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      repo: "acme/widgets",
      eventKey: "review:finding:gate-1:0:accepted:github",
      type: "review_outcome",
      refs: { findingId: "gate-1:0", runId: "run-1" },
      payload: {
        disposition: "accepted",
        findingClass: "tests",
        action: "issue_created",
        target: "github",
      },
      actorRef: { kind: "workspace_member", id: "user-1" },
      sourceRef: { kind: "console_review_gate", id: "gate-1" },
    });
  });
});
