import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@agentrail/db-postgres", () => ({
  resolveInboundChatIdentity: vi.fn(),
  enqueueChannelMessage: vi.fn(),
}));

vi.mock("./channel-dispatch", () => ({
  dispatchQueuedChannelMessages: vi.fn(),
}));

import { admitDiscordChannelMessage } from "./discord-inbound";
import { resolveInboundChatIdentity, enqueueChannelMessage } from "@agentrail/db-postgres";
import { dispatchQueuedChannelMessages } from "./channel-dispatch";

const mockResolve = vi.mocked(resolveInboundChatIdentity);
const mockEnqueue = vi.mocked(enqueueChannelMessage);
const mockDispatch = vi.mocked(dispatchQueuedChannelMessages);

beforeEach(() => {
  vi.clearAllMocks();
  mockDispatch.mockResolvedValue({ processed: 0, failed: 0 });
});

describe("admitDiscordChannelMessage", () => {
  it("resolves identity and enqueues, anchoring on chatIdentityId for an unbound (intro) sender", async () => {
    mockResolve.mockResolvedValue({
      identity: { id: "chat-identity-1", workspaceId: null } as never,
      created: true,
      disposition: "intro",
    });
    mockEnqueue.mockResolvedValue({ id: "row-1", deduped: false });

    const result = await admitDiscordChannelMessage({
      channelId: "998877",
      providerMessageId: "998877:msg-1",
      senderId: "555",
      senderDisplay: "Ada",
      senderUsername: "ada",
      text: "hello jace",
    });

    expect(result).toEqual({ deduped: false });
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

    await admitDiscordChannelMessage({
      channelId: "998877",
      providerMessageId: "998877:msg-2",
      senderId: "555",
      senderDisplay: "Ada",
      senderUsername: "ada",
      text: "hi",
    });

    const enqueueArgs = mockEnqueue.mock.calls[0]?.[0];
    expect(enqueueArgs).toMatchObject({ workspaceId: "ws-1" });
    expect(enqueueArgs).not.toHaveProperty("chatIdentityId");
  });

  it("passes a null fromUsername through when senderUsername is null", async () => {
    mockResolve.mockResolvedValue({
      identity: { id: "chat-identity-3", workspaceId: null } as never,
      created: true,
      disposition: "intro",
    });
    mockEnqueue.mockResolvedValue({ id: "row-3", deduped: false });

    await admitDiscordChannelMessage({
      channelId: "1",
      providerMessageId: "1:msg-3",
      senderId: "9",
      senderDisplay: "9",
      senderUsername: null,
      text: "hi",
    });

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

    const result = await admitDiscordChannelMessage({
      channelId: "998877",
      providerMessageId: "998877:msg-1",
      senderId: "555",
      senderDisplay: "Ada",
      senderUsername: "ada",
      text: "hello jace",
    });

    expect(result).toEqual({ deduped: true });
  });

  it("kicks the dispatcher fire-and-forget after enqueueing", async () => {
    mockResolve.mockResolvedValue({
      identity: { id: "chat-identity-1", workspaceId: null } as never,
      created: true,
      disposition: "intro",
    });
    mockEnqueue.mockResolvedValue({ id: "row-1", deduped: false });

    await admitDiscordChannelMessage({
      channelId: "998877",
      providerMessageId: "998877:msg-1",
      senderId: "555",
      senderDisplay: "Ada",
      senderUsername: "ada",
      text: "hello jace",
    });

    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it("never lets a dispatcher rejection propagate out of admitDiscordChannelMessage", async () => {
    mockResolve.mockResolvedValue({
      identity: { id: "chat-identity-1", workspaceId: null } as never,
      created: true,
      disposition: "intro",
    });
    mockEnqueue.mockResolvedValue({ id: "row-1", deduped: false });
    mockDispatch.mockRejectedValueOnce(new Error("drain blew up"));

    await expect(
      admitDiscordChannelMessage({
        channelId: "998877",
        providerMessageId: "998877:msg-1",
        senderId: "555",
        senderDisplay: "Ada",
        senderUsername: "ada",
        text: "hello jace",
      })
    ).resolves.toEqual({ deduped: false });
  });
});
