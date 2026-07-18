import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ClaimedChannelInboxRow } from "@agentrail/db-postgres";

vi.mock("@agentrail/db-postgres", () => ({
  reclaimStaleChannelMessages: vi.fn(),
  claimNextChannelMessage: vi.fn(),
  completeChannelMessage: vi.fn(),
  failChannelMessage: vi.fn(),
  getChatIdentity: vi.fn(),
  resolveConversationWorkspace: vi.fn(),
  pinConversationWorkspace: vi.fn(),
  getOrCreateIntroJaceSession: vi.fn(),
  getOrCreateJaceSession: vi.fn(),
  bindEveSession: vi.fn(),
}));

vi.mock("./telegram-system-message", () => ({
  sendSystemTelegramMessage: vi.fn(),
  buildWorkspaceChoiceMessage: (options: { name: string }[]) =>
    [
      `You're in ${options.length} workspaces. Which one is this about?`,
      ...options.map((o, i) => `${i + 1}. ${o.name}`),
      "Reply with a number or the name.",
    ].join("\n"),
  buildPinConfirmationMessage: (name: string) =>
    `Got it — this conversation is now about ${name}.`,
}));

import {
  reclaimStaleChannelMessages,
  claimNextChannelMessage,
  completeChannelMessage,
  failChannelMessage,
  getChatIdentity,
  resolveConversationWorkspace,
  pinConversationWorkspace,
  getOrCreateIntroJaceSession,
  getOrCreateJaceSession,
  bindEveSession,
} from "@agentrail/db-postgres";
import { sendSystemTelegramMessage } from "./telegram-system-message";
import { dispatchQueuedChannelMessages } from "./channel-dispatch";

const mockReclaim = vi.mocked(reclaimStaleChannelMessages);
const mockClaim = vi.mocked(claimNextChannelMessage);
const mockComplete = vi.mocked(completeChannelMessage);
const mockFail = vi.mocked(failChannelMessage);
const mockGetChatIdentity = vi.mocked(getChatIdentity);
const mockResolve = vi.mocked(resolveConversationWorkspace);
const mockPin = vi.mocked(pinConversationWorkspace);
const mockGetOrCreateIntro = vi.mocked(getOrCreateIntroJaceSession);
const mockGetOrCreateSession = vi.mocked(getOrCreateJaceSession);
const mockBindEveSession = vi.mocked(bindEveSession);
const mockSendSystem = vi.mocked(sendSystemTelegramMessage);

const mockFetch = vi.fn();

function row(overrides: Partial<ClaimedChannelInboxRow> & { payload?: unknown } = {}): ClaimedChannelInboxRow {
  return {
    id: "row-1",
    workspaceId: null as unknown as string,
    channel: "telegram",
    conversationKey: "-100123",
    kind: "message",
    senderId: "555",
    senderDisplay: "ada",
    providerMessageId: "-100123:42",
    payload: { chatId: -100123, text: "hello jace" },
    state: "processing",
    attempts: 0,
    createdAt: new Date(),
    ...overrides,
  } as ClaimedChannelInboxRow;
}

const IDENTITY = { id: "chat-1", platform: "telegram", platformUserId: "555" } as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mockFetch);
  mockReclaim.mockResolvedValue(0);
  mockClaim.mockResolvedValue(null);
  mockGetChatIdentity.mockResolvedValue(IDENTITY);
  mockComplete.mockResolvedValue(undefined);
  mockFail.mockResolvedValue("requeued");
  mockSendSystem.mockResolvedValue({ ok: true });
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ sessionId: "eve-sess-1", continuationToken: "tok-1" }),
  });
});

describe("dispatchQueuedChannelMessages — loop shape", () => {
  it("reclaims stale rows once, then claims until null, returning zero counts on an empty queue", async () => {
    const result = await dispatchQueuedChannelMessages();

    expect(mockReclaim).toHaveBeenCalledTimes(1);
    expect(mockClaim).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ processed: 0, failed: 0 });
  });
});

describe("dispatchQueuedChannelMessages — 'ask' kind", () => {
  const OPTIONS = [{ id: "ws-1", name: "Acme" }, { id: "ws-2", name: "Widgets" }];

  it("sends the numbered options and completes WITHOUT an Eve call, for a non-choice reply", async () => {
    mockClaim.mockResolvedValueOnce(row({ payload: { chatId: -100123, text: "hi jace" } })).mockResolvedValueOnce(null);
    mockResolve.mockResolvedValue({ kind: "ask", options: OPTIONS } as never);

    const result = await dispatchQueuedChannelMessages();

    expect(mockSendSystem).toHaveBeenCalledWith(
      "-100123",
      "You're in 2 workspaces. Which one is this about?\n1. Acme\n2. Widgets\nReply with a number or the name.",
      undefined,
    );
    expect(mockPin).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockComplete).toHaveBeenCalledWith("row-1");
    expect(result).toEqual({ processed: 1, failed: 0 });
  });

  it("pins the chosen workspace on a valid numeric reply, sends a one-line confirmation, and skips the Eve turn", async () => {
    mockClaim.mockResolvedValueOnce(row({ payload: { chatId: -100123, text: "2" } })).mockResolvedValueOnce(null);
    mockResolve.mockResolvedValue({ kind: "ask", options: OPTIONS } as never);
    mockPin.mockResolvedValue({ ok: true, sessionId: "pin-sess-2" } as never);

    await dispatchQueuedChannelMessages();

    expect(mockPin).toHaveBeenCalledWith({
      chatIdentityId: "chat-1",
      channel: "telegram",
      conversationKey: "-100123",
      workspaceId: "ws-2",
    });
    expect(mockSendSystem).toHaveBeenCalledWith(
      "-100123",
      "Got it — this conversation is now about Widgets.",
      undefined,
    );
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockComplete).toHaveBeenCalledWith("row-1");
  });

  it("matches an exact case-insensitive workspace-name reply the same as a numeric one", async () => {
    mockClaim.mockResolvedValueOnce(row({ payload: { chatId: -100123, text: "widgets" } })).mockResolvedValueOnce(null);
    mockResolve.mockResolvedValue({ kind: "ask", options: OPTIONS } as never);
    mockPin.mockResolvedValue({ ok: true, sessionId: "pin-sess-2" } as never);

    await dispatchQueuedChannelMessages();

    expect(mockPin).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-2" }),
    );
  });

  it("re-sends the SAME options on an invalid reply (not a number in range, not a name)", async () => {
    mockClaim.mockResolvedValueOnce(row({ payload: { chatId: -100123, text: "banana" } })).mockResolvedValueOnce(null);
    mockResolve.mockResolvedValue({ kind: "ask", options: OPTIONS } as never);

    await dispatchQueuedChannelMessages();

    expect(mockPin).not.toHaveBeenCalled();
    expect(mockSendSystem).toHaveBeenCalledWith(
      "-100123",
      "You're in 2 workspaces. Which one is this about?\n1. Acme\n2. Widgets\nReply with a number or the name.",
      undefined,
    );
    expect(mockComplete).toHaveBeenCalledWith("row-1");
  });

  it("an out-of-range number (e.g. '3' of 2 options) is treated as invalid, not a crash", async () => {
    mockClaim.mockResolvedValueOnce(row({ payload: { chatId: -100123, text: "3" } })).mockResolvedValueOnce(null);
    mockResolve.mockResolvedValue({ kind: "ask", options: OPTIONS } as never);

    await dispatchQueuedChannelMessages();

    expect(mockPin).not.toHaveBeenCalled();
    expect(mockSendSystem).toHaveBeenCalledWith(
      "-100123",
      expect.stringContaining("Which one is this about?"),
      undefined,
    );
  });

  it("falls back to re-sending options when the chosen pin is refused (race / stale reachability)", async () => {
    mockClaim.mockResolvedValueOnce(row({ payload: { chatId: -100123, text: "1" } })).mockResolvedValueOnce(null);
    mockResolve.mockResolvedValue({ kind: "ask", options: OPTIONS } as never);
    mockPin.mockResolvedValue({ ok: false, reason: "already_pinned_elsewhere" } as never);

    await dispatchQueuedChannelMessages();

    expect(mockSendSystem).toHaveBeenCalledWith(
      "-100123",
      "You're in 2 workspaces. Which one is this about?\n1. Acme\n2. Widgets\nReply with a number or the name.",
      undefined,
    );
    expect(mockComplete).toHaveBeenCalledWith("row-1");
    expect(mockFail).not.toHaveBeenCalled();
  });
});

describe("dispatchQueuedChannelMessages — 'intro' kind", () => {
  it("runs the Eve turn with workspace null in the auth attributes, and posts the EXACT body", async () => {
    mockClaim.mockResolvedValueOnce(row()).mockResolvedValueOnce(null);
    mockResolve.mockResolvedValue({ kind: "intro" } as never);
    mockGetOrCreateIntro.mockResolvedValue({ id: "ledger-intro-1" } as never);

    await dispatchQueuedChannelMessages();

    expect(mockGetOrCreateIntro).toHaveBeenCalledWith("chat-1", "telegram", "-100123");
    expect(mockGetOrCreateSession).not.toHaveBeenCalled();

    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:2000/eve/v1/hosted-inbound",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "hello jace",
          target: { chatId: -100123 },
          auth: {
            authenticator: "agentrail",
            principalType: "service",
            principalId: "chat-1",
            attributes: {
              chatIdentityId: "chat-1",
              workspaceId: null,
              channel: "telegram",
              conversationKey: "-100123",
            },
          },
        }),
      },
    );

    expect(mockBindEveSession).toHaveBeenCalledWith("ledger-intro-1", "eve-sess-1");
    expect(mockComplete).toHaveBeenCalledWith("row-1");
  });
});

describe("dispatchQueuedChannelMessages — 'pinned' kind", () => {
  it("runs the Eve turn and binds the ledger session to the returned Eve sessionId", async () => {
    mockClaim.mockResolvedValueOnce(row()).mockResolvedValueOnce(null);
    mockResolve.mockResolvedValue({ kind: "pinned", workspaceId: "ws-9", sessionId: "pin-sess-9", ambiguous: false } as never);
    mockGetOrCreateSession.mockResolvedValue({ id: "ledger-9" } as never);

    await dispatchQueuedChannelMessages();

    expect(mockGetOrCreateSession).toHaveBeenCalledWith("ws-9", "telegram", "-100123");
    const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string);
    expect(body.auth.principalId).toBe("ws-9");
    expect(body.auth.attributes.workspaceId).toBe("ws-9");
    expect(mockBindEveSession).toHaveBeenCalledWith("ledger-9", "eve-sess-1");
    expect(mockComplete).toHaveBeenCalledWith("row-1");
  });

  it("proceeds with the Eve turn even when ambiguous:true (does not block)", async () => {
    mockClaim.mockResolvedValueOnce(row()).mockResolvedValueOnce(null);
    mockResolve.mockResolvedValue({ kind: "pinned", workspaceId: "ws-9", sessionId: "pin-sess-9", ambiguous: true } as never);
    mockGetOrCreateSession.mockResolvedValue({ id: "ledger-9" } as never);

    await dispatchQueuedChannelMessages();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockComplete).toHaveBeenCalledWith("row-1");
    expect(mockFail).not.toHaveBeenCalled();
  });

  it("passes the row's message_thread_id through to target when the payload carries one", async () => {
    mockClaim
      .mockResolvedValueOnce(row({ payload: { chatId: -100123, text: "hi", messageThreadId: 77 } }))
      .mockResolvedValueOnce(null);
    mockResolve.mockResolvedValue({ kind: "pinned", workspaceId: "ws-9", sessionId: "pin-sess-9", ambiguous: false } as never);
    mockGetOrCreateSession.mockResolvedValue({ id: "ledger-9" } as never);

    await dispatchQueuedChannelMessages();

    const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string);
    expect(body.target).toEqual({ chatId: -100123, messageThreadId: 77 });
  });
});

describe("dispatchQueuedChannelMessages — 'single' kind", () => {
  it("pins the sole reachable workspace, then runs the Eve turn and binds the ledger session", async () => {
    mockClaim.mockResolvedValueOnce(row()).mockResolvedValueOnce(null);
    mockResolve.mockResolvedValue({ kind: "single", workspaceId: "ws-5" } as never);
    mockPin.mockResolvedValue({ ok: true, sessionId: "pin-5" } as never);
    mockGetOrCreateSession.mockResolvedValue({ id: "ledger-5" } as never);

    await dispatchQueuedChannelMessages();

    expect(mockPin).toHaveBeenCalledWith({
      chatIdentityId: "chat-1",
      channel: "telegram",
      conversationKey: "-100123",
      workspaceId: "ws-5",
    });
    expect(mockGetOrCreateSession).toHaveBeenCalledWith("ws-5", "telegram", "-100123");
    expect(mockBindEveSession).toHaveBeenCalledWith("ledger-5", "eve-sess-1");
    expect(mockComplete).toHaveBeenCalledWith("row-1");
  });

  it("on already_pinned_elsewhere, re-resolves ONCE and proceeds with the re-resolved pin (race handling)", async () => {
    mockClaim.mockResolvedValueOnce(row()).mockResolvedValueOnce(null);
    mockResolve
      .mockResolvedValueOnce({ kind: "single", workspaceId: "ws-5" } as never)
      .mockResolvedValueOnce({ kind: "pinned", workspaceId: "ws-5", sessionId: "pin-5b", ambiguous: false } as never);
    mockPin.mockResolvedValue({ ok: false, reason: "already_pinned_elsewhere" } as never);
    mockGetOrCreateSession.mockResolvedValue({ id: "ledger-5b" } as never);

    await dispatchQueuedChannelMessages();

    expect(mockResolve).toHaveBeenCalledTimes(2);
    expect(mockResolve).toHaveBeenNthCalledWith(1, {
      chatIdentityId: "chat-1",
      channel: "telegram",
      conversationKey: "-100123",
    });
    expect(mockResolve).toHaveBeenNthCalledWith(2, {
      chatIdentityId: "chat-1",
      channel: "telegram",
      conversationKey: "-100123",
    });
    expect(mockGetOrCreateSession).toHaveBeenCalledWith("ws-5", "telegram", "-100123");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockComplete).toHaveBeenCalledWith("row-1");
    expect(mockFail).not.toHaveBeenCalled();
  });
});

describe("dispatchQueuedChannelMessages — sidecar failures", () => {
  it("fails the row when the sidecar returns non-200", async () => {
    mockClaim.mockResolvedValueOnce(row()).mockResolvedValueOnce(null);
    mockResolve.mockResolvedValue({ kind: "intro" } as never);
    mockGetOrCreateIntro.mockResolvedValue({ id: "ledger-intro-1" } as never);
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

    const result = await dispatchQueuedChannelMessages();

    expect(mockFail).toHaveBeenCalledWith("row-1", expect.stringContaining("500"));
    expect(mockComplete).not.toHaveBeenCalled();
    expect(mockBindEveSession).not.toHaveBeenCalled();
    expect(result).toEqual({ processed: 0, failed: 1 });
  });

  it("fails the row when the sidecar is unreachable (fetch throws)", async () => {
    mockClaim.mockResolvedValueOnce(row()).mockResolvedValueOnce(null);
    mockResolve.mockResolvedValue({ kind: "intro" } as never);
    mockGetOrCreateIntro.mockResolvedValue({ id: "ledger-intro-1" } as never);
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await dispatchQueuedChannelMessages();

    expect(mockFail).toHaveBeenCalledWith("row-1", expect.stringContaining("ECONNREFUSED"));
    expect(mockComplete).not.toHaveBeenCalled();
    expect(result).toEqual({ processed: 0, failed: 1 });
  });
});

describe("dispatchQueuedChannelMessages — poisoned rows never kill the loop", () => {
  it("continues to the next row after an unexpected throw mid-processing", async () => {
    mockClaim
      .mockResolvedValueOnce(row({ id: "row-bad" }))
      .mockResolvedValueOnce(row({ id: "row-good" }))
      .mockResolvedValueOnce(null);
    mockGetChatIdentity
      .mockRejectedValueOnce(new Error("db blip"))
      .mockResolvedValueOnce(IDENTITY);
    mockResolve.mockResolvedValue({ kind: "intro" } as never);
    mockGetOrCreateIntro.mockResolvedValue({ id: "ledger-intro-1" } as never);

    const result = await dispatchQueuedChannelMessages();

    expect(mockFail).toHaveBeenCalledWith("row-bad", expect.stringContaining("db blip"));
    expect(mockComplete).toHaveBeenCalledWith("row-good");
    expect(result).toEqual({ processed: 1, failed: 1 });
  });

  it("fails a row whose payload is malformed (no text/chatId) without calling identity lookup", async () => {
    mockClaim.mockResolvedValueOnce(row({ payload: { chatType: "private" } })).mockResolvedValueOnce(null);

    const result = await dispatchQueuedChannelMessages();

    expect(mockGetChatIdentity).not.toHaveBeenCalled();
    expect(mockFail).toHaveBeenCalledWith("row-1", expect.any(String));
    expect(result).toEqual({ processed: 0, failed: 1 });
  });

  it("fails a row with no resolvable chat identity (data-integrity guard, never crashes)", async () => {
    mockClaim.mockResolvedValueOnce(row()).mockResolvedValueOnce(null);
    mockGetChatIdentity.mockResolvedValueOnce(null);

    const result = await dispatchQueuedChannelMessages();

    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockFail).toHaveBeenCalledWith("row-1", expect.any(String));
    expect(result).toEqual({ processed: 0, failed: 1 });
  });

  it("fails, rather than processes, an out-of-scope inbox kind (approvals ride the Eve-native path)", async () => {
    mockClaim.mockResolvedValueOnce(row({ kind: "approval_response" })).mockResolvedValueOnce(null);

    const result = await dispatchQueuedChannelMessages();

    expect(mockGetChatIdentity).not.toHaveBeenCalled();
    expect(mockFail).toHaveBeenCalledWith("row-1", expect.any(String));
    expect(result).toEqual({ processed: 0, failed: 1 });
  });
});

describe("dispatchQueuedChannelMessages — in-process latch", () => {
  it("collapses two concurrent kicks into a single drain", async () => {
    mockClaim.mockResolvedValueOnce(row()).mockResolvedValueOnce(null);
    mockResolve.mockResolvedValue({ kind: "intro" } as never);
    mockGetOrCreateIntro.mockResolvedValue({ id: "ledger-intro-1" } as never);

    const first = dispatchQueuedChannelMessages();
    const second = dispatchQueuedChannelMessages();

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(mockReclaim).toHaveBeenCalledTimes(1);
    expect(mockClaim).toHaveBeenCalledTimes(2); // one row, then null — ONE drain's worth
    expect(firstResult).toEqual({ processed: 1, failed: 0 });
    expect(secondResult).toEqual(firstResult);
  });

  it("starts a fresh drain on a later, non-overlapping call", async () => {
    mockClaim.mockResolvedValueOnce(null);
    await dispatchQueuedChannelMessages();

    mockClaim.mockResolvedValueOnce(null);
    await dispatchQueuedChannelMessages();

    expect(mockReclaim).toHaveBeenCalledTimes(2);
  });
});
