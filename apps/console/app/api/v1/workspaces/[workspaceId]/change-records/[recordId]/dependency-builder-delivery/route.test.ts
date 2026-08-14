import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const RECORD_ID = "33333333-3333-4333-8333-333333333333";
const PACK_EVENT_ID = "44444444-4444-4444-8444-444444444444";

const { mockAuth, mockMembership, mockRun } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockMembership: vi.fn(),
  mockRun: vi.fn(),
}));
vi.mock("@agentrail/auth", () => ({ auth: mockAuth }));
vi.mock("@agentrail/db-postgres", () => ({ getWorkspaceMembership: mockMembership }));
vi.mock("../../../../../../../../lib/github-dependency-builder-delivery", () => ({
  runGithubDependencyBuilderDelivery: mockRun,
}));

import { POST } from "./route";

const params = { params: Promise.resolve({ workspaceId: WORKSPACE_ID, recordId: RECORD_ID }) };
const url = `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/change-records/${RECORD_ID}/dependency-builder-delivery`;

function request(body: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: USER_ID } });
  mockMembership.mockResolvedValue({ role: "owner" });
  mockRun.mockResolvedValue({ kind: "carrier_accepted", deliveryId: "delivery-1", githubCommentId: "1", githubCommentUrl: "https://github.com/acme/widgets/pull/1#issuecomment-1" });
});

describe("POST dependency Builder delivery", () => {
  it("authenticates and authorizes before accepting the body", async () => {
    mockAuth.mockResolvedValueOnce(null);
    const response = await POST(request("{"), params);
    expect(response.status).toBe(401);
    expect(mockMembership).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();

    mockMembership.mockResolvedValueOnce({ role: "member" });
    const forbidden = await POST(request("{"), params);
    expect(forbidden.status).toBe(403);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("rejects declared and chunked over-limit bodies without invoking delivery", async () => {
    const declared = await POST(request("{}", { "content-length": "2049" }), params);
    expect(declared.status).toBe(400);

    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(2049)); },
      cancel,
    });
    const chunked = new NextRequest(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as never);
    const streamed = await POST(chunked, params);
    expect(streamed.status).toBe(400);
    expect(cancel).toHaveBeenCalledOnce();
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("passes only the exact Pack event with the session actor", async () => {
    const response = await POST(request(JSON.stringify({ externalBuilderPackEventId: PACK_EVENT_ID })), params);
    expect(response.status).toBe(201);
    expect(mockRun).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      recordId: RECORD_ID,
      externalBuilderPackEventId: PACK_EVENT_ID,
      requestedBy: `user:${USER_ID}`,
    });
  });
});
