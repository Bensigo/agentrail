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
  latestRunForIssue: vi.fn(),
}));

// Stub ONLY the network-performing send; keep the REAL pure message
// builders via importActual so wording changes can't silently drift
// between this mock and the actual implementation (test-hygiene fix).
vi.mock("./telegram-system-message", async () => {
  const actual = await vi.importActual<typeof import("./telegram-system-message")>(
    "./telegram-system-message"
  );
  return {
    ...actual,
    sendSystemTelegramMessage: vi.fn(),
  };
});

// #1284: Discord's own system-message sender, stubbed the same way.
vi.mock("./discord-system-message", () => ({
  sendSystemDiscordMessage: vi.fn(),
}));

// #1285: Slack's own system-message sender, stubbed the same way.
vi.mock("./slack-system-message", () => ({
  sendSystemSlackMessage: vi.fn(),
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
  latestRunForIssue,
} from "@agentrail/db-postgres";
import { sendSystemTelegramMessage } from "./telegram-system-message";
import { sendSystemDiscordMessage } from "./discord-system-message";
import { sendSystemSlackMessage } from "./slack-system-message";
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
const mockSendSystemDiscord = vi.mocked(sendSystemDiscordMessage);
const mockSendSystemSlack = vi.mocked(sendSystemSlackMessage);
const mockLatestRunForIssue = vi.mocked(latestRunForIssue);

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
  mockSendSystemDiscord.mockResolvedValue({ ok: true });
  mockSendSystemSlack.mockResolvedValue({ ok: true });
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ sessionId: "eve-sess-1", continuationToken: "tok-1" }),
  });
  // #1277: unused by any row without a replyContext (the overwhelming
  // majority of existing tests) — a harmless default for the few that do.
  mockLatestRunForIssue.mockResolvedValue(null);
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

describe("dispatchQueuedChannelMessages — 'ask' kind — name-vs-index precedence (reviewer Important #3)", () => {
  // A workspace literally named "2" sits at position 1 (index 0) — a
  // DIFFERENT position than what a numeric-first parse of the reply "2"
  // would index to (position 2, "Other"). This is the exact mis-pin the
  // reviewer flagged: an exact name match must win before a numeric index
  // is even considered.
  const NAME_COLLIDES_WITH_INDEX_OPTIONS = [
    { id: "ws-named-2", name: "2" },
    { id: "ws-other", name: "Other" },
  ];

  it("an exact name match wins over the numeric-index reading of the same text", async () => {
    mockClaim.mockResolvedValueOnce(row({ payload: { chatId: -100123, text: "2" } })).mockResolvedValueOnce(null);
    mockResolve.mockResolvedValue({ kind: "ask", options: NAME_COLLIDES_WITH_INDEX_OPTIONS } as never);
    mockPin.mockResolvedValue({ ok: true, sessionId: "pin-sess-named-2" } as never);

    await dispatchQueuedChannelMessages();

    // Pins the workspace NAMED "2" (position 1) — NOT position 2 ("Other"),
    // which is what treating "2" as a 1-indexed position (index 2-1=1)
    // would have wrongly picked.
    expect(mockPin).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-named-2" }),
    );
  });

  it("still falls back to the 1-indexed position when no workspace name matches the reply", async () => {
    mockClaim.mockResolvedValueOnce(row({ payload: { chatId: -100123, text: "1" } })).mockResolvedValueOnce(null);
    mockResolve.mockResolvedValue({ kind: "ask", options: NAME_COLLIDES_WITH_INDEX_OPTIONS } as never);
    mockPin.mockResolvedValue({ ok: true, sessionId: "pin-sess-pos-1" } as never);

    await dispatchQueuedChannelMessages();

    // No workspace is named "1", so this reply falls through to the numeric
    // path and resolves position 1 (index 0) — ws-named-2, in this fixture,
    // reached via the INDEX path rather than the name-match path.
    expect(mockPin).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-named-2" }),
    );
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
          channel: "telegram",
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
        // Fix 2 (reviewer Important #1): every hosted-inbound fetch now
        // carries a bounded AbortSignal — see the "sidecar timeout" describe
        // below for the dedicated timeout/abort coverage.
        signal: expect.any(AbortSignal),
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

describe("dispatchQueuedChannelMessages — sidecar timeout (reviewer Important #1)", () => {
  it("wires a bounded AbortSignal onto the hosted-inbound fetch call", async () => {
    mockClaim.mockResolvedValueOnce(row()).mockResolvedValueOnce(null);
    mockResolve.mockResolvedValue({ kind: "intro" } as never);
    mockGetOrCreateIntro.mockResolvedValue({ id: "ledger-intro-1" } as never);

    await dispatchQueuedChannelMessages();

    const init = mockFetch.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("aborts a hanging fetch after the bounded timeout and fails the row (never wedges the drain)", async () => {
    vi.useFakeTimers();
    try {
      mockClaim.mockResolvedValueOnce(row()).mockResolvedValueOnce(null);
      mockResolve.mockResolvedValue({ kind: "intro" } as never);
      mockGetOrCreateIntro.mockResolvedValue({ id: "ledger-intro-1" } as never);
      // A faithful stand-in for real fetch's own abort contract: the promise
      // never settles on its own, only when the wired signal fires.
      mockFetch.mockImplementation((_url: unknown, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        });
      });

      const pending = dispatchQueuedChannelMessages();
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await pending;

      expect(mockFail).toHaveBeenCalledWith(
        "row-1",
        expect.stringContaining("hosted-inbound unreachable"),
      );
      expect(mockComplete).not.toHaveBeenCalled();
      expect(mockBindEveSession).not.toHaveBeenCalled();
      expect(result).toEqual({ processed: 0, failed: 1 });
    } finally {
      vi.useRealTimers();
    }
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

describe("dispatchQueuedChannelMessages — reply-context injection (#1277 replyable run-outcome threads)", () => {
  function rowWithReply(issueNumber: number, text = "why did this fail?") {
    return row({
      payload: {
        chatId: -100123,
        text,
        replyContext: { kind: "run_outcome", issueNumber },
      },
    });
  }

  it("prepends the found-run preface and calls latestRunForIssue with the conversation's OWN resolved workspace", async () => {
    mockClaim.mockResolvedValueOnce(rowWithReply(42)).mockResolvedValueOnce(null);
    mockResolve.mockResolvedValue({
      kind: "pinned",
      workspaceId: "ws-9",
      sessionId: "pin-sess-9",
      ambiguous: false,
    } as never);
    mockGetOrCreateSession.mockResolvedValue({ id: "ledger-9" } as never);
    mockLatestRunForIssue.mockResolvedValue({ runId: "run-abc", state: "failed" });

    await dispatchQueuedChannelMessages();

    expect(mockLatestRunForIssue).toHaveBeenCalledWith("ws-9", 42);
    const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string);
    expect(body.message).toBe(
      "[reply to the run-outcome notification for issue #42 — latest run: run-abc, state: failed]\nwhy did this fail?"
    );
  });

  it("prepends an HONEST not-found preface when no run matches, and the turn still proceeds as plain chat (not blocked)", async () => {
    mockClaim.mockResolvedValueOnce(rowWithReply(42)).mockResolvedValueOnce(null);
    mockResolve.mockResolvedValue({
      kind: "pinned",
      workspaceId: "ws-9",
      sessionId: "pin-sess-9",
      ambiguous: false,
    } as never);
    mockGetOrCreateSession.mockResolvedValue({ id: "ledger-9" } as never);
    mockLatestRunForIssue.mockResolvedValue(null);

    const result = await dispatchQueuedChannelMessages();

    const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string);
    expect(body.message).toBe(
      "[reply to the run-outcome notification for issue #42 — no matching run found]\nwhy did this fail?"
    );
    expect(mockComplete).toHaveBeenCalledWith("row-1");
    expect(result).toEqual({ processed: 1, failed: 0 });
  });

  it("does NOT call latestRunForIssue and sends the message UNTOUCHED when there is no replyContext (regression: plain messages unaffected)", async () => {
    mockClaim.mockResolvedValueOnce(row()).mockResolvedValueOnce(null); // default row(), no replyContext
    mockResolve.mockResolvedValue({
      kind: "pinned",
      workspaceId: "ws-9",
      sessionId: "pin-sess-9",
      ambiguous: false,
    } as never);
    mockGetOrCreateSession.mockResolvedValue({ id: "ledger-9" } as never);

    await dispatchQueuedChannelMessages();

    expect(mockLatestRunForIssue).not.toHaveBeenCalled();
    const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string);
    expect(body.message).toBe("hello jace");
  });

  it("does NOT call latestRunForIssue when the conversation has no workspace yet ('intro' — nothing to scope the lookup to)", async () => {
    mockClaim.mockResolvedValueOnce(rowWithReply(42)).mockResolvedValueOnce(null);
    mockResolve.mockResolvedValue({ kind: "intro" } as never);
    mockGetOrCreateIntro.mockResolvedValue({ id: "ledger-intro-1" } as never);

    await dispatchQueuedChannelMessages();

    expect(mockLatestRunForIssue).not.toHaveBeenCalled();
    const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string);
    expect(body.message).toBe("why did this fail?");
  });

  it("THREAT MODEL: resolves a forged/lookalike reply within the caller's OWN workspace only, never a different one (ws-alpha case)", async () => {
    mockClaim.mockResolvedValueOnce(rowWithReply(999999)).mockResolvedValueOnce(null);
    mockResolve.mockResolvedValue({
      kind: "pinned",
      workspaceId: "ws-alpha",
      sessionId: "s1",
      ambiguous: false,
    } as never);
    mockGetOrCreateSession.mockResolvedValue({ id: "ledger-alpha" } as never);
    mockLatestRunForIssue.mockResolvedValue(null);

    await dispatchQueuedChannelMessages();

    expect(mockLatestRunForIssue).toHaveBeenCalledWith("ws-alpha", 999999);
    expect(mockLatestRunForIssue).not.toHaveBeenCalledWith("ws-beta", 999999);
    const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string);
    expect(body.message).toContain("no matching run found");
  });

  it("THREAT MODEL: the SAME forged issue number resolves independently in a different workspace — no cross-tenant leak (ws-beta case)", async () => {
    mockClaim.mockResolvedValueOnce(rowWithReply(999999)).mockResolvedValueOnce(null);
    mockResolve.mockResolvedValue({
      kind: "pinned",
      workspaceId: "ws-beta",
      sessionId: "s2",
      ambiguous: false,
    } as never);
    mockGetOrCreateSession.mockResolvedValue({ id: "ledger-beta" } as never);
    mockLatestRunForIssue.mockResolvedValue({ runId: "run-beta-1", state: "success" });

    await dispatchQueuedChannelMessages();

    expect(mockLatestRunForIssue).toHaveBeenCalledWith("ws-beta", 999999);
    expect(mockLatestRunForIssue).not.toHaveBeenCalledWith("ws-alpha", 999999);
    const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string);
    expect(body.message).toContain("run-beta-1");
  });
});

// --- #1284: Discord rows ride the SAME dispatcher, additively ---------------
//
// The webhook route (connectors/discord/webhook/route.ts) enqueues a Discord
// row's target under the SAME internal `chatId` payload field Telegram uses
// (so extractPayload above needs no fork); these tests prove the two
// channel-specific seams that DO differ — the hosted-inbound wire shape
// (`channel` + `channelId`-keyed target) and which system-message sender
// handles the 'ask'/pin flow — both come out right for a `channel: "discord"`
// row, without touching a single Telegram-path assertion above.

function discordRow(overrides: Partial<ClaimedChannelInboxRow> & { payload?: unknown } = {}): ClaimedChannelInboxRow {
  return row({
    channel: "discord",
    conversationKey: "998877",
    providerMessageId: "998877:1",
    payload: { chatId: "998877", text: "hello jace" },
    ...overrides,
  });
}

const DISCORD_IDENTITY = { id: "chat-discord-1", platform: "discord", platformUserId: "555" } as never;

describe("dispatchQueuedChannelMessages — discord rows (#1284)", () => {
  it("posts to hosted-inbound with channel: 'discord' and a channelId-keyed target (not chatId)", async () => {
    mockClaim.mockResolvedValueOnce(discordRow()).mockResolvedValueOnce(null);
    mockGetChatIdentity.mockResolvedValue(DISCORD_IDENTITY);
    mockResolve.mockResolvedValue({ kind: "intro" } as never);
    mockGetOrCreateIntro.mockResolvedValue({ id: "ledger-discord-1" } as never);

    await dispatchQueuedChannelMessages();

    expect(mockGetChatIdentity).toHaveBeenCalledWith("discord", "555");
    const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string);
    expect(body.channel).toBe("discord");
    expect(body.target).toEqual({ channelId: "998877" });
    expect(body.target).not.toHaveProperty("chatId");
    expect(mockBindEveSession).toHaveBeenCalledWith("ledger-discord-1", "eve-sess-1");
    expect(mockComplete).toHaveBeenCalledWith("row-1");
  });

  it("resolves conversation -> workspace scoped to channel: 'discord' (never bleeds into telegram's identity space)", async () => {
    mockClaim.mockResolvedValueOnce(discordRow()).mockResolvedValueOnce(null);
    mockGetChatIdentity.mockResolvedValue(DISCORD_IDENTITY);
    mockResolve.mockResolvedValue({ kind: "pinned", workspaceId: "ws-9", sessionId: "s-9", ambiguous: false } as never);
    mockGetOrCreateSession.mockResolvedValue({ id: "ledger-9" } as never);

    await dispatchQueuedChannelMessages();

    expect(mockResolve).toHaveBeenCalledWith({
      chatIdentityId: "chat-discord-1",
      channel: "discord",
      conversationKey: "998877",
    });
    expect(mockGetOrCreateSession).toHaveBeenCalledWith("ws-9", "discord", "998877");
  });

  it("'ask' kind on a discord row sends the workspace-choice message via sendSystemDiscordMessage, never sendSystemTelegramMessage", async () => {
    const OPTIONS = [{ id: "ws-1", name: "Acme" }, { id: "ws-2", name: "Widgets" }];
    mockClaim.mockResolvedValueOnce(discordRow({ payload: { chatId: "998877", text: "hi jace" } })).mockResolvedValueOnce(null);
    mockGetChatIdentity.mockResolvedValue(DISCORD_IDENTITY);
    mockResolve.mockResolvedValue({ kind: "ask", options: OPTIONS } as never);

    await dispatchQueuedChannelMessages();

    expect(mockSendSystemDiscord).toHaveBeenCalledWith("998877", expect.stringContaining("Acme"));
    expect(mockSendSystem).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockComplete).toHaveBeenCalledWith("row-1");
  });

  it("'ask' kind on a discord row: a valid workspace-name reply pins and sends the pin confirmation via sendSystemDiscordMessage", async () => {
    const OPTIONS = [{ id: "ws-1", name: "Acme" }, { id: "ws-2", name: "Widgets" }];
    mockClaim.mockResolvedValueOnce(discordRow({ payload: { chatId: "998877", text: "Acme" } })).mockResolvedValueOnce(null);
    mockGetChatIdentity.mockResolvedValue(DISCORD_IDENTITY);
    mockResolve.mockResolvedValue({ kind: "ask", options: OPTIONS } as never);
    mockPin.mockResolvedValue({ ok: true, sessionId: "pin-1" } as never);

    await dispatchQueuedChannelMessages();

    expect(mockPin).toHaveBeenCalledWith({
      chatIdentityId: "chat-discord-1",
      channel: "discord",
      conversationKey: "998877",
      workspaceId: "ws-1",
    });
    expect(mockSendSystemDiscord).toHaveBeenCalledWith("998877", expect.stringContaining("Acme"));
    expect(mockSendSystem).not.toHaveBeenCalled();
  });

  it("a sidecar failure fails the row exactly like a telegram row (channel-agnostic error handling)", async () => {
    mockClaim.mockResolvedValueOnce(discordRow()).mockResolvedValueOnce(null);
    mockGetChatIdentity.mockResolvedValue(DISCORD_IDENTITY);
    mockResolve.mockResolvedValue({ kind: "intro" } as never);
    mockGetOrCreateIntro.mockResolvedValue({ id: "ledger-discord-1" } as never);
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

    await dispatchQueuedChannelMessages();

    expect(mockFail).toHaveBeenCalledWith("row-1", expect.stringContaining("hosted-inbound returned 500"));
    expect(mockComplete).not.toHaveBeenCalled();
  });
});

// --- #1285: Slack rows ride the SAME dispatcher, additively -----------------
//
// Mirrors the Discord block above exactly: the Slack Events webhook route
// (connectors/slack/events/route.ts) enqueues a Slack row's target under the
// SAME internal `chatId` payload field, so extractPayload needs no fork here
// either.

function slackRow(overrides: Partial<ClaimedChannelInboxRow> & { payload?: unknown } = {}): ClaimedChannelInboxRow {
  return row({
    channel: "slack",
    conversationKey: "D0PNCRP9N",
    providerMessageId: "D0PNCRP9N:1",
    payload: { chatId: "D0PNCRP9N", text: "hello jace" },
    ...overrides,
  });
}

const SLACK_IDENTITY = { id: "chat-slack-1", platform: "slack", platformUserId: "U061F7AUR" } as never;

describe("dispatchQueuedChannelMessages — slack rows (#1285)", () => {
  it("posts to hosted-inbound with channel: 'slack' and a channelId-keyed target (not chatId)", async () => {
    mockClaim.mockResolvedValueOnce(slackRow()).mockResolvedValueOnce(null);
    mockGetChatIdentity.mockResolvedValue(SLACK_IDENTITY);
    mockResolve.mockResolvedValue({ kind: "intro" } as never);
    mockGetOrCreateIntro.mockResolvedValue({ id: "ledger-slack-1" } as never);

    await dispatchQueuedChannelMessages();

    expect(mockGetChatIdentity).toHaveBeenCalledWith("slack", "555");
    const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string);
    expect(body.channel).toBe("slack");
    expect(body.target).toEqual({ channelId: "D0PNCRP9N" });
    expect(body.target).not.toHaveProperty("chatId");
    expect(mockBindEveSession).toHaveBeenCalledWith("ledger-slack-1", "eve-sess-1");
    expect(mockComplete).toHaveBeenCalledWith("row-1");
  });

  it("resolves conversation -> workspace scoped to channel: 'slack'", async () => {
    mockClaim.mockResolvedValueOnce(slackRow()).mockResolvedValueOnce(null);
    mockGetChatIdentity.mockResolvedValue(SLACK_IDENTITY);
    mockResolve.mockResolvedValue({ kind: "pinned", workspaceId: "ws-9", sessionId: "s-9", ambiguous: false } as never);
    mockGetOrCreateSession.mockResolvedValue({ id: "ledger-9" } as never);

    await dispatchQueuedChannelMessages();

    expect(mockResolve).toHaveBeenCalledWith({
      chatIdentityId: "chat-slack-1",
      channel: "slack",
      conversationKey: "D0PNCRP9N",
    });
    expect(mockGetOrCreateSession).toHaveBeenCalledWith("ws-9", "slack", "D0PNCRP9N");
  });

  it("'ask' kind on a slack row sends the workspace-choice message via sendSystemSlackMessage, never the other channels' senders", async () => {
    const OPTIONS = [{ id: "ws-1", name: "Acme" }, { id: "ws-2", name: "Widgets" }];
    mockClaim.mockResolvedValueOnce(slackRow({ payload: { chatId: "D0PNCRP9N", text: "hi jace" } })).mockResolvedValueOnce(null);
    mockGetChatIdentity.mockResolvedValue(SLACK_IDENTITY);
    mockResolve.mockResolvedValue({ kind: "ask", options: OPTIONS } as never);

    await dispatchQueuedChannelMessages();

    expect(mockSendSystemSlack).toHaveBeenCalledWith("D0PNCRP9N", expect.stringContaining("Acme"));
    expect(mockSendSystem).not.toHaveBeenCalled();
    expect(mockSendSystemDiscord).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockComplete).toHaveBeenCalledWith("row-1");
  });

  it("'ask' kind on a slack row: a valid workspace-name reply pins and sends the pin confirmation via sendSystemSlackMessage", async () => {
    const OPTIONS = [{ id: "ws-1", name: "Acme" }, { id: "ws-2", name: "Widgets" }];
    mockClaim.mockResolvedValueOnce(slackRow({ payload: { chatId: "D0PNCRP9N", text: "Acme" } })).mockResolvedValueOnce(null);
    mockGetChatIdentity.mockResolvedValue(SLACK_IDENTITY);
    mockResolve.mockResolvedValue({ kind: "ask", options: OPTIONS } as never);
    mockPin.mockResolvedValue({ ok: true, sessionId: "pin-1" } as never);

    await dispatchQueuedChannelMessages();

    expect(mockPin).toHaveBeenCalledWith({
      chatIdentityId: "chat-slack-1",
      channel: "slack",
      conversationKey: "D0PNCRP9N",
      workspaceId: "ws-1",
    });
    expect(mockSendSystemSlack).toHaveBeenCalledWith("D0PNCRP9N", expect.stringContaining("Acme"));
  });

  it("a sidecar failure fails the row exactly like a telegram/discord row (channel-agnostic error handling)", async () => {
    mockClaim.mockResolvedValueOnce(slackRow()).mockResolvedValueOnce(null);
    mockGetChatIdentity.mockResolvedValue(SLACK_IDENTITY);
    mockResolve.mockResolvedValue({ kind: "intro" } as never);
    mockGetOrCreateIntro.mockResolvedValue({ id: "ledger-slack-1" } as never);
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

    await dispatchQueuedChannelMessages();

    expect(mockFail).toHaveBeenCalledWith("row-1", expect.stringContaining("hosted-inbound returned 500"));
    expect(mockComplete).not.toHaveBeenCalled();
  });
});
