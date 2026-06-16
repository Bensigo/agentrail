import { describe, expect, it } from "vitest";
import {
  CONNECTOR_CATALOG,
  DEFAULT_INGEST_LABEL,
  DEFAULT_POLL_INTERVAL_SECONDS,
  activeHeartbeatConnectors,
  capabilitySummary,
  connectorStatusLabel,
  maskWebhook,
  projectConnectors,
  type ConnectorConfigInput,
} from "./connector-helpers";

describe("projectConnectors", () => {
  it("returns one row per catalog entry (github, linear, discord)", () => {
    const rows = projectConnectors([]);
    expect(rows.map((r) => r.kind)).toEqual(["github", "linear", "discord"]);
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

  it("marks Linear connected when its config says so (M038 AC3)", () => {
    // Linear's adapter now exists (agentrail/connectors/linear.py) → manageable.
    const linear = projectConnectors([
      { kind: "linear", connected: true, ingestLabel: "afk-ready", target: "Team ENG" },
    ]).find((r) => r.kind === "linear")!;
    expect(linear.availability).toBe("available");
    expect(linear.status).toBe("connected");
    expect(linear.ingestLabel).toBe("afk-ready");
    expect(linear.target).toBe("Team ENG");
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

  it("summarizes the Linear adapter's two-way capabilities", () => {
    const linear = CONNECTOR_CATALOG.find((c) => c.kind === "linear")!;
    expect(linear.availability).toBe("available");
    expect(capabilitySummary(linear.capabilities)).toBe("Ingest · Post result");
  });

  it("summarizes the Discord adapter as notify-only", () => {
    const discord = CONNECTOR_CATALOG.find((c) => c.kind === "discord")!;
    expect(capabilitySummary(discord.capabilities)).toBe("Notify");
  });
});
