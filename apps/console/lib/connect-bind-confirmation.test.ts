import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@agentrail/db-postgres", () => ({
  latestTelegramSessionForChatIdentity: vi.fn(),
}));
vi.mock("./telegram-system-message", () => ({
  sendSystemTelegramMessage: vi.fn(),
}));

import {
  shouldConfirmConnectBind,
  buildConnectBindConfirmationText,
  sendConnectBindConfirmation,
} from "./connect-bind-confirmation";
import { latestTelegramSessionForChatIdentity } from "@agentrail/db-postgres";
import { sendSystemTelegramMessage } from "./telegram-system-message";
import type { ConnectIdentityBindDecision } from "./connect-bind-decision";

const mockLatestSession = vi.mocked(latestTelegramSessionForChatIdentity);
const mockSend = vi.mocked(sendSystemTelegramMessage);

const FRESH_BIND_WITH_WORKSPACE: ConnectIdentityBindDecision = {
  kind: "fresh_bind",
  workspaceDecision: { action: "bind", workspace: { id: "ws-1", name: "Acme" } },
};
const FRESH_BIND_NO_WORKSPACE: ConnectIdentityBindDecision = {
  kind: "fresh_bind",
  workspaceDecision: { action: "skip", reason: "ambiguous_memberships" },
};
const ALREADY_YOURS_NEW_WORKSPACE: ConnectIdentityBindDecision = {
  kind: "already_yours",
  workspaceDecision: { action: "bind", workspace: { id: "ws-2", name: "Beta Corp" } },
};
const ALREADY_YOURS_PURE_REVISIT: ConnectIdentityBindDecision = {
  kind: "already_yours",
  workspaceDecision: { action: "skip", reason: "already_bound" },
};
const FOREIGN_USER: ConnectIdentityBindDecision = { kind: "foreign_user" };

const SESSION_ROW = {
  id: "session-1",
  workspaceId: "ws-1",
  chatIdentityId: "chat-identity-1",
  channel: "telegram",
  conversationKey: "tg-chat-42",
  eveSessionId: "eve-1",
  status: "active",
  lastActivityAt: new Date("2026-07-18T00:00:00Z"),
  createdAt: new Date("2026-07-18T00:00:00Z"),
  updatedAt: new Date("2026-07-18T00:00:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("shouldConfirmConnectBind", () => {
  it("true for fresh_bind, even without a new workspace bind", () => {
    expect(shouldConfirmConnectBind(FRESH_BIND_WITH_WORKSPACE)).toBe(true);
    expect(shouldConfirmConnectBind(FRESH_BIND_NO_WORKSPACE)).toBe(true);
  });

  it("true for already_yours ONLY when a NEW workspace bind just happened", () => {
    expect(shouldConfirmConnectBind(ALREADY_YOURS_NEW_WORKSPACE)).toBe(true);
  });

  it("false for already_yours with no new workspace bind — the pure idempotent revisit", () => {
    expect(shouldConfirmConnectBind(ALREADY_YOURS_PURE_REVISIT)).toBe(false);
  });

  it("false for foreign_user — never confirm a hijack attempt", () => {
    expect(shouldConfirmConnectBind(FOREIGN_USER)).toBe(false);
  });
});

describe("buildConnectBindConfirmationText", () => {
  it("names the account and invites use, with no workspace clause when none given", () => {
    const text = buildConnectBindConfirmationText({ accountLabel: "Ada" });
    expect(text).toBe("GitHub connected: Ada. You can ask me to use it now.");
  });

  it("includes the workspace clause when a workspace name is given", () => {
    const text = buildConnectBindConfirmationText({ accountLabel: "Ada", workspaceName: "Acme" });
    expect(text).toBe("GitHub connected: Ada. Workspace: Acme. You can ask me to use it now.");
  });

  it("is plain text, no markdown", () => {
    const text = buildConnectBindConfirmationText({ accountLabel: "Ada", workspaceName: "Acme" });
    expect(text).not.toMatch(/[*_`[\]]/);
  });

  it("issue #1264 PR 2/2: ownershipCompleted true + a workspace name — ownership line replaces the neutral workspace clause", () => {
    const text = buildConnectBindConfirmationText({
      accountLabel: "Ada",
      workspaceName: "Acme",
      ownershipCompleted: true,
    });
    expect(text).toBe("GitHub connected: Ada. You now own Acme. You can ask me to use it now.");
  });

  it("ownershipCompleted true with no workspace name (lookup failed): generic fallback, never blank", () => {
    const text = buildConnectBindConfirmationText({
      accountLabel: "Ada",
      ownershipCompleted: true,
    });
    expect(text).toBe(
      "GitHub connected: Ada. You now own this workspace. You can ask me to use it now."
    );
  });

  it("ownershipCompleted false (default) with a workspace name: unchanged neutral 'Workspace: X.' wording", () => {
    const text = buildConnectBindConfirmationText({
      accountLabel: "Ada",
      workspaceName: "Acme",
      ownershipCompleted: false,
    });
    expect(text).toBe("GitHub connected: Ada. Workspace: Acme. You can ask me to use it now.");
  });
});

describe("sendConnectBindConfirmation", () => {
  it("fresh_bind + new workspace bind: looks up the latest telegram session and sends the right chatId/text", async () => {
    mockLatestSession.mockResolvedValue(SESSION_ROW as never);
    mockSend.mockResolvedValue({ ok: true });

    await sendConnectBindConfirmation({
      chatIdentityId: "chat-identity-1",
      decision: FRESH_BIND_WITH_WORKSPACE,
      accountLabel: "Ada",
    });

    expect(mockLatestSession).toHaveBeenCalledWith("chat-identity-1");
    expect(mockSend).toHaveBeenCalledWith(
      "tg-chat-42",
      "GitHub connected: Ada. Workspace: Acme. You can ask me to use it now."
    );
  });

  it("fresh_bind with no workspace bind (e.g. ambiguous memberships): still sends, without the workspace clause", async () => {
    mockLatestSession.mockResolvedValue(SESSION_ROW as never);
    mockSend.mockResolvedValue({ ok: true });

    await sendConnectBindConfirmation({
      chatIdentityId: "chat-identity-1",
      decision: FRESH_BIND_NO_WORKSPACE,
      accountLabel: "Ada",
    });

    expect(mockSend).toHaveBeenCalledWith(
      "tg-chat-42",
      "GitHub connected: Ada. You can ask me to use it now."
    );
  });

  it("already_yours + a NEW workspace bind: sends", async () => {
    mockLatestSession.mockResolvedValue(SESSION_ROW as never);
    mockSend.mockResolvedValue({ ok: true });

    await sendConnectBindConfirmation({
      chatIdentityId: "chat-identity-1",
      decision: ALREADY_YOURS_NEW_WORKSPACE,
      accountLabel: "Ada",
    });

    expect(mockSend).toHaveBeenCalledWith(
      "tg-chat-42",
      "GitHub connected: Ada. Workspace: Beta Corp. You can ask me to use it now."
    );
  });

  it("already_yours pure idempotent revisit: does NOT look up a session or send anything", async () => {
    await sendConnectBindConfirmation({
      chatIdentityId: "chat-identity-1",
      decision: ALREADY_YOURS_PURE_REVISIT,
      accountLabel: "Ada",
    });

    expect(mockLatestSession).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("foreign_user: does NOT look up a session or send anything", async () => {
    await sendConnectBindConfirmation({
      chatIdentityId: "chat-identity-1",
      decision: FOREIGN_USER,
      accountLabel: "Ada",
    });

    expect(mockLatestSession).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("no telegram session exists for the identity: skips silently, never calls send", async () => {
    mockLatestSession.mockResolvedValue(null);

    await expect(
      sendConnectBindConfirmation({
        chatIdentityId: "chat-identity-1",
        decision: FRESH_BIND_WITH_WORKSPACE,
        accountLabel: "Ada",
      })
    ).resolves.toBeUndefined();

    expect(mockSend).not.toHaveBeenCalled();
  });

  it("never rejects even when the Telegram send fails (typed { ok: false }) — a failed confirmation must not fail the caller", async () => {
    mockLatestSession.mockResolvedValue(SESSION_ROW as never);
    mockSend.mockResolvedValue({ ok: false, error: "Couldn't reach Telegram to send the message — try again." });

    await expect(
      sendConnectBindConfirmation({
        chatIdentityId: "chat-identity-1",
        decision: FRESH_BIND_WITH_WORKSPACE,
        accountLabel: "Ada",
      })
    ).resolves.toBeUndefined();
  });

  it("never rejects even when sendSystemTelegramMessage itself throws/rejects unexpectedly", async () => {
    mockLatestSession.mockResolvedValue(SESSION_ROW as never);
    mockSend.mockRejectedValue(new Error("unexpected throw"));

    await expect(
      sendConnectBindConfirmation({
        chatIdentityId: "chat-identity-1",
        decision: FRESH_BIND_WITH_WORKSPACE,
        accountLabel: "Ada",
      })
    ).resolves.toBeUndefined();
  });

  it("never rejects even when the session lookup itself throws/rejects unexpectedly", async () => {
    mockLatestSession.mockRejectedValue(new Error("db unreachable"));

    await expect(
      sendConnectBindConfirmation({
        chatIdentityId: "chat-identity-1",
        decision: FRESH_BIND_WITH_WORKSPACE,
        accountLabel: "Ada",
      })
    ).resolves.toBeUndefined();

    expect(mockSend).not.toHaveBeenCalled();
  });

  describe("ownerElectCompletion (issue #1264 PR 2/2)", () => {
    it("completed:true + name: extends the text with the ownership line, even when the decision itself carries no workspace bind", async () => {
      mockLatestSession.mockResolvedValue(SESSION_ROW as never);
      mockSend.mockResolvedValue({ ok: true });

      await sendConnectBindConfirmation({
        chatIdentityId: "chat-identity-1",
        decision: FRESH_BIND_NO_WORKSPACE,
        accountLabel: "Ada",
        ownerElectCompletion: { completed: true, workspaceName: "Acme" },
      });

      expect(mockSend).toHaveBeenCalledWith(
        "tg-chat-42",
        "GitHub connected: Ada. You now own Acme. You can ask me to use it now."
      );
    });

    it("completed:true, no name (lookup failed): generic fallback ownership line, never blank", async () => {
      mockLatestSession.mockResolvedValue(SESSION_ROW as never);
      mockSend.mockResolvedValue({ ok: true });

      await sendConnectBindConfirmation({
        chatIdentityId: "chat-identity-1",
        decision: FRESH_BIND_NO_WORKSPACE,
        accountLabel: "Ada",
        ownerElectCompletion: { completed: true, workspaceName: null },
      });

      expect(mockSend).toHaveBeenCalledWith(
        "tg-chat-42",
        "GitHub connected: Ada. You now own this workspace. You can ask me to use it now."
      );
    });

    it("completed:false: falls back to the pre-existing decision.workspaceDecision wording, unaffected", async () => {
      mockLatestSession.mockResolvedValue(SESSION_ROW as never);
      mockSend.mockResolvedValue({ ok: true });

      await sendConnectBindConfirmation({
        chatIdentityId: "chat-identity-1",
        decision: FRESH_BIND_WITH_WORKSPACE,
        accountLabel: "Ada",
        ownerElectCompletion: { completed: false, workspaceName: null },
      });

      expect(mockSend).toHaveBeenCalledWith(
        "tg-chat-42",
        "GitHub connected: Ada. Workspace: Acme. You can ask me to use it now."
      );
    });

    it("omitted entirely: behaves exactly as before this PR (backward compatible)", async () => {
      mockLatestSession.mockResolvedValue(SESSION_ROW as never);
      mockSend.mockResolvedValue({ ok: true });

      await sendConnectBindConfirmation({
        chatIdentityId: "chat-identity-1",
        decision: FRESH_BIND_WITH_WORKSPACE,
        accountLabel: "Ada",
      });

      expect(mockSend).toHaveBeenCalledWith(
        "tg-chat-42",
        "GitHub connected: Ada. Workspace: Acme. You can ask me to use it now."
      );
    });

    it("takes precedence over decision.workspaceDecision's own workspace name when both are somehow present (defensive — real callers never produce both)", async () => {
      mockLatestSession.mockResolvedValue(SESSION_ROW as never);
      mockSend.mockResolvedValue({ ok: true });

      await sendConnectBindConfirmation({
        chatIdentityId: "chat-identity-1",
        decision: FRESH_BIND_WITH_WORKSPACE, // workspaceDecision names "Acme"
        accountLabel: "Ada",
        ownerElectCompletion: { completed: true, workspaceName: "Beta Corp" },
      });

      expect(mockSend).toHaveBeenCalledWith(
        "tg-chat-42",
        "GitHub connected: Ada. You now own Beta Corp. You can ask me to use it now."
      );
    });
  });
});
