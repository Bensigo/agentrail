import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Keep `jaceOwnsTelegramNotify` as the REAL pure decision (it never touches the
// db) so the routing tests exercise the true migration gate; only the
// db-touching lookups are mocked. Mirrors the jace inbound route test.
vi.mock("@agentrail/db-postgres", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@agentrail/db-postgres")>();
  return {
    ...actual,
    getConnector: vi.fn(),
    getConnectorSecret: vi.fn(),
  };
});
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

/**
 * Outbound Telegram routing through Jace (#1047, AC1). Exactly ONE path fires per
 * workspace: the migrated route (Jace) OR the legacy sender — never both (no
 * dark, no double). Migration is gated on the `jace` connector being enabled AND
 * an explicit `telegramNotify` opt-in, so it is a safe no-op until per-workspace
 * cutover. The Jace handoff is a best-effort POST to the sidecar; the tests stub
 * `fetch` so no live sidecar is needed.
 */
describe("notifyRunOutcome — Jace outbound routing (#1047)", () => {
  /** An enabled `jace` connector row view, opting Telegram notify into Jace. */
  function jaceConnector(
    opts: { enabled?: boolean; telegramNotify?: boolean } = {}
  ) {
    const { enabled = true, telegramNotify = true } = opts;
    return {
      provider: "jace" as const,
      enabled,
      config: {
        repos: [],
        triggerLabel: "x",
        pollIntervalSeconds: 60,
        telegramNotify,
      },
      hasSecret: false,
      updatedAt: null,
    };
  }

  /** Route getConnector by provider: a jace row + a connected telegram row. */
  function routeConnectors(
    jace: ReturnType<typeof jaceConnector> | null,
    telegram = telegramConnected("999")
  ) {
    mockGetConnector.mockImplementation(async (_ws: string, provider: string) =>
      provider === "jace" ? jace : telegram
    );
  }

  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    mockGetSecret.mockResolvedValue("bot-token");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("delivers via Jace EXACTLY ONCE and NEVER via the legacy sender when migrated", async () => {
    routeConnectors(jaceConnector());

    await notifyRunOutcome(WS, {
      issueNumber: "42",
      outcome: "green",
      prUrl: "https://github.com/o/r/pull/9",
      costUsd: 1.2,
    });

    // Exactly-once via the Jace sidecar handoff...
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // ...and the legacy Telegram sender is NOT invoked (no double-fire).
    expect(mockSend).not.toHaveBeenCalled();

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain("/eve/v1/notify");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toMatchObject({
      channel: "telegram",
      chatId: "999",
      issueNumber: "42",
      outcome: "green",
    });
    expect(String(body.text)).toContain("PR ready");
  });

  it("stays on the legacy sender when the jace connector is DISABLED (kill switch)", async () => {
    routeConnectors(jaceConnector({ enabled: false }));

    await notifyRunOutcome(WS, { issueNumber: "1", outcome: "green" });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("stays on the legacy sender when the telegramNotify opt-in is OFF (default, pre-cutover)", async () => {
    routeConnectors(jaceConnector({ telegramNotify: false }));

    await notifyRunOutcome(WS, { issueNumber: "1", outcome: "green" });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("stays on the legacy sender when there is NO jace connector at all", async () => {
    routeConnectors(null);

    await notifyRunOutcome(WS, { issueNumber: "1", outcome: "green" });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("swallows a Jace sidecar failure and does NOT fall back to legacy (exactly-once, never double)", async () => {
    routeConnectors(jaceConnector());
    fetchSpy.mockRejectedValue(new Error("sidecar down"));

    await expect(
      notifyRunOutcome(WS, { issueNumber: "1", outcome: "green" })
    ).resolves.toBeUndefined();

    // Critical: a transient Jace blip must NOT trigger a legacy send — that would
    // risk a double-fire if Jace had already delivered.
    expect(mockSend).not.toHaveBeenCalled();
  });
});
