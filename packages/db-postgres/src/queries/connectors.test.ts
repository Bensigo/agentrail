import { describe, expect, it } from "vitest";
import { isConnectorProvider, validateConnectorUpdate } from "./connectors.js";

/**
 * Pure-function coverage only (Task 7, debugging design spec). Both
 * functions under test are synchronous and touch no I/O — `getConnectors.js`
 * / `db.js` mocking (see `briefs.test.ts`'s own doc-comment: "there is no
 * live-DB harness in this package") is unnecessary here.
 *
 * Task 7 adds `"railway"` to `connectorProviderEnum` (a free-text column, so
 * this is a TS-union addition only — no migration, same precedent as
 * `"jace"`) and a `railwayProjectId` branch to `validateConnectorUpdate`
 * (the workspace's Railway project id, saved via this route alongside the
 * secret PUT — see `schema/connectors.ts`'s doc-comment on
 * `ConnectorConfig.railwayProjectId`).
 */

describe("isConnectorProvider — railway (Task 7)", () => {
  it("recognizes 'railway' as a known connector provider", () => {
    expect(isConnectorProvider("railway")).toBe(true);
  });

  it("still rejects an arbitrary string", () => {
    expect(isConnectorProvider("not-a-provider")).toBe(false);
  });
});

// Task P2 (Evidence Providers Wave 2): "langfuse" added to
// connectorProviderEnum — same free-text-column, TS-union-only precedent as
// "railway" above (no migration). langfuseHost's own validateConnectorUpdate
// coverage (scheme-gated via validateUrlConfigString) already lives in the
// "Evidence Providers Wave 2 (Task P0)" describe block below, alongside its
// nine Wave-2 siblings — not duplicated here.
describe("isConnectorProvider — langfuse (Task P2)", () => {
  it("recognizes 'langfuse' as a known connector provider", () => {
    expect(isConnectorProvider("langfuse")).toBe(true);
  });
});

// Task P3 (Evidence Providers Wave 2): "sentry" added to
// connectorProviderEnum — same free-text-column, TS-union-only precedent as
// "railway"/"langfuse" above (no migration). sentryOrg/sentryProject's own
// validateConnectorUpdate coverage already lives in the "Evidence Providers
// Wave 2 (Task P0)" describe block below, alongside their eight Wave-2
// siblings — not duplicated here.
describe("isConnectorProvider — sentry (Task P3)", () => {
  it("recognizes 'sentry' as a known connector provider", () => {
    expect(isConnectorProvider("sentry")).toBe(true);
  });
});

// Task P4 (Evidence Providers Wave 2): "datadog" added to
// connectorProviderEnum — same free-text-column, TS-union-only precedent as
// "railway"/"langfuse"/"sentry" above (no migration). datadogSite's own
// validateConnectorUpdate coverage already lives in the "Evidence Providers
// Wave 2 (Task P0)" describe block below, alongside its nine Wave-2
// siblings — not duplicated here.
describe("isConnectorProvider — datadog (Task P4)", () => {
  it("recognizes 'datadog' as a known connector provider", () => {
    expect(isConnectorProvider("datadog")).toBe(true);
  });
});

// Task P5 (Evidence Providers Wave 2): "prometheus" added to
// connectorProviderEnum — same free-text-column, TS-union-only precedent as
// "railway"/"langfuse"/"sentry"/"datadog" above (no migration).
// prometheusUrl's own validateConnectorUpdate coverage already lives in the
// "Evidence Providers Wave 2 (Task P0)" describe block below, alongside its
// nine Wave-2 siblings — not duplicated here.
describe("isConnectorProvider — prometheus (Task P5)", () => {
  it("recognizes 'prometheus' as a known connector provider", () => {
    expect(isConnectorProvider("prometheus")).toBe(true);
  });
});

describe("validateConnectorUpdate — railwayProjectId (Task 7)", () => {
  it("accepts and trims a well-formed railwayProjectId", () => {
    const res = validateConnectorUpdate({ config: { railwayProjectId: "  proj-123  " } });
    expect(res).toEqual({ ok: true, value: { config: { railwayProjectId: "proj-123" } } });
  });

  it("rejects a non-string railwayProjectId", () => {
    const res = validateConnectorUpdate({ config: { railwayProjectId: 123 as unknown as string } });
    expect(res).toEqual({ ok: false, error: "railwayProjectId must be a string" });
  });

  it("rejects an empty (or whitespace-only) railwayProjectId", () => {
    const res = validateConnectorUpdate({ config: { railwayProjectId: "   " } });
    expect(res).toEqual({ ok: false, error: "railwayProjectId must not be empty" });
  });

  it("rejects a railwayProjectId over 64 characters", () => {
    const res = validateConnectorUpdate({ config: { railwayProjectId: "x".repeat(65) } });
    expect(res).toEqual({
      ok: false,
      error: "railwayProjectId must be at most 64 characters",
    });
  });

  it("leaves railwayProjectId out of the normalized value when absent (no accidental default)", () => {
    const res = validateConnectorUpdate({ config: { triggerLabel: "afk" } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.config).not.toHaveProperty("railwayProjectId");
    }
  });

  it("composes with an unrelated field (triggerLabel) in the same update, unaffected by this addition", () => {
    const res = validateConnectorUpdate({
      config: { triggerLabel: "ready-for-agent", railwayProjectId: "proj-abc" },
    });
    expect(res).toEqual({
      ok: true,
      value: { config: { triggerLabel: "ready-for-agent", railwayProjectId: "proj-abc" } },
    });
  });
});

/**
 * Evidence Providers Wave 2 (Task P0): the ten non-secret companion fields
 * added to `ConnectorConfig` all at once so P2-P8 never touch this package
 * again (mirrors `railwayProjectId` above, Task 7). Every field shares the
 * base "string, trim, non-empty, ≤256 chars" shape (exercised generically
 * over the whole field list rather than eleven near-duplicate describe
 * blocks); the three URL-shaped fields ADDITIONALLY require an http(s)
 * scheme (Fix Round 1's `validateUrlConfigString`) and get their own
 * dedicated cases below, since a bare non-URL string like `value-langfuseHost`
 * is no longer a well-formed value for them.
 */
describe("validateConnectorUpdate — Evidence Providers Wave 2 extra config fields (Task P0)", () => {
  const WAVE2_SIMPLE_FIELDS = [
    "sentryOrg",
    "sentryProject",
    "datadogSite",
    "vercelTeamId",
    "vercelProjectId",
    "cloudflareZoneId",
    "cloudflareAccountId",
  ] as const;
  const WAVE2_URL_FIELDS = ["langfuseHost", "prometheusUrl", "grafanaUrl"] as const;
  // The base-shape checks (non-string / empty / over-length / absent) are
  // identical across BOTH groups — `validateUrlConfigString` delegates to
  // `validateSimpleConfigString` for all of them before ever parsing a URL.
  const WAVE2_FIELDS = [...WAVE2_SIMPLE_FIELDS, ...WAVE2_URL_FIELDS] as const;

  it.each(WAVE2_SIMPLE_FIELDS)("accepts and trims a well-formed %s", (field) => {
    const res = validateConnectorUpdate({ config: { [field]: `  value-${field}  ` } });
    expect(res).toEqual({ ok: true, value: { config: { [field]: `value-${field}` } } });
  });

  it.each(WAVE2_FIELDS)("rejects a non-string %s", (field) => {
    const res = validateConnectorUpdate({ config: { [field]: 123 as unknown as string } });
    expect(res).toEqual({ ok: false, error: `${field} must be a string` });
  });

  it.each(WAVE2_FIELDS)("rejects an empty (whitespace-only) %s", (field) => {
    const res = validateConnectorUpdate({ config: { [field]: "   " } });
    expect(res).toEqual({ ok: false, error: `${field} must not be empty` });
  });

  it.each(WAVE2_FIELDS)("rejects a %s over 256 characters", (field) => {
    const res = validateConnectorUpdate({ config: { [field]: "x".repeat(257) } });
    expect(res).toEqual({ ok: false, error: `${field} must be at most 256 characters` });
  });

  it.each(WAVE2_SIMPLE_FIELDS)("accepts a %s at exactly 256 characters (boundary)", (field) => {
    const res = validateConnectorUpdate({ config: { [field]: "x".repeat(256) } });
    expect(res.ok).toBe(true);
  });

  it.each(WAVE2_FIELDS)("leaves %s out of the normalized value when absent (no accidental default)", (field) => {
    const res = validateConnectorUpdate({ config: { triggerLabel: "afk" } });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.config).not.toHaveProperty(field);
  });

  it("composes two Wave 2 fields together in the same update (Sentry's two companions)", () => {
    const res = validateConnectorUpdate({
      config: { sentryOrg: "acme", sentryProject: "web" },
    });
    expect(res).toEqual({
      ok: true,
      value: { config: { sentryOrg: "acme", sentryProject: "web" } },
    });
  });

  it("composes a Wave 2 field with railwayProjectId and triggerLabel — no cross-field interference", () => {
    const res = validateConnectorUpdate({
      config: {
        triggerLabel: "ready-for-agent",
        railwayProjectId: "proj-abc",
        langfuseHost: "https://cloud.langfuse.com",
      },
    });
    expect(res).toEqual({
      ok: true,
      value: {
        config: {
          triggerLabel: "ready-for-agent",
          railwayProjectId: "proj-abc",
          langfuseHost: "https://cloud.langfuse.com",
        },
      },
    });
  });

  /**
   * Fix Round 1: langfuseHost/prometheusUrl/grafanaUrl are scheme-gated via
   * `validateUrlConfigString` — must parse as a URL AND be http(s). Private/
   * internal hosts are deliberately accepted (self-hosted Prometheus/
   * Grafana/Langfuse are legitimate) — only the SCHEME is gated, never the
   * host, per that function's own SSRF-tradeoff doc-comment.
   */
  describe("URL-shaped fields — scheme gate (Fix Round 1)", () => {
    it.each(WAVE2_URL_FIELDS)("rejects %s with a javascript: scheme", (field) => {
      const res = validateConnectorUpdate({ config: { [field]: "javascript:alert(1)" } });
      expect(res).toEqual({ ok: false, error: `${field} must be an http:// or https:// URL` });
    });

    it.each(WAVE2_URL_FIELDS)("rejects %s with a file: scheme", (field) => {
      const res = validateConnectorUpdate({ config: { [field]: "file:///etc/passwd" } });
      expect(res).toEqual({ ok: false, error: `${field} must be an http:// or https:// URL` });
    });

    it.each(WAVE2_URL_FIELDS)("rejects a bare non-URL string for %s", (field) => {
      const res = validateConnectorUpdate({ config: { [field]: "not-a-url" } });
      expect(res).toEqual({ ok: false, error: `${field} must be a valid URL` });
    });

    it("accepts prometheusUrl pointing at a private/internal host — deliberate SSRF tradeoff (self-hosted Prometheus)", () => {
      const res = validateConnectorUpdate({
        config: { prometheusUrl: "http://prometheus.internal:9090" },
      });
      expect(res).toEqual({
        ok: true,
        value: { config: { prometheusUrl: "http://prometheus.internal:9090" } },
      });
    });

    it("accepts langfuseHost pointing at a cloud region URL (https://jp.cloud.langfuse.com)", () => {
      const res = validateConnectorUpdate({
        config: { langfuseHost: "https://jp.cloud.langfuse.com" },
      });
      expect(res).toEqual({
        ok: true,
        value: { config: { langfuseHost: "https://jp.cloud.langfuse.com" } },
      });
    });

    it("accepts grafanaUrl pointing at a private host too (same scheme-only gate)", () => {
      const res = validateConnectorUpdate({
        config: { grafanaUrl: "http://grafana.internal:3000" },
      });
      expect(res).toEqual({
        ok: true,
        value: { config: { grafanaUrl: "http://grafana.internal:3000" } },
      });
    });

    it("accepts a URL-shaped field at exactly 256 characters (boundary, still a valid http URL)", () => {
      const value = "http://" + "x".repeat(249); // 7 + 249 = 256
      expect(value.length).toBe(256);
      const res = validateConnectorUpdate({ config: { grafanaUrl: value } });
      expect(res).toEqual({ ok: true, value: { config: { grafanaUrl: value } } });
    });
  });
});
