import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  resolveInboundChatIdentity: vi.fn(),
  enqueueChannelMessage: vi.fn(),
  getApprovalByCallbackToken: vi.fn(),
  getChatIdentityById: vi.fn(),
  getJaceSessionById: vi.fn(),
  resolveApproval: vi.fn(),
}));

vi.mock("../../../../../../lib/channel-dispatch", () => ({
  dispatchQueuedChannelMessages: vi.fn(),
}));

vi.mock("../../../../../../lib/approval-message", () => ({
  renderApprovalMessage: vi.fn(),
}));

vi.mock("../../../workspaces/[workspaceId]/connectors/secret/telegram", () => ({
  answerCallbackQuery: vi.fn(),
  editMessageText: vi.fn(),
  parseApprovalCallbackData: vi.fn(),
  APPROVAL_CALLBACK_PREFIX: "ar:",
}));

import { POST } from "./route";
import {
  resolveInboundChatIdentity,
  enqueueChannelMessage,
  getApprovalByCallbackToken,
  getChatIdentityById,
  getJaceSessionById,
  resolveApproval,
} from "@agentrail/db-postgres";
import { dispatchQueuedChannelMessages } from "../../../../../../lib/channel-dispatch";
import { renderApprovalMessage } from "../../../../../../lib/approval-message";
import {
  answerCallbackQuery,
  editMessageText,
  parseApprovalCallbackData,
} from "../../../workspaces/[workspaceId]/connectors/secret/telegram";

const mockResolve = vi.mocked(resolveInboundChatIdentity);
const mockEnqueue = vi.mocked(enqueueChannelMessage);
const mockDispatch = vi.mocked(dispatchQueuedChannelMessages);
const mockGetApproval = vi.mocked(getApprovalByCallbackToken);
const mockGetChatIdentity = vi.mocked(getChatIdentityById);
const mockGetJaceSessionById = vi.mocked(getJaceSessionById);
const mockResolveApproval = vi.mocked(resolveApproval);
const mockRender = vi.mocked(renderApprovalMessage);
const mockAnswer = vi.mocked(answerCallbackQuery);
const mockEdit = vi.mocked(editMessageText);
const mockParse = vi.mocked(parseApprovalCallbackData);
// Every test gets a non-throwing default so route.ts's `.catch(...)` on the
// kick has a real Promise to attach to; clearAllMocks (below) resets call
// counts/args between tests but not this persistent implementation.
mockDispatch.mockResolvedValue({ processed: 0, failed: 0 });

const HEADER = "x-telegram-bot-api-secret-token";
const SECRET = "shared-bot-secret-abc123";
const ORIGINAL_SECRET_ENV = process.env["TELEGRAM_WEBHOOK_SECRET_TOKEN"];
const ORIGINAL_TOKEN_ENV = process.env["TELEGRAM_BOT_TOKEN"];
const ORIGINAL_EVE_HOST_ENV = process.env["EVE_HOST"];

function req(
  body: unknown,
  opts: { header?: string; raw?: string } = {}
): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.header !== undefined) headers[HEADER] = opts.header;
  return new NextRequest("http://localhost/api/v1/connectors/telegram/webhook", {
    method: "POST",
    headers,
    body: opts.raw ?? JSON.stringify(body),
  });
}

const MESSAGE_UPDATE = {
  update_id: 1,
  message: {
    message_id: 42,
    date: 1752800000,
    chat: { id: -100123, type: "private" },
    from: { id: 555, username: "ada", first_name: "Ada" },
    text: "hello jace",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  // Sane non-throwing defaults for the ar: flow's helpers — individual tests
  // override where the scenario needs a different value.
  mockAnswer.mockResolvedValue({ ok: true } as never);
  mockEdit.mockResolvedValue({ ok: true } as never);
  mockRender.mockReturnValue("rendered approval text");
});

afterEach(() => {
  if (ORIGINAL_SECRET_ENV === undefined) {
    delete process.env["TELEGRAM_WEBHOOK_SECRET_TOKEN"];
  } else {
    process.env["TELEGRAM_WEBHOOK_SECRET_TOKEN"] = ORIGINAL_SECRET_ENV;
  }
  if (ORIGINAL_TOKEN_ENV === undefined) {
    delete process.env["TELEGRAM_BOT_TOKEN"];
  } else {
    process.env["TELEGRAM_BOT_TOKEN"] = ORIGINAL_TOKEN_ENV;
  }
  if (ORIGINAL_EVE_HOST_ENV === undefined) {
    delete process.env["EVE_HOST"];
  } else {
    process.env["EVE_HOST"] = ORIGINAL_EVE_HOST_ENV;
  }
  vi.unstubAllGlobals();
});

describe("POST /api/v1/connectors/telegram/webhook — verify (fail closed)", () => {
  it("401s when TELEGRAM_WEBHOOK_SECRET_TOKEN is unset, even with a header present", async () => {
    delete process.env["TELEGRAM_WEBHOOK_SECRET_TOKEN"];

    const res = await POST(req(MESSAGE_UPDATE, { header: "whatever" }));

    expect(res.status).toBe(401);
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("401s when the header is missing entirely", async () => {
    process.env["TELEGRAM_WEBHOOK_SECRET_TOKEN"] = SECRET;

    const res = await POST(req(MESSAGE_UPDATE));

    expect(res.status).toBe(401);
  });

  it("401s on a wrong secret of the SAME LENGTH — exercises timingSafeEqual itself, not just a length check", async () => {
    process.env["TELEGRAM_WEBHOOK_SECRET_TOKEN"] = SECRET;
    const nearMiss = SECRET.slice(0, -1) + (SECRET.endsWith("3") ? "4" : "3");
    expect(nearMiss).toHaveLength(SECRET.length);
    expect(nearMiss).not.toBe(SECRET);

    const res = await POST(req(MESSAGE_UPDATE, { header: nearMiss }));

    expect(res.status).toBe(401);
  });

  it("401s on a wrong secret of a DIFFERENT length (must not throw from timingSafeEqual)", async () => {
    process.env["TELEGRAM_WEBHOOK_SECRET_TOKEN"] = SECRET;

    const res = await POST(req(MESSAGE_UPDATE, { header: "short" }));

    expect(res.status).toBe(401);
  });

  it("never reads the body when verification fails (an unparsable raw body does not surface as 400)", async () => {
    delete process.env["TELEGRAM_WEBHOOK_SECRET_TOKEN"];

    const res = await POST(req(undefined, { header: "x", raw: "{not json" }));

    expect(res.status).toBe(401);
  });
});

describe("POST /api/v1/connectors/telegram/webhook — parse", () => {
  beforeEach(() => {
    process.env["TELEGRAM_WEBHOOK_SECRET_TOKEN"] = SECRET;
  });

  it("400s on malformed JSON (after auth passes)", async () => {
    const res = await POST(req(undefined, { header: SECRET, raw: "{not json" }));

    expect(res.status).toBe(400);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("400s on a non-object JSON body (e.g. a bare number)", async () => {
    const res = await POST(req(undefined, { header: SECRET, raw: "42" }));

    expect(res.status).toBe(400);
  });

  it("400s on a JSON array body", async () => {
    const res = await POST(req(undefined, { header: SECRET, raw: "[1,2,3]" }));

    expect(res.status).toBe(400);
  });

  it("a non-ar callback_query is forwarded to Eve (issue #1273), not silently ignored", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    mockParse.mockReturnValue(null);

    const res = await POST(
      req(
        { update_id: 2, callback_query: { id: "cb1", from: { id: 999 }, data: "eve:something" } },
        { header: SECRET }
      )
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("ignores a callback_query so malformed it carries no 'from' at all — defensive fallback, never crashes", async () => {
    const res = await POST(
      req({ update_id: 2, callback_query: { id: "cb1" } }, { header: SECRET })
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("ignores a my_chat_member update with 200 { ok: true, ignored: true }", async () => {
    const res = await POST(
      req({ update_id: 3, my_chat_member: {} }, { header: SECRET })
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
  });

  it("ignores a message carrying neither text nor caption (e.g. a bare photo) with 200 ignored", async () => {
    const res = await POST(
      req(
        {
          message: {
            message_id: 1,
            date: 1,
            chat: { id: 1, type: "private" },
            from: { id: 1, first_name: "A" },
          },
        },
        { header: SECRET }
      )
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("400s when message is present but missing chat/from (malformed — would otherwise crash downstream)", async () => {
    const res = await POST(
      req({ message: { message_id: 1, text: "hi" } }, { header: SECRET })
    );

    expect(res.status).toBe(400);
    expect(mockResolve).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/connectors/telegram/webhook — identity + enqueue arguments", () => {
  beforeEach(() => {
    process.env["TELEGRAM_WEBHOOK_SECRET_TOKEN"] = SECRET;
  });

  it("resolves identity and enqueues, anchoring on chatIdentityId for an unbound (intro) sender", async () => {
    mockResolve.mockResolvedValue({
      identity: { id: "chat-identity-1", workspaceId: null } as never,
      created: true,
      disposition: "intro",
    });
    mockEnqueue.mockResolvedValue({ id: "row-1", deduped: false });

    const res = await POST(req(MESSAGE_UPDATE, { header: SECRET }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(mockResolve).toHaveBeenCalledWith({
      platform: "telegram",
      platformUserId: "555",
      displayName: "ada",
    });

    expect(mockEnqueue).toHaveBeenCalledWith({
      chatIdentityId: "chat-identity-1",
      channel: "telegram",
      conversationKey: "-100123",
      kind: "message",
      senderId: "555",
      senderDisplay: "ada",
      providerMessageId: "-100123:42",
      payload: {
        chatId: -100123,
        chatType: "private",
        fromId: 555,
        fromUsername: "ada",
        text: "hello jace",
        messageId: 42,
        date: 1752800000,
      },
    });
  });

  it("anchors on workspaceId (not chatIdentityId) for a bound identity", async () => {
    mockResolve.mockResolvedValue({
      identity: { id: "chat-identity-2", workspaceId: "ws-1" } as never,
      created: false,
      disposition: "bound",
    });
    mockEnqueue.mockResolvedValue({ id: "row-2", deduped: false });

    const res = await POST(req(MESSAGE_UPDATE, { header: SECRET }));

    expect(res.status).toBe(200);
    const enqueueArgs = mockEnqueue.mock.calls[0]?.[0];
    expect(enqueueArgs).toMatchObject({ workspaceId: "ws-1" });
    expect(enqueueArgs).not.toHaveProperty("chatIdentityId");
  });

  it("falls back to '[first_name] [last_name]' trimmed for displayName when username is absent", async () => {
    mockResolve.mockResolvedValue({
      identity: { id: "chat-identity-3", workspaceId: null } as never,
      created: true,
      disposition: "intro",
    });
    mockEnqueue.mockResolvedValue({ id: "row-3", deduped: false });

    await POST(
      req(
        {
          message: {
            message_id: 7,
            date: 2,
            chat: { id: 9, type: "private" },
            from: { id: 9, first_name: "Grace", last_name: "Hopper" },
            text: "hi",
          },
        },
        { header: SECRET }
      )
    );

    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "Grace Hopper" })
    );
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ senderDisplay: "Grace Hopper" })
    );
  });

  it("uses text ?? caption for a captioned-photo message", async () => {
    mockResolve.mockResolvedValue({
      identity: { id: "chat-identity-1", workspaceId: null } as never,
      created: false,
      disposition: "intro",
    });
    mockEnqueue.mockResolvedValue({ id: "row-4", deduped: false });

    await POST(
      req(
        {
          message: {
            message_id: 8,
            date: 3,
            chat: { id: 9, type: "private" },
            from: { id: 9, username: "ada" },
            caption: "a caption",
          },
        },
        { header: SECRET }
      )
    );

    const enqueueArgs = mockEnqueue.mock.calls[0]?.[0];
    expect(enqueueArgs.payload).toMatchObject({ text: "a caption" });
  });

  it("returns { ok: true, deduped: true } on a redelivered provider_message_id, without erroring", async () => {
    mockResolve.mockResolvedValue({
      identity: { id: "chat-identity-1", workspaceId: null } as never,
      created: false,
      disposition: "intro",
    });
    mockEnqueue.mockResolvedValue({ id: null, deduped: true });

    const res = await POST(req(MESSAGE_UPDATE, { header: SECRET }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deduped: true });
  });

  it("processes edited_message the same as message", async () => {
    mockResolve.mockResolvedValue({
      identity: { id: "chat-identity-1", workspaceId: null } as never,
      created: false,
      disposition: "intro",
    });
    mockEnqueue.mockResolvedValue({ id: "row-5", deduped: false });

    const res = await POST(
      req(
        {
          edited_message: {
            message_id: 42,
            date: 1752800001,
            chat: { id: -100123, type: "private" },
            from: { id: 555, username: "ada" },
            text: "hello jace (edited)",
          },
        },
        { header: SECRET }
      )
    );

    expect(res.status).toBe(200);
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        providerMessageId: "-100123:42",
        payload: expect.objectContaining({ text: "hello jace (edited)" }),
      })
    );
  });
});

describe("POST /api/v1/connectors/telegram/webhook — dispatcher kick", () => {
  beforeEach(() => {
    process.env["TELEGRAM_WEBHOOK_SECRET_TOKEN"] = SECRET;
  });

  it("kicks the dispatcher after a fresh enqueue (the happy path)", async () => {
    mockResolve.mockResolvedValue({
      identity: { id: "chat-identity-1", workspaceId: null } as never,
      created: true,
      disposition: "intro",
    });
    mockEnqueue.mockResolvedValue({ id: "row-1", deduped: false });

    const res = await POST(req(MESSAGE_UPDATE, { header: SECRET }));

    expect(res.status).toBe(200);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it("still kicks the dispatcher on a deduped (redelivered) enqueue", async () => {
    mockResolve.mockResolvedValue({
      identity: { id: "chat-identity-1", workspaceId: null } as never,
      created: false,
      disposition: "intro",
    });
    mockEnqueue.mockResolvedValue({ id: null, deduped: true });

    const res = await POST(req(MESSAGE_UPDATE, { header: SECRET }));

    expect(res.status).toBe(200);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it("does NOT kick when verification fails (nothing was enqueued)", async () => {
    delete process.env["TELEGRAM_WEBHOOK_SECRET_TOKEN"];

    const res = await POST(req(MESSAGE_UPDATE, { header: "whatever" }));

    expect(res.status).toBe(401);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("does NOT kick when the update is ignored (a callback_query so malformed it has no 'from' — nothing was enqueued)", async () => {
    const res = await POST(
      req({ update_id: 2, callback_query: { id: "cb1" } }, { header: SECRET })
    );

    expect(res.status).toBe(200);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("does NOT kick for a callback_query at all (issue #1273 — handled/forwarded, never touches channel_inbox)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    );
    mockParse.mockReturnValue(null);

    const res = await POST(
      req(
        { update_id: 2, callback_query: { id: "cb1", from: { id: 999 }, data: "eve:something" } },
        { header: SECRET }
      )
    );

    expect(res.status).toBe(200);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("never lets a dispatcher rejection surface into the route's response (fire-and-forget)", async () => {
    mockResolve.mockResolvedValue({
      identity: { id: "chat-identity-1", workspaceId: null } as never,
      created: true,
      disposition: "intro",
    });
    mockEnqueue.mockResolvedValue({ id: "row-1", deduped: false });
    mockDispatch.mockRejectedValueOnce(new Error("drain blew up"));

    const res = await POST(req(MESSAGE_UPDATE, { header: SECRET }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

// --- issue #1273: ar: flow (record -> callback -> flip -> answer + edit) ---

/** Build a realistic callback_query update for the ar: flow. */
function arCallbackUpdate(opts: {
  data?: string;
  fromId?: number;
  firstName?: string;
  username?: string;
  withMessage?: boolean;
  chatType?: string;
} = {}): Record<string, unknown> {
  const from: Record<string, unknown> = { id: opts.fromId ?? 555 };
  if (opts.firstName !== undefined) from["first_name"] = opts.firstName;
  if (opts.username !== undefined) from["username"] = opts.username;

  const callbackQuery: Record<string, unknown> = {
    id: "cbq-1",
    from,
    data: opts.data ?? "ar:ytoken123456",
  };
  if (opts.withMessage !== false) {
    const chat: Record<string, unknown> = { id: -100123 };
    if (opts.chatType !== undefined) chat["type"] = opts.chatType;
    callbackQuery["message"] = { chat, message_id: 42 };
  }
  return { update_id: 99, callback_query: callbackQuery };
}

const MOCK_APPROVAL_ROW = {
  id: "approval-1",
  workspaceId: "ws-1",
  chatIdentityId: "chat-identity-1",
  sessionId: "session-1",
  eveSessionId: "eve-session-1",
  requestId: "req-1",
  callbackToken: "token123456",
  toolName: "create_issue",
  toolInput: { title: "Add dark mode" },
  approveOptionId: "approve",
  denyOptionId: "deny",
  status: "pending",
  publishedIssueUrl: null,
  createdAt: new Date("2026-07-18T00:00:00Z"),
  resolvedAt: null,
};

const MOCK_IDENTITY_ROW = {
  id: "chat-identity-1",
  platform: "telegram",
  platformUserId: "555",
  displayName: "Ada",
  userId: null,
  workspaceId: "ws-1",
  linkToken: null,
  linkTokenExpiresAt: null,
  createdAt: new Date("2026-07-18T00:00:00Z"),
  updatedAt: new Date("2026-07-18T00:00:00Z"),
};

describe("POST /api/v1/connectors/telegram/webhook — ar: flow (issue #1273)", () => {
  beforeEach(() => {
    process.env["TELEGRAM_WEBHOOK_SECRET_TOKEN"] = SECRET;
    process.env["TELEGRAM_BOT_TOKEN"] = "test-bot-token";
  });

  it("answers 'invalid' and never looks up an approval when parseApprovalCallbackData rejects the payload", async () => {
    mockParse.mockReturnValue(null);

    const res = await POST(req(arCallbackUpdate(), { header: SECRET }));

    expect(res.status).toBe(200);
    expect(mockGetApproval).not.toHaveBeenCalled();
    expect(mockAnswer).toHaveBeenCalledWith(
      "test-bot-token",
      "cbq-1",
      expect.stringMatching(/invalid/i)
    );
    expect(mockResolveApproval).not.toHaveBeenCalled();
  });

  it("answers 'not found' and never flips when the callback token matches no approval", async () => {
    mockParse.mockReturnValue({ decision: "approved", callbackToken: "token123456" });
    mockGetApproval.mockResolvedValue(null);

    const res = await POST(req(arCallbackUpdate(), { header: SECRET }));

    expect(res.status).toBe(200);
    expect(mockGetApproval).toHaveBeenCalledWith("token123456");
    expect(mockAnswer).toHaveBeenCalledWith(
      "test-bot-token",
      "cbq-1",
      expect.stringMatching(/not.*found/i)
    );
    expect(mockResolveApproval).not.toHaveBeenCalled();
    expect(mockEdit).not.toHaveBeenCalled();
  });

  it("SENDER CHECK (both ways): refuses and never flips when the tapper's id does not match the approval's chat identity", async () => {
    mockParse.mockReturnValue({ decision: "approved", callbackToken: "token123456" });
    mockGetApproval.mockResolvedValue(MOCK_APPROVAL_ROW as never);
    mockGetChatIdentity.mockResolvedValue(MOCK_IDENTITY_ROW as never); // platformUserId "555"

    const res = await POST(
      req(arCallbackUpdate({ fromId: 999 }), { header: SECRET }) // a DIFFERENT tapper
    );

    expect(res.status).toBe(200);
    expect(mockGetChatIdentity).toHaveBeenCalledWith("chat-identity-1");
    expect(mockAnswer).toHaveBeenCalledWith(
      "test-bot-token",
      "cbq-1",
      expect.stringMatching(/yours to approve/i)
    );
    expect(mockResolveApproval).not.toHaveBeenCalled();
    expect(mockEdit).not.toHaveBeenCalled();
  });

  it("SENDER CHECK (both ways): proceeds when the tapper's id matches the approval's own chat identity", async () => {
    mockParse.mockReturnValue({ decision: "approved", callbackToken: "token123456" });
    mockGetApproval.mockResolvedValue(MOCK_APPROVAL_ROW as never);
    mockGetChatIdentity.mockResolvedValue(MOCK_IDENTITY_ROW as never); // platformUserId "555"
    mockResolveApproval.mockResolvedValue(true);

    const res = await POST(
      req(arCallbackUpdate({ fromId: 555 }), { header: SECRET }) // the SAME tapper
    );

    expect(res.status).toBe(200);
    expect(mockResolveApproval).toHaveBeenCalledWith("approval-1", "approved");
  });

  it("treats a null chatIdentityId on the approval as a failed sender check when the DM fallback ALSO can't establish authority (no chat.type at all, e.g. a malformed/missing message) — never looks up an identity, never flips", async () => {
    mockParse.mockReturnValue({ decision: "approved", callbackToken: "token123456" });
    mockGetApproval.mockResolvedValue({
      ...MOCK_APPROVAL_ROW,
      chatIdentityId: null,
    } as never);

    const res = await POST(req(arCallbackUpdate(), { header: SECRET }));

    expect(res.status).toBe(200);
    expect(mockGetChatIdentity).not.toHaveBeenCalled();
    expect(mockGetJaceSessionById).not.toHaveBeenCalled();
    expect(mockAnswer).toHaveBeenCalledWith(
      "test-bot-token",
      "cbq-1",
      expect.stringMatching(/yours to approve/i)
    );
    expect(mockResolveApproval).not.toHaveBeenCalled();
  });

  // --- null-identity DM-scoped fallback (review fix) ------------------------
  // A legacy approval with chatIdentityId null can never pass the strict
  // check above (identity is always null) — without a fallback, its buttons
  // look tappable but refuse EVERY tap forever. These four cases are the
  // fix's own contract: private chat + matching tapper succeeds; group chat
  // refuses (can't infer authority); private chat + mismatched tapper
  // refuses; the identity-present path (already covered by the two "SENDER
  // CHECK (both ways)" tests above) is untouched by any of this.

  it("null-identity DM fallback: flips when the tap is in the session's own PRIVATE chat and the tapper's id equals the session's conversationKey", async () => {
    mockParse.mockReturnValue({ decision: "approved", callbackToken: "token123456" });
    mockGetApproval.mockResolvedValue({
      ...MOCK_APPROVAL_ROW,
      chatIdentityId: null,
    } as never);
    mockGetJaceSessionById.mockResolvedValue({
      id: "session-1",
      conversationKey: "777",
    } as never);
    mockResolveApproval.mockResolvedValue(true);

    const res = await POST(
      req(
        arCallbackUpdate({ fromId: 777, chatType: "private" }),
        { header: SECRET }
      )
    );

    expect(res.status).toBe(200);
    expect(mockGetChatIdentity).not.toHaveBeenCalled();
    expect(mockGetJaceSessionById).toHaveBeenCalledWith("session-1");
    expect(mockResolveApproval).toHaveBeenCalledWith("approval-1", "approved");
    expect(mockAnswer).toHaveBeenCalledWith("test-bot-token", "cbq-1", "✅ Approved");
  });

  it("null-identity DM fallback: refuses when the tap comes from a GROUP chat, even if the tapper's id happens to equal the session's conversationKey — a group's conversationKey is the group's own chat id, not any member's", async () => {
    mockParse.mockReturnValue({ decision: "approved", callbackToken: "token123456" });
    mockGetApproval.mockResolvedValue({
      ...MOCK_APPROVAL_ROW,
      chatIdentityId: null,
    } as never);
    mockGetJaceSessionById.mockResolvedValue({
      id: "session-1",
      conversationKey: "777",
    } as never);

    const res = await POST(
      req(
        arCallbackUpdate({ fromId: 777, chatType: "group" }),
        { header: SECRET }
      )
    );

    expect(res.status).toBe(200);
    expect(mockGetJaceSessionById).not.toHaveBeenCalled();
    expect(mockAnswer).toHaveBeenCalledWith(
      "test-bot-token",
      "cbq-1",
      expect.stringMatching(/yours to approve/i)
    );
    expect(mockResolveApproval).not.toHaveBeenCalled();
  });

  it("null-identity DM fallback: refuses when the chat is private but the tapper's id does NOT match the session's conversationKey", async () => {
    mockParse.mockReturnValue({ decision: "approved", callbackToken: "token123456" });
    mockGetApproval.mockResolvedValue({
      ...MOCK_APPROVAL_ROW,
      chatIdentityId: null,
    } as never);
    mockGetJaceSessionById.mockResolvedValue({
      id: "session-1",
      conversationKey: "777",
    } as never);

    const res = await POST(
      req(
        arCallbackUpdate({ fromId: 999, chatType: "private" }),
        { header: SECRET }
      )
    );

    expect(res.status).toBe(200);
    expect(mockGetJaceSessionById).toHaveBeenCalledWith("session-1");
    expect(mockAnswer).toHaveBeenCalledWith(
      "test-bot-token",
      "cbq-1",
      expect.stringMatching(/yours to approve/i)
    );
    expect(mockResolveApproval).not.toHaveBeenCalled();
  });

  it("flips to approved, answers, and edits the message with the re-rendered text + outcome + tapper's first name", async () => {
    mockParse.mockReturnValue({ decision: "approved", callbackToken: "token123456" });
    mockGetApproval.mockResolvedValue(MOCK_APPROVAL_ROW as never);
    mockGetChatIdentity.mockResolvedValue(MOCK_IDENTITY_ROW as never);
    mockResolveApproval.mockResolvedValue(true);

    const res = await POST(
      req(arCallbackUpdate({ fromId: 555, firstName: "Ada" }), { header: SECRET })
    );

    expect(res.status).toBe(200);
    expect(mockRender).toHaveBeenCalledWith("create_issue", { title: "Add dark mode" });
    expect(mockAnswer).toHaveBeenCalledWith("test-bot-token", "cbq-1", "✅ Approved");
    expect(mockEdit).toHaveBeenCalledWith(
      "test-bot-token",
      -100123,
      42,
      "rendered approval text\n\n✅ Approved by Ada"
    );
  });

  it("flips to denied for an 'n'-flagged callback, with the ❌ Denied label", async () => {
    mockParse.mockReturnValue({ decision: "denied", callbackToken: "token123456" });
    mockGetApproval.mockResolvedValue(MOCK_APPROVAL_ROW as never);
    mockGetChatIdentity.mockResolvedValue(MOCK_IDENTITY_ROW as never);
    mockResolveApproval.mockResolvedValue(true);

    const res = await POST(
      req(arCallbackUpdate({ data: "ar:ntoken123456", fromId: 555 }), { header: SECRET })
    );

    expect(res.status).toBe(200);
    expect(mockResolveApproval).toHaveBeenCalledWith("approval-1", "denied");
    expect(mockAnswer).toHaveBeenCalledWith("test-bot-token", "cbq-1", "❌ Denied");
    expect(mockEdit).toHaveBeenCalledWith(
      "test-bot-token",
      -100123,
      42,
      expect.stringContaining("❌ Denied by")
    );
  });

  it("falls back to username, then the numeric id, when first_name is absent", async () => {
    mockParse.mockReturnValue({ decision: "approved", callbackToken: "token123456" });
    mockGetApproval.mockResolvedValue(MOCK_APPROVAL_ROW as never);
    mockGetChatIdentity.mockResolvedValue(MOCK_IDENTITY_ROW as never);
    mockResolveApproval.mockResolvedValue(true);

    await POST(
      req(arCallbackUpdate({ fromId: 555, username: "ada_handle" }), { header: SECRET })
    );

    expect(mockEdit).toHaveBeenCalledWith(
      "test-bot-token",
      -100123,
      42,
      expect.stringContaining("by ada_handle")
    );
  });

  it("duplicate tap: resolveApproval returning false answers 'already resolved' and does NOT edit again", async () => {
    mockParse.mockReturnValue({ decision: "approved", callbackToken: "token123456" });
    mockGetApproval.mockResolvedValue(MOCK_APPROVAL_ROW as never);
    mockGetChatIdentity.mockResolvedValue(MOCK_IDENTITY_ROW as never);
    mockResolveApproval.mockResolvedValue(false);

    const res = await POST(req(arCallbackUpdate({ fromId: 555 }), { header: SECRET }));

    expect(res.status).toBe(200);
    expect(mockAnswer).toHaveBeenCalledWith(
      "test-bot-token",
      "cbq-1",
      expect.stringMatching(/already resolved/i)
    );
    expect(mockEdit).not.toHaveBeenCalled();
  });

  it("flips and answers even when the update carries no message to edit (skips editMessageText, never throws)", async () => {
    mockParse.mockReturnValue({ decision: "approved", callbackToken: "token123456" });
    mockGetApproval.mockResolvedValue(MOCK_APPROVAL_ROW as never);
    mockGetChatIdentity.mockResolvedValue(MOCK_IDENTITY_ROW as never);
    mockResolveApproval.mockResolvedValue(true);

    const res = await POST(
      req(arCallbackUpdate({ fromId: 555, withMessage: false }), { header: SECRET })
    );

    expect(res.status).toBe(200);
    expect(mockAnswer).toHaveBeenCalled();
    expect(mockEdit).not.toHaveBeenCalled();
  });

  it("logs and 200s without answering/flipping when TELEGRAM_BOT_TOKEN is unset (cannot answer/edit)", async () => {
    delete process.env["TELEGRAM_BOT_TOKEN"];

    const res = await POST(req(arCallbackUpdate(), { header: SECRET }));

    expect(res.status).toBe(200);
    expect(mockGetApproval).not.toHaveBeenCalled();
    expect(mockAnswer).not.toHaveBeenCalled();
  });
});

// --- issue #1273: forward path (the cutover bridge) -------------------------

describe("POST /api/v1/connectors/telegram/webhook — forward path (issue #1273)", () => {
  const EVE_TELEGRAM_URL = "http://127.0.0.1:2000/eve/v1/telegram";

  beforeEach(() => {
    process.env["TELEGRAM_WEBHOOK_SECRET_TOKEN"] = SECRET;
    delete process.env["EVE_HOST"];
  });

  it("forwards an eve:-prefixed callback_query verbatim, with the same secret header, to the sidecar's real /eve/v1/telegram", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, handled: "eve" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const update = arCallbackUpdate({ data: "eve:abc123" });
    const res = await POST(req(update, { header: SECRET }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, handled: "eve" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(EVE_TELEGRAM_URL);
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toMatchObject({
      "Content-Type": "application/json",
      [HEADER]: SECRET,
    });
    // Verbatim: the forwarded body is the EXACT raw bytes this request
    // carried, not a re-serialized/re-parsed copy.
    expect((init as RequestInit).body).toBe(JSON.stringify(update));
  });

  it("mirrors a non-2xx status from the sidecar", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "sidecar rejected it" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        })
      )
    );

    const res = await POST(
      req(arCallbackUpdate({ data: "eve:abc123" }), { header: SECRET })
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "sidecar rejected it" });
  });

  it("responds 200 { ok: true, forwarded: false } when the sidecar is unreachable — never a retry-storm-inducing non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const res = await POST(
      req(arCallbackUpdate({ data: "eve:abc123" }), { header: SECRET })
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, forwarded: false });
  });

  it("also forwards a callback_query with no data field at all (not just eve:-prefixed)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const update = arCallbackUpdate();
    delete (update["callback_query"] as Record<string, unknown>)["data"];

    const res = await POST(req(update, { header: SECRET }));

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never forwards an ar:-prefixed callback_query (handled locally instead)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    process.env["TELEGRAM_BOT_TOKEN"] = "test-bot-token";
    mockParse.mockReturnValue({ decision: "approved", callbackToken: "token123456" });
    mockGetApproval.mockResolvedValue(null); // not-found path is enough to prove no forward happens

    await POST(req(arCallbackUpdate({ data: "ar:ytoken123456" }), { header: SECRET }));

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
