import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  resolveInboundChatIdentity: vi.fn(),
  enqueueChannelMessage: vi.fn(),
}));

import { POST } from "./route";
import {
  resolveInboundChatIdentity,
  enqueueChannelMessage,
} from "@agentrail/db-postgres";

const mockResolve = vi.mocked(resolveInboundChatIdentity);
const mockEnqueue = vi.mocked(enqueueChannelMessage);

const HEADER = "x-telegram-bot-api-secret-token";
const SECRET = "shared-bot-secret-abc123";
const ORIGINAL_SECRET_ENV = process.env["TELEGRAM_WEBHOOK_SECRET_TOKEN"];

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
});

afterEach(() => {
  if (ORIGINAL_SECRET_ENV === undefined) {
    delete process.env["TELEGRAM_WEBHOOK_SECRET_TOKEN"];
  } else {
    process.env["TELEGRAM_WEBHOOK_SECRET_TOKEN"] = ORIGINAL_SECRET_ENV;
  }
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

  it("ignores a callback_query update with 200 { ok: true, ignored: true } (rides the Eve-native approvals path)", async () => {
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
