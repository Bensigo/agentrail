import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  appendJudgmentEvent: vi.fn(),
  getChatIdentityById: vi.fn(),
  getJaceSessionByEveSessionId: vi.fn(),
  getRepositoryByName: vi.fn(),
}));

import { POST } from "./route";
import {
  appendJudgmentEvent,
  getChatIdentityById,
  getJaceSessionByEveSessionId,
  getRepositoryByName,
} from "@agentrail/db-postgres";

const TOKEN_ENV = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-shared-secret-abc123";
const ORIGINAL_TOKEN = process.env[TOKEN_ENV];

function request(body: unknown, authorized = true): NextRequest {
  return new NextRequest("http://localhost/api/v1/runner/judgment-events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorized ? { authorization: `Bearer ${SECRET}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

const validBody = {
  eveSessionId: "eve-1",
  repo: "acme/widgets",
  eventKey: "requirement-refusal:abc123",
  type: "requirement_correction",
  refs: {},
  payload: { decisionAttempted: true, refusal: true, outcome: "requirements_conflict" },
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env[TOKEN_ENV] = SECRET;
  vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({
    workspaceId: "ws-1",
    chatIdentityId: null,
  } as never);
  vi.mocked(getChatIdentityById).mockResolvedValue(null as never);
  vi.mocked(getRepositoryByName).mockResolvedValue({ id: "repo-1" } as never);
  vi.mocked(appendJudgmentEvent).mockResolvedValue({
    inserted: true,
    event: { id: "event-1" },
  } as never);
});

afterEach(() => {
  if (ORIGINAL_TOKEN === undefined) delete process.env[TOKEN_ENV];
  else process.env[TOKEN_ENV] = ORIGINAL_TOKEN;
});

describe("POST /api/v1/runner/judgment-events", () => {
  it("rejects missing Jace auth before touching the tenant", async () => {
    const response = await POST(request(validBody, false));
    expect(response.status).toBe(401);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
    expect(appendJudgmentEvent).not.toHaveBeenCalled();
  });

  it("resolves the workspace from the Eve session and appends a refusal event", async () => {
    const response = await POST(request(validBody));
    expect(response.status).toBe(201);
    expect(getRepositoryByName).toHaveBeenCalledWith("ws-1", "acme/widgets");
    expect(appendJudgmentEvent).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      repo: "acme/widgets",
      eventKey: "requirement-refusal:abc123",
      type: "requirement_correction",
      refs: {},
      payload: validBody.payload,
      actorRef: { kind: "jace" },
      sourceRef: { kind: "create_issue" },
    });
  });

  it("does not write when the repo is outside the resolved workspace", async () => {
    vi.mocked(getRepositoryByName).mockResolvedValue(null as never);
    const response = await POST(request(validBody));
    expect(response.status).toBe(404);
    expect(appendJudgmentEvent).not.toHaveBeenCalled();
  });
});
