import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

// Renders a raw drizzle `SQL` fragment to its query text — the SAME idiom
// `investigations.test.ts` establishes for inspecting a `sql\`...\`` value
// passed to `.set()`/`.where()` (a bare `String(sqlFragment)` does NOT
// produce readable SQL; the fragment must go through the dialect renderer).
const renderSql = (q: unknown): string => new PgDialect().sqlToQuery(q as never).sql;

// W3-T1 (OAuth Connect Wave 3, `.superpowers/sdd/plan-oauth.md`) adds two
// I/O-touching functions (`mintConnectorOauthState`/`consumeConnectorOauthState`)
// alongside this file's original pure-function-only coverage — see the
// describe blocks at the bottom of this file. Mocked exactly like
// `src/__tests__/github-app-token.test.ts` mocks `mintGithubInstallState`'s
// own sibling `consumeGithubInstallState` (the closest structural
// precedent: an atomic single-use-state UPDATE…RETURNING).
vi.mock("../db.js", () => ({
  db: { insert: vi.fn(), update: vi.fn() },
}));

import { db } from "../db.js";
import {
  isConnectorProvider,
  validateConnectorUpdate,
  mintConnectorOauthState,
  consumeConnectorOauthState,
} from "./connectors.js";

const mockDb = vi.mocked(db);

/**
 * Task 7 adds `"railway"` to `connectorProviderEnum` (a free-text column, so
 * this is a TS-union addition only — no migration, same precedent as
 * `"jace"`) and a `railwayProjectId` branch to `validateConnectorUpdate`
 * (the workspace's Railway project id, saved via this route alongside the
 * secret PUT — see `schema/connectors.ts`'s doc-comment on
 * `ConnectorConfig.railwayProjectId`).
 *
 * `isConnectorProvider`/`validateConnectorUpdate` below stay pure-function,
 * no-mock coverage (see `briefs.test.ts`'s own doc-comment: "there is no
 * live-DB harness in this package") — the `db.js` mock above is a no-op for
 * them; only the W3-T1 describe blocks at the bottom of this file exercise it.
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

// Task P6 (Evidence Providers Wave 2): "grafana" added to
// connectorProviderEnum — same free-text-column, TS-union-only precedent as
// "railway"/"langfuse"/"sentry"/"datadog"/"prometheus" above (no migration).
// grafanaUrl's own validateConnectorUpdate coverage already lives in the
// "Evidence Providers Wave 2 (Task P0)" describe block below (P0 added the
// field for all seven remaining Wave-2 providers at once) — not duplicated
// here.
describe("isConnectorProvider — grafana (Task P6)", () => {
  it("recognizes 'grafana' as a known connector provider", () => {
    expect(isConnectorProvider("grafana")).toBe(true);
  });
});

// Task P7 (Evidence Providers Wave 2): "vercel" added to
// connectorProviderEnum — same free-text-column, TS-union-only precedent as
// "railway"/"langfuse"/"sentry"/"datadog"/"prometheus"/"grafana" above (no
// migration). vercelProjectId's/vercelTeamId's own validateConnectorUpdate
// coverage already lives in the "Evidence Providers Wave 2 (Task P0)"
// describe block below (P0 added both fields for all seven remaining
// Wave-2 providers at once) — not duplicated here.
describe("isConnectorProvider — vercel (Task P7)", () => {
  it("recognizes 'vercel' as a known connector provider", () => {
    expect(isConnectorProvider("vercel")).toBe(true);
  });
});

// Task P8 (Evidence Providers Wave 2, FINAL provider): "cloudflare" added to
// connectorProviderEnum — same free-text-column, TS-union-only precedent as
// "railway"/"langfuse"/"sentry"/"datadog"/"prometheus"/"grafana"/"vercel"
// above (no migration). cloudflareZoneId's/cloudflareAccountId's own
// validateConnectorUpdate coverage already lives in the "Evidence Providers
// Wave 2 (Task P0)" describe block below (P0 added both fields for all
// seven remaining Wave-2 providers at once) — not duplicated here.
describe("isConnectorProvider — cloudflare (Task P8)", () => {
  it("recognizes 'cloudflare' as a known connector provider", () => {
    expect(isConnectorProvider("cloudflare")).toBe(true);
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
 * OAuth Connect Wave 3, W3-T3 (`.superpowers/sdd/plan-oauth.md`):
 * `sentryInstallationId` — the Sentry Public Integration installation id,
 * normally written ONLY via `postExchange`'s configPatch
 * (`lib/oauth/sentry.ts`, which calls `upsertConnector` directly, bypassing
 * this validator) but also declared here for defense in depth / consistency
 * — see the schema doc-comment on `ConnectorConfig.sentryInstallationId`.
 * Same "string, trim, non-empty, ≤64 chars" shape as `railwayProjectId`
 * above (an id-shaped field, not a Wave-2-style free-text companion, hence
 * the tighter 64-char bound rather than the Wave-2 default of 256) — this
 * IS the config-key drift coverage the plan asks for: proving the field
 * round-trips through validation, doesn't leak into a normalized value when
 * absent, and composes cleanly alongside its sibling sentryOrg/sentryProject
 * fields with no cross-field interference. The DB-level "survives an
 * unrelated write and stays visible in the client-safe view" half of this
 * proof lives in `oauth-state-consume-race.integration.test.ts` (real
 * Postgres — a mocked `db` here can't meaningfully prove a storage
 * round-trip, same reasoning that file's own doc-comment gives for
 * IMPORTANT-1).
 */
describe("validateConnectorUpdate — sentryInstallationId (OAuth Connect Wave 3, W3-T3)", () => {
  it("accepts and trims a well-formed sentryInstallationId", () => {
    const res = validateConnectorUpdate({
      config: { sentryInstallationId: "  01635075-m30w-4f96-8fc8-ff9680780a13  " },
    });
    expect(res).toEqual({
      ok: true,
      value: { config: { sentryInstallationId: "01635075-m30w-4f96-8fc8-ff9680780a13" } },
    });
  });

  it("rejects a non-string sentryInstallationId", () => {
    const res = validateConnectorUpdate({ config: { sentryInstallationId: 123 as unknown as string } });
    expect(res).toEqual({ ok: false, error: "sentryInstallationId must be a string" });
  });

  it("rejects an empty (or whitespace-only) sentryInstallationId", () => {
    const res = validateConnectorUpdate({ config: { sentryInstallationId: "   " } });
    expect(res).toEqual({ ok: false, error: "sentryInstallationId must not be empty" });
  });

  it("rejects a sentryInstallationId over 64 characters", () => {
    const res = validateConnectorUpdate({ config: { sentryInstallationId: "x".repeat(65) } });
    expect(res).toEqual({
      ok: false,
      error: "sentryInstallationId must be at most 64 characters",
    });
  });

  it("leaves sentryInstallationId out of the normalized value when absent (no accidental default)", () => {
    const res = validateConnectorUpdate({ config: { triggerLabel: "afk" } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.config).not.toHaveProperty("sentryInstallationId");
    }
  });

  it("composes with sentryOrg + sentryProject in the same update — no cross-field interference (config-key drift proof)", () => {
    const res = validateConnectorUpdate({
      config: {
        sentryOrg: "acme",
        sentryProject: "web",
        sentryInstallationId: "01635075-m30w-4f96-8fc8-ff9680780a13",
      },
    });
    expect(res).toEqual({
      ok: true,
      value: {
        config: {
          sentryOrg: "acme",
          sentryProject: "web",
          sentryInstallationId: "01635075-m30w-4f96-8fc8-ff9680780a13",
        },
      },
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

// --------------------------------------------------------------------------- //
// W3-T1 (OAuth Connect Wave 3): server-minted single-use OAuth state.
// `mintGithubInstallState`/`consumeGithubInstallState` (`github-app-token.ts`)
// are github-hardcoded — two dedicated columns on `workspaces`, one in-flight
// state per WORKSPACE (no provider dimension). That doesn't generalize
// without a schema change, and the plan pins NO migration, so this mirrors
// the mechanism instead, into the EXISTING `connectors.config` jsonb column,
// scoped per (workspaceId, provider) — see `connectors.ts`'s own doc-comment
// on both functions for the full design (surgical jsonb merge/delete, never
// routed through `upsertConnector`'s whole-column replace).
//
// W3-T1 FIX ROUND (independent review, `.superpowers/sdd/review-W3T1.md`):
//   - CRITICAL-1: state now ALSO binds the minting user's id
//     (`oauthUserId`) — `mintConnectorOauthState` takes a third `userId`
//     arg; `consumeConnectorOauthState` returns it alongside `workspaceId`
//     so the callback route (the actual enforcement point) can require the
//     redeeming session to match. See the mint/consume tests below and
//     `apps/console/app/api/v1/connectors/oauth/callback/[provider]/route.test.ts`
//     for the full tenant-binding coverage.
//   - IMPORTANT-1: `completeConfig` now PRESERVES all three ephemeral keys
//     across an unrelated write (a pending state used to be silently wiped
//     by, e.g., a teammate's own connector edit landing on the same row) —
//     see the real-Postgres integration test
//     (`src/__tests__/oauth-state-consume-race.integration.test.ts`) for
//     the "config write during pending state → state survives" proof (a
//     mocked unit test can't meaningfully prove a multi-step storage
//     round-trip, so this is integration-tested, matching how this
//     package's OTHER real-Postgres claims are proven —
//     `queue-retry-backoff.integration.test.ts`). The client-facing LEAK
//     protection is unchanged: `toClientSafeConfig` strips all three keys
//     from every `ConnectorRowView`, so preserving them in storage does not
//     reopen the original "never reaches a browser" property.
// --------------------------------------------------------------------------- //

function insertChain() {
  const chain: Record<string, unknown> = {};
  chain.values = vi.fn(() => chain);
  chain.onConflictDoUpdate = vi.fn(() => Promise.resolve(undefined));
  return chain;
}

function updateChain(returned: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ["set", "where"]) chain[m] = vi.fn(() => chain);
  chain.returning = vi.fn(() => Promise.resolve(returned));
  return chain;
}

describe("mintConnectorOauthState (W3-T1)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("issues one INSERT … ON CONFLICT DO UPDATE scoped to (workspaceId, provider), binding the minting userId (CRITICAL-1)", async () => {
    const chain = insertChain();
    mockDb.insert.mockReturnValue(chain as never);

    const state = await mintConnectorOauthState("ws-1", "railway", "user-1");

    expect(typeof state).toBe("string");
    expect(state.length).toBeGreaterThanOrEqual(32); // high-entropy, mirrors mintGithubInstallState's 24 bytes hex
    expect(chain.values).toHaveBeenCalledTimes(1);
    const inserted = (chain.values as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      workspaceId: string;
      provider: string;
      config: { oauthUserId?: string };
    };
    expect(inserted.workspaceId).toBe("ws-1");
    expect(inserted.provider).toBe("railway");
    expect(inserted.config.oauthUserId).toBe("user-1");
    expect(chain.onConflictDoUpdate).toHaveBeenCalledTimes(1);
  });

  it("mints a fresh, distinct state on every call (never reused)", async () => {
    mockDb.insert.mockReturnValue(insertChain() as never);
    const a = await mintConnectorOauthState("ws-1", "railway", "user-1");
    const b = await mintConnectorOauthState("ws-1", "railway", "user-1");
    expect(a).not.toBe(b);
  });

  // W3-T2 fix round (PKCE upgrade) — codeVerifier is an optional 4th arg.
  describe("codeVerifier (W3-T2 fix round, PKCE upgrade)", () => {
    it("includes oauthPkceVerifier in the INSERT-branch config when a codeVerifier is passed", async () => {
      const chain = insertChain();
      mockDb.insert.mockReturnValue(chain as never);
      await mintConnectorOauthState("ws-1", "railway", "user-1", "verifier-abc");
      const inserted = (chain.values as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        config: { oauthPkceVerifier?: string };
      };
      expect(inserted.config.oauthPkceVerifier).toBe("verifier-abc");
    });

    it("omits oauthPkceVerifier from the INSERT-branch config when no codeVerifier is passed (provider without PKCE)", async () => {
      const chain = insertChain();
      mockDb.insert.mockReturnValue(chain as never);
      await mintConnectorOauthState("ws-1", "railway", "user-1");
      const inserted = (chain.values as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        config: { oauthPkceVerifier?: string };
      };
      expect(inserted.config.oauthPkceVerifier).toBeUndefined();
    });

    it("the ON CONFLICT jsonb patch always carries the oauthPkceVerifier key (present or a bound NULL) so a re-mint deterministically overwrites any stale verifier from a prior attempt — proven with AND without a codeVerifier this call", async () => {
      function captureOnConflictConfig(): { chain: Record<string, unknown>; get: () => unknown } {
        const chain: Record<string, unknown> = {};
        chain.values = vi.fn(() => chain);
        let captured: unknown;
        chain.onConflictDoUpdate = vi.fn((arg: { set: { config: unknown } }) => {
          captured = arg.set.config;
          return Promise.resolve(undefined);
        });
        return { chain, get: () => captured };
      }

      const withVerifier = captureOnConflictConfig();
      mockDb.insert.mockReturnValueOnce(withVerifier.chain as never);
      await mintConnectorOauthState("ws-1", "railway", "user-1", "verifier-xyz");
      expect(renderSql(withVerifier.get())).toContain("oauthPkceVerifier");

      const withoutVerifier = captureOnConflictConfig();
      mockDb.insert.mockReturnValueOnce(withoutVerifier.chain as never);
      await mintConnectorOauthState("ws-1", "railway", "user-1");
      // Still present in the rendered SQL TEXT (the jsonb_build_object call
      // always names the key) — the bound VALUE is what differs (NULL vs.
      // "verifier-xyz"), not whether the key is mentioned at all.
      expect(renderSql(withoutVerifier.get())).toContain("oauthPkceVerifier");
    });
  });

  it("binds a DIFFERENT minting user distinctly from another mint (no cross-user bleed in the patch)", async () => {
    const chainA = insertChain();
    mockDb.insert.mockReturnValueOnce(chainA as never);
    await mintConnectorOauthState("ws-1", "railway", "user-A");
    const insertedA = (chainA.values as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      config: { oauthUserId?: string };
    };
    expect(insertedA.config.oauthUserId).toBe("user-A");

    const chainB = insertChain();
    mockDb.insert.mockReturnValueOnce(chainB as never);
    await mintConnectorOauthState("ws-1", "railway", "user-B");
    const insertedB = (chainB.values as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      config: { oauthUserId?: string };
    };
    expect(insertedB.config.oauthUserId).toBe("user-B");
  });
});

describe("consumeConnectorOauthState (W3-T1)", () => {
  it("resolves {workspaceId, userId, codeVerifier:null} on a live, matching, unexpired state with no PKCE verifier stored (atomic UPDATE … RETURNING)", async () => {
    mockDb.update.mockReturnValue(
      updateChain([
        {
          workspaceId: "ws-1",
          config: { repos: [], triggerLabel: "x", pollIntervalSeconds: 60, oauthUserId: "user-1" },
        },
      ]) as never
    );
    expect(await consumeConnectorOauthState("railway", "deadbeef")).toEqual({
      workspaceId: "ws-1",
      userId: "user-1",
      codeVerifier: null,
    });
  });

  // W3-T2 fix round (PKCE upgrade).
  it("resolves codeVerifier from the stored oauthPkceVerifier when the mint carried one", async () => {
    mockDb.update.mockReturnValue(
      updateChain([
        {
          workspaceId: "ws-1",
          config: {
            repos: [],
            triggerLabel: "x",
            pollIntervalSeconds: 60,
            oauthUserId: "user-1",
            oauthPkceVerifier: "verifier-abc",
          },
        },
      ]) as never
    );
    expect(await consumeConnectorOauthState("railway", "deadbeef")).toEqual({
      workspaceId: "ws-1",
      userId: "user-1",
      codeVerifier: "verifier-abc",
    });
  });

  it("resolves codeVerifier:null (never throws) when oauthPkceVerifier is present but not a string (defensive)", async () => {
    mockDb.update.mockReturnValue(
      updateChain([
        {
          workspaceId: "ws-1",
          config: {
            repos: [],
            triggerLabel: "x",
            pollIntervalSeconds: 60,
            oauthUserId: "user-1",
            oauthPkceVerifier: 12345,
          },
        },
      ]) as never
    );
    expect(await consumeConnectorOauthState("railway", "deadbeef")).toEqual({
      workspaceId: "ws-1",
      userId: "user-1",
      codeVerifier: null,
    });
  });

  it("returns null for an unknown / expired / already-consumed state — never throws", async () => {
    mockDb.update.mockReturnValue(updateChain([]) as never);
    expect(await consumeConnectorOauthState("railway", "deadbeef")).toBeNull();
  });

  it("fails CLOSED — returns null — when the matched row has no bound oauthUserId (defensive; should not occur post-fix)", async () => {
    mockDb.update.mockReturnValue(
      updateChain([
        { workspaceId: "ws-1", config: { repos: [], triggerLabel: "x", pollIntervalSeconds: 60 } },
      ]) as never
    );
    expect(await consumeConnectorOauthState("railway", "deadbeef")).toBeNull();
  });

  it("clears oauthState/oauthStateExpiresAt but NOT oauthUserId or oauthPkceVerifier in the same SET (so RETURNING can still read both)", async () => {
    const chain = updateChain([
      { workspaceId: "ws-1", config: { oauthUserId: "user-1", oauthPkceVerifier: "verifier-abc" } },
    ]);
    mockDb.update.mockReturnValue(chain as never);
    await consumeConnectorOauthState("railway", "deadbeef");
    const setArg = (chain.set as ReturnType<typeof vi.fn>).mock.calls[0][0] as { config: unknown };
    const rendered = renderSql(setArg.config);
    expect(rendered).toContain("oauthState");
    expect(rendered).toContain("oauthStateExpiresAt");
    expect(rendered).not.toContain("oauthUserId");
    expect(rendered).not.toContain("oauthPkceVerifier");
  });
});
