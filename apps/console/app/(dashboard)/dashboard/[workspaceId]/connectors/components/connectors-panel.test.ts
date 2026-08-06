import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { ConnectorTile } from "./connectors-panel";
import { ConnectorStatusBadge } from "./connector-status-badge";
import { filterPublicConnectors, projectConnectors } from "./connector-helpers";

interface ReactElementLike {
  type: unknown;
  props: Record<string, unknown>;
}

function asElement(node: unknown): ReactElementLike {
  return node as ReactElementLike;
}

function collectText(node: unknown, acc: string[] = []): string[] {
  if (node === null || node === undefined || typeof node === "boolean") return acc;
  if (typeof node === "string" || typeof node === "number") {
    acc.push(String(node));
    return acc;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, acc);
    return acc;
  }
  const el = node as Partial<ReactElementLike>;
  if (el && typeof el === "object" && "props" in el) collectText(el.props?.children, acc);
  return acc;
}

const NOOP_ON_OPEN = () => {};

function railwayConnector(hasSecret = false) {
  return projectConnectors([
    {
      kind: "railway" as const,
      hasSecret,
      oauthReady: false,
      oauthSetup: { capable: true as const, missingEnv: ["RAILWAY_OAUTH_CLIENT_ID"] },
    },
  ]).find((connector) => connector.kind === "railway")!;
}

describe("ConnectorTile — one-click surface", () => {
  it("does not render setup instructions or a second action on a disconnected tile", () => {
    const connector = railwayConnector();
    const text = collectText(ConnectorTile({ connector, onOpen: NOOP_ON_OPEN }));
    expect(text).not.toContain("Setup");
    expect(connector.status).toBe("disconnected");
  });

  it("keeps a connected tile the same fixed height", () => {
    const disconnected = asElement(ConnectorTile({ connector: railwayConnector(), onOpen: NOOP_ON_OPEN }));
    const connected = asElement(ConnectorTile({ connector: railwayConnector(true), onOpen: NOOP_ON_OPEN }));
    expect(String(disconnected.props.className)).toContain("h-28");
    expect(disconnected.props.className).toBe(connected.props.className);
  });

  it("keeps only the status badge in the tile's bottom row", () => {
    const connector = railwayConnector();
    const rows = asElement(ConnectorTile({ connector, onOpen: NOOP_ON_OPEN })).props.children as ReactElementLike[];
    const bottomRow = asElement(rows[2]);
    expect(asElement(bottomRow.props.children).type).toBe(ConnectorStatusBadge);
  });
});

describe("ConnectorsPanel — trust-layer presentation", () => {
  it("shows only the supported GitHub connector", () => {
    const rows = projectConnectors([]);
    expect(filterPublicConnectors(rows).map((row) => row.kind)).toEqual(["github"]);
  });

  it("keeps public catalog copy free of legacy setup claims", () => {
    const pageSource = readFileSync(
      new URL("../page.tsx", import.meta.url),
      "utf8",
    );
    expect(pageSource).toContain("Connectors");
    expect(pageSource).not.toContain("Repository and PR anchor");
    expect(pageSource).not.toMatch(/factory|autonomous|coming soon|generate code/i);
  });

  it("does not render the removed Heartbeat/autonomous-loop block", () => {
    const source = readFileSync(
      new URL("./connectors-panel.tsx", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain("HeartbeatStatusHeader");
    expect(source).not.toContain("activeHeartbeatConnectors");
    expect(source).not.toContain("autonomous loop");
    expect(source).not.toContain("Issue Queue");
  });
});
