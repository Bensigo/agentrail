import { describe, expect, it } from "vitest";
import {
  CONNECTOR_CATALOG,
  DEFAULT_INGEST_LABEL,
  DEFAULT_POLL_INTERVAL_SECONDS,
  activeHeartbeatConnectors,
  capabilitySummary,
  connectorStatusLabel,
  linkedIdentitiesLine,
  projectConnectors,
  validateConnectorCredential,
  type ChannelIdentity,
  type ConnectorConfigInput,
} from "./connector-helpers";

describe("projectConnectors", () => {
  it("returns one row per catalog entry, grouped issue-source → mcp → channel", () => {
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
    // #1292: GitHub AND Linear are both `issue-source` (they feed the Issue
    // Queue — Linear via its real-time webhook); only Figma / Context7 remain
    // tools-only `mcp`. The Gateway → Channels cutover renamed the third group
    // from `gateway` to `channel` (Discord / Slack / Telegram).
    expect(rows.map((r) => r.type)).toEqual([
      "issue-source",
      "issue-source",
      "mcp",
      "mcp",
      "channel",
      "channel",
      "channel",
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

  it("marks Linear (issue source) connected when an API key is stored", () => {
    // Linear is a secret-connected connector — connected derives from hasSecret,
    // not a bare connected flag (its falsifiable signal is a stored credential).
    // #1292: it is now categorized as an `issue-source` (its primary role) rather
    // than `mcp`, even though it still exposes MCP tools.
    const linear = projectConnectors([
      { kind: "linear", hasSecret: true, ingestLabel: "afk-ready" },
    ]).find((r) => r.kind === "linear")!;
    expect(linear.availability).toBe("available");
    expect(linear.type).toBe("issue-source");
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

  it("treats a kind with no config as disconnected", () => {
    const github = projectConnectors([]).find((r) => r.kind === "github")!;
    expect(github.status).toBe("disconnected");
    expect(github.ingestLabel).toBeNull();
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

  // -- channel identities (Gateway → Channels cutover) ----------------------- //

  it("marks Telegram connected via a linked chat identity and carries linkedIdentities, preserving a null display name", () => {
    const identities: ChannelIdentity[] = [
      { platform: "telegram", displayName: "Ben" },
      { platform: "telegram", displayName: null },
    ];
    const telegram = projectConnectors([], identities).find(
      (r) => r.kind === "telegram"
    )!;
    expect(telegram.status).toBe("connected");
    expect(telegram.linkedIdentities).toEqual([
      { displayName: "Ben" },
      { displayName: null },
    ]);
  });

  it("treats a channel kind with no linked identity as disconnected, with empty linkedIdentities", () => {
    const telegram = projectConnectors([]).find((r) => r.kind === "telegram")!;
    expect(telegram.status).toBe("disconnected");
    expect(telegram.linkedIdentities).toEqual([]);
    // No second argument at all (default param) — same result.
    const telegramDefaulted = projectConnectors([]).find(
      (r) => r.kind === "telegram"
    )!;
    expect(telegramDefaulted.status).toBe("disconnected");
  });

  it("never connects a planned channel kind (discord/slack) even with a linked identity for its platform", () => {
    const identities: ChannelIdentity[] = [
      { platform: "discord", displayName: "Team" },
      { platform: "slack", displayName: "Team" },
    ];
    const rows = projectConnectors([], identities);
    const discord = rows.find((r) => r.kind === "discord")!;
    const slack = rows.find((r) => r.kind === "slack")!;
    expect(discord.availability).toBe("planned");
    expect(discord.status).toBe("disconnected");
    expect(slack.availability).toBe("planned");
    expect(slack.status).toBe("disconnected");
  });

  it("never populates linkedIdentities for a non-channel kind, even if identities carry its kind as platform", () => {
    // Defensive: identities are keyed by platform strings that only ever come
    // from telegram/slack/discord in practice, but the projection should never
    // leak them onto an issue-source/mcp row regardless.
    const identities: ChannelIdentity[] = [{ platform: "github", displayName: "x" }];
    const github = projectConnectors([], identities).find(
      (r) => r.kind === "github"
    )!;
    expect(github.linkedIdentities).toEqual([]);
  });
});

describe("activeHeartbeatConnectors", () => {
  it("returns only connected + enabled ingest connectors", () => {
    const views = projectConnectors([
      { kind: "github", connected: true, enabled: true },
      { kind: "linear", hasSecret: true, enabled: false },
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

  it("never counts a connected channel kind — chat channels don't drive the ingest heartbeat", () => {
    const views = projectConnectors(
      [],
      [{ platform: "telegram", displayName: "Ben" }]
    );
    expect(activeHeartbeatConnectors(views)).toEqual([]);
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

  it("summarizes the channel adapters (discord/slack/telegram) as chat-only", () => {
    for (const kind of ["discord", "slack", "telegram"] as const) {
      const e = CONNECTOR_CATALOG.find((c) => c.kind === kind)!;
      expect(capabilitySummary(e.capabilities)).toBe("Chat");
    }
  });
});

describe("linkedIdentitiesLine (lifted from connectors-panel.tsx, connectors-channels cutover T5 — shared with the setup wizard's channel step)", () => {
  it("lists comma-joined display names when every identity has one", () => {
    expect(linkedIdentitiesLine(["Ben", "Ada"])).toBe("Linked: Ben, Ada");
  });

  it("a single named identity needs no +N suffix", () => {
    expect(linkedIdentitiesLine(["Ben"])).toBe("Linked: Ben");
  });

  it("falls back to a bare count when none of the identities have a display name", () => {
    expect(linkedIdentitiesLine([null, null])).toBe("2 linked");
  });

  it("folds nameless identities into a trailing +N alongside the named ones", () => {
    expect(linkedIdentitiesLine(["Ben", null, null])).toBe("Linked: Ben +2");
  });

  it("an empty list reads as 0 linked — total, never throws", () => {
    expect(linkedIdentitiesLine([])).toBe("0 linked");
  });
});

describe("connector catalog — channel group (Gateway → Channels cutover)", () => {
  it("carries no connect meta for any channel kind — no BYO credential forms", () => {
    for (const kind of ["discord", "slack", "telegram"] as const) {
      const e = CONNECTOR_CATALOG.find((c) => c.kind === kind)!;
      expect(e.type).toBe("channel");
      expect(e.connect).toBeUndefined();
    }
  });

  it("Telegram is available; Discord and Slack are planned", () => {
    expect(
      CONNECTOR_CATALOG.find((c) => c.kind === "telegram")!.availability
    ).toBe("available");
    expect(
      CONNECTOR_CATALOG.find((c) => c.kind === "discord")!.availability
    ).toBe("planned");
    expect(
      CONNECTOR_CATALOG.find((c) => c.kind === "slack")!.availability
    ).toBe("planned");
  });

  it("leaves GitHub, Linear, Figma, Context7 catalog entries unchanged (type/availability)", () => {
    expect(CONNECTOR_CATALOG.find((c) => c.kind === "github")!.type).toBe(
      "issue-source"
    );
    expect(CONNECTOR_CATALOG.find((c) => c.kind === "linear")!.type).toBe(
      "issue-source"
    );
    expect(CONNECTOR_CATALOG.find((c) => c.kind === "figma")!.type).toBe("mcp");
    expect(CONNECTOR_CATALOG.find((c) => c.kind === "context7")!.type).toBe(
      "mcp"
    );
    for (const kind of ["github", "linear", "figma", "context7"] as const) {
      expect(CONNECTOR_CATALOG.find((c) => c.kind === kind)!.availability).toBe(
        "available"
      );
    }
  });
});

describe("validateConnectorCredential", () => {
  it("accepts well-formed credential-based keys (linear/figma/context7) and rejects malformed ones", () => {
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

  it("rejects credentials for non-credential kinds — github (oauth) and the channel kinds discord/slack/telegram (Jace-native, nothing to paste)", () => {
    expect(validateConnectorCredential("github", "x").ok).toBe(false);
    expect(validateConnectorCredential("discord", "x").ok).toBe(false);
    expect(validateConnectorCredential("slack", "x").ok).toBe(false);
    expect(validateConnectorCredential("telegram", "x").ok).toBe(false);
  });

  it("rejects a slack/telegram credential even in its old well-formed shape — no format special-cases the fallback catches everything", () => {
    // These were VALID shapes under the old (pre-cutover) webhook/bot-token
    // validators. Proves the fallback isn't reachable only for malformed
    // input — telegram/slack simply have no credential path anymore.
    const wellFormedSlackWebhook = "https://hooks.slack.com/services/T0/B0/abcDEF";
    const wellFormedTelegramToken = "123456789:AAH" + "a".repeat(32);
    expect(validateConnectorCredential("slack", wellFormedSlackWebhook)).toEqual({
      ok: false,
      error: "This connector is not credential-based.",
    });
    expect(validateConnectorCredential("telegram", wellFormedTelegramToken)).toEqual(
      { ok: false, error: "This connector is not credential-based." }
    );
  });
});
