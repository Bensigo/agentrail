import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getJaceSessionByEveSessionId: vi.fn(),
  recordApprovalRequest: vi.fn(),
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
import { renderApprovalMessage } from "../../../../../lib/approval-message";
import {
  sendTelegramMessage,
  buildApprovalKeyboard,
} from "../../workspaces/[workspaceId]/connectors/secret/telegram";

const mockGetSession = vi.mocked(getJaceSessionByEveSessionId);
const mockRecord = vi.mocked(recordApprovalRequest);
const mockRender = vi.mocked(renderApprovalMessage);
const mockSend = vi.mocked(sendTelegramMessage);
const mockBuildKeyboard = vi.mocked(buildApprovalKeyboard);

const NOW = new Date("2026-07-18T00:00:00.000Z");
const ORIGINAL_TOKEN_ENV = process.env["TELEGRAM_BOT_TOKEN"];

// Central-secret auth (2026-07-20 fix): the route now authenticates via
// requireJaceConsoleSecret / JACE_CONSOLE_TOKEN instead of a per-workspace
// bearer api_key. Real helper, real env var, real header — same idiom as
// fleet/workspace-tokens/sync/route.test.ts uses for its own shared secret.
const ENV_KEY = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-shared-secret-abc123";
const ORIGINAL_ENV = process.env[ENV_KEY];

function req(body?: unknown, withAuth = true): NextRequest {
  return new NextRequest("http://localhost/api/v1/runner/approvals", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(withAuth ? { Authorization: `Bearer ${SECRET}` } : {}),
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
  process.env[ENV_KEY] = SECRET;
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
  if (ORIGINAL_ENV === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_ENV;
});

describe("POST /api/v1/runner/approvals — auth + body validation", () => {
  it("401 when no Authorization header is sent, and never touches session/record/send", async () => {
    const res = await POST(req(MOCK_BODY, false));

    expect(res.status).toBe(401);
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("401 when JACE_CONSOLE_TOKEN is unset (fail closed, never 'open') — even the objectively correct secret is rejected", async () => {
    delete process.env[ENV_KEY];

    const res = await POST(req(MOCK_BODY, true));

    expect(res.status).toBe(401);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("401 on a wrong secret", async () => {
    const request = new NextRequest("http://localhost/api/v1/runner/approvals", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer wrong-secret" },
      body: JSON.stringify(MOCK_BODY),
    });

    const res = await POST(request);

    expect(res.status).toBe(401);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("400 on invalid JSON body", async () => {
    const request = new NextRequest("http://localhost/api/v1/runner/approvals", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${SECRET}` },
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

  it("BEHAVIOR CHANGE (accepted, central-secret model — see route doc-comment): a resolved session workspaceId no longer needs to match anything — there is no bearer-own workspace left to cross-check against (JACE_CONSOLE_TOKEN is ONE shared secret for the whole deployment). Records successfully (201) where the old per-workspace-bearer model would have refused a mismatch (404).", async () => {
    mockGetSession.mockResolvedValue({
      ...MOCK_SESSION_WS,
      workspaceId: "ws-some-other-tenant",
    } as never);
    mockRecord.mockResolvedValue({
      approval: { ...MOCK_APPROVAL, workspaceId: "ws-some-other-tenant" },
      created: true,
    } as never);

    const res = await POST(req(MOCK_BODY));

    expect(res.status).toBe(201);
    const recordArgs = mockRecord.mock.calls[0]?.[0];
    expect(recordArgs).toMatchObject({ workspaceId: "ws-some-other-tenant" });
  });

  it("201 when the session is an intro (workspaceId null) session, regardless of which caller asks — the create_workspace cold-start flow", async () => {
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

  it("201 for the common case — a normal resolved-workspace session", async () => {
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
  it("passes eveSessionId/toolName/toolInput straight through for a tool #1274 PR ② does NOT enrich, vestigial literal approve/deny option ids, and requestId = the caller's idempotencyKey verbatim", async () => {
    // create_workspace (not create_issue): proves the "straight through" claim
    // for every OTHER tool. create_issue's own toolInput is now enriched with
    // a `_brief` before recording — see the dedicated "#1274 PR ② chat-born
    // enrichment" describe block below for that tool's specific contract.
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);
    const body = {
      ...MOCK_BODY,
      toolName: "create_workspace",
      toolInput: { name: "Acme Corp" },
    };

    await POST(req(body));

    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        eveSessionId: "eve-session-1",
        toolName: "create_workspace",
        toolInput: body.toolInput,
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

describe("POST /api/v1/runner/approvals — #1274 PR ② chat-born enrichment (create_issue only)", () => {
  it("enriches a create_issue toolInput with a _brief computed from its own title/whatToBuild/acceptanceCriteria", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);

    await POST(
      req({
        ...MOCK_BODY,
        toolInput: {
          title: "Add dark mode toggle",
          whatToBuild: "A settings toggle that persists across reload.",
          acceptanceCriteria: ["Toggle in settings", "Persists across reload"],
        },
      })
    );

    const recordArgs = mockRecord.mock.calls[0]?.[0];
    const brief = (recordArgs?.toolInput as Record<string, unknown>)?._brief as
      | Record<string, unknown>
      | undefined;
    expect(brief).toBeDefined();
    expect(typeof brief?.taskType).toBe("string");
    expect(typeof brief?.estimateUsd).toBe("number");
    expect((brief?.estimateUsd as number)).toBeGreaterThan(0);
    expect(brief?.suggestedModel).toMatchObject({ slug: expect.any(String), displayName: expect.any(String) });
    // Original create_issue fields survive untouched alongside _brief.
    expect(recordArgs?.toolInput).toMatchObject({
      title: "Add dark mode toggle",
      whatToBuild: "A settings toggle that persists across reload.",
      acceptanceCriteria: ["Toggle in settings", "Persists across reload"],
    });
  });

  it("INJECTION GUARD: a caller-supplied _brief is overwritten with the server-computed one, never passed through", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);

    await POST(
      req({
        ...MOCK_BODY,
        toolInput: {
          title: "Add dark mode toggle",
          whatToBuild: "A settings toggle that persists across reload.",
          acceptanceCriteria: ["Toggle in settings"],
          _brief: { evil: true, estimateUsd: 0, suggestedModel: { slug: "attacker/free-model" } },
        },
      })
    );

    const recordArgs = mockRecord.mock.calls[0]?.[0];
    const brief = (recordArgs?.toolInput as Record<string, unknown>)?._brief as
      | Record<string, unknown>
      | undefined;
    expect(brief).not.toHaveProperty("evil");
    expect(brief?.estimateUsd).not.toBe(0);
    expect((brief?.suggestedModel as Record<string, unknown>)?.slug).not.toBe(
      "attacker/free-model"
    );
  });

  it("INJECTION GUARD: an attacker-cheap _brief attempting to undercut the real estimate is discarded — the recorded estimate always matches the server's own computation for the SAME content", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);

    const honestToolInput = {
      title: "Add dark mode toggle",
      whatToBuild: "A settings toggle that persists across reload.",
      acceptanceCriteria: ["Toggle in settings"],
    };
    await POST(
      req({ ...MOCK_BODY, toolInput: honestToolInput })
    );
    const honestBrief = (mockRecord.mock.calls[0]?.[0]?.toolInput as Record<string, unknown>)
      ?._brief as Record<string, unknown>;

    mockRecord.mockClear();
    await POST(
      req({
        ...MOCK_BODY,
        idempotencyKey: "different-key-same-content",
        toolInput: {
          ...honestToolInput,
          _brief: { estimateUsd: 0.01, suggestedModel: { slug: "attacker/free-model", displayName: "Free" } },
        },
      })
    );
    const attackerAttemptBrief = (
      mockRecord.mock.calls[0]?.[0]?.toolInput as Record<string, unknown>
    )?._brief as Record<string, unknown>;

    expect(attackerAttemptBrief).toEqual(honestBrief);
  });

  it("does NOT enrich other tools' toolInput — passes through unchanged, no _brief added", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);

    await POST(
      req({
        eveSessionId: "eve-session-1",
        toolName: "create_workspace",
        toolInput: { name: "Acme Corp" },
        idempotencyKey: "k-workspace",
      })
    );

    const recordArgs = mockRecord.mock.calls[0]?.[0];
    expect(recordArgs?.toolInput).toEqual({ name: "Acme Corp" });
  });

  it("sends the ENRICHED toolInput to renderApprovalMessage, not the raw request body", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);

    await POST(
      req({
        ...MOCK_BODY,
        toolInput: { title: "x", whatToBuild: "y", acceptanceCriteria: ["ac1"] },
      })
    );

    const renderedInput = mockRender.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(renderedInput).toHaveProperty("_brief");
  });

  it("a malformed create_issue toolInput (missing whatToBuild, non-array acceptanceCriteria) never throws — degrades gracefully, still 201", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);

    const res = await POST(
      req({
        ...MOCK_BODY,
        toolInput: { title: "only a title", acceptanceCriteria: "not-an-array" },
      })
    );

    expect(res.status).toBe(201);
  });
});

describe("POST /api/v1/runner/approvals — rich Telegram send (best-effort)", () => {
  it("renders the message from toolName/toolInput and sends it with an Approve/Deny keyboard to the session's conversation", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);

    await POST(req(MOCK_BODY));

    // MOCK_BODY.toolName is create_issue, so the RENDERED toolInput is the
    // #1274 PR ② enriched one (carries an extra `_brief` on top of the
    // original fields) — objectContaining proves the original fields still
    // reach the renderer; the enrichment's own contract is covered by the
    // dedicated "#1274 PR ② chat-born enrichment" describe block above.
    expect(mockRender).toHaveBeenCalledWith(
      "create_issue",
      expect.objectContaining(MOCK_BODY.toolInput)
    );
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
