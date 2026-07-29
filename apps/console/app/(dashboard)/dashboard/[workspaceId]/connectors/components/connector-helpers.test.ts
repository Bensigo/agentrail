import { describe, expect, it } from "vitest";
import {
  CONNECTOR_CATALOG,
  CONNECTOR_TYPE_META,
  DEFAULT_INGEST_LABEL,
  DEFAULT_POLL_INTERVAL_SECONDS,
  activeHeartbeatConnectors,
  capabilitySummary,
  connectorStatusLabel,
  projectConnectors,
  validateConnectorCredential,
  type ConnectorCatalogEntry,
  type ConnectorConfigInput,
} from "./connector-helpers";

describe("projectConnectors", () => {
  it("returns one row per catalog entry, grouped issue-source → mcp → observability", () => {
    const rows = projectConnectors([]);
    expect(rows.map((r) => r.kind)).toEqual([
      "github",
      "linear",
      "figma",
      "context7",
      "railway",
    ]);
    // Each row carries its catalog type so the page can section the cards.
    // #1292: GitHub AND Linear are both `issue-source` (they feed the Issue
    // Queue — Linear via its real-time webhook); Figma / Context7 stay
    // tools-only `mcp`. Gateways-page T4 removed the third group, `channel`
    // (Discord / Slack / Telegram) — those now live on their own Gateways
    // surface. Task 7 adds a FOURTH group, `observability` (Railway — evidence
    // for debugging investigations, no ingest).
    expect(rows.map((r) => r.type)).toEqual([
      "issue-source",
      "issue-source",
      "mcp",
      "mcp",
      "observability",
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

  it("filters availability: 'internal' entries out of the grid entirely (evidence-only providers like Task 5's factory never render as a connector card)", () => {
    // Task 5's real `factory` entry is already `internal` in CONNECTOR_CATALOG
    // (filtered below without any synthetic override) — this test additionally
    // makes context7 internal too, via projectConnectors' own optional
    // (test-only) catalog parameter, to prove the filter mechanism generically
    // rather than relying on factory alone.
    const withInternal: ConnectorCatalogEntry[] = CONNECTOR_CATALOG.map((entry) =>
      entry.kind === "context7" ? { ...entry, availability: "internal" as const } : entry
    );
    const rows = projectConnectors([], withInternal);
    expect(rows.find((r) => r.kind === "context7")).toBeUndefined();
    expect(rows.find((r) => r.kind === "factory")).toBeUndefined();
    expect(rows.map((r) => r.kind)).toEqual(["github", "linear", "figma", "railway"]);
  });

  it("the default (no injected catalog) call still projects every real catalog entry — the optional param is additive, not a behavior change", () => {
    const rows = projectConnectors([]);
    expect(rows.map((r) => r.kind)).toEqual([
      "github",
      "linear",
      "figma",
      "context7",
      "railway",
    ]);
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

  // Task 7: railway has no ingest/postResult/notify/tools — only `evidence`,
  // which capabilitySummary doesn't render at all — so its card header must
  // fall back to the em-dash placeholder, same as any other all-false input.
  it("summarizes railway (evidence-only) as the em-dash placeholder — no ingest/postResult/notify/tools", () => {
    const railway = CONNECTOR_CATALOG.find((c) => c.kind === "railway")!;
    expect(capabilitySummary(railway.capabilities)).toBe("—");
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

  // Task 7: Railway tokens (Account/Team) are UUIDs — confirmed against
  // Railway's public API docs (query { me { name email } } over
  // https://backboard.railway.com/graphql/v2, Authorization: Bearer <token>;
  // the token itself is displayed as a UUID at railway.com/account/tokens).
  // A generic UUID SHAPE regex, not RFC4122-version-specific — Railway does
  // not document which UUID version it mints, so this validates the
  // 8-4-4-4-12 hex shape only, same "cheap format gate, not a claim of
  // cryptographic correctness" spirit as the other credential checks here.
  it("accepts a UUID-shaped railway token", () => {
    expect(
      validateConnectorCredential("railway", "3fa85f64-5717-4562-b3fc-2c963f66afa6")
    ).toEqual({ ok: true });
    // Case-insensitive — GraphQL/JSON tokens are not case-normalized by convention.
    expect(
      validateConnectorCredential("railway", "3FA85F64-5717-4562-B3FC-2C963F66AFA6")
    ).toEqual({ ok: true });
  });

  it("rejects a non-UUID-shaped railway token", () => {
    expect(validateConnectorCredential("railway", "not-a-uuid").ok).toBe(false);
    expect(validateConnectorCredential("railway", "lin_api_abc123").ok).toBe(false);
    // One character short of a valid UUID.
    expect(
      validateConnectorCredential("railway", "3fa85f64-5717-4562-b3fc-2c963f66afa").ok
    ).toBe(false);
  });
});

describe("CONNECTOR_TYPE_META — observability section (Task 7)", () => {
  it("has a label and description for the new observability section", () => {
    expect(CONNECTOR_TYPE_META.observability.label).toBe("Observability");
    expect(CONNECTOR_TYPE_META.observability.description.length).toBeGreaterThan(0);
  });
});

describe("connector catalog — railway entry (Task 7)", () => {
  const railway = CONNECTOR_CATALOG.find((c) => c.kind === "railway")!;

  it("is type observability, connectMethod secret, availability available", () => {
    expect(railway.type).toBe("observability");
    expect(railway.connectMethod).toBe("secret");
    expect(railway.availability).toBe("available");
  });

  it("declares evidence capabilities changes + search_events, and no ingest/postResult/notify", () => {
    expect(railway.capabilities).toEqual({
      ingest: false,
      postResult: false,
      notify: false,
      evidence: ["changes", "search_events"],
    });
  });

  it("declares an extraConfigField for the Railway project id, driving the connect form's second input", () => {
    expect(railway.connect?.extraConfigField).toEqual({
      key: "railwayProjectId",
      label: expect.any(String),
      placeholder: expect.any(String),
    });
  });

  it("every other catalog entry declares no extraConfigField (Task 7 is the first provider needing one)", () => {
    for (const entry of CONNECTOR_CATALOG) {
      if (entry.kind === "railway") continue;
      expect(entry.connect?.extraConfigField).toBeUndefined();
    }
  });
});

// Fix Round 1, FIX 3: railwayProjectId forwarded through projectConnectors
// into ConnectorView.target — mirrors how GitHub's target renders (same
// field, same generic render slot in SecretManage's connected-state
// summary; connectors-panel.tsx needed no new code).
describe("projectConnectors — railway's target (Fix Round 1, FIX 3)", () => {
  it("shows railway's stored project id as its target once connected", () => {
    const railway = projectConnectors([
      { kind: "railway", hasSecret: true, railwayProjectId: "proj-abc" },
    ]).find((r) => r.kind === "railway")!;
    expect(railway.status).toBe("connected");
    expect(railway.target).toBe("proj-abc");
  });

  it("railway's target is null when connected but no project id is stored yet", () => {
    const railway = projectConnectors([{ kind: "railway", hasSecret: true }]).find(
      (r) => r.kind === "railway"
    )!;
    expect(railway.status).toBe("connected");
    expect(railway.target).toBeNull();
  });

  it("railway's target still surfaces from stored config even while disconnected — mirrors oauth's target, which is likewise independent of `status` in this function", () => {
    const railway = projectConnectors([
      { kind: "railway", hasSecret: false, railwayProjectId: "proj-abc" },
    ]).find((r) => r.kind === "railway")!;
    expect(railway.status).toBe("disconnected");
    expect(railway.target).toBe("proj-abc");
  });

  it("a kind with no declared extraConfigField never surfaces railwayProjectId as its target, even if the field is (incorrectly) present in its config", () => {
    const linear = projectConnectors([
      { kind: "linear", hasSecret: true, railwayProjectId: "should-not-leak" },
    ]).find((r) => r.kind === "linear")!;
    expect(linear.target).toBeNull();
  });
});
