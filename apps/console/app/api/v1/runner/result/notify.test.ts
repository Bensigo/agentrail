import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@agentrail/db-postgres", () => ({
  getConnector: vi.fn(),
  getConnectorSecret: vi.fn(),
}));
vi.mock("../../workspaces/[workspaceId]/connectors/secret/telegram", () => ({
  sendTelegramMessage: vi.fn(),
}));

import { buildOutcomeMessage, notifyRunOutcome } from "./notify";
import { getConnector, getConnectorSecret } from "@agentrail/db-postgres";
import { sendTelegramMessage } from "../../workspaces/[workspaceId]/connectors/secret/telegram";

const mockGetConnector = vi.mocked(getConnector);
const mockGetSecret = vi.mocked(getConnectorSecret);
const mockSend = vi.mocked(sendTelegramMessage);

const WS = "ws-1";

/** A connected, enabled telegram connector view with a chat id. */
function telegramConnected(chatId = "12345") {
  return {
    provider: "telegram" as const,
    enabled: true,
    config: { repos: [], triggerLabel: "x", pollIntervalSeconds: 60, chatId },
    hasSecret: true,
    updatedAt: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockResolvedValue({ ok: true });
});

describe("buildOutcomeMessage", () => {
  it("green → 'PR ready' with issue number, PR link, and cost", () => {
    const msg = buildOutcomeMessage({
      issueNumber: "42",
      outcome: "green",
      prUrl: "https://github.com/o/r/pull/9",
      costUsd: 1.2,
    });
    expect(msg).toContain("PR ready");
    expect(msg).toContain("#42");
    expect(msg).toContain("https://github.com/o/r/pull/9");
    expect(msg).toContain("$1.20");
  });

  it("maps escalated-to-human and blocked to operational wording", () => {
    expect(buildOutcomeMessage({ issueNumber: "1", outcome: "escalated-to-human" })).toContain(
      "Escalated to human"
    );
    expect(buildOutcomeMessage({ issueNumber: "1", outcome: "blocked" })).toContain("Blocked");
  });

  it("omits PR/cost extras when absent", () => {
    const msg = buildOutcomeMessage({ issueNumber: "7", outcome: "green" });
    expect(msg).toBe("AgentRail: PR ready — issue #7");
  });
});

describe("notifyRunOutcome", () => {
  it("sends to the enabled telegram connector with the built message", async () => {
    mockGetConnector.mockResolvedValue(telegramConnected("999"));
    mockGetSecret.mockResolvedValue("bot-token");

    await notifyRunOutcome(WS, {
      issueNumber: "42",
      outcome: "green",
      prUrl: "https://github.com/o/r/pull/9",
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    const [token, chatId, text] = mockSend.mock.calls[0];
    expect(token).toBe("bot-token");
    expect(chatId).toBe("999");
    expect(text).toContain("PR ready");
    expect(text).toContain("#42");
  });

  it("no-op when telegram is not connected", async () => {
    mockGetConnector.mockResolvedValue(null);
    await notifyRunOutcome(WS, { issueNumber: "1", outcome: "green" });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("no-op when telegram is disabled", async () => {
    mockGetConnector.mockResolvedValue({ ...telegramConnected(), enabled: false });
    await notifyRunOutcome(WS, { issueNumber: "1", outcome: "green" });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("no-op when there is no chat id", async () => {
    mockGetConnector.mockResolvedValue({
      ...telegramConnected(),
      config: { repos: [], triggerLabel: "x", pollIntervalSeconds: 60 },
    });
    await notifyRunOutcome(WS, { issueNumber: "1", outcome: "green" });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("no-op when there is no stored token", async () => {
    mockGetConnector.mockResolvedValue(telegramConnected());
    mockGetSecret.mockResolvedValue(null);
    await notifyRunOutcome(WS, { issueNumber: "1", outcome: "green" });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("swallows a send failure (best-effort, never throws)", async () => {
    mockGetConnector.mockResolvedValue(telegramConnected());
    mockGetSecret.mockResolvedValue("bot-token");
    mockSend.mockRejectedValue(new Error("telegram down"));
    await expect(
      notifyRunOutcome(WS, { issueNumber: "1", outcome: "green" })
    ).resolves.toBeUndefined();
  });

  it("swallows a connector-lookup throw (never throws)", async () => {
    mockGetConnector.mockRejectedValue(new Error("db down"));
    await expect(
      notifyRunOutcome(WS, { issueNumber: "1", outcome: "green" })
    ).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
