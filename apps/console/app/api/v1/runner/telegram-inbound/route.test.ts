import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// Telegram has no `lib/discord-inbound.ts`-style shared admit function today —
// the connectors webhook (`connectors/telegram/webhook/route.ts`) calls
// `resolveInboundChatIdentity`/`enqueueChannelMessage`/
// `dispatchQueuedChannelMessages` inline rather than through an extracted lib,
// so this second Telegram door mirrors THAT call shape directly instead of
// inventing a new shared module purely for a route with only one caller.
vi.mock("@agentrail/db-postgres", () => ({
  resolveInboundChatIdentity: vi.fn(),
  enqueueChannelMessage: vi.fn(),
}));

vi.mock("../../../../../lib/channel-dispatch", () => ({
  dispatchQueuedChannelMessages: vi.fn(),
}));

import { POST } from "./route";
import { resolveInboundChatIdentity, enqueueChannelMessage } from "@agentrail/db-postgres";
import { dispatchQueuedChannelMessages } from "../../../../../lib/channel-dispatch";

const mockResolve = vi.mocked(resolveInboundChatIdentity);
const mockEnqueue = vi.mocked(enqueueChannelMessage);
const mockDispatch = vi.mocked(dispatchQueuedChannelMessages);

// Central-secret auth (mirrors runner/discord-inbound/route.test.ts's idiom).
const ENV_KEY = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-shared-secret-abc123";
const ORIGINAL_ENV = process.env[ENV_KEY];

function req(opts: { body?: unknown; token?: string } = {}): NextRequest {
  const { body, token } = opts;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== undefined) headers["Authorization"] = `Bearer ${token}`;
  return new NextRequest("http://localhost/api/v1/runner/telegram-inbound", {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  });
}

const VALID_BODY = {
  chatId: "998877",
  messageId: "msg-1",
  senderId: "555",
  senderDisplay: "Ada",
  senderUsername: "ada",
  text: "what's the status?",
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env[ENV_KEY] = SECRET;
  mockResolve.mockResolvedValue({
    identity: { id: "chat-identity-1", workspaceId: null } as never,
    created: true,
    disposition: "intro",
  });
  mockEnqueue.mockResolvedValue({ id: "row-1", deduped: false });
  mockDispatch.mockResolvedValue({ processed: 0, failed: 0 });
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_ENV;
});

describe("POST /api/v1/runner/telegram-inbound", () => {
  describe("auth (central JACE_CONSOLE_TOKEN secret)", () => {
    it("401 when JACE_CONSOLE_TOKEN is unset, and never touches the pipeline", async () => {
      delete process.env[ENV_KEY];
      const res = await POST(req({ token: SECRET, body: VALID_BODY }));
      expect(res.status).toBe(401);
      expect(mockResolve).not.toHaveBeenCalled();
      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it("401 when no Authorization header is sent", async () => {
      const res = await POST(req({ body: VALID_BODY }));
      expect(res.status).toBe(401);
      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it("401 on a wrong secret", async () => {
      const res = await POST(req({ token: "wrong", body: VALID_BODY }));
      expect(res.status).toBe(401);
    });
  });

  describe("validation", () => {
    it("400 when chatId is missing", async () => {
      const { chatId, ...rest } = VALID_BODY;
      const res = await POST(req({ token: SECRET, body: rest }));
      expect(res.status).toBe(400);
      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it("400 when messageId is missing", async () => {
      const { messageId, ...rest } = VALID_BODY;
      const res = await POST(req({ token: SECRET, body: rest }));
      expect(res.status).toBe(400);
    });

    it("400 when senderId is missing", async () => {
      const { senderId, ...rest } = VALID_BODY;
      const res = await POST(req({ token: SECRET, body: rest }));
      expect(res.status).toBe(400);
    });

    it("400 when text is missing/blank", async () => {
      const res = await POST(req({ token: SECRET, body: { ...VALID_BODY, text: "   " } }));
      expect(res.status).toBe(400);
      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it("400 when text exceeds the max length", async () => {
      const res = await POST(req({ token: SECRET, body: { ...VALID_BODY, text: "x".repeat(4001) } }));
      expect(res.status).toBe(400);
    });

    it("falls back senderDisplay to senderId when blank", async () => {
      await POST(req({ token: SECRET, body: { ...VALID_BODY, senderDisplay: "" } }));
      expect(mockResolve).toHaveBeenCalledWith(
        expect.objectContaining({ displayName: "555" })
      );
    });
  });

  it("happy path: resolves identity, builds the chatId:messageId dedupe key, and enqueues", async () => {
    const res = await POST(req({ token: SECRET, body: VALID_BODY }));
    expect(res.status).toBe(200);
    expect(mockResolve).toHaveBeenCalledWith({
      platform: "telegram",
      platformUserId: "555",
      displayName: "Ada",
    });
    expect(mockEnqueue).toHaveBeenCalledWith({
      chatIdentityId: "chat-identity-1",
      channel: "telegram",
      conversationKey: "998877",
      kind: "message",
      senderId: "555",
      senderDisplay: "Ada",
      providerMessageId: "998877:msg-1",
      payload: {
        chatId: "998877",
        text: "what's the status?",
        fromId: "555",
        fromUsername: "ada",
      },
    });
    const json = await res.json();
    expect(json).toEqual({ ok: true, deduped: false });
  });

  it("anchors on workspaceId (not chatIdentityId) for a bound identity", async () => {
    mockResolve.mockResolvedValue({
      identity: { id: "chat-identity-2", workspaceId: "ws-1" } as never,
      created: false,
      disposition: "bound",
    });
    await POST(req({ token: SECRET, body: VALID_BODY }));
    const enqueueArgs = mockEnqueue.mock.calls[0]?.[0];
    expect(enqueueArgs).toMatchObject({ workspaceId: "ws-1" });
    expect(enqueueArgs).not.toHaveProperty("chatIdentityId");
  });

  it("reports deduped:true straight through", async () => {
    mockEnqueue.mockResolvedValue({ id: null, deduped: true });
    const res = await POST(req({ token: SECRET, body: VALID_BODY }));
    const json = await res.json();
    expect(json).toEqual({ ok: true, deduped: true });
  });

  it("kicks the dispatcher fire-and-forget after enqueueing", async () => {
    await POST(req({ token: SECRET, body: VALID_BODY }));
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it("502 when the pipeline throws", async () => {
    mockEnqueue.mockRejectedValue(new Error("pg down"));
    const res = await POST(req({ token: SECRET, body: VALID_BODY }));
    expect(res.status).toBe(502);
  });

  it("senderUsername defaults to null when absent", async () => {
    const { senderUsername, ...rest } = VALID_BODY;
    await POST(req({ token: SECRET, body: rest }));
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ fromUsername: null }) })
    );
  });

  // (channel, senderId) invariant (channel-dispatch.ts's own doc-comment): the
  // pair this route enqueues under MUST equal the (platform, platformUserId)
  // pair `resolveInboundChatIdentity` creates the chat_identities row under —
  // otherwise `getChatIdentity(row.channel, row.senderId)` at dispatch time
  // finds nothing and the row dead-letters silently. This pins that the
  // SAME raw `senderId` string feeds both calls, exactly like the connectors
  // webhook's `String(message.from.id)` feeding both
  // `resolveInboundChatIdentity`'s `platformUserId` and
  // `enqueueChannelMessage`'s `senderId`.
  it("enqueues under the SAME (channel, senderId) pair resolveInboundChatIdentity resolved (platform, platformUserId) under", async () => {
    await POST(req({ token: SECRET, body: VALID_BODY }));
    const resolveArgs = mockResolve.mock.calls[0]?.[0];
    const enqueueArgs = mockEnqueue.mock.calls[0]?.[0];
    expect(enqueueArgs?.channel).toBe("telegram");
    expect(resolveArgs?.platform).toBe("telegram");
    expect(enqueueArgs?.senderId).toBe(resolveArgs?.platformUserId);
  });
});
