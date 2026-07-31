import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@agentrail/db-postgres", () => ({
  latestTelegramSessionForWorkspace: vi.fn(),
}));
vi.mock("../../../../../lib/telegram-system-message", () => ({
  sendSystemTelegramMessage: vi.fn(),
}));
vi.mock("../../../../../lib/discord-system-message", () => ({
  sendSystemDiscordMessage: vi.fn(),
}));

import {
  buildBudgetExhaustedMessage,
  notifyWorkspaceBudgetExhausted,
  buildCapacityPausedMessage,
  buildCapacityWarningMessage,
  notifyAccountCapacity,
} from "./notify";
import { latestTelegramSessionForWorkspace } from "@agentrail/db-postgres";
import { sendSystemTelegramMessage } from "../../../../../lib/telegram-system-message";
import { sendSystemDiscordMessage } from "../../../../../lib/discord-system-message";

const mockLatestSession = vi.mocked(latestTelegramSessionForWorkspace);
const mockSend = vi.mocked(sendSystemTelegramMessage);
const mockSendDiscord = vi.mocked(sendSystemDiscordMessage);

const WS = "ws-1";

const SESSION = {
  id: "session-1",
  workspaceId: WS,
  chatIdentityId: null,
  channel: "telegram",
  conversationKey: "tg-chat-42",
  eveSessionId: "eve-1",
  status: "active",
  lastActivityAt: new Date("2026-07-18T00:00:00Z"),
  createdAt: new Date("2026-07-01T00:00:00Z"),
  updatedAt: new Date("2026-07-18T00:00:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockResolvedValue({ ok: true } as never);
  mockSendDiscord.mockResolvedValue({ ok: true } as never);
});

describe("buildBudgetExhaustedMessage", () => {
  it("renders spend vs ceiling, both to 2 decimal places", () => {
    const msg = buildBudgetExhaustedMessage(12.5, 10);
    expect(msg).toContain("$12.50");
    expect(msg).toContain("$10.00");
    expect(msg).toContain("monthly budget reached");
    expect(msg).toContain("paused until the ceiling is raised");
  });

  it("carries no markdown, secrets, or URLs — plain text only", () => {
    const msg = buildBudgetExhaustedMessage(3, 3);
    expect(msg).not.toMatch(/https?:\/\//);
    expect(msg).not.toMatch(/[*_`[\]]/);
  });
});

describe("notifyWorkspaceBudgetExhausted", () => {
  it("sends into the workspace's most recently active telegram session", async () => {
    mockLatestSession.mockResolvedValue(SESSION as never);

    await notifyWorkspaceBudgetExhausted(WS, 12.5, 10);

    expect(mockLatestSession).toHaveBeenCalledWith(WS);
    expect(mockSend).toHaveBeenCalledWith(
      "tg-chat-42",
      buildBudgetExhaustedMessage(12.5, 10)
    );
  });

  it("does nothing when the workspace has no telegram session", async () => {
    mockLatestSession.mockResolvedValue(null);

    await notifyWorkspaceBudgetExhausted(WS, 12.5, 10);

    expect(mockSend).not.toHaveBeenCalled();
  });

  it("propagates a session-lookup failure — the caller (the claim route) owns the best-effort contract", async () => {
    mockLatestSession.mockRejectedValue(new Error("db blip"));

    await expect(
      notifyWorkspaceBudgetExhausted(WS, 12.5, 10)
    ).rejects.toThrow("db blip");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("logs a TYPED send failure ({ok:false}) and still resolves — the sender never throws, so without this log the failure would vanish (CAS already flipped)", async () => {
    mockLatestSession.mockResolvedValue(SESSION as never);
    mockSend.mockResolvedValue({
      ok: false,
      error: "telegram: bot blocked by the user",
    } as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      // Resolves (never rejects) on a typed failure — so the route's plain
      // flow proceeds to its 204 + X-Agentrail-Claim-Blocked exactly as its
      // own suite proves for a resolving notify; the route's try/catch only
      // exists for contract-violating throws.
      await expect(
        notifyWorkspaceBudgetExhausted(WS, 12.5, 10)
      ).resolves.toBeUndefined();

      // Assert BEFORE mockRestore(): vitest 4's restore also resets the
      // spy's recorded calls.
      expect(errorSpy).toHaveBeenCalledWith(
        "[runner/claim] budget-exhausted notice send failed:",
        "telegram: bot blocked by the user"
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("does NOT log on a successful ({ok:true}) send", async () => {
    mockLatestSession.mockResolvedValue(SESSION as never);
    mockSend.mockResolvedValue({ ok: true } as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await notifyWorkspaceBudgetExhausted(WS, 12.5, 10);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

const TELEGRAM_SESSION = { channel: "telegram", conversationKey: "tg-chat-42" };
const DISCORD_SESSION = { channel: "discord", conversationKey: "discord-channel-1" };
const SLACK_SESSION = { channel: "slack", conversationKey: "T123:C456" };

describe("buildCapacityPausedMessage", () => {
  it("is the exact §7 hard-pause copy — byte-exact, no dollars/model names/'budget'", () => {
    expect(buildCapacityPausedMessage()).toBe(
      "You've used your included monthly engineering capacity. Upgrade to Growth for additional capacity and premium reasoning."
    );
  });

  it("carries no markdown, secrets, or URLs — plain text only", () => {
    const msg = buildCapacityPausedMessage();
    expect(msg).not.toMatch(/https?:\/\//);
    expect(msg).not.toMatch(/[*_`[\]]/);
    expect(msg).not.toMatch(/\$\d/);
  });
});

describe("buildCapacityWarningMessage", () => {
  it("is the exact 80% soft-notice copy — byte-exact", () => {
    expect(buildCapacityWarningMessage()).toBe(
      "Heads up: your team has used 80% of its included monthly engineering capacity. Upgrade to Growth for additional capacity and premium reasoning."
    );
  });

  it("carries no markdown, secrets, or URLs — plain text only", () => {
    const msg = buildCapacityWarningMessage();
    expect(msg).not.toMatch(/https?:\/\//);
    expect(msg).not.toMatch(/[*_`[\]]/);
    expect(msg).not.toMatch(/\$\d/);
  });
});

describe("notifyAccountCapacity", () => {
  // `session` is now a caller-resolved parameter (review round 1 fix — see
  // notify.ts's own doc-comment: the original version re-resolved
  // latestChatSessionForWorkspace a second, independent time here, racing
  // against route.ts's maybeNotifyCapacity CAS read of the very same
  // lookup). These tests pass `session` directly rather than mocking a
  // lookup this function no longer performs.

  it("does nothing when no session is passed (null — no chat session bound)", async () => {
    await notifyAccountCapacity(WS, "capacity", null);

    expect(mockSend).not.toHaveBeenCalled();
    expect(mockSendDiscord).not.toHaveBeenCalled();
  });

  it("kind='capacity' sends the paused message into the given telegram session", async () => {
    await notifyAccountCapacity(WS, "capacity", TELEGRAM_SESSION);

    expect(mockSend).toHaveBeenCalledWith("tg-chat-42", buildCapacityPausedMessage());
    expect(mockSendDiscord).not.toHaveBeenCalled();
  });

  it("kind='capacity_warning' sends the warning message into the given telegram session", async () => {
    await notifyAccountCapacity(WS, "capacity_warning", TELEGRAM_SESSION);

    expect(mockSend).toHaveBeenCalledWith("tg-chat-42", buildCapacityWarningMessage());
  });

  it("routes to the PLAIN discord sender — never the followup-preferring one, no interaction token exists in this async claim context", async () => {
    await notifyAccountCapacity(WS, "capacity", DISCORD_SESSION);

    expect(mockSendDiscord).toHaveBeenCalledWith("discord-channel-1", buildCapacityPausedMessage());
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("skips slack delivery entirely and logs loudly with the [capacity-notify] prefix — no derivable team id in this claim-route context (no live inbound payload to read one from)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(notifyAccountCapacity(WS, "capacity", SLACK_SESSION)).resolves.toBeUndefined();

      expect(mockSend).not.toHaveBeenCalled();
      expect(mockSendDiscord).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("[capacity-notify]"));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(WS));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("logs a TYPED send failure ({ok:false}) and still resolves — the sender never throws, so without this log the failure would vanish", async () => {
    mockSend.mockResolvedValue({ ok: false, error: "telegram: bot blocked by the user" } as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(notifyAccountCapacity(WS, "capacity", TELEGRAM_SESSION)).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("capacity notice send failed"),
        "telegram: bot blocked by the user"
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("logs a TYPED discord send failure the same way", async () => {
    mockSendDiscord.mockResolvedValue({ ok: false, error: "50001 Missing Access" } as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(notifyAccountCapacity(WS, "capacity", DISCORD_SESSION)).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("capacity notice send failed"),
        "50001 Missing Access"
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("does NOT log on a successful ({ok:true}) send", async () => {
    mockSend.mockResolvedValue({ ok: true } as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await notifyAccountCapacity(WS, "capacity", TELEGRAM_SESSION);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("defensively skips and logs for a channel value it doesn't recognize (jace_sessions is filtered to telegram/discord/slack, but the return type is a plain string)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        notifyAccountCapacity(WS, "capacity", { channel: "console", conversationKey: "c-1" })
      ).resolves.toBeUndefined();

      expect(mockSend).not.toHaveBeenCalled();
      expect(mockSendDiscord).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("[capacity-notify]"));
    } finally {
      errorSpy.mockRestore();
    }
  });
});
