import { describe, expect, it } from "vitest";
import {
  CONNECTOR_CATALOG,
  CONNECTOR_TYPE_META,
  DEFAULT_INGEST_LABEL,
  DEFAULT_POLL_INTERVAL_SECONDS,
  activeHeartbeatConnectors,
  capabilitySummary,
  connectorStatusLabel,
  extraConfigFieldKeys,
  projectConnectors,
  projectExtraConfigValues,
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
      "langfuse",
      "sentry",
      "datadog",
      "prometheus",
      "grafana",
      "vercel",
      "cloudflare",
    ]);
    // Each row carries its catalog type so the page can section the cards.
    // #1292: GitHub AND Linear are both `issue-source` (they feed the Issue
    // Queue — Linear via its real-time webhook); Figma / Context7 stay
    // tools-only `mcp`. Gateways-page T4 removed the third group, `channel`
    // (Discord / Slack / Telegram) — those now live on their own Gateways
    // surface. Task 7 adds a FOURTH group, `observability` (Railway — evidence
    // for debugging investigations, no ingest); Task P2 adds langfuse, Task
    // P3 adds sentry, Task P4 adds datadog, Task P5 adds prometheus, Task P6
    // adds grafana, Task P7 adds vercel, and Task P8 adds cloudflare (the
    // final Wave-2 provider) to the SAME `observability` group.
    expect(rows.map((r) => r.type)).toEqual([
      "issue-source",
      "issue-source",
      "mcp",
      "mcp",
      "observability",
      "observability",
      "observability",
      "observability",
      "observability",
      "observability",
      "observability",
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
    expect(rows.map((r) => r.kind)).toEqual([
      "github",
      "linear",
      "figma",
      "railway",
      "langfuse",
      "sentry",
      "datadog",
      "prometheus",
      "grafana",
      "vercel",
      "cloudflare",
    ]);
  });

  it("the default (no injected catalog) call still projects every real catalog entry — the optional param is additive, not a behavior change", () => {
    const rows = projectConnectors([]);
    expect(rows.map((r) => r.kind)).toEqual([
      "github",
      "linear",
      "figma",
      "context7",
      "railway",
      "langfuse",
      "sentry",
      "datadog",
      "prometheus",
      "grafana",
      "vercel",
      "cloudflare",
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

// Task P0: the generic composite-secret validation path — a catalog entry
// declaring `secretParts` (+ optionally `secretPartPatterns`) is validated
// WITHOUT a hand-written switch case. Exercised via a synthetic catalog
// (mirroring the `internal`-entry-filter test's injection pattern above) so
// this is proven generically, without a second real composite provider (P0
// adds none — that's P2-P8's job).
describe("validateConnectorCredential — composite secrets (generic secretParts/secretPartPatterns, Task P0)", () => {
  const compositeEntry: ConnectorCatalogEntry = {
    kind: "context7",
    type: "mcp",
    connectMethod: "secret",
    label: "Composite Test",
    description: "test",
    availability: "available",
    capabilities: { ingest: false, postResult: false, notify: false },
    connect: {
      credentialLabel: "test",
      credentialPlaceholder: "test",
      credentialHint: "test",
      helpUrl: "https://example.com",
      setupSteps: [],
      secretParts: [{ name: "Public key" }, { name: "Secret key" }],
      secretPartPatterns: ["^pk-", "^sk-"],
    },
  };
  const catalog = [compositeEntry];

  it("accepts a well-formed composite secret matching both part patterns", () => {
    expect(validateConnectorCredential("context7", "pk-abc:sk-def", catalog)).toEqual({
      ok: true,
    });
  });

  it("rejects when the first part fails its pattern, naming that part", () => {
    const res = validateConnectorCredential("context7", "xx-abc:sk-def", catalog);
    expect(res).toEqual({ ok: false, error: "Public key has an unexpected format." });
  });

  it("rejects when the second part fails its pattern, naming that part", () => {
    const res = validateConnectorCredential("context7", "pk-abc:xx-def", catalog);
    expect(res).toEqual({ ok: false, error: "Secret key has an unexpected format." });
  });

  it("propagates a splitCompositeSecret count error (wrong number of parts)", () => {
    const res = validateConnectorCredential("context7", "only-one-part", catalog);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("2 parts");
  });

  it("accepts any well-split content when secretParts is declared but secretPartPatterns is absent (count/non-empty only)", () => {
    const noPatterns: ConnectorCatalogEntry = {
      ...compositeEntry,
      connect: { ...compositeEntry.connect!, secretPartPatterns: undefined },
    };
    expect(
      validateConnectorCredential("context7", "anything:whatever", [noPatterns])
    ).toEqual({ ok: true });
  });

  it("skips per-part validation for an index missing from a sparse secretPartPatterns array", () => {
    const sparse: ConnectorCatalogEntry = {
      ...compositeEntry,
      connect: { ...compositeEntry.connect!, secretPartPatterns: ["^pk-"] }, // no pattern for part 2
    };
    expect(
      validateConnectorCredential("context7", "pk-abc:literally-anything", [sparse])
    ).toEqual({ ok: true });
  });

  it("existing single-pattern providers stay on their hand-written case — unaffected, real catalog default param", () => {
    // Uses the DEFAULT (real) catalog — proves the generic path is a no-op
    // for every provider shipped before this wave (none declares secretParts).
    expect(validateConnectorCredential("linear", "lin_api_abc123")).toEqual({ ok: true });
    expect(validateConnectorCredential("linear", "nope").ok).toBe(false);
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

  // Task P0: extraConfigField (singular object) → extraConfigFields (array).
  // Railway's entry is the array shape's first user — behavior-identical to
  // the single-field shape it replaces (asserted throughout this file via
  // `projectConnectors`'s target derivation and connectors/route.test.ts).
  it("declares extraConfigFields (array shape) for the Railway project id, driving the connect form's second input", () => {
    expect(railway.connect?.extraConfigFields).toEqual([
      {
        key: "railwayProjectId",
        label: expect.any(String),
        placeholder: expect.any(String),
      },
    ]);
  });

  it("every catalog entry that doesn't need one declares no extraConfigFields — railway (project id), langfuse (host, Task P2), sentry (org+project, Task P3), datadog (site, Task P4), prometheus (base URL, Task P5), grafana (base URL, Task P6), vercel (project id + team id, Task P7), and cloudflare (zone id, Task P8) are the only eight so far", () => {
    for (const entry of CONNECTOR_CATALOG) {
      if (
        entry.kind === "railway" ||
        entry.kind === "langfuse" ||
        entry.kind === "sentry" ||
        entry.kind === "datadog" ||
        entry.kind === "prometheus" ||
        entry.kind === "grafana" ||
        entry.kind === "vercel" ||
        entry.kind === "cloudflare"
      )
        continue;
      expect(entry.connect?.extraConfigFields).toBeUndefined();
    }
  });

  it("declares neither secretParts nor secretPartPatterns — a single-part credential, unaffected by the composite-secret generalization", () => {
    expect(railway.connect?.secretParts).toBeUndefined();
    expect(railway.connect?.secretPartPatterns).toBeUndefined();
  });

  // OAuth Connect Wave 3, W3-T2 — ConnectorConnectMeta.oauthHint.
  it("declares a calm oauthHint sentence for the OAuth-primary button, mentioning read-only access and the token fallback", () => {
    expect(railway.connect?.oauthHint).toBeDefined();
    expect(railway.connect?.oauthHint).toMatch(/read-only/i);
    expect(railway.connect?.oauthHint).toMatch(/api token/i);
  });
});

describe("connector catalog — langfuse entry (Task P2)", () => {
  const langfuse = CONNECTOR_CATALOG.find((c) => c.kind === "langfuse")!;

  it("is type observability, connectMethod secret, availability available", () => {
    expect(langfuse.type).toBe("observability");
    expect(langfuse.connectMethod).toBe("secret");
    expect(langfuse.availability).toBe("available");
  });

  it("declares evidence capabilities traces + signals, and no ingest/postResult/notify", () => {
    expect(langfuse.capabilities).toEqual({
      ingest: false,
      postResult: false,
      notify: false,
      evidence: ["traces", "signals"],
    });
  });

  it("declares a composite two-part secret (public + secret key) with per-part patterns", () => {
    expect(langfuse.connect?.secretParts).toEqual([{ name: "Public key" }, { name: "Secret key" }]);
    expect(langfuse.connect?.secretPartPatterns).toEqual(["^pk-lf-", "^sk-lf-"]);
  });

  it("declares a required langfuseHost extraConfigFields entry", () => {
    expect(langfuse.connect?.extraConfigFields).toEqual([
      {
        key: "langfuseHost",
        label: expect.any(String),
        placeholder: expect.any(String),
        required: true,
      },
    ]);
  });
});

describe("validateConnectorCredential — langfuse (Task P2)", () => {
  it("accepts a well-formed pk-lf-…:sk-lf-… composite secret via the generic composite path (real catalog, no synthetic entry needed)", () => {
    expect(validateConnectorCredential("langfuse", "pk-lf-abc123:sk-lf-def456")).toEqual({
      ok: true,
    });
  });

  it("rejects when the public key part doesn't match ^pk-lf-", () => {
    const res = validateConnectorCredential("langfuse", "wrong-prefix:sk-lf-def456");
    expect(res).toEqual({ ok: false, error: "Public key has an unexpected format." });
  });

  it("rejects when the secret key part doesn't match ^sk-lf-", () => {
    const res = validateConnectorCredential("langfuse", "pk-lf-abc123:wrong-prefix");
    expect(res).toEqual({ ok: false, error: "Secret key has an unexpected format." });
  });

  it("rejects a single-part value (no colon) with the composite part-count error, never reaching the langfuse switch case", () => {
    const res = validateConnectorCredential("langfuse", "pk-lf-abc123-only");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("2 parts");
  });

  it("the langfuse switch case itself (defense in depth, unreachable through the real catalog) rejects — proven via a synthetic catalog entry with secretParts stripped", () => {
    const real = CONNECTOR_CATALOG.find((c) => c.kind === "langfuse")!;
    const stripped: ConnectorCatalogEntry = {
      ...real,
      connect: { ...real.connect!, secretParts: undefined, secretPartPatterns: undefined },
    };
    const res = validateConnectorCredential("langfuse", "anything", [stripped]);
    expect(res).toEqual({
      ok: false,
      error: "Langfuse requires both API keys (public + secret).",
    });
  });
});

describe("connector catalog — sentry entry (Task P3)", () => {
  const sentry = CONNECTOR_CATALOG.find((c) => c.kind === "sentry")!;

  it("is type observability, connectMethod secret, availability available", () => {
    expect(sentry.type).toBe("observability");
    expect(sentry.connectMethod).toBe("secret");
    expect(sentry.availability).toBe("available");
  });

  it("declares evidence capabilities search_events + signals, and no ingest/postResult/notify", () => {
    expect(sentry.capabilities).toEqual({
      ingest: false,
      postResult: false,
      notify: false,
      evidence: ["search_events", "signals"],
    });
  });

  it("declares neither secretParts nor secretPartPatterns — a SINGLE-part credential, unlike langfuse's composite pair", () => {
    expect(sentry.connect?.secretParts).toBeUndefined();
    expect(sentry.connect?.secretPartPatterns).toBeUndefined();
  });

  it("declares required sentryOrg + sentryProject extraConfigFields entries, in that order", () => {
    expect(sentry.connect?.extraConfigFields).toEqual([
      {
        key: "sentryOrg",
        label: expect.any(String),
        placeholder: expect.any(String),
        required: true,
      },
      {
        key: "sentryProject",
        label: expect.any(String),
        placeholder: expect.any(String),
        required: true,
      },
    ]);
  });
});

describe("validateConnectorCredential — sentry (Task P3)", () => {
  it("accepts an sntrys_… organization auth token", () => {
    expect(validateConnectorCredential("sentry", "sntrys_abc123")).toEqual({ ok: true });
  });

  it("accepts an sntryu_… user auth token", () => {
    expect(validateConnectorCredential("sentry", "sntryu_def456")).toEqual({ ok: true });
  });

  it("rejects a token with neither confirmed prefix, including the two OUT-OF-SCOPE Sentry kinds (sntrya_ user-app, sntryi_ integration)", () => {
    expect(validateConnectorCredential("sentry", "sntrya_abc").ok).toBe(false);
    expect(validateConnectorCredential("sentry", "sntryi_abc").ok).toBe(false);
    expect(validateConnectorCredential("sentry", "ghp_abc123").ok).toBe(false);
    const res = validateConnectorCredential("sentry", "not-a-sentry-token");
    expect(res).toEqual({
      ok: false,
      error: "Sentry tokens start with sntrys_ (organization) or sntryu_ (user).",
    });
  });

  it("rejects an empty credential before ever reaching the sentry-specific check", () => {
    expect(validateConnectorCredential("sentry", "   ").ok).toBe(false);
  });
});

describe("connector catalog — datadog entry (Task P4)", () => {
  const datadog = CONNECTOR_CATALOG.find((c) => c.kind === "datadog")!;

  it("is type observability, connectMethod secret, availability available", () => {
    expect(datadog.type).toBe("observability");
    expect(datadog.connectMethod).toBe("secret");
    expect(datadog.availability).toBe("available");
  });

  it("declares evidence capabilities signals + search_events, and no ingest/postResult/notify", () => {
    expect(datadog.capabilities).toEqual({
      ingest: false,
      postResult: false,
      notify: false,
      evidence: ["signals", "search_events"],
    });
  });

  it("declares a composite two-part secret (apiKey + appKey) with per-part patterns", () => {
    expect(datadog.connect?.secretParts).toEqual([{ name: "API key" }, { name: "Application key" }]);
    expect(datadog.connect?.secretPartPatterns).toEqual(["^[0-9a-f]{32}$", "^([0-9a-f]{40}|ddapp_[A-Za-z0-9]{34})$"]);
  });

  it("declares a required datadogSite extraConfigFields entry", () => {
    expect(datadog.connect?.extraConfigFields).toEqual([
      {
        key: "datadogSite",
        label: expect.any(String),
        placeholder: expect.any(String),
        required: true,
      },
    ]);
  });
});

describe("validateConnectorCredential — datadog (Task P4)", () => {
  it("accepts a well-formed 32-hex-api-key:40-hex-app-key composite secret via the generic composite path", () => {
    expect(
      validateConnectorCredential("datadog", `${"a".repeat(32)}:${"b".repeat(40)}`)
    ).toEqual({ ok: true });
  });

  it("also accepts the newer ddapp_-prefixed application key form (exactly 34 chars after the prefix, Fix Round 1's tightened length)", () => {
    expect(
      validateConnectorCredential("datadog", `${"a".repeat(32)}:ddapp_${"X".repeat(34)}`)
    ).toEqual({ ok: true });
  });

  it("rejects a ddapp_-prefixed application key of the WRONG length — Fix Round 1 tightened the pattern from open-ended to exactly 34 chars", () => {
    const tooShort = validateConnectorCredential("datadog", `${"a".repeat(32)}:ddapp_${"X".repeat(33)}`);
    expect(tooShort.ok).toBe(false);
    const tooLong = validateConnectorCredential("datadog", `${"a".repeat(32)}:ddapp_${"X".repeat(35)}`);
    expect(tooLong.ok).toBe(false);
  });

  it("rejects when the api key part isn't exactly 32 hex chars", () => {
    const res = validateConnectorCredential("datadog", `${"a".repeat(31)}:${"b".repeat(40)}`);
    expect(res).toEqual({ ok: false, error: "API key has an unexpected format." });
  });

  it("rejects when the app key part matches neither the 40-hex nor the ddapp_ form", () => {
    const res = validateConnectorCredential("datadog", `${"a".repeat(32)}:not-a-real-app-key`);
    expect(res).toEqual({ ok: false, error: "Application key has an unexpected format." });
  });

  it("rejects a single-part value (no colon) with the composite part-count error, never reaching the datadog switch case", () => {
    const res = validateConnectorCredential("datadog", "only-one-part");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("2 parts");
  });

  it("the datadog switch case itself (defense in depth, unreachable through the real catalog) rejects — proven via a synthetic catalog entry with secretParts stripped", () => {
    const real = CONNECTOR_CATALOG.find((c) => c.kind === "datadog")!;
    const stripped: ConnectorCatalogEntry = {
      ...real,
      connect: { ...real.connect!, secretParts: undefined, secretPartPatterns: undefined },
    };
    const res = validateConnectorCredential("datadog", "anything", [stripped]);
    expect(res).toEqual({
      ok: false,
      error: "Datadog requires both an API key and an application key.",
    });
  });
});

describe("connector catalog — prometheus entry (Task P5)", () => {
  const prometheus = CONNECTOR_CATALOG.find((c) => c.kind === "prometheus")!;

  it("is type observability, connectMethod secret, availability available", () => {
    expect(prometheus.type).toBe("observability");
    expect(prometheus.connectMethod).toBe("secret");
    expect(prometheus.availability).toBe("available");
  });

  it("declares evidence capabilities signals ONLY, and no ingest/postResult/notify", () => {
    expect(prometheus.capabilities).toEqual({
      ingest: false,
      postResult: false,
      notify: false,
      evidence: ["signals"],
    });
  });

  it("declares neither secretParts nor secretPartPatterns — a SINGLE-part credential, unlike langfuse's/datadog's composite pairs", () => {
    expect(prometheus.connect?.secretParts).toBeUndefined();
    expect(prometheus.connect?.secretPartPatterns).toBeUndefined();
  });

  it("declares a required prometheusUrl extraConfigFields entry", () => {
    expect(prometheus.connect?.extraConfigFields).toEqual([
      {
        key: "prometheusUrl",
        label: expect.any(String),
        placeholder: expect.any(String),
        required: true,
      },
    ]);
  });
});

describe("validateConnectorCredential — prometheus (Task P5)", () => {
  it("accepts a plain bearer-shaped token (no colon)", () => {
    expect(validateConnectorCredential("prometheus", "sometoken1234567890")).toEqual({ ok: true });
  });

  it("accepts a user:pass composite (the same single field also carries Basic-auth pairs)", () => {
    expect(validateConnectorCredential("prometheus", "myuser:mypass")).toEqual({ ok: true });
  });

  it("accepts a user:pass pair whose password itself contains a colon", () => {
    expect(validateConnectorCredential("prometheus", "myuser:my:pass:word")).toEqual({ ok: true });
  });

  it("rejects a credential containing whitespace", () => {
    const res = validateConnectorCredential("prometheus", "token with spaces");
    expect(res).toEqual({ ok: false, error: "Prometheus credentials must not contain whitespace." });
  });

  it("rejects a credential over 512 characters", () => {
    const res = validateConnectorCredential("prometheus", "a".repeat(513));
    expect(res).toEqual({ ok: false, error: "Prometheus credentials must be at most 512 characters." });
  });

  it("accepts a credential at exactly 512 characters (boundary)", () => {
    expect(validateConnectorCredential("prometheus", "a".repeat(512))).toEqual({ ok: true });
  });

  it("rejects an empty credential before ever reaching the prometheus-specific check", () => {
    expect(validateConnectorCredential("prometheus", "   ").ok).toBe(false);
  });
});

describe("connector catalog — grafana entry (Task P6)", () => {
  const grafana = CONNECTOR_CATALOG.find((c) => c.kind === "grafana")!;

  it("is type observability, connectMethod secret, availability available", () => {
    expect(grafana.type).toBe("observability");
    expect(grafana.connectMethod).toBe("secret");
    expect(grafana.availability).toBe("available");
  });

  it("declares evidence capabilities search_events ONLY, and no ingest/postResult/notify — the pivot away from the plan's believed signals", () => {
    expect(grafana.capabilities).toEqual({
      ingest: false,
      postResult: false,
      notify: false,
      evidence: ["search_events"],
    });
  });

  it("declares neither secretParts nor secretPartPatterns — a SINGLE-part credential, like prometheus, unlike langfuse's/datadog's composite pairs", () => {
    expect(grafana.connect?.secretParts).toBeUndefined();
    expect(grafana.connect?.secretPartPatterns).toBeUndefined();
  });

  it("declares a required grafanaUrl extraConfigFields entry", () => {
    expect(grafana.connect?.extraConfigFields).toEqual([
      {
        key: "grafanaUrl",
        label: expect.any(String),
        placeholder: expect.any(String),
        required: true,
      },
    ]);
  });
});

// FIXTURE, deliberately non-realistic (every credential literal below):
// built from an obviously-fake body ("TESTFIXTURE"/repeated digits, or —
// for the eyJ… legacy-key shape — the base64 of a nonsense JSON object)
// specifically so GitHub push protection's secret scanner never flags it.
// Do NOT "fix" these to look more like a real token/key — that is what
// gets them flagged.
describe("validateConnectorCredential — grafana (Task P6)", () => {
  it("accepts a glsa_-prefixed service account token", () => {
    expect(validateConnectorCredential("grafana", "glsa_TESTFIXTURE0000000000000000000000AB")).toEqual({
      ok: true,
    });
  });

  it("accepts a legacy eyJ-prefixed API key", () => {
    // base64 of {"TEST":"fixture-not-a-key"} — NOT the {"k":...,"n":...,
    // "id":...} shape a real legacy Grafana API key decodes to.
    expect(
      validateConnectorCredential("grafana", "eyJURVNUIjoiZml4dHVyZS1ub3QtYS1rZXkifQ==")
    ).toEqual({ ok: true });
  });

  it("rejects a credential matching neither documented prefix", () => {
    const res = validateConnectorCredential("grafana", "not-a-real-token");
    expect(res).toEqual({
      ok: false,
      error: "Grafana tokens start with glsa_ (service account) or eyJ (legacy API key).",
    });
  });

  it("rejects an empty credential before ever reaching the grafana-specific check", () => {
    expect(validateConnectorCredential("grafana", "   ").ok).toBe(false);
  });
});

describe("connector catalog — vercel entry (Task P7)", () => {
  const vercel = CONNECTOR_CATALOG.find((c) => c.kind === "vercel")!;

  it("is type observability, connectMethod secret, availability available", () => {
    expect(vercel.type).toBe("observability");
    expect(vercel.connectMethod).toBe("secret");
    expect(vercel.availability).toBe("available");
  });

  it("declares evidence capabilities [changes, search_events], and no ingest/postResult/notify", () => {
    expect(vercel.capabilities).toEqual({
      ingest: false,
      postResult: false,
      notify: false,
      evidence: ["changes", "search_events"],
    });
  });

  it("declares neither secretParts nor secretPartPatterns — a SINGLE-part credential, like sentry/prometheus/grafana", () => {
    expect(vercel.connect?.secretParts).toBeUndefined();
    expect(vercel.connect?.secretPartPatterns).toBeUndefined();
  });

  it("declares vercelProjectId (required) then vercelTeamId (optional) — the wave's first OPTIONAL extra config field", () => {
    expect(vercel.connect?.extraConfigFields).toEqual([
      {
        key: "vercelProjectId",
        label: expect.any(String),
        placeholder: expect.any(String),
        required: true,
      },
      {
        key: "vercelTeamId",
        label: expect.any(String),
        placeholder: expect.any(String),
        required: false,
      },
    ]);
  });
});

describe("connector catalog — cloudflare entry (Task P8, FINAL Wave-2 provider)", () => {
  const cloudflare = CONNECTOR_CATALOG.find((c) => c.kind === "cloudflare")!;

  it("is type observability, connectMethod secret, availability available", () => {
    expect(cloudflare.type).toBe("observability");
    expect(cloudflare.connectMethod).toBe("secret");
    expect(cloudflare.availability).toBe("available");
  });

  it("declares evidence capabilities [signals, search_events], and no ingest/postResult/notify", () => {
    expect(cloudflare.capabilities).toEqual({
      ingest: false,
      postResult: false,
      notify: false,
      evidence: ["signals", "search_events"],
    });
  });

  it("declares neither secretParts nor secretPartPatterns — a SINGLE-part credential, like sentry/prometheus/grafana/vercel", () => {
    expect(cloudflare.connect?.secretParts).toBeUndefined();
    expect(cloudflare.connect?.secretPartPatterns).toBeUndefined();
  });

  it("declares ONLY cloudflareZoneId (required) — cloudflareAccountId is deliberately NOT declared here (zoneTag suffices for both GraphQL datasets)", () => {
    expect(cloudflare.connect?.extraConfigFields).toEqual([
      {
        key: "cloudflareZoneId",
        label: expect.any(String),
        placeholder: expect.any(String),
        required: true,
      },
    ]);
  });
});

// FIXTURE, deliberately non-realistic (Fix Round 1 — shape asserted
// explicitly, per review; Fix Round 2 — a prior version of the test below
// wrote its prefixed literal as ONE contiguous string, itself flagged on
// re-review: a prefix immediately followed by a long token-shaped run is
// exactly the shape a live provider secret-scanning detector matches on —
// partner detector patterns are prefix+charset heuristics that cannot tell
// obvious filler from real entropy, so a harmless-looking BODY does not
// save an unbroken PREFIX (the P6 push-protection incident's own lesson,
// generalized: it is the CONTIGUOUS literal in source that gets scanned,
// not the fixture's intent — this note deliberately avoids spelling the
// prefix out immediately next to a token-shaped run too, for the same
// reason). RULE: never commit a contiguous literal bearing any
// live-scanned provider prefix, in CODE OR IN A COMMENT — build it from
// two separately-quoted string pieces joined with `+` at the point of use
// instead (see the concatenation below), so no single source token is ever
// prefix-matchable. Every literal below either has no prefix at all or is
// built this way. Do NOT "fix" these to look more like a real token, and
// do NOT re-join a split literal back into one contiguous string — either
// change is what gets them flagged.
describe("validateConnectorCredential — vercel (Task P7)", () => {
  it("accepts a legacy, unprefixed credential — the shape the gate has always accepted, still valid per Vercel's own changelog", () => {
    expect(validateConnectorCredential("vercel", "a-plausible-looking-token-0000")).toEqual({ ok: true });
  });

  it("ALSO accepts a vcp_-prefixed credential (the newer format) — the gate is deliberately permissive across both generations, not a rejection of the new one", () => {
    // Concat-split (see this block's own shared comment) — no contiguous
    // `vcp_...` literal exists in source.
    const vcpPrefixedFixture = "vcp" + "_TESTFIXTURE00000000000000000000000000";
    expect(validateConnectorCredential("vercel", vcpPrefixedFixture)).toEqual({
      ok: true,
    });
  });

  it("rejects a credential containing whitespace", () => {
    const res = validateConnectorCredential("vercel", "has a space");
    expect(res).toEqual({ ok: false, error: "Vercel tokens must not contain whitespace." });
  });

  it("rejects a credential over 512 characters", () => {
    const res = validateConnectorCredential("vercel", "x".repeat(513));
    expect(res).toEqual({ ok: false, error: "Vercel tokens must be at most 512 characters." });
  });

  it("accepts a credential at exactly 512 characters (boundary)", () => {
    expect(validateConnectorCredential("vercel", "x".repeat(512))).toEqual({ ok: true });
  });

  it("rejects an empty credential before ever reaching the vercel-specific check", () => {
    expect(validateConnectorCredential("vercel", "   ").ok).toBe(false);
  });
});

// FIXTURE, deliberately non-realistic (mirrors the vercel block's own
// shared comment above — see that block for the full concat-split rule).
// Cloudflare's live-scanned prefixes are `cfut_`/`cfat_`/`cfk_` (see
// lib/evidence/cloudflare.ts's own doc-comment, "AUTH") — no contiguous
// literal bearing any of them exists in this file.
describe("validateConnectorCredential — cloudflare (Task P8, FINAL Wave-2 provider)", () => {
  it("accepts a legacy, unprefixed credential — the shape the gate has always accepted, still valid per Cloudflare's own token-formats page", () => {
    expect(validateConnectorCredential("cloudflare", "a-plausible-looking-token-0000")).toEqual({ ok: true });
  });

  it("ALSO accepts a cfut_-prefixed credential (the newer User API Token format) — the gate is deliberately permissive across both generations", () => {
    // Concat-split (see this block's own shared comment) — no contiguous
    // `cfut_...` literal exists in source.
    const cfutPrefixedFixture = "cfut" + "_TESTFIXTURE0000000000000000000000000000000";
    expect(validateConnectorCredential("cloudflare", cfutPrefixedFixture)).toEqual({ ok: true });
  });

  it("ALSO accepts a cfat_-prefixed credential (the newer Account API Token format)", () => {
    const cfatPrefixedFixture = "cfat" + "_TESTFIXTURE0000000000000000000000000000000";
    expect(validateConnectorCredential("cloudflare", cfatPrefixedFixture)).toEqual({ ok: true });
  });

  it("rejects a credential containing whitespace", () => {
    const res = validateConnectorCredential("cloudflare", "has a space");
    expect(res).toEqual({ ok: false, error: "Cloudflare tokens must not contain whitespace." });
  });

  it("rejects a credential over 512 characters", () => {
    const res = validateConnectorCredential("cloudflare", "x".repeat(513));
    expect(res).toEqual({ ok: false, error: "Cloudflare tokens must be at most 512 characters." });
  });

  it("accepts a credential at exactly 512 characters (boundary)", () => {
    expect(validateConnectorCredential("cloudflare", "x".repeat(512))).toEqual({ ok: true });
  });

  it("rejects an empty credential before ever reaching the cloudflare-specific check", () => {
    expect(validateConnectorCredential("cloudflare", "   ").ok).toBe(false);
  });
});

describe("extraConfigFieldKeys (Task P0)", () => {
  it("includes railway's declared key from the real catalog", () => {
    expect(extraConfigFieldKeys().has("railwayProjectId")).toBe(true);
  });

  it("includes langfuse's declared key from the real catalog (Task P2)", () => {
    expect(extraConfigFieldKeys().has("langfuseHost")).toBe(true);
  });

  it("includes both of sentry's declared keys from the real catalog (Task P3)", () => {
    expect(extraConfigFieldKeys().has("sentryOrg")).toBe(true);
    expect(extraConfigFieldKeys().has("sentryProject")).toBe(true);
  });

  it("includes prometheus's declared key from the real catalog (Task P5)", () => {
    expect(extraConfigFieldKeys().has("prometheusUrl")).toBe(true);
  });

  it("includes datadog's declared key from the real catalog (Task P4)", () => {
    expect(extraConfigFieldKeys().has("datadogSite")).toBe(true);
  });

  it("includes grafana's declared key from the real catalog (Task P6)", () => {
    expect(extraConfigFieldKeys().has("grafanaUrl")).toBe(true);
  });

  it("includes both of vercel's declared keys from the real catalog (Task P7)", () => {
    expect(extraConfigFieldKeys().has("vercelProjectId")).toBe(true);
    expect(extraConfigFieldKeys().has("vercelTeamId")).toBe(true);
  });

  it("includes cloudflare's declared key from the real catalog (Task P8) but NOT cloudflareAccountId (deliberately undeclared)", () => {
    expect(extraConfigFieldKeys().has("cloudflareZoneId")).toBe(true);
    expect(extraConfigFieldKeys().has("cloudflareAccountId")).toBe(false);
  });

  it("generalizes over N synthetic entries declaring multiple fields each — no second real provider needed to prove it", () => {
    const synthetic = [
      { connect: { extraConfigFields: [{ key: "fakeHost", label: "x", placeholder: "x" }] } },
      {
        connect: {
          extraConfigFields: [
            { key: "fakeOrg", label: "x", placeholder: "x" },
            { key: "fakeProject", label: "x", placeholder: "x" },
          ],
        },
      },
      { connect: undefined }, // an oauth-style entry with no connect metadata at all
      {}, // an entry with connect but no extraConfigFields (single-secret provider)
    ];
    const keys = extraConfigFieldKeys(synthetic);
    expect(keys).toEqual(new Set(["fakeHost", "fakeOrg", "fakeProject"]));
  });

  it("the default (no injected catalog) call reflects the real catalog only", () => {
    const keys = extraConfigFieldKeys();
    expect(keys.has("fakeHost")).toBe(false);
  });
});

describe("projectExtraConfigValues (Task P0)", () => {
  it("returns an empty bag for an entry with no declared fields", () => {
    expect(projectExtraConfigValues({}, { anything: "x" })).toEqual({});
  });

  it("projects a single declared field's stored value", () => {
    const entry = { connect: { extraConfigFields: [{ key: "railwayProjectId", label: "x", placeholder: "x" }] } };
    expect(projectExtraConfigValues(entry, { railwayProjectId: "proj-abc" })).toEqual({
      railwayProjectId: "proj-abc",
    });
  });

  it("generalizes to N declared fields, each read independently", () => {
    const entry = {
      connect: {
        extraConfigFields: [
          { key: "sentryOrg", label: "x", placeholder: "x" },
          { key: "sentryProject", label: "x", placeholder: "x" },
        ],
      },
    };
    expect(
      projectExtraConfigValues(entry, { sentryOrg: "acme", sentryProject: "web" })
    ).toEqual({ sentryOrg: "acme", sentryProject: "web" });
  });

  it("projects null for a declared field absent from the stored config", () => {
    const entry = { connect: { extraConfigFields: [{ key: "railwayProjectId", label: "x", placeholder: "x" }] } };
    expect(projectExtraConfigValues(entry, undefined)).toEqual({ railwayProjectId: null });
    expect(projectExtraConfigValues(entry, {})).toEqual({ railwayProjectId: null });
  });

  it("projects null (not the raw value) for a declared field whose stored value isn't a string", () => {
    const entry = { connect: { extraConfigFields: [{ key: "railwayProjectId", label: "x", placeholder: "x" }] } };
    expect(projectExtraConfigValues(entry, { railwayProjectId: 123 })).toEqual({
      railwayProjectId: null,
    });
  });
});

// Task P0: proves `projectConnectors`'s target derivation generalizes to N
// extraConfigFields (not just railway's single field) via a synthetic
// catalog override — the same test-injection pattern the `internal`-entry
// filter test above already uses.
describe("projectConnectors — target derivation generalizes to N extraConfigFields (Task P0)", () => {
  const syntheticCatalog: ConnectorCatalogEntry[] = CONNECTOR_CATALOG.map((entry) =>
    entry.kind === "railway"
      ? {
          ...entry,
          connect: {
            ...entry.connect!,
            extraConfigFields: [
              { key: "fieldA", label: "Field A", placeholder: "a" },
              { key: "fieldB", label: "Field B", placeholder: "b" },
            ],
          },
        }
      : entry
  );

  it("uses the FIRST declared field's value when an entry declares more than one", () => {
    const rows = projectConnectors(
      [{ kind: "railway", hasSecret: true, fieldA: "value-a", fieldB: "value-b" }],
      syntheticCatalog
    );
    expect(rows.find((r) => r.kind === "railway")!.target).toBe("value-a");
  });

  it("is null when the first field has no stored value, even if a later field does", () => {
    const rows = projectConnectors(
      [{ kind: "railway", hasSecret: true, fieldB: "value-b" }],
      syntheticCatalog
    );
    expect(rows.find((r) => r.kind === "railway")!.target).toBeNull();
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

  it("a kind with no declared extraConfigFields never surfaces railwayProjectId as its target, even if the field is (incorrectly) present in its config", () => {
    const linear = projectConnectors([
      { kind: "linear", hasSecret: true, railwayProjectId: "should-not-leak" },
    ]).find((r) => r.kind === "linear")!;
    expect(linear.target).toBeNull();
  });
});

// Task P3: sentry declares TWO extraConfigFields (sentryOrg, sentryProject,
// in that order) — the FIRST one (sentryOrg) is what surfaces as target,
// exactly the same generic derivation railway's own single-field block above
// already proved; this is the multi-field real-catalog case.
describe("projectConnectors — sentry's target (Task P3)", () => {
  it("shows sentry's stored org (the FIRST declared field) as its target once connected, not the project", () => {
    const sentry = projectConnectors([
      { kind: "sentry", hasSecret: true, sentryOrg: "acme", sentryProject: "web" },
    ]).find((r) => r.kind === "sentry")!;
    expect(sentry.status).toBe("connected");
    expect(sentry.target).toBe("acme");
  });

  it("sentry's target is null when connected but no org is stored yet, even if the project is", () => {
    const sentry = projectConnectors([
      { kind: "sentry", hasSecret: true, sentryProject: "web" },
    ]).find((r) => r.kind === "sentry")!;
    expect(sentry.status).toBe("connected");
    expect(sentry.target).toBeNull();
  });
});

// --------------------------------------------------------------------------- //
// W3-T1 (OAuth Connect Wave 3, `.superpowers/sdd/plan-oauth.md`): `oauthReady`
// is a DERIVED, ENV-COMPUTED-SERVER-SIDE flag (adapter registered AND
// `<PROVIDER>_OAUTH_CLIENT_ID`/`_SECRET` both set — see
// `apps/console/lib/oauth/types.ts`'s `oauthAdapterFor`/`oauthConfigFor`) —
// this pure model never computes it itself (no `process.env` read belongs in
// a "no I/O" projection file); the connectors GET route computes it and
// passes it in like every other per-row boolean (`hasSecret`, `enabled`).
// Absent from the input → false, so a route that hasn't been updated yet (or
// a provider the route never bothered to check) never accidentally shows the
// OAuth-primary sheet UI.
// --------------------------------------------------------------------------- //
describe("projectConnectors — oauthReady (W3-T1)", () => {
  it("defaults to false when the config input omits oauthReady", () => {
    const railway = projectConnectors([{ kind: "railway", hasSecret: true }]).find(
      (r) => r.kind === "railway"
    )!;
    expect(railway.oauthReady).toBe(false);
  });

  it("carries oauthReady: true through from the config input", () => {
    const railway = projectConnectors([
      { kind: "railway", hasSecret: false, oauthReady: true },
    ]).find((r) => r.kind === "railway")!;
    expect(railway.oauthReady).toBe(true);
  });

  it("is false for every row with no config input at all (disconnected, never queried)", () => {
    const rows = projectConnectors([]);
    for (const r of rows) expect(r.oauthReady).toBe(false);
  });

  it("is independent of connection status — a connected row can still be oauthReady:false (e.g. connected via legacy token before the env was ever set)", () => {
    const railway = projectConnectors([
      { kind: "railway", hasSecret: true, oauthReady: false },
    ]).find((r) => r.kind === "railway")!;
    expect(railway.status).toBe("connected");
    expect(railway.oauthReady).toBe(false);
  });
});
