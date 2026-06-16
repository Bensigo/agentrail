import { describe, expect, it } from "vitest";
import {
  CONNECTOR_CATALOG,
  DEFAULT_INGEST_LABEL,
  capabilitySummary,
  connectorStatusLabel,
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

  it("never reports a planned connector as connected even if config claims it", () => {
    // A planned connector's adapter does not exist yet — config can't fake it.
    const linear = projectConnectors([
      { kind: "linear", connected: true },
    ]).find((r) => r.kind === "linear")!;
    expect(linear.availability).toBe("planned");
    expect(linear.status).toBe("disconnected");
    expect(linear.ingestLabel).toBeNull();
  });

  it("treats a kind with no config as disconnected", () => {
    const github = projectConnectors([]).find((r) => r.kind === "github")!;
    expect(github.status).toBe("disconnected");
    expect(github.ingestLabel).toBeNull();
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

  it("summarizes the Discord adapter as notify-only", () => {
    const discord = CONNECTOR_CATALOG.find((c) => c.kind === "discord")!;
    expect(capabilitySummary(discord.capabilities)).toBe("Notify");
  });
});
