import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getJaceSessionByEveSessionId: vi.fn(),
  recordApprovalRequest: vi.fn(),
}));
vi.mock("../../../../../lib/bearer-auth", () => ({
  requireBearer: vi.fn(),
}));
vi.mock("../../../../../lib/approval-message", () => ({
  renderApprovalMessage: vi.fn(),
}));
vi.mock("../../workspaces/[workspaceId]/connectors/secret/telegram", () => ({
  sendTelegramMessage: vi.fn(),
  buildApprovalKeyboard: vi.fn(),
}));

import { POST } from "./route";
import {
  getJaceSessionByEveSessionId,
  recordApprovalRequest,
} from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";
import { renderApprovalMessage } from "../../../../../lib/approval-message";
import {
  sendTelegramMessage,
  buildApprovalKeyboard,
} from "../../workspaces/[workspaceId]/connectors/secret/telegram";

const mockGetSession = vi.mocked(getJaceSessionByEveSessionId);
const mockRecord = vi.mocked(recordApprovalRequest);
const mockRequireBearer = vi.mocked(requireBearer);
const mockRender = vi.mocked(renderApprovalMessage);
const mockSend = vi.mocked(sendTelegramMessage);
const mockBuildKeyboard = vi.mocked(buildApprovalKeyboard);

const NOW = new Date("2026-07-18T00:00:00.000Z");
const ORIGINAL_TOKEN_ENV = process.env["TELEGRAM_BOT_TOKEN"];

function req(body?: unknown, withAuth = true): NextRequest {
  return new NextRequest("http://localhost/api/v1/runner/approvals", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(withAuth ? { Authorization: "Bearer ar_test" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const MOCK_BODY = {
  eveSessionId: "eve-session-1",
  toolName: "create_issue",
  toolInput: { title: "Add dark mode", acceptanceCriteria: ["Toggle in settings"] },
  idempotencyKey: "eve-session-1:turn-1:create_issue:abc123",
};

const MOCK_SESSION_WS = {
  id: "session-1",
  workspaceId: "ws-1",
  chatIdentityId: "chat-identity-1",
  channel: "telegram",
  conversationKey: "-100123",
  eveSessionId: "eve-session-1",
  status: "active",
  lastActivityAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
};

const MOCK_SESSION_INTRO = {
  ...MOCK_SESSION_WS,
  id: "session-intro-1",
  workspaceId: null,
};

const MOCK_APPROVAL = {
  id: "approval-1",
  workspaceId: "ws-1",
  chatIdentityId: "chat-identity-1",
  sessionId: "session-1",
  eveSessionId: "eve-session-1",
  requestId: MOCK_BODY.idempotencyKey,
  callbackToken: "cbtoken123456",
  toolName: "create_issue",
  toolInput: MOCK_BODY.toolInput,
  approveOptionId: "approve",
  denyOptionId: "deny",
  status: "pending",
  publishedIssueUrl: null,
  createdAt: NOW,
  resolvedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env["TELEGRAM_BOT_TOKEN"] = "test-bot-token";
  mockRequireBearer.mockResolvedValue({
    apiKeyId: "key-1",
    workspaceId: "ws-1",
    teamId: null,
  } as never);
  mockRender.mockReturnValue("rendered approval text");
  mockBuildKeyboard.mockReturnValue({ inline_keyboard: [[]] } as never);
  mockSend.mockResolvedValue({ ok: true } as never);
});

afterEach(() => {
  if (ORIGINAL_TOKEN_ENV === undefined) {
    delete process.env["TELEGRAM_BOT_TOKEN"];
  } else {
    process.env["TELEGRAM_BOT_TOKEN"] = ORIGINAL_TOKEN_ENV;
  }
});

describe("POST /api/v1/runner/approvals — auth + body validation", () => {
  it("401 when requireBearer rejects, and never touches session/record/send", async () => {
    const { NextResponse } = await import("next/server");
    mockRequireBearer.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }) as never
    );

    const res = await POST(req(MOCK_BODY, false));

    expect(res.status).toBe(401);
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("400 on invalid JSON body", async () => {
    const request = new NextRequest("http://localhost/api/v1/runner/approvals", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer ar_test" },
      body: "{not valid json",
    });
    const res = await POST(request);
    expect(res.status).toBe(400);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("400 when eveSessionId is missing", async () => {
    const res = await POST(
      req({ toolName: "create_issue", toolInput: {}, idempotencyKey: "k" })
    );
    expect(res.status).toBe(400);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("400 when toolName is missing", async () => {
    const res = await POST(
      req({ eveSessionId: "eve-session-1", toolInput: {}, idempotencyKey: "k" })
    );
    expect(res.status).toBe(400);
  });

  it("400 when toolInput is missing", async () => {
    const res = await POST(
      req({ eveSessionId: "eve-session-1", toolName: "create_issue", idempotencyKey: "k" })
    );
    expect(res.status).toBe(400);
  });

  it("400 when toolInput is not a plain object (e.g. an array)", async () => {
    const res = await POST(
      req({
        eveSessionId: "eve-session-1",
        toolName: "create_issue",
        toolInput: [],
        idempotencyKey: "k",
      })
    );
    expect(res.status).toBe(400);
  });

  it("400 when idempotencyKey is missing — it is REQUIRED, not optional", async () => {
    const res = await POST(
      req({ eveSessionId: "eve-session-1", toolName: "create_issue", toolInput: {} })
    );
    expect(res.status).toBe(400);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("400 when idempotencyKey is an empty string", async () => {
    const res = await POST(req({ ...MOCK_BODY, idempotencyKey: "" }));
    expect(res.status).toBe(400);
    expect(mockGetSession).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/runner/approvals — session resolution + tenant scoping", () => {
  it("404 when no jace_sessions row is bound to this eveSessionId", async () => {
    mockGetSession.mockResolvedValue(null);

    const res = await POST(req(MOCK_BODY));

    expect(res.status).toBe(404);
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("404 when the session has neither workspaceId nor chatIdentityId (defensive, unreachable in practice)", async () => {
    mockGetSession.mockResolvedValue({
      ...MOCK_SESSION_INTRO,
      chatIdentityId: null,
    } as never);

    const res = await POST(req(MOCK_BODY));
    const text = await res.text();

    expect(res.status).toBe(404);
    expect(mockRecord).not.toHaveBeenCalled();

    mockGetSession.mockResolvedValue(null);
    const unknownRes = await POST(req(MOCK_BODY));
    expect(await unknownRes.text()).toBe(text);
  });

  it("404 when the session's workspaceId differs from the bearer's own — cross-tenant refusal, byte-identical to the unknown-session 404", async () => {
    mockGetSession.mockResolvedValue({
      ...MOCK_SESSION_WS,
      workspaceId: "ws-other-tenant",
    } as never);

    const res = await POST(req(MOCK_BODY));
    const text = await res.text();

    expect(res.status).toBe(404);
    expect(mockRecord).not.toHaveBeenCalled();

    mockGetSession.mockResolvedValue(null);
    const unknownRes = await POST(req(MOCK_BODY));
    expect(await unknownRes.text()).toBe(text);
  });

  it("201 when the session is an intro (workspaceId null) session, regardless of which bearer asks — the create_workspace cold-start flow", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_INTRO as never);
    mockRecord.mockResolvedValue({
      approval: {
        ...MOCK_APPROVAL,
        workspaceId: null,
        sessionId: MOCK_SESSION_INTRO.id,
      },
      created: true,
    } as never);

    const res = await POST(req(MOCK_BODY));

    expect(res.status).toBe(201);
    const recordArgs = mockRecord.mock.calls[0]?.[0];
    expect(recordArgs).toMatchObject({
      chatIdentityId: "chat-identity-1",
      sessionId: "session-intro-1",
    });
    expect(recordArgs?.workspaceId).toBeUndefined();
  });

  it("201 when the session's workspaceId matches the bearer's own workspace", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);

    const res = await POST(req(MOCK_BODY));

    expect(res.status).toBe(201);
    const recordArgs = mockRecord.mock.calls[0]?.[0];
    expect(recordArgs).toMatchObject({
      workspaceId: "ws-1",
      chatIdentityId: "chat-identity-1",
      sessionId: "session-1",
    });
  });
});

describe("POST /api/v1/runner/approvals — recordApprovalRequest arguments + response shape", () => {
  it("passes eveSessionId/toolName/toolInput straight through, vestigial literal approve/deny option ids, and requestId = the caller's idempotencyKey verbatim", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);

    await POST(req(MOCK_BODY));

    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        eveSessionId: "eve-session-1",
        toolName: "create_issue",
        toolInput: MOCK_BODY.toolInput,
        approveOptionId: "approve",
        denyOptionId: "deny",
        requestId: MOCK_BODY.idempotencyKey,
      })
    );
  });

  it("derives requestId from idempotencyKey alone — two different keys produce two different requestIds, same key produces the same requestId", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);

    await POST(req({ ...MOCK_BODY, idempotencyKey: "key-a" }));
    await POST(req({ ...MOCK_BODY, idempotencyKey: "key-b" }));
    await POST(req({ ...MOCK_BODY, idempotencyKey: "key-a" }));

    const requestIds = mockRecord.mock.calls.map((c) => c[0]?.requestId);
    expect(requestIds).toEqual(["key-a", "key-b", "key-a"]);
  });

  it("responds 201 { approvalId, status: 'pending' } — exactly those two fields — on a fresh (created: true) record", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);

    const res = await POST(req(MOCK_BODY));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body).toEqual({ approvalId: "approval-1", status: "pending" });
  });
});

describe("POST /api/v1/runner/approvals — idempotent replay (created: false, issue #1273 PR ②)", () => {
  it("responds 200 with the EXISTING approval's { approvalId, status } — no second row, no second send", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    const existing = { ...MOCK_APPROVAL, id: "approval-existing", status: "pending" };
    mockRecord.mockResolvedValue({ approval: existing, created: false } as never);

    const res = await POST(req(MOCK_BODY));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ approvalId: "approval-existing", status: "pending" });
    expect(mockRender).not.toHaveBeenCalled();
    expect(mockBuildKeyboard).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("reflects the EXISTING approval's actual (already-terminal) status on replay, not a hardcoded 'pending'", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    const existing = { ...MOCK_APPROVAL, id: "approval-existing", status: "approved" };
    mockRecord.mockResolvedValue({ approval: existing, created: false } as never);

    const res = await POST(req(MOCK_BODY));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ approvalId: "approval-existing", status: "approved" });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("still calls recordApprovalRequest with the same derived requestId on replay (the DB layer is what detects the conflict, not this route)", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: false } as never);

    await POST(req(MOCK_BODY));

    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: MOCK_BODY.idempotencyKey })
    );
  });
});

describe("POST /api/v1/runner/approvals — rich Telegram send (best-effort)", () => {
  it("renders the message from toolName/toolInput and sends it with an Approve/Deny keyboard to the session's conversation", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);

    await POST(req(MOCK_BODY));

    expect(mockRender).toHaveBeenCalledWith("create_issue", MOCK_BODY.toolInput);
    expect(mockBuildKeyboard).toHaveBeenCalledWith("cbtoken123456");
    expect(mockSend).toHaveBeenCalledWith(
      "test-bot-token",
      "-100123",
      "rendered approval text",
      { inline_keyboard: [[]] }
    );
  });

  it("still responds 201 when the Telegram send fails (best-effort, never blocks the record)", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);
    mockSend.mockResolvedValue({ ok: false, error: "boom" } as never);

    const res = await POST(req(MOCK_BODY));

    expect(res.status).toBe(201);
  });

  it("still responds 201 when the Telegram send throws unexpectedly", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);
    mockSend.mockRejectedValue(new Error("network down"));

    const res = await POST(req(MOCK_BODY));

    expect(res.status).toBe(201);
  });

  it("skips the send (no throw, still 201) when TELEGRAM_BOT_TOKEN is unset", async () => {
    delete process.env["TELEGRAM_BOT_TOKEN"];
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);

    const res = await POST(req(MOCK_BODY));

    expect(res.status).toBe(201);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("skips the send (no throw, still 201) for a non-telegram channel", async () => {
    mockGetSession.mockResolvedValue({
      ...MOCK_SESSION_WS,
      channel: "slack",
    } as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);

    const res = await POST(req(MOCK_BODY));

    expect(res.status).toBe(201);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
