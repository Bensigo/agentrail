import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@agentrail/db-postgres", () => ({
  latestTelegramSessionForChatIdentity: vi.fn(),
}));
vi.mock("./telegram-system-message", () => ({
  sendSystemTelegramMessage: vi.fn(),
}));

import {
  buildSignupConfirmationText,
  sendSignupConfirmation,
} from "./signup-confirmation";
import { latestTelegramSessionForChatIdentity } from "@agentrail/db-postgres";
import { sendSystemTelegramMessage } from "./telegram-system-message";

const mockLatestSession = vi.mocked(latestTelegramSessionForChatIdentity);
const mockSend = vi.mocked(sendSystemTelegramMessage);

const SESSION_ROW = {
  id: "session-1",
  workspaceId: null,
  chatIdentityId: "chat-identity-1",
  channel: "telegram",
  conversationKey: "tg-chat-42",
  eveSessionId: "eve-1",
  status: "active",
  lastActivityAt: new Date("2026-07-22T00:00:00Z"),
  createdAt: new Date("2026-07-22T00:00:00Z"),
  updatedAt: new Date("2026-07-22T00:00:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildSignupConfirmationText", () => {
  it("invites the user to ask Jace to set up a workspace when ownership wasn't completed", () => {
    const text = buildSignupConfirmationText({ accountLabel: "Ada" });
    expect(text).toBe(
      "You're signed up, Ada. Ask me to set up your workspace and I'll pick up right here."
    );
  });

  it("swaps in the ownership line when ownershipCompleted is true, with a workspace name", () => {
    const text = buildSignupConfirmationText({
      accountLabel: "Ada",
      ownershipCompleted: true,
      workspaceName: "Acme",
    });
    expect(text).toBe("You're signed up, Ada. You now own Acme.");
  });

  it("ownershipCompleted true with no workspace name (lookup failed): generic fallback, never blank", () => {
    const text = buildSignupConfirmationText({
      accountLabel: "Ada",
      ownershipCompleted: true,
      workspaceName: null,
    });
    expect(text).toBe("You're signed up, Ada. You now own this workspace.");
  });

  it("is plain text, no markdown", () => {
    const text = buildSignupConfirmationText({
      accountLabel: "Ada",
      ownershipCompleted: true,
      workspaceName: "Acme",
    });
    expect(text).not.toMatch(/[*_`[\]]/);
  });
});

describe("sendSignupConfirmation", () => {
  it("looks up the latest telegram session and sends the right chatId/text", async () => {
    mockLatestSession.mockResolvedValue(SESSION_ROW as never);
    mockSend.mockResolvedValue({ ok: true });

    await sendSignupConfirmation({
      chatIdentityId: "chat-identity-1",
      accountLabel: "Ada",
    });

    expect(mockLatestSession).toHaveBeenCalledWith("chat-identity-1");
    expect(mockSend).toHaveBeenCalledWith(
      "tg-chat-42",
      "You're signed up, Ada. Ask me to set up your workspace and I'll pick up right here."
    );
  });

  it("sends the ownership-flavored text when ownerElectCompletion.completed is true", async () => {
    mockLatestSession.mockResolvedValue(SESSION_ROW as never);
    mockSend.mockResolvedValue({ ok: true });

    await sendSignupConfirmation({
      chatIdentityId: "chat-identity-1",
      accountLabel: "Ada",
      ownerElectCompletion: { completed: true, workspaceName: "Acme" },
    });

    expect(mockSend).toHaveBeenCalledWith("tg-chat-42", "You're signed up, Ada. You now own Acme.");
  });

  it("no telegram session exists for the identity: skips silently, never calls send", async () => {
    mockLatestSession.mockResolvedValue(null);

    await expect(
      sendSignupConfirmation({ chatIdentityId: "chat-identity-1", accountLabel: "Ada" })
    ).resolves.toBeUndefined();

    expect(mockSend).not.toHaveBeenCalled();
  });

  it("never rejects even when the Telegram send fails (typed { ok: false })", async () => {
    mockLatestSession.mockResolvedValue(SESSION_ROW as never);
    mockSend.mockResolvedValue({ ok: false, error: "Couldn't reach Telegram." });

    await expect(
      sendSignupConfirmation({ chatIdentityId: "chat-identity-1", accountLabel: "Ada" })
    ).resolves.toBeUndefined();
  });

  it("never rejects even when sendSystemTelegramMessage itself throws/rejects unexpectedly", async () => {
    mockLatestSession.mockResolvedValue(SESSION_ROW as never);
    mockSend.mockRejectedValue(new Error("unexpected throw"));

    await expect(
      sendSignupConfirmation({ chatIdentityId: "chat-identity-1", accountLabel: "Ada" })
    ).resolves.toBeUndefined();
  });

  it("never rejects even when the session lookup itself throws/rejects unexpectedly", async () => {
    mockLatestSession.mockRejectedValue(new Error("db unreachable"));

    await expect(
      sendSignupConfirmation({ chatIdentityId: "chat-identity-1", accountLabel: "Ada" })
    ).resolves.toBeUndefined();

    expect(mockSend).not.toHaveBeenCalled();
  });
});
