import { describe, expect, it } from "vitest";
import {
  CONNECTOR_CATALOG,
  DEFAULT_INGEST_LABEL,
  DEFAULT_POLL_INTERVAL_SECONDS,
  activeHeartbeatConnectors,
  capabilitySummary,
  connectorStatusLabel,
  isSlackWebhook,
  isTelegramChatId,
  isTelegramToken,
  maskWebhook,
  projectConnectors,
  validateConnectorCredential,
  type ConnectorConfigInput,
} from "./connector-helpers";

describe("projectConnectors", () => {
  it("returns one row per catalog entry, grouped https → mcp → gateway", () => {
    const rows = projectConnectors([]);
    expect(rows.map((r) => r.kind)).toEqual([
      "github",
      "linear",
      "figma",
      "context7",
      "discord",
      "slack",
      "telegram",
    ]);
    // Each row carries its catalog type so the page can section the cards.
    expect(rows.map((r) => r.type)).toEqual([
      "https",
      "mcp",
      "mcp",
      "mcp",
      "gateway",
      "gateway",
      "gateway",
    ]);
  });

  it("marks an available connector connected when its config says so", () => {
    const configs: ConnectorConfigInput[] = [
      { kind: "github", connected: true, ingestLabel: "afk-ready", target: "org/repo" },
    ];
    const github = projectConnectors(configs).find((r) => r.kind === "github")!;
    expect(github.status).toBe("connected");
    expect(github.ingestLabel).toBe("afk-ready");
    expect(github.target).toBe("org/repo");
  });

  it("defaults the ingest label when connected without an explicit one", () => {
    const github = projectConnectors([{ kind: "github", connected: true }]).find(
      (r) => r.kind === "github"
    )!;
    expect(github.ingestLabel).toBe(DEFAULT_INGEST_LABEL);
  });

  it("marks Linear (MCP) connected when an API key is stored", () => {
    // Linear is an MCP key connector now — connected derives from hasSecret, not
    // a bare connected flag (its falsifiable signal is a stored credential).
    const linear = projectConnectors([
      { kind: "linear", hasSecret: true, ingestLabel: "afk-ready" },
    ]).find((r) => r.kind === "linear")!;
    expect(linear.availability).toBe("available");
    expect(linear.type).toBe("mcp");
    expect(linear.connectMethod).toBe("secret");
    expect(linear.status).toBe("connected");
    expect(linear.ingestLabel).toBe("afk-ready");
  });

  it("never reports an MCP connector connected from a bare connected flag", () => {
    // hasSecret is the only signal; connected:true without a key can't fake it.
    const figma = projectConnectors([{ kind: "figma", connected: true }]).find(
      (r) => r.kind === "figma"
    )!;
    expect(figma.status).toBe("disconnected");
  });

  it("marks Slack / Telegram (gateway) connected from a stored secret", () => {
    const rows = projectConnectors([
      { kind: "slack", hasSecret: true },
      { kind: "telegram", hasSecret: true, chatId: "-1001234567890" },
    ]);
    const slack = rows.find((r) => r.kind === "slack")!;
    const telegram = rows.find((r) => r.kind === "telegram")!;
    expect(slack.status).toBe("connected");
    expect(telegram.status).toBe("connected");
    // Telegram surfaces its (non-secret) chat id as the display target.
    expect(telegram.target).toBe("-1001234567890");
  });

  it("never reports discord connected from a bare connected flag — only a real webhook counts", () => {
    // Discord's falsifiable signal is a configured webhook, so a config that
    // merely claims connected:true (no webhook) can't fake a connection.
    const discord = projectConnectors([
      { kind: "discord", connected: true },
    ]).find((r) => r.kind === "discord")!;
    expect(discord.availability).toBe("available");
    expect(discord.status).toBe("disconnected");
    expect(discord.ingestLabel).toBeNull();
  });

  it("treats a kind with no config as disconnected", () => {
    const github = projectConnectors([]).find((r) => r.kind === "github")!;
    expect(github.status).toBe("disconnected");
    expect(github.ingestLabel).toBeNull();
  });

  it("marks Discord connected when a webhook is configured (M038 AC3)", () => {
    const discord = projectConnectors([
      {
        kind: "discord",
        connected: false, // notify connectors derive from webhookUrl, not this
        webhookUrl: "https://discord.com/api/webhooks/12345/secret-token",
      },
    ]).find((r) => r.kind === "discord")!;
    expect(discord.availability).toBe("available");
    expect(discord.status).toBe("connected");
    // Notify-only: no ingest label, and the target masks the secret token.
    expect(discord.ingestLabel).toBeNull();
    expect(discord.target).toBe("webhook 12345");
  });

  it("treats Discord as disconnected without a webhook", () => {
    const discord = projectConnectors([{ kind: "discord", connected: true }]).find(
      (r) => r.kind === "discord"
    )!;
    expect(discord.status).toBe("disconnected");
    expect(discord.target).toBeNull();
  });

  it("folds in the heartbeat trigger config from the connector row (#816)", () => {
    const github = projectConnectors([
      {
        kind: "github",
        connected: true,
        enabled: false,
        triggerLabel: "afk",
        pollIntervalSeconds: 300,
      },
    ]).find((r) => r.kind === "github")!;
    expect(github.enabled).toBe(false);
    expect(github.triggerLabel).toBe("afk");
    expect(github.pollIntervalSeconds).toBe(300);
  });

  it("defaults trigger config: connected ⇒ enabled, default label + interval", () => {
    const github = projectConnectors([
      { kind: "github", connected: true },
    ]).find((r) => r.kind === "github")!;
    expect(github.enabled).toBe(true);
    expect(github.triggerLabel).toBe(DEFAULT_INGEST_LABEL);
    expect(github.pollIntervalSeconds).toBe(DEFAULT_POLL_INTERVAL_SECONDS);
  });

  it("a disconnected connector defaults disabled", () => {
    const github = projectConnectors([]).find((r) => r.kind === "github")!;
    expect(github.enabled).toBe(false);
  });
});

describe("activeHeartbeatConnectors", () => {
  it("returns only connected + enabled connectors", () => {
    const views = projectConnectors([
      { kind: "github", connected: true, enabled: true },
      {
        kind: "discord",
        connected: false,
        webhookUrl: "https://discord.com/api/webhooks/1/t",
        enabled: false,
      },
    ]);
    const active = activeHeartbeatConnectors(views);
    expect(active.map((v) => v.kind)).toEqual(["github"]);
  });

  it("excludes a connected-but-disabled connector", () => {
    const views = projectConnectors([
      { kind: "github", connected: true, enabled: false },
    ]);
    expect(activeHeartbeatConnectors(views)).toEqual([]);
  });
});

describe("maskWebhook", () => {
  it("masks a discord webhook to its id, never the token", () => {
    expect(
      maskWebhook("https://discord.com/api/webhooks/98765/super-secret")
    ).toBe("webhook 98765");
  });

  it("returns null for missing input and a generic label otherwise", () => {
    expect(maskWebhook(null)).toBeNull();
    expect(maskWebhook("")).toBeNull();
    expect(maskWebhook("https://example.com/hook")).toBe("webhook configured");
  });
});

describe("connectorStatusLabel", () => {
  it("renders connected / not connected", () => {
    expect(connectorStatusLabel("connected")).toBe("Connected");
    expect(connectorStatusLabel("disconnected")).toBe("Not connected");
  });
});

describe("capabilitySummary", () => {
  it("summarizes the GitHub adapter's two-way capabilities", () => {
    const github = CONNECTOR_CATALOG.find((c) => c.kind === "github")!;
    expect(capabilitySummary(github.capabilities)).toBe("Ingest · Post result");
  });

  it("summarizes the Linear adapter as ingest + post + tools (MCP)", () => {
    const linear = CONNECTOR_CATALOG.find((c) => c.kind === "linear")!;
    expect(linear.availability).toBe("available");
    expect(capabilitySummary(linear.capabilities)).toBe(
      "Ingest · Post result · Tools"
    );
  });

  it("summarizes Figma / Context7 as tools-only (MCP)", () => {
    for (const kind of ["figma", "context7"] as const) {
      const e = CONNECTOR_CATALOG.find((c) => c.kind === kind)!;
      expect(capabilitySummary(e.capabilities)).toBe("Tools");
    }
  });

  it("summarizes the gateway adapters as notify-only", () => {
    for (const kind of ["discord", "slack", "telegram"] as const) {
      const e = CONNECTOR_CATALOG.find((c) => c.kind === kind)!;
      expect(capabilitySummary(e.capabilities)).toBe("Notify");
    }
  });
});

describe("validateConnectorCredential", () => {
  it("accepts well-formed MCP keys and rejects malformed ones", () => {
    expect(validateConnectorCredential("linear", "lin_api_abc123")).toEqual({
      ok: true,
    });
    expect(validateConnectorCredential("linear", "nope").ok).toBe(false);
    expect(validateConnectorCredential("figma", "figd_xyz")).toEqual({ ok: true });
    expect(validateConnectorCredential("figma", "ghp_x").ok).toBe(false);
    expect(validateConnectorCredential("context7", "ctx7sk-abc")).toEqual({
      ok: true,
    });
    expect(validateConnectorCredential("context7", "ctx7sk_abc")).toEqual({
      ok: true,
    });
    expect(validateConnectorCredential("context7", "sk-abc").ok).toBe(false);
  });

  it("validates a Slack incoming webhook URL", () => {
    expect(
      validateConnectorCredential(
        "slack",
        "https://hooks.slack.com/services/T0/B0/abcDEF"
      )
    ).toEqual({ ok: true });
    expect(isSlackWebhook("https://example.com/x")).toBe(false);
    expect(validateConnectorCredential("slack", "http://hooks.slack.com/x").ok).toBe(
      false
    );
  });

  it("requires a valid Telegram token and treats chat id as OPTIONAL", () => {
    const token = "123456789:AAH" + "a".repeat(32);
    expect(isTelegramToken(token)).toBe(true);
    expect(isTelegramChatId("-1001234567890")).toBe(true);
    expect(isTelegramChatId("@my_channel")).toBe(true);
    // Token + explicit (group/channel) chat id is valid.
    expect(validateConnectorCredential("telegram", token, "-100123")).toEqual({
      ok: true,
    });
    // Valid token with NO chat id is now valid (direct-chat flow; the chat id
    // is resolved at connect time from the bot's updates).
    expect(validateConnectorCredential("telegram", token)).toEqual({ ok: true });
    expect(validateConnectorCredential("telegram", token, "")).toEqual({
      ok: true,
    });
    expect(validateConnectorCredential("telegram", token, "   ")).toEqual({
      ok: true,
    });
    // A supplied-but-malformed chat id is still rejected.
    expect(validateConnectorCredential("telegram", token, "not a chat").ok).toBe(
      false
    );
    // Bad token is rejected even with a chat id.
    expect(validateConnectorCredential("telegram", "nope", "-100123").ok).toBe(
      false
    );
  });

  it("rejects credentials for non-credential connectors (github/discord)", () => {
    expect(validateConnectorCredential("github", "x").ok).toBe(false);
    expect(validateConnectorCredential("discord", "x").ok).toBe(false);
  });
});
