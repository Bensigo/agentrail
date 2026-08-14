import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  AcceptanceMcpTurnDispatchConflictError: class AcceptanceMcpTurnDispatchConflictError extends Error {},
  completeAcceptanceMcpTurnDispatch: vi.fn(),
  findEnabledJaceWorkspace: vi.fn(),
  holdAcceptanceMcpTurnDispatch: vi.fn(),
  readAcceptanceIntakeMcpReply: vi.fn(),
  readAcceptanceIntakeReadback: vi.fn(),
  readAcceptanceMcpTurnDispatch: vi.fn(),
  readAcceptanceRecordDetail: vi.fn(),
  reserveAcceptanceMcpTurnDispatch: vi.fn(),
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
  AcceptanceMcpTurnDispatchConflictError,
  completeAcceptanceMcpTurnDispatch,
  findEnabledJaceWorkspace,
  holdAcceptanceMcpTurnDispatch,
  readAcceptanceIntakeMcpReply,
  readAcceptanceIntakeReadback,
  readAcceptanceMcpTurnDispatch,
  readAcceptanceRecordDetail,
  reserveAcceptanceMcpTurnDispatch,
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
  vi.mocked(reserveAcceptanceMcpTurnDispatch).mockResolvedValue({
    kind: "claimed",
    dispatch: { status: "reserved" },
  } as never);
  vi.mocked(completeAcceptanceMcpTurnDispatch).mockResolvedValue({
    kind: "accepted",
    dispatch: { status: "accepted", sessionId: "session-1", continuationToken: "continuation-1" },
  } as never);
  vi.mocked(holdAcceptanceMcpTurnDispatch).mockResolvedValue({
    kind: "held",
    dispatch: { status: "held", resultReason: "hosted_inbound_unreachable" },
  } as never);
  vi.mocked(readAcceptanceMcpTurnDispatch).mockResolvedValue(null);
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

  it("reserves the canonical Intake turn before dispatch and persists Eve acceptance", async () => {
    const response = await POST(request({
      taskContextKey: "codex-task-7",
      messageKey: "turn-1",
      message: "Help me plan the smallest safe fix.",
    }));

    expect(reserveAcceptanceMcpTurnDispatch).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      credentialId: API_KEY_ID,
      taskContextKey: "codex-task-7",
      messageKey: "turn-1",
      conversationKey: `mcp:${API_KEY_ID}:codex-task-7`,
      sourceKey: `mcp-inbound:${API_KEY_ID}:codex-task-7:turn-1`,
      message: "Help me plan the smallest safe fix.",
    });
    expect(dispatchMcpJaceTurn).toHaveBeenCalledOnce();
    expect(completeAcceptanceMcpTurnDispatch).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      credentialId: API_KEY_ID,
      taskContextKey: "codex-task-7",
      messageKey: "turn-1",
      sessionId: "session-1",
      continuationToken: "continuation-1",
    });
    expect(holdAcceptanceMcpTurnDispatch).not.toHaveBeenCalled();
    expect(response.status).toBe(202);
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
    vi.mocked(reserveAcceptanceMcpTurnDispatch).mockResolvedValueOnce({
      kind: "replayed",
      dispatch: {
        status: "accepted",
        sessionId: "stored-session",
        continuationToken: "stored-continuation",
      },
    } as never);
    const response = await POST(request({
      taskContextKey: "codex-task-7",
      messageKey: "turn-2",
      message: "Use the existing Acceptance spine.",
    }));

    expect(response.status).toBe(200);
    expect(dispatchMcpJaceTurn).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      accepted: true,
      duplicate: true,
      session: { id: "stored-session", continuationToken: "stored-continuation" },
    });
  });

  it("reports a turn key/content collision without dispatching", async () => {
    vi.mocked(reserveAcceptanceMcpTurnDispatch).mockRejectedValueOnce(
      new AcceptanceMcpTurnDispatchConflictError(),
    );

    const response = await POST(request({
      taskContextKey: "codex-task-7",
      messageKey: "turn-collision",
      message: "Changed content under the same key.",
    }));

    expect(response.status).toBe(409);
    expect(dispatchMcpJaceTurn).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: "Jace turn key is already bound to different content",
    });
  });

  it("surfaces an in-flight reservation without dispatching the turn again", async () => {
    vi.mocked(reserveAcceptanceMcpTurnDispatch).mockResolvedValueOnce({
      kind: "replayed",
      dispatch: { status: "reserved" },
    } as never);

    const response = await POST(request({
      taskContextKey: "codex-task-7",
      messageKey: "turn-concurrent",
      message: "Keep this turn single-delivery.",
    }));

    expect(response.status).toBe(202);
    expect(dispatchMcpJaceTurn).not.toHaveBeenCalled();
    expect(completeAcceptanceMcpTurnDispatch).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      accepted: false,
      duplicate: true,
      dispatch: { status: "reserved" },
    });
  });

  it("persists an ambiguous Eve result as held and never reports acceptance", async () => {
    vi.mocked(dispatchMcpJaceTurn).mockResolvedValueOnce({
      ok: false,
      reason: "hosted_inbound_unreachable",
    });

    const response = await POST(request({
      taskContextKey: "codex-task-7",
      messageKey: "turn-held",
      message: "Do not redeliver an ambiguous turn.",
    }));

    expect(holdAcceptanceMcpTurnDispatch).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      credentialId: API_KEY_ID,
      taskContextKey: "codex-task-7",
      messageKey: "turn-held",
      reason: "hosted_inbound_unreachable",
    });
    expect(completeAcceptanceMcpTurnDispatch).not.toHaveBeenCalled();
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      accepted: false,
      dispatch: { status: "held" },
    });
  });

  it("holds the reservation when Eve dispatch throws ambiguously", async () => {
    vi.mocked(dispatchMcpJaceTurn).mockRejectedValueOnce(new Error("connection reset"));

    const response = await POST(request({
      taskContextKey: "codex-task-7",
      messageKey: "turn-thrown",
      message: "Treat a thrown delivery as ambiguous.",
    }));

    expect(holdAcceptanceMcpTurnDispatch).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      credentialId: API_KEY_ID,
      taskContextKey: "codex-task-7",
      messageKey: "turn-thrown",
      reason: "hosted_inbound_ambiguous_error",
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      accepted: false,
      dispatch: { status: "held" },
    });
  });

  it("holds the reservation when Eve acceptance cannot be durably completed", async () => {
    vi.mocked(completeAcceptanceMcpTurnDispatch).mockRejectedValueOnce(
      new Error("database completion unavailable"),
    );

    const response = await POST(request({
      taskContextKey: "codex-task-7",
      messageKey: "turn-result-held",
      message: "Keep result custody fail-closed.",
    }));

    expect(holdAcceptanceMcpTurnDispatch).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      credentialId: API_KEY_ID,
      taskContextKey: "codex-task-7",
      messageKey: "turn-result-held",
      reason: "result_custody_ambiguous",
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      accepted: false,
      dispatch: { status: "held" },
    });
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
    vi.mocked(readAcceptanceMcpTurnDispatch).mockResolvedValue({
      messageKey: "turn-1",
      status: "accepted",
      sessionId: "session-1",
      resultReason: null,
      reservedAt: new Date("2026-08-14T00:00:00.000Z"),
      completedAt: new Date("2026-08-14T00:00:01.000Z"),
    } as never);
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
    expect(readAcceptanceMcpTurnDispatch).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      credentialId: API_KEY_ID,
      taskContextKey: "codex-task-7",
      messageKey: "turn-1",
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
      dispatch: {
        messageKey: "turn-1",
        status: "accepted",
        sessionId: "session-1",
      },
      authority: { implementation: "not_granted", merge: "not_granted" },
    });
  });
});
