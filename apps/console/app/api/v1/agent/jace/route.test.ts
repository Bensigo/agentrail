import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  findEnabledJaceWorkspace: vi.fn(),
  readAcceptanceIntakeMessage: vi.fn(),
  readAcceptanceIntakeMcpReply: vi.fn(),
  readAcceptanceIntakeReadback: vi.fn(),
  readAcceptanceRecordDetail: vi.fn(),
}));
vi.mock("../../../../../lib/bearer-auth", () => ({ requireBearer: vi.fn() }));
vi.mock("../../../../../lib/agent-jace-mcp", () => ({
  MCP_TASK_CONTEXT_KEY_LIMIT: 256,
  MCP_MESSAGE_KEY_LIMIT: 256,
  MCP_MESSAGE_LIMIT: 8_000,
  dispatchMcpJaceTurn: vi.fn(),
  mcpConversationKey: (credentialId: string, taskContextKey: string) =>
    `mcp:${credentialId}:${taskContextKey}`,
  mcpIntakeId: vi.fn(() => "00000000-0000-4000-8000-000000000004"),
  mcpMessageSourceKey: (credentialId: string, taskContextKey: string, messageKey: string) =>
    `mcp-inbound:${credentialId}:${taskContextKey}:${messageKey}`,
}));

import {
  findEnabledJaceWorkspace,
  readAcceptanceIntakeMessage,
  readAcceptanceIntakeMcpReply,
  readAcceptanceIntakeReadback,
  readAcceptanceRecordDetail,
} from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";
import { dispatchMcpJaceTurn } from "../../../../../lib/agent-jace-mcp";
import { GET, POST } from "./route";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const API_KEY_ID = "00000000-0000-4000-8000-000000000002";

function request(body: unknown) {
  return new NextRequest("http://localhost/api/v1/agent/jace", {
    method: "POST",
    headers: {
      Authorization: "Bearer workspace-key",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function streamedRequest(bytes: number) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
  const init = {
    method: "POST",
    headers: { Authorization: "Bearer workspace-key", "Content-Type": "application/json" },
    body,
  };
  Object.assign(init, { duplex: "half" });
  return new NextRequest("http://localhost/api/v1/agent/jace", init);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireBearer).mockResolvedValue({
    apiKeyId: API_KEY_ID,
    workspaceId: WORKSPACE_ID,
    teamId: null,
    kind: "agent_mcp",
  });
  vi.mocked(findEnabledJaceWorkspace).mockResolvedValue(WORKSPACE_ID);
  vi.mocked(readAcceptanceIntakeMessage).mockResolvedValue(null);
  vi.mocked(dispatchMcpJaceTurn).mockResolvedValue({
    ok: true,
    sessionId: "session-1",
    continuationToken: "continuation-1",
  });
});

describe("direct Jace MCP turn", () => {
  it("rejects declared and streamed bodies beyond the machine byte budget", async () => {
    const declared = new NextRequest("http://localhost/api/v1/agent/jace", {
      method: "POST",
      headers: {
        Authorization: "Bearer workspace-key",
        "Content-Type": "application/json",
        "Content-Length": String(16 * 1024 + 1),
      },
      body: JSON.stringify({ taskContextKey: "task", messageKey: "turn", message: "small" }),
    });

    expect((await POST(declared)).status).toBe(400);
    expect((await POST(streamedRequest(16 * 1024 + 1))).status).toBe(400);
    expect(dispatchMcpJaceTurn).not.toHaveBeenCalled();
  });

  it("rejects runner/fleet credentials and workspaces without an enabled Jace connector", async () => {
    vi.mocked(requireBearer).mockResolvedValueOnce({
      apiKeyId: API_KEY_ID,
      workspaceId: WORKSPACE_ID,
      teamId: null,
      kind: "self_hosted",
    });
    expect((await POST(request({
      taskContextKey: "codex-task-7",
      messageKey: "turn-0",
      message: "Plan this.",
    }))).status).toBe(403);

    vi.mocked(requireBearer).mockResolvedValueOnce({
      apiKeyId: API_KEY_ID,
      workspaceId: WORKSPACE_ID,
      teamId: null,
      kind: "fleet",
    });
    expect((await POST(request({
      taskContextKey: "codex-task-7",
      messageKey: "turn-0",
      message: "Plan this.",
    }))).status).toBe(403);

    vi.mocked(findEnabledJaceWorkspace).mockResolvedValueOnce(null);
    expect((await POST(request({
      taskContextKey: "codex-task-7",
      messageKey: "turn-0",
      message: "Plan this.",
    }))).status).toBe(403);
    expect(dispatchMcpJaceTurn).not.toHaveBeenCalled();
  });

  it("opts into only the dedicated agent_mcp bearer kind", async () => {
    await POST(request({
      taskContextKey: "codex-task-7",
      messageKey: "turn-0",
      message: "Plan this.",
    }));

    expect(requireBearer).toHaveBeenCalledWith(expect.any(NextRequest), {
      allowedKinds: ["agent_mcp"],
    });
  });

  it("rejects a team-bound agent_mcp key until Record team authority is enforceable", async () => {
    vi.mocked(requireBearer).mockResolvedValueOnce({
      apiKeyId: API_KEY_ID,
      workspaceId: WORKSPACE_ID,
      teamId: "00000000-0000-4000-8000-000000000099",
      kind: "agent_mcp",
    });

    const response = await POST(request({
      taskContextKey: "codex-task-7",
      messageKey: "turn-team",
      message: "Plan this.",
    }));

    expect(response.status).toBe(403);
    expect(dispatchMcpJaceTurn).not.toHaveBeenCalled();
  });

  it("derives workspace and conversation authority from the bearer, not tool input", async () => {
    const response = await POST(request({
      taskContextKey: "codex-task-7",
      messageKey: "turn-1",
      message: "Help me plan the smallest safe fix.",
    }));

    expect(response.status).toBe(202);
    expect(dispatchMcpJaceTurn).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      credentialId: API_KEY_ID,
      taskContextKey: "codex-task-7",
      sourceKey: `mcp-inbound:${API_KEY_ID}:codex-task-7:turn-1`,
      message: "Help me plan the smallest safe fix.",
    });
    await expect(response.json()).resolves.toMatchObject({
      task: {
        taskContextKey: "codex-task-7",
        intakeId: "00000000-0000-4000-8000-000000000004",
      },
      accepted: true,
      authority: {
        humanConfirmation: "required_elsewhere",
        implementation: "not_granted",
        merge: "not_granted",
        deployment: "not_granted",
      },
    });
  });

  it("replays the same message key without invoking Jace twice", async () => {
    vi.mocked(readAcceptanceIntakeMessage).mockResolvedValue({
      direction: "inbound",
      text: "Use the existing Acceptance spine.",
    } as never);
    const response = await POST(request({
      taskContextKey: "codex-task-7",
      messageKey: "turn-2",
      message: "Use the existing Acceptance spine.",
    }));

    expect(response.status).toBe(200);
    expect(dispatchMcpJaceTurn).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ accepted: true, duplicate: true });
  });

  it("rejects caller-selected workspace or Record authority", async () => {
    const response = await POST(request({
      taskContextKey: "codex-task-7",
      messageKey: "turn-3",
      message: "Use this Record.",
      workspaceId: "foreign-workspace",
      recordId: "foreign-record",
    }));
    expect(response.status).toBe(400);
    expect(dispatchMcpJaceTurn).not.toHaveBeenCalled();
  });
});

describe("direct Jace MCP task state", () => {
  it("derives the linked Record and returns only bounded Contract and Pack status", async () => {
    vi.mocked(readAcceptanceIntakeReadback).mockResolvedValue({
      intake: {
        id: "00000000-0000-4000-8000-000000000004",
        status: "drafted",
        originChannel: "mcp",
        recordId: "00000000-0000-4000-8000-000000000005",
      },
      firstInbound: { text: "Plan the fix." },
      recentMessages: [{ direction: "outbound", text: "Which repo?" }],
      messageCounts: { total: 2, included: 2, truncated: false },
      contract: { id: "contract-1", version: 1, status: "confirmed" },
    } as never);
    vi.mocked(readAcceptanceRecordDetail).mockResolvedValue({
      kind: "record",
      detail: {
        summary: { recordId: "00000000-0000-4000-8000-000000000005", repo: "acme/web", unknownReasons: [] },
        contract: { identity: { id: "contract-1", version: 1, sha256: "a".repeat(64) } },
        pullRequest: { kind: "not_attached", occurrences: [] },
        contextPacks: [{
          occurrence: { kind: "current", repo: "acme/web", prNumber: 7, headSha: "b".repeat(40), headCycleId: "cycle-1" },
          sourceSnapshot: { id: "snapshot-1", status: "admitted", reason: null, binding: { recordId: "00000000-0000-4000-8000-000000000005" } },
          compiledPacks: [{ id: "pack-1", compilerVersion: "v1", policyVersion: "v1", packSha256: "c".repeat(64), binding: { recordId: "00000000-0000-4000-8000-000000000005" } }],
        }],
      },
    } as never);
    vi.mocked(readAcceptanceIntakeMcpReply).mockResolvedValue({
      id: "reply-1",
      text: "This is the reply to turn one.",
    } as never);

    const response = await GET(new NextRequest(
      "http://localhost/api/v1/agent/jace?taskContextKey=codex-task-7&messageKey=turn-1",
      { headers: { Authorization: "Bearer workspace-key" } },
    ));

    expect(response.status).toBe(200);
    expect(readAcceptanceRecordDetail).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      recordId: "00000000-0000-4000-8000-000000000005",
    });
    expect(readAcceptanceIntakeMcpReply).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      intakeId: "00000000-0000-4000-8000-000000000004",
      replyToSourceKey: `mcp-inbound:${API_KEY_ID}:codex-task-7:turn-1`,
    });
    await expect(response.json()).resolves.toMatchObject({
      task: { taskContextKey: "codex-task-7", messageKey: "turn-1" },
      reply: { status: "available", text: "This is the reply to turn one." },
      acceptance: {
        intake: { originChannel: "mcp", recordId: "00000000-0000-4000-8000-000000000005" },
        contract: { id: "contract-1", status: "confirmed" },
        record: {
          kind: "record",
          repo: "acme/web",
          contextPacks: [{ compiledPacks: [{ id: "pack-1" }] }],
        },
      },
      authority: { implementation: "not_granted", merge: "not_granted" },
    });
  });
});
