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
      sourceRef: { kind: "chat" },
    });
  });

  it("accepts a chat-originated rejected_approach with bounded blocked terms and reason", async () => {
    const body = {
      eveSessionId: "eve-1",
      repo: "acme/widgets",
      eventKey: "rejected-approach:abc123",
      type: "rejected_approach",
      refs: { briefSlug: "retry-design" },
      payload: {
        blockedTerms: ["redis queue", "polling loop"],
        reason: "The user rejected Redis-backed retries during grilling.",
      },
      actorRef: { kind: "spoofed" },
      sourceRef: { kind: "spoofed" },
    };

    const response = await POST(request(body));
    expect(response.status).toBe(201);
    expect(appendJudgmentEvent).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      repo: "acme/widgets",
      eventKey: "rejected-approach:abc123",
      type: "rejected_approach",
      refs: { briefSlug: "retry-design" },
      payload: body.payload,
      actorRef: { kind: "jace" },
      sourceRef: { kind: "chat" },
    });
  });

  it("rejects trusted producer event types on the chat-originated route", async () => {
    for (const type of ["review_outcome", "false_green", "missed_check"]) {
      const response = await POST(request({ ...validBody, type }));
      expect(response.status).toBe(400);
    }
    expect(appendJudgmentEvent).not.toHaveBeenCalled();
  });

  it("rejects rejected_approach without a nonempty bounded reason and blockedTerms", async () => {
    const base = {
      ...validBody,
      type: "rejected_approach",
      payload: { reason: "Rejected during grilling.", blockedTerms: ["redis"] },
    };

    for (const payload of [
      { reason: "", blockedTerms: ["redis"] },
      { reason: "Rejected during grilling.", blockedTerms: [] },
      { reason: "Rejected during grilling.", blockedTerms: [""] },
      { reason: "Rejected during grilling.", blockedTerms: Array.from({ length: 21 }, (_, i) => `term-${i}`) },
      { reason: "x".repeat(1201), blockedTerms: ["redis"] },
      { reason: "Rejected during grilling.", blockedTerms: ["x".repeat(161)] },
    ]) {
      const response = await POST(request({ ...base, payload }));
      expect(response.status).toBe(400);
    }
    expect(appendJudgmentEvent).not.toHaveBeenCalled();
  });

  it("does not write when the repo is outside the resolved workspace", async () => {
    vi.mocked(getRepositoryByName).mockResolvedValue(null as never);
    const response = await POST(request(validBody));
    expect(response.status).toBe(404);
    expect(appendJudgmentEvent).not.toHaveBeenCalled();
  });
});
