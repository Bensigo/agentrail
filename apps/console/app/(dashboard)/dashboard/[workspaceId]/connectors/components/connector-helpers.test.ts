import { describe, expect, it } from "vitest";
import {
  CONNECTOR_CATALOG,
  DEFAULT_INGEST_LABEL,
  DEFAULT_POLL_INTERVAL_SECONDS,
  activeHeartbeatConnectors,
  capabilitySummary,
  connectorStatusLabel,
  projectConnectors,
  validateConnectorCredential,
  type ConnectorConfigInput,
} from "./connector-helpers";

describe("projectConnectors", () => {
  it("returns one row per catalog entry, grouped issue-source → mcp", () => {
    const rows = projectConnectors([]);
    expect(rows.map((r) => r.kind)).toEqual([
      "github",
      "linear",
      "figma",
      "context7",
    ]);
    // Each row carries its catalog type so the page can section the cards.
    // #1292: GitHub AND Linear are both `issue-source` (they feed the Issue
    // Queue — Linear via its real-time webhook); only Figma / Context7 remain
    // tools-only `mcp`. Gateways-page T4 removed the third group, `channel`
    // (Discord / Slack / Telegram) — those now live on their own Gateways
    // surface.
    expect(rows.map((r) => r.type)).toEqual([
      "issue-source",
      "issue-source",
      "mcp",
      "mcp",
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
});

describe("connector catalog — issue-source / mcp entries", () => {
  it("pins GitHub, Linear, Figma, Context7 catalog entries (type/availability)", () => {
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

  it("rejects a credential for github (oauth) — nothing is pasted here", () => {
    expect(validateConnectorCredential("github", "x")).toEqual({
      ok: false,
      error: "This connector is not credential-based.",
    });
  });
});
