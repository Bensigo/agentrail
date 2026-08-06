import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({ appendAcceptanceOutboundReply: vi.fn() }));
import { appendAcceptanceOutboundReply } from "@agentrail/db-postgres";
import { POST } from "./route";

const secret = "test-secret";
const workspaceId = "00000000-0000-0000-0000-000000000001";
const intakeId = "00000000-0000-0000-0000-000000000002";
const params = Promise.resolve({ intakeId });
const request = (body: unknown, auth = true) => new NextRequest("http://localhost", {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${secret}` } : {}) },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JACE_CONSOLE_TOKEN = secret;
  vi.mocked(appendAcceptanceOutboundReply).mockResolvedValue({
    inserted: true,
    message: { id: "message-1", intakeId, sourceKey: "reply-1", direction: "outbound", text: "Which repo?", metadata: {}, createdAt: new Date() },
  } as never);
});

describe("Acceptance Intake outbound messages", () => {
  it("requires Jace auth and never calls the DB when absent", async () => {
    expect((await POST(request({ workspaceId, sourceKey: "reply-1", text: "Which repo?" }, false), { params })).status).toBe(401);
    expect(appendAcceptanceOutboundReply).not.toHaveBeenCalled();
  });

  it("appends an outbound message without any Record action", async () => {
    const response = await POST(request({ workspaceId, sourceKey: "reply-1", text: "Which repo?" }), { params });
    expect(response.status).toBe(201);
    expect(appendAcceptanceOutboundReply).toHaveBeenCalledWith({ workspaceId, intakeId, sourceKey: "reply-1", text: "Which repo?", metadata: {} });
    await expect(response.json()).resolves.toMatchObject({ inserted: true, message: { direction: "outbound" } });
  });

  it("rejects malformed text/source keys before the DB", async () => {
    expect((await POST(request({ workspaceId, sourceKey: " ", text: "reply" }), { params })).status).toBe(400);
    expect((await POST(request({ workspaceId, sourceKey: "reply-1", text: " " }), { params })).status).toBe(400);
    expect(appendAcceptanceOutboundReply).not.toHaveBeenCalled();
  });

  it("returns not-found when the workspace/intake pair does not match", async () => {
    vi.mocked(appendAcceptanceOutboundReply).mockResolvedValue(null);
    expect((await POST(request({ workspaceId, sourceKey: "reply-1", text: "Which repo?" }), { params })).status).toBe(404);
  });
});
