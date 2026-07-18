import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@agentrail/db-postgres", () => ({
  latestTelegramSessionForWorkspace: vi.fn(),
}));
vi.mock("../../../../../lib/telegram-system-message", () => ({
  sendSystemTelegramMessage: vi.fn(),
}));

import {
  buildBudgetExhaustedMessage,
  notifyWorkspaceBudgetExhausted,
} from "./notify";
import { latestTelegramSessionForWorkspace } from "@agentrail/db-postgres";
import { sendSystemTelegramMessage } from "../../../../../lib/telegram-system-message";

const mockLatestSession = vi.mocked(latestTelegramSessionForWorkspace);
const mockSend = vi.mocked(sendSystemTelegramMessage);

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
});
