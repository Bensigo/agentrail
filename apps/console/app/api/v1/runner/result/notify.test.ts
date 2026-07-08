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
    // Discord's webhook lives on the workspace row; the legacy Discord sender
    // reads it here. Mocked so the routing tests never touch the db.
    getDiscordWebhookUrl: vi.fn(),
  };
});
vi.mock("../../workspaces/[workspaceId]/connectors/secret/telegram", () => ({
  sendTelegramMessage: vi.fn(),
}));
vi.mock("../../workspaces/[workspaceId]/connectors/secret/discord", () => ({
  sendDiscordMessage: vi.fn(),
}));

import { buildOutcomeMessage, notifyRunOutcome } from "./notify";
import {
  getConnector,
  getConnectorSecret,
  getDiscordWebhookUrl,
} from "@agentrail/db-postgres";
import { sendTelegramMessage } from "../../workspaces/[workspaceId]/connectors/secret/telegram";
import { sendDiscordMessage } from "../../workspaces/[workspaceId]/connectors/secret/discord";

const mockGetConnector = vi.mocked(getConnector);
const mockGetSecret = vi.mocked(getConnectorSecret);
const mockGetDiscordWebhook = vi.mocked(getDiscordWebhookUrl);
const mockSend = vi.mocked(sendTelegramMessage);
const mockSendDiscord = vi.mocked(sendDiscordMessage);

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
  mockSendDiscord.mockResolvedValue({ ok: true });
  // Default: no Discord webhook, so the legacy Discord sender no-ops unless a
  // test opts into a webhook. Keeps the existing Telegram tests unaffected by the
  // added Discord channel.
  mockGetDiscordWebhook.mockResolvedValue(null);
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
    // The REAL Eve run-outcome channel route (not the removed /eve/v1/notify).
    expect(String(url)).toContain("/eve/v1/run-outcome");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toMatchObject({
      channel: "telegram",
      target: { chatId: "999" },
      issueNumber: "42",
      outcome: "green",
    });
    // Eve-shaped payload: `message` (not `text`) + an initiator `auth`.
    expect(String(body.message)).toContain("PR ready");
    expect(body.auth).toMatchObject({ principalId: WS });
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

/**
 * Outbound Discord routing through Jace (#1050). Mirrors the Telegram arc: exactly
 * ONE path fires per workspace — the Jace handoff OR the legacy Discord webhook
 * sender, never both. Gated on the `jace` connector being enabled AND an explicit
 * `discordNotify` opt-in, so it is a safe no-op until per-workspace cutover. The
 * legacy path posts to the workspace-level Discord webhook (mocked here); the Jace
 * handoff is a best-effort `fetch` to the sidecar (stubbed).
 */
describe("notifyRunOutcome — Discord Jace outbound routing (#1050)", () => {
  const DISCORD_WEBHOOK = "https://discord.com/api/webhooks/123/super-secret";

  /** An enabled `jace` connector row view, opting Discord notify into Jace. */
  function jaceConnector(
    opts: { enabled?: boolean; discordNotify?: boolean } = {}
  ) {
    const { enabled = true, discordNotify = true } = opts;
    return {
      provider: "jace" as const,
      enabled,
      config: {
        repos: [],
        triggerLabel: "x",
        pollIntervalSeconds: 60,
        discordNotify,
      },
      hasSecret: false,
      updatedAt: null,
    };
  }

  /** A connected, enabled discord connector row view (with a Jace-native channel id). */
  function discordConnected(enabled = true) {
    return {
      provider: "discord" as const,
      enabled,
      config: {
        repos: [],
        triggerLabel: "x",
        pollIntervalSeconds: 60,
        channelId: "C-DISCORD",
      },
      hasSecret: false,
      updatedAt: null,
    };
  }

  // Route getConnector by provider: a jace row + a connected discord row. Telegram
  // is absent so its legacy sender is a no-op and never muddies the fetch counts.
  function routeConnectors(jace: ReturnType<typeof jaceConnector> | null) {
    mockGetConnector.mockImplementation(async (_ws: string, provider: string) =>
      provider === "jace"
        ? jace
        : provider === "discord"
          ? discordConnected()
          : null
    );
  }

  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    mockGetSecret.mockResolvedValue("bot-token");
    mockGetDiscordWebhook.mockResolvedValue(DISCORD_WEBHOOK);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("delivers via Jace EXACTLY ONCE and NEVER via the legacy Discord webhook sender when migrated", async () => {
    routeConnectors(jaceConnector());

    await notifyRunOutcome(WS, {
      issueNumber: "42",
      outcome: "green",
      prUrl: "https://github.com/o/r/pull/9",
      costUsd: 1.2,
    });

    // Exactly-once via the Jace sidecar handoff...
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // ...and the legacy Discord webhook sender is NOT invoked (no double-fire).
    expect(mockSendDiscord).not.toHaveBeenCalled();

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain("/eve/v1/run-outcome");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toMatchObject({
      channel: "discord",
      target: { channelId: "C-DISCORD" },
      issueNumber: "42",
      outcome: "green",
    });
    expect(String(body.message)).toContain("PR ready");
    // The secret webhook URL is never sent over the wire — the non-secret
    // channelId is the target; the bot credentials live in Jace's env.
    expect(JSON.stringify(body)).not.toContain("super-secret");
  });

  it("stays on the legacy Discord webhook sender when the jace connector is DISABLED (kill switch)", async () => {
    routeConnectors(jaceConnector({ enabled: false }));

    await notifyRunOutcome(WS, { issueNumber: "1", outcome: "green" });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockSendDiscord).toHaveBeenCalledTimes(1);
    const [webhook, text] = mockSendDiscord.mock.calls[0]!;
    expect(webhook).toBe(DISCORD_WEBHOOK);
    expect(String(text)).toContain("PR ready");
  });

  it("stays on the legacy Discord sender when the discordNotify opt-in is OFF (default, pre-cutover)", async () => {
    routeConnectors(jaceConnector({ discordNotify: false }));

    await notifyRunOutcome(WS, { issueNumber: "1", outcome: "green" });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockSendDiscord).toHaveBeenCalledTimes(1);
  });

  it("stays on the legacy Discord sender when there is NO jace connector at all", async () => {
    routeConnectors(null);

    await notifyRunOutcome(WS, { issueNumber: "1", outcome: "green" });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockSendDiscord).toHaveBeenCalledTimes(1);
  });

  it("no-ops the legacy Discord sender when no webhook is configured (nothing to deliver to)", async () => {
    routeConnectors(jaceConnector({ discordNotify: false }));
    mockGetDiscordWebhook.mockResolvedValue(null);

    await notifyRunOutcome(WS, { issueNumber: "1", outcome: "green" });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockSendDiscord).not.toHaveBeenCalled();
  });

  it("swallows a Jace sidecar failure and does NOT fall back to the legacy Discord sender (exactly-once, never double)", async () => {
    routeConnectors(jaceConnector());
    fetchSpy.mockRejectedValue(new Error("sidecar down"));

    await expect(
      notifyRunOutcome(WS, { issueNumber: "1", outcome: "green" })
    ).resolves.toBeUndefined();

    // A transient Jace blip must NOT trigger a legacy Discord send — that would
    // risk a double-fire if Jace had already delivered.
    expect(mockSendDiscord).not.toHaveBeenCalled();
  });
});

/**
 * Outbound Slack routing through Jace (#1050) — GREENFIELD. Slack has NO legacy
 * console sender, so it is delivered ONLY when the workspace has opted Slack into
 * Jace (`jace` enabled AND `slackNotify` true). When not migrated, there is simply
 * no Slack notification — there is nothing to fall back to, and no legacy Slack
 * path is created in the console.
 */
describe("notifyRunOutcome — Slack Jace outbound routing (#1050, greenfield)", () => {
  /** An enabled `jace` connector row view, opting Slack notify into Jace. */
  function jaceConnector(
    opts: { enabled?: boolean; slackNotify?: boolean } = {}
  ) {
    const { enabled = true, slackNotify = true } = opts;
    return {
      provider: "jace" as const,
      enabled,
      config: {
        repos: [],
        triggerLabel: "x",
        pollIntervalSeconds: 60,
        slackNotify,
      },
      hasSecret: false,
      updatedAt: null,
    };
  }

  /** A connected slack connector row view (with a Jace-native channel id). */
  function slackConnected(channelId = "C-SLACK") {
    return {
      provider: "slack" as const,
      enabled: true,
      config: { repos: [], triggerLabel: "x", pollIntervalSeconds: 60, channelId },
      hasSecret: true,
      updatedAt: null,
    };
  }

  // A jace row + a connected slack row; telegram + discord are absent so ONLY a
  // Slack Jace handoff can ever produce a fetch here.
  function routeConnectors(
    jace: ReturnType<typeof jaceConnector> | null,
    slack: ReturnType<typeof slackConnected> | null = slackConnected()
  ) {
    mockGetConnector.mockImplementation(async (_ws: string, provider: string) =>
      provider === "jace" ? jace : provider === "slack" ? slack : null
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

  it("delivers via Jace EXACTLY ONCE when migrated (Slack is Jace-only)", async () => {
    routeConnectors(jaceConnector());

    await notifyRunOutcome(WS, {
      issueNumber: "42",
      outcome: "escalated-to-human",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // No legacy Telegram/Discord send fired.
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockSendDiscord).not.toHaveBeenCalled();

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain("/eve/v1/run-outcome");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toMatchObject({
      channel: "slack",
      target: { channelId: "C-SLACK" },
      issueNumber: "42",
      outcome: "escalated-to-human",
    });
    expect(String(body.message)).toContain("Escalated to human");
  });

  it("produces NO Slack notification when the jace connector is DISABLED (kill switch; no legacy fallback)", async () => {
    routeConnectors(jaceConnector({ enabled: false }));

    await notifyRunOutcome(WS, { issueNumber: "1", outcome: "green" });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("produces NO Slack notification when the slackNotify opt-in is OFF (default)", async () => {
    routeConnectors(jaceConnector({ slackNotify: false }));

    await notifyRunOutcome(WS, { issueNumber: "1", outcome: "green" });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("produces NO Slack notification when there is NO jace connector at all", async () => {
    routeConnectors(null);

    await notifyRunOutcome(WS, { issueNumber: "1", outcome: "green" });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("swallows a Jace sidecar failure without throwing and with no legacy fallback (greenfield)", async () => {
    routeConnectors(jaceConnector());
    fetchSpy.mockRejectedValue(new Error("sidecar down"));

    await expect(
      notifyRunOutcome(WS, { issueNumber: "1", outcome: "green" })
    ).resolves.toBeUndefined();

    // Greenfield: there is no legacy Slack sender to fall back to.
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockSendDiscord).not.toHaveBeenCalled();
  });
});
