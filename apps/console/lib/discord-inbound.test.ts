import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@agentrail/db-postgres", () => ({
  resolveInboundChatIdentity: vi.fn(),
  enqueueChannelMessage: vi.fn(),
  getThreadEngagement: vi.fn(),
}));

vi.mock("./channel-dispatch", () => ({
  dispatchQueuedChannelMessages: vi.fn(),
}));

import { admitDiscordChannelMessage } from "./discord-inbound";
import {
  resolveInboundChatIdentity,
  enqueueChannelMessage,
  getThreadEngagement,
} from "@agentrail/db-postgres";
import { dispatchQueuedChannelMessages } from "./channel-dispatch";

const mockResolve = vi.mocked(resolveInboundChatIdentity);
const mockEnqueue = vi.mocked(enqueueChannelMessage);
const mockDispatch = vi.mocked(dispatchQueuedChannelMessages);
const mockGetEngagement = vi.mocked(getThreadEngagement);

/** The full set of engagement-envelope fields every caller must now supply. */
function baseMessage(over: Partial<Parameters<typeof admitDiscordChannelMessage>[0]> = {}) {
  return {
    channelId: "998877",
    providerMessageId: "998877:msg-1",
    senderId: "555",
    senderDisplay: "Ada",
    senderUsername: "ada",
    text: "hello jace",
    threadId: null,
    mentionsBot: false,
    mentionsOtherUsers: false,
    repliesToMessageId: null,
    repliesToBot: false,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDispatch.mockResolvedValue({ processed: 0, failed: 0 });
  mockResolve.mockResolvedValue({
    identity: { id: "chat-identity-1", workspaceId: null } as never,
    created: true,
    disposition: "intro",
  });
  mockEnqueue.mockResolvedValue({ id: "row-1", deduped: false });
});

describe("admitDiscordChannelMessage", () => {
  it("resolves identity and enqueues, anchoring on chatIdentityId for an unbound (intro) sender", async () => {
    const result = await admitDiscordChannelMessage(
      baseMessage({ mentionsBot: true, senderId: "555", senderDisplay: "Ada", senderUsername: "ada" })
    );

    expect(result).toEqual({ deduped: false, skipped: false });
    expect(mockResolve).toHaveBeenCalledWith({
      platform: "discord",
      platformUserId: "555",
      displayName: "Ada",
    });
    expect(mockEnqueue).toHaveBeenCalledWith({
      chatIdentityId: "chat-identity-1",
      channel: "discord",
      conversationKey: "998877",
      kind: "message",
      senderId: "555",
      senderDisplay: "Ada",
      providerMessageId: "998877:msg-1",
      payload: {
        chatId: "998877",
        text: "hello jace",
        fromId: "555",
        fromUsername: "ada",
        threadId: null,
        mentionsBot: true,
        mentionsOtherUsers: false,
        repliesToMessageId: null,
        repliesToBot: false,
      },
    });
  });

  it("anchors on workspaceId (not chatIdentityId) for a bound identity", async () => {
    mockResolve.mockResolvedValue({
      identity: { id: "chat-identity-2", workspaceId: "ws-1" } as never,
      created: false,
      disposition: "bound",
    });

    await admitDiscordChannelMessage(baseMessage({ mentionsBot: true }));

    const enqueueArgs = mockEnqueue.mock.calls[0]?.[0];
    expect(enqueueArgs).toMatchObject({ workspaceId: "ws-1" });
    expect(enqueueArgs).not.toHaveProperty("chatIdentityId");
  });

  it("passes a null fromUsername through when senderUsername is null", async () => {
    await admitDiscordChannelMessage(
      baseMessage({ channelId: "1", providerMessageId: "1:msg-3", senderId: "9", senderDisplay: "9", senderUsername: null, mentionsBot: true })
    );

    const enqueueArgs = mockEnqueue.mock.calls[0]?.[0];
    expect(enqueueArgs?.payload).toMatchObject({ fromUsername: null });
  });

  it("reports deduped:true from enqueueChannelMessage straight through", async () => {
    mockResolve.mockResolvedValue({
      identity: { id: "chat-identity-1", workspaceId: "ws-1" } as never,
      created: false,
      disposition: "bound",
    });
    mockEnqueue.mockResolvedValue({ id: null, deduped: true });

    const result = await admitDiscordChannelMessage(baseMessage({ mentionsBot: true }));

    expect(result).toEqual({ deduped: true, skipped: false });
  });

  it("kicks the dispatcher fire-and-forget after enqueueing", async () => {
    await admitDiscordChannelMessage(baseMessage({ mentionsBot: true }));

    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it("never lets a dispatcher rejection propagate out of admitDiscordChannelMessage", async () => {
    mockDispatch.mockRejectedValueOnce(new Error("drain blew up"));

    await expect(admitDiscordChannelMessage(baseMessage({ mentionsBot: true }))).resolves.toEqual({
      deduped: false,
      skipped: false,
    });
  });

  // --- engagement gate (spec: docs/superpowers/specs/2026-07-28-thread-native-jace-design.md) ---

  describe("the engagement gate", () => {
    it("always enqueues a mention, without ever looking up engagement state", async () => {
      const result = await admitDiscordChannelMessage(
        baseMessage({ threadId: "thread-1", mentionsBot: true })
      );

      expect(result).toEqual({ deduped: false, skipped: false });
      expect(mockGetEngagement).not.toHaveBeenCalled();
      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({ conversationKey: "thread-1" })
      );
    });

    it("always enqueues outside a thread (channelId is the conversation key), without looking up engagement state", async () => {
      const result = await admitDiscordChannelMessage(baseMessage({ threadId: null, mentionsBot: false }));

      expect(result).toEqual({ deduped: false, skipped: false });
      expect(mockGetEngagement).not.toHaveBeenCalled();
      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({ conversationKey: "998877" })
      );
    });

    it("enqueues an un-mentioned thread message when the session is engaged (latch clear)", async () => {
      mockGetEngagement.mockResolvedValue({ dormantSince: null, engagedSpeakerId: "555" });

      const result = await admitDiscordChannelMessage(
        baseMessage({ threadId: "thread-1", mentionsBot: false })
      );

      expect(mockGetEngagement).toHaveBeenCalledWith({ channel: "discord", conversationKey: "thread-1" });
      expect(result).toEqual({ deduped: false, skipped: false });
      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({ conversationKey: "thread-1" })
      );
    });

    it("drops an un-mentioned thread message when the session is dormant (latch set) — never enqueues, never resolves identity", async () => {
      mockGetEngagement.mockResolvedValue({ dormantSince: new Date("2026-07-28T12:00:00Z"), engagedSpeakerId: "555" });

      const result = await admitDiscordChannelMessage(
        baseMessage({ threadId: "thread-1", mentionsBot: false })
      );

      expect(result).toEqual({ deduped: false, skipped: true });
      expect(mockResolve).not.toHaveBeenCalled();
      expect(mockEnqueue).not.toHaveBeenCalled();
      expect(mockDispatch).not.toHaveBeenCalled();
    });

    it("drops an un-mentioned thread message with no session row at all — never enqueues", async () => {
      mockGetEngagement.mockResolvedValue(null);

      const result = await admitDiscordChannelMessage(
        baseMessage({ threadId: "thread-1", mentionsBot: false })
      );

      expect(result).toEqual({ deduped: false, skipped: true });
      expect(mockEnqueue).not.toHaveBeenCalled();
    });
  });

  // --- envelope fields land in the stored payload ---

  it("carries the full envelope (threadId, mentionsBot, mentionsOtherUsers, repliesToMessageId, repliesToBot) into the payload", async () => {
    await admitDiscordChannelMessage(
      baseMessage({
        threadId: "thread-9",
        mentionsBot: true,
        mentionsOtherUsers: true,
        repliesToMessageId: "msg-77",
        repliesToBot: true,
      })
    );

    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationKey: "thread-9",
        payload: expect.objectContaining({
          chatId: "thread-9",
          threadId: "thread-9",
          mentionsBot: true,
          mentionsOtherUsers: true,
          repliesToMessageId: "msg-77",
          repliesToBot: true,
        }),
      })
    );
  });

  it("never kicks the dispatcher when the gate drops the message", async () => {
    mockGetEngagement.mockResolvedValue(null);

    await admitDiscordChannelMessage(baseMessage({ threadId: "thread-1", mentionsBot: false }));

    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("still carries interactionToken/applicationId (both-or-neither) alongside the new envelope fields", async () => {
    await admitDiscordChannelMessage(
      baseMessage({ mentionsBot: true, interactionToken: "tok", applicationId: "app-1" })
    );

    const enqueueArgs = mockEnqueue.mock.calls[0]?.[0];
    expect(enqueueArgs?.payload).toMatchObject({ interactionToken: "tok", applicationId: "app-1" });
  });

  it("omits interactionToken/applicationId entirely when neither is supplied (never writes them as undefined)", async () => {
    await admitDiscordChannelMessage(baseMessage({ mentionsBot: true }));

    const enqueueArgs = mockEnqueue.mock.calls[0]?.[0] as { payload: Record<string, unknown> };
    expect(enqueueArgs.payload).not.toHaveProperty("interactionToken");
    expect(enqueueArgs.payload).not.toHaveProperty("applicationId");
  });
});
