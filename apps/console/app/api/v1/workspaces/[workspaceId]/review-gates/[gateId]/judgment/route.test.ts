import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({ auth: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({
  appendJudgmentEvent: vi.fn(),
  getRepository: vi.fn(),
  getReviewGate: vi.fn(),
  getRun: vi.fn(),
  getWorkspaceMembership: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import {
  appendJudgmentEvent,
  getRepository,
  getReviewGate,
  getRun,
  getWorkspaceMembership,
} from "@agentrail/db-postgres";
import { POST } from "./route";

const mockAuth = vi.mocked(auth);
const mockAppend = vi.mocked(appendJudgmentEvent);
const mockRepository = vi.mocked(getRepository);
const mockGate = vi.mocked(getReviewGate);
const mockRun = vi.mocked(getRun);
const mockMembership = vi.mocked(getWorkspaceMembership);

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/workspaces/ws-1/review-gates/gate-1/judgment", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
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
  mockRepository.mockResolvedValue({ name: "acme/widgets" } as never);
  mockAppend.mockResolvedValue({ event: { id: "event-1" }, inserted: true } as never);
});

describe("POST review gate finding judgment", () => {
  it.each([
    ["accepted", { disposition: "accepted" }],
    ["dismissed", { disposition: "dismissed" }],
  ])("captures a %s review outcome", async (_label, body) => {
    const response = await POST(request({ findingIndex: 0, ...body }), {
      params: Promise.resolve({ workspaceId: "ws-1", gateId: "gate-1" }),
    });

    expect(response.status).toBe(201);
    expect(mockAppend).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "ws-1",
      repo: "acme/widgets",
      type: "review_outcome",
      refs: { findingId: "gate-1:0", runId: "run-1" },
      payload: expect.objectContaining({ disposition: body.disposition, findingClass: "tests" }),
      actorRef: { kind: "workspace_member", id: "user-1" },
      sourceRef: { kind: "console_review_gate", id: "gate-1" },
    }));
  });

  it("records the edited text as the human ground truth", async () => {
    await POST(request({
      findingIndex: 0,
      disposition: "edited",
      editedDescription: "Test the empty state",
      editedSuggestedFix: "Add a browser test",
    }), { params: Promise.resolve({ workspaceId: "ws-1", gateId: "gate-1" }) });

    expect(mockAppend).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        disposition: "edited",
        editedDescription: "Test the empty state",
        editedSuggestedFix: "Add a browser test",
      }),
    }));
  });

  it("rejects an edited disposition without replacement text", async () => {
    const response = await POST(request({ findingIndex: 0, disposition: "edited" }), {
      params: Promise.resolve({ workspaceId: "ws-1", gateId: "gate-1" }),
    });
    expect(response.status).toBe(400);
    expect(mockAppend).not.toHaveBeenCalled();
  });
});
