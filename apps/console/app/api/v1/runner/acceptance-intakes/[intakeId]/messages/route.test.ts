import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({ appendAcceptanceOutboundReply: vi.fn() }));
import { appendAcceptanceOutboundReply } from "@agentrail/db-postgres";
import { POST } from "./route";

const secret = "jace-secret";
const intakeId = "00000000-0000-4000-8000-000000000001";
const workspaceId = "00000000-0000-4000-8000-000000000002";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JACE_CONSOLE_TOKEN = secret;
  vi.mocked(appendAcceptanceOutboundReply).mockResolvedValue({
    inserted: true,
    message: { id: "message-1", sourceKey: "reply-1", direction: "outbound" },
  } as never);
});

describe("MCP Acceptance Intake reply custody", () => {
  it("requires Jace auth and records only an outbound Intake message", async () => {
    const request = new NextRequest("http://localhost", {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId,
        sourceKey: "reply-1",
        text: "Which repository should this plan target?",
        metadata: { channel: "mcp" },
      }),
    });
    const response = await POST(request, { params: Promise.resolve({ intakeId }) });
    expect(response.status).toBe(201);
    expect(appendAcceptanceOutboundReply).toHaveBeenCalledWith({
      workspaceId,
      intakeId,
      sourceKey: "reply-1",
      text: "Which repository should this plan target?",
      metadata: { channel: "mcp" },
    });
  });
});
