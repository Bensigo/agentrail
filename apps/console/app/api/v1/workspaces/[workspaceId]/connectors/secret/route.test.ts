import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({ auth: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  setConnectorSecret: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, setConnectorSecret } from "@agentrail/db-postgres";
import { PUT } from "./route";

const WS = "00000000-0000-0000-0000-000000000001";
const USER = "user-1";

function params() {
  return Promise.resolve({ workspaceId: WS });
}

function putReq(body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WS}/connectors/secret`,
    { method: "PUT", body: JSON.stringify(body) }
  );
}

beforeEach(() => {
  vi.mocked(auth).mockReset();
  vi.mocked(getWorkspaceMembership).mockReset();
  vi.mocked(setConnectorSecret).mockReset();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ role: "owner" } as never);
});

/**
 * Allowlist behavior (Gateway → Channels cutover): this route manages the
 * MCP tools' credentials only (linear/figma/context7). Discord, Slack and
 * Telegram used to be here too (a bot token / webhook secret); post-cutover
 * they are Jace-native chat channels with nothing to paste — connecting is
 * DMing the shared bot, recorded as a `chat_identities` row elsewhere. A PUT
 * for any of the three (or any other non-allowlisted provider) must fail with
 * the route's existing invalid-provider error shape, and never touch storage.
 */
describe("PUT /connectors/secret — allowlist (Channels cutover)", () => {
  it("rejects telegram — no longer credential-based; connects via a linked chat identity instead", async () => {
    const res = await PUT(
      putReq({ provider: "telegram", secret: "123456789:AAH" + "a".repeat(32) }),
      { params: params() }
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/^provider must be one of /);
    expect(body.error).not.toContain("telegram");
    expect(setConnectorSecret).not.toHaveBeenCalled();
  });

  it("rejects slack — no longer credential-based", async () => {
    const res = await PUT(
      putReq({
        provider: "slack",
        secret: "https://hooks.slack.com/services/T0/B0/abcDEF",
      }),
      { params: params() }
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/^provider must be one of /);
    expect(setConnectorSecret).not.toHaveBeenCalled();
  });

  it("rejects discord too — it never had a credential here, and its dedicated webhook route is gone", async () => {
    const res = await PUT(putReq({ provider: "discord", secret: "x" }), {
      params: params(),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/^provider must be one of /);
    expect(setConnectorSecret).not.toHaveBeenCalled();
  });

  // Task 7 (debugging design spec) — THE BEHAVIOR-DRIVING CHANGE:
  // CREDENTIAL_PROVIDERS is now DERIVED from CONNECTOR_CATALOG's
  // `connectMethod: "secret"` entries, not a hand-enumerated literal.
  it("still rejects github — it is connectMethod: 'oauth' in the catalog, never a credential-based entry", async () => {
    const res = await PUT(putReq({ provider: "github", secret: "ghp_x" }), {
      params: params(),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/^provider must be one of /);
    expect(body.error).not.toContain("github");
    expect(setConnectorSecret).not.toHaveBeenCalled();
  });

  it("accepts railway at the allowlist gate — a non-UUID token still fails, but at the FORMAT gate (proves it passed the allowlist, not that it was rejected by it)", async () => {
    const res = await PUT(putReq({ provider: "railway", secret: "not-a-uuid" }), {
      params: params(),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    // NOT the allowlist-rejection message — the UUID-format message instead.
    expect(body.error).not.toMatch(/^provider must be one of /);
    expect(body.error).toBe("Railway tokens are UUIDs.");
    expect(setConnectorSecret).not.toHaveBeenCalled();
  });

  it("the derived allowlist includes every real credential-based catalog kind so the error message stays accurate (linear, figma, context7, railway, langfuse, sentry, datadog, prometheus, grafana, vercel, cloudflare) and excludes factory", async () => {
    const res = await PUT(putReq({ provider: "not-a-real-kind", secret: "x" }), {
      params: params(),
    });
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("linear");
    expect(body.error).toContain("figma");
    expect(body.error).toContain("context7");
    expect(body.error).toContain("railway");
    // Task P2.
    expect(body.error).toContain("langfuse");
    // Task P3.
    expect(body.error).toContain("sentry");
    // Task P4.
    expect(body.error).toContain("datadog");
    // Task P5.
    expect(body.error).toContain("prometheus");
    // Task P6.
    expect(body.error).toContain("grafana");
    // Task P7.
    expect(body.error).toContain("vercel");
    // Task P8 (final Wave-2 provider).
    expect(body.error).toContain("cloudflare");
    // Fix Round 1, FIX 4 — see below for the dedicated test.
    expect(body.error).not.toContain("factory");
  });

  // Fix Round 1, FIX 4 (structural guard — see route.ts's own doc-comment):
  // the allowlist derivation now ALSO filters `availability !== "internal"`,
  // so `factory` (Task 5, availability: "internal") is excluded from
  // CREDENTIAL_PROVIDERS itself — the allowlist rejects it BEFORE
  // `validateConnectorCredential` (the format gate) is ever reached, proven
  // by asserting the response is the ALLOWLIST's own rejection message, not
  // the format gate's "This connector is not credential-based." text. This
  // holds regardless of what any credential validator would say about
  // "factory" — even if one were ever added, this gate would still reject
  // it first. Never a behavior regression either way: factory never reaches
  // the connect form at all (filtered out of the grid by
  // projectConnectors).
  it("factory (availability: 'internal') is excluded from the allowlist itself — structural, not just the format gate's fallback", async () => {
    const res = await PUT(putReq({ provider: "factory", secret: "anything" }), {
      params: params(),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    // The ALLOWLIST'S rejection message, not the format gate's.
    expect(body.error).toMatch(/^provider must be one of /);
    expect(body.error).not.toBe("This connector is not credential-based.");
    expect(setConnectorSecret).not.toHaveBeenCalled();
  });
});

/**
 * Full railway connect flow — both gates run for real here (this route
 * doesn't mock `./verify`), so the live-verify HTTP call is exercised via a
 * `global.fetch` swap, the same idiom `verify.test.ts` uses.
 */
describe("PUT /connectors/secret — railway, full flow (Task 7)", () => {
  const originalFetch = global.fetch;
  const RAILWAY_TOKEN = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("PUT railway accepted end to end: valid UUID + a live verify that succeeds → 200 connected:true, setConnectorSecret called with the trimmed token", async () => {
    global.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { me: { name: "Ada", email: "ada@example.com" } } }),
    })) as unknown as typeof fetch;
    vi.mocked(setConnectorSecret).mockResolvedValue({
      provider: "railway",
      enabled: true,
      config: { repos: [], triggerLabel: "ready-for-agent", pollIntervalSeconds: 60 },
      hasSecret: true,
      updatedAt: "2026-07-29T00:00:00.000Z",
    } as never);

    const res = await PUT(putReq({ provider: "railway", secret: `  ${RAILWAY_TOKEN}  ` }), {
      params: params(),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: true });
    expect(setConnectorSecret).toHaveBeenCalledWith(WS, "railway", RAILWAY_TOKEN);
  });

  it("PUT railway with a well-formed UUID but a live verify that Railway rejects (401) → 400, setConnectorSecret never called", async () => {
    global.fetch = (async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    })) as unknown as typeof fetch;

    const res = await PUT(putReq({ provider: "railway", secret: RAILWAY_TOKEN }), {
      params: params(),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Railway rejected this token." });
    expect(setConnectorSecret).not.toHaveBeenCalled();
  });

  it("PUT railway with secret:null disconnects without ever calling verify/fetch", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.mocked(setConnectorSecret).mockResolvedValue({
      provider: "railway",
      enabled: false,
      config: { repos: [], triggerLabel: "ready-for-agent", pollIntervalSeconds: 60 },
      hasSecret: false,
      updatedAt: "2026-07-29T00:00:00.000Z",
    } as never);

    const res = await PUT(putReq({ provider: "railway", secret: null }), {
      params: params(),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setConnectorSecret).toHaveBeenCalledWith(WS, "railway", null);
  });
});

/**
 * Full langfuse connect flow (Task P2) — both gates run for real (this
 * route doesn't mock `./verify`), so the live-verify HTTP call is exercised
 * via a `global.fetch` swap, same idiom as the railway block above. ALSO
 * proves the extra-config pass-through mechanism this task added (see
 * `verify.ts`'s own doc-comment, "LANGFUSE HOST — THE ORDERING GAP"): a
 * catalog-declared extraConfigFields value (`langfuseHost`) riding
 * alongside `secret` in the SAME PUT body reaches `verifyConnectorCredential`
 * generically, with no langfuse-specific code in this route.
 */
describe("PUT /connectors/secret — langfuse, full flow + extra-config pass-through (Task P2)", () => {
  const originalFetch = global.fetch;
  const PUBLIC_KEY = "pk-lf-abc123";
  const SECRET_KEY = "sk-lf-def456";
  const LANGFUSE_SECRET = `${PUBLIC_KEY}:${SECRET_KEY}`;
  const HOST = "https://cloud.langfuse.com";

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("PUT langfuse accepted end to end: composite secret + langfuseHost in the SAME body + a live verify that succeeds → 200 connected:true, setConnectorSecret called with the trimmed composite secret (host NOT part of it)", async () => {
    let capturedUrl = "";
    global.fetch = (async (url: string) => {
      capturedUrl = String(url);
      return { ok: true, status: 200, json: async () => ({ data: [{ id: "proj-1" }] }) };
    }) as unknown as typeof fetch;
    vi.mocked(setConnectorSecret).mockResolvedValue({
      provider: "langfuse",
      enabled: true,
      config: { repos: [], triggerLabel: "ready-for-agent", pollIntervalSeconds: 60, langfuseHost: HOST },
      hasSecret: true,
      updatedAt: "2026-07-29T00:00:00.000Z",
    } as never);

    const res = await PUT(
      putReq({ provider: "langfuse", secret: `  ${LANGFUSE_SECRET}  `, langfuseHost: HOST }),
      { params: params() }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: true });
    expect(capturedUrl).toBe(`${HOST}/api/public/projects`);
    // The route itself never persists langfuseHost — only the trimmed secret.
    expect(setConnectorSecret).toHaveBeenCalledWith(WS, "langfuse", LANGFUSE_SECRET);
  });

  it("PUT langfuse with NO langfuseHost in the body → 400 with verify's own host-missing error, setConnectorSecret never called (proves the pass-through, not a hardcoded route branch)", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await PUT(putReq({ provider: "langfuse", secret: LANGFUSE_SECRET }), {
      params: params(),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Set the Langfuse host before connecting." });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setConnectorSecret).not.toHaveBeenCalled();
  });

  it("PUT langfuse with a well-formed composite secret but a live verify Langfuse rejects (401) → 400, setConnectorSecret never called", async () => {
    global.fetch = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch;

    const res = await PUT(
      putReq({ provider: "langfuse", secret: LANGFUSE_SECRET, langfuseHost: HOST }),
      { params: params() }
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Langfuse rejected these API keys." });
    expect(setConnectorSecret).not.toHaveBeenCalled();
  });

  it("PUT langfuse with a malformed composite secret (wrong prefix) fails at the FORMAT gate — never calls fetch, never reads langfuseHost", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await PUT(
      putReq({ provider: "langfuse", secret: "wrong:wrong", langfuseHost: HOST }),
      { params: params() }
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Public key has an unexpected format." });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setConnectorSecret).not.toHaveBeenCalled();
  });

  it("PUT langfuse with secret:null disconnects without ever calling verify/fetch, and without needing langfuseHost in the body", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.mocked(setConnectorSecret).mockResolvedValue({
      provider: "langfuse",
      enabled: false,
      config: { repos: [], triggerLabel: "ready-for-agent", pollIntervalSeconds: 60 },
      hasSecret: false,
      updatedAt: "2026-07-29T00:00:00.000Z",
    } as never);

    const res = await PUT(putReq({ provider: "langfuse", secret: null }), {
      params: params(),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setConnectorSecret).toHaveBeenCalledWith(WS, "langfuse", null);
  });
});

/**
 * Full sentry connect flow (Task P3) — both gates run for real (this route
 * doesn't mock `./verify`), so the live-verify HTTP call is exercised via a
 * `global.fetch` swap, same idiom as the railway/langfuse blocks above.
 * ALSO proves the extra-config pass-through mechanism generalizes to TWO
 * simultaneous keys (`sentryOrg` + `sentryProject`) riding alongside
 * `secret` in the SAME PUT body, with no sentry-specific code in this
 * route.
 */
describe("PUT /connectors/secret — sentry, full flow + two-key extra-config pass-through (Task P3)", () => {
  const originalFetch = global.fetch;
  const TOKEN = "sntrys_abc123";
  const ORG = "acme";
  const PROJECT = "web";

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("PUT sentry accepted end to end: token + sentryOrg + sentryProject in the SAME body + a live verify that succeeds → 200 connected:true, setConnectorSecret called with the trimmed token (org/project NOT part of it)", async () => {
    let capturedUrl = "";
    global.fetch = (async (url: string) => {
      capturedUrl = String(url);
      return { ok: true, status: 200, json: async () => ({ id: "123", slug: PROJECT }) };
    }) as unknown as typeof fetch;
    vi.mocked(setConnectorSecret).mockResolvedValue({
      provider: "sentry",
      enabled: true,
      config: {
        repos: [],
        triggerLabel: "ready-for-agent",
        pollIntervalSeconds: 60,
        sentryOrg: ORG,
        sentryProject: PROJECT,
      },
      hasSecret: true,
      updatedAt: "2026-07-29T00:00:00.000Z",
    } as never);

    const res = await PUT(
      putReq({ provider: "sentry", secret: `  ${TOKEN}  `, sentryOrg: ORG, sentryProject: PROJECT }),
      { params: params() }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: true });
    expect(capturedUrl).toBe(`https://sentry.io/api/0/projects/${ORG}/${PROJECT}/`);
    // The route itself never persists sentryOrg/sentryProject — only the
    // trimmed secret.
    expect(setConnectorSecret).toHaveBeenCalledWith(WS, "sentry", TOKEN);
  });

  it("PUT sentry with NO sentryOrg/sentryProject in the body → 400 with verify's own org-missing error, setConnectorSecret never called (proves the pass-through, not a hardcoded route branch)", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await PUT(putReq({ provider: "sentry", secret: TOKEN }), {
      params: params(),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Set the Sentry organization before connecting." });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setConnectorSecret).not.toHaveBeenCalled();
  });

  it("PUT sentry with sentryOrg but NO sentryProject → 400 with verify's own project-missing error", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await PUT(putReq({ provider: "sentry", secret: TOKEN, sentryOrg: ORG }), {
      params: params(),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Set the Sentry project before connecting." });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setConnectorSecret).not.toHaveBeenCalled();
  });

  it("PUT sentry with a well-formed token but a live verify Sentry rejects (401) → 400, setConnectorSecret never called", async () => {
    global.fetch = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch;

    const res = await PUT(
      putReq({ provider: "sentry", secret: TOKEN, sentryOrg: ORG, sentryProject: PROJECT }),
      { params: params() }
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Sentry rejected this token." });
    expect(setConnectorSecret).not.toHaveBeenCalled();
  });

  it("PUT sentry with a malformed token (wrong prefix) fails at the FORMAT gate — never calls fetch, never reads sentryOrg/sentryProject", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await PUT(
      putReq({ provider: "sentry", secret: "wrong-prefix", sentryOrg: ORG, sentryProject: PROJECT }),
      { params: params() }
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Sentry tokens start with sntrys_ (organization) or sntryu_ (user).",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setConnectorSecret).not.toHaveBeenCalled();
  });

  it("PUT sentry with secret:null disconnects without ever calling verify/fetch, and without needing sentryOrg/sentryProject in the body", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.mocked(setConnectorSecret).mockResolvedValue({
      provider: "sentry",
      enabled: false,
      config: { repos: [], triggerLabel: "ready-for-agent", pollIntervalSeconds: 60 },
      hasSecret: false,
      updatedAt: "2026-07-29T00:00:00.000Z",
    } as never);

    const res = await PUT(putReq({ provider: "sentry", secret: null }), {
      params: params(),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setConnectorSecret).toHaveBeenCalledWith(WS, "sentry", null);
  });
});

/**
 * Full datadog connect flow (Task P4) — both gates run for real (this route
 * doesn't mock `./verify`), so the live-verify HTTP call is exercised via a
 * `global.fetch` swap, same idiom as the railway/langfuse/sentry blocks
 * above. ALSO proves the extra-config pass-through mechanism generalizes to
 * a THIRD provider (`datadogSite`) riding alongside `secret` in the SAME
 * PUT body, with no datadog-specific code in this route.
 */
describe("PUT /connectors/secret — datadog, full flow + extra-config pass-through (Task P4)", () => {
  const originalFetch = global.fetch;
  const API_KEY = "a".repeat(32);
  const APP_KEY = "b".repeat(40);
  const DATADOG_SECRET = `${API_KEY}:${APP_KEY}`;
  const SITE = "datadoghq.com";

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("PUT datadog accepted end to end: composite secret + datadogSite in the SAME body + a live verify that succeeds → 200 connected:true, setConnectorSecret called with the trimmed composite secret (site NOT part of it)", async () => {
    let capturedUrl = "";
    global.fetch = (async (url: string) => {
      capturedUrl = String(url);
      return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
    }) as unknown as typeof fetch;
    vi.mocked(setConnectorSecret).mockResolvedValue({
      provider: "datadog",
      enabled: true,
      config: { repos: [], triggerLabel: "ready-for-agent", pollIntervalSeconds: 60, datadogSite: SITE },
      hasSecret: true,
      updatedAt: "2026-07-29T00:00:00.000Z",
    } as never);

    const res = await PUT(
      putReq({ provider: "datadog", secret: `  ${DATADOG_SECRET}  `, datadogSite: SITE }),
      { params: params() }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: true });
    expect(capturedUrl).toBe(`https://api.${SITE}/api/v2/validate_keys`);
    // The route itself never persists datadogSite — only the trimmed secret.
    expect(setConnectorSecret).toHaveBeenCalledWith(WS, "datadog", DATADOG_SECRET);
  });

  it("PUT datadog with NO datadogSite in the body → 400 with verify's own site-missing error, setConnectorSecret never called (proves the pass-through, not a hardcoded route branch)", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await PUT(putReq({ provider: "datadog", secret: DATADOG_SECRET }), {
      params: params(),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Set a valid Datadog site before connecting." });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setConnectorSecret).not.toHaveBeenCalled();
  });

  it("PUT datadog with a well-formed composite secret but a live verify Datadog rejects (401) → 400, setConnectorSecret never called", async () => {
    global.fetch = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch;

    const res = await PUT(
      putReq({ provider: "datadog", secret: DATADOG_SECRET, datadogSite: SITE }),
      { params: params() }
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Datadog rejected these API keys." });
    expect(setConnectorSecret).not.toHaveBeenCalled();
  });

  it("PUT datadog with a malformed composite secret (wrong shape) fails at the FORMAT gate — never calls fetch, never reads datadogSite", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await PUT(
      putReq({ provider: "datadog", secret: "wrong:wrong", datadogSite: SITE }),
      { params: params() }
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "API key has an unexpected format." });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setConnectorSecret).not.toHaveBeenCalled();
  });

  it("PUT datadog with secret:null disconnects without ever calling verify/fetch, and without needing datadogSite in the body", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.mocked(setConnectorSecret).mockResolvedValue({
      provider: "datadog",
      enabled: false,
      config: { repos: [], triggerLabel: "ready-for-agent", pollIntervalSeconds: 60 },
      hasSecret: false,
      updatedAt: "2026-07-29T00:00:00.000Z",
    } as never);

    const res = await PUT(putReq({ provider: "datadog", secret: null }), {
      params: params(),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setConnectorSecret).toHaveBeenCalledWith(WS, "datadog", null);
  });
});

/**
 * Full prometheus connect flow (Task P5) — both gates run for real (this
 * route doesn't mock `./verify`), so the live-verify HTTP call is exercised
 * via a `global.fetch` swap, same idiom as the railway/langfuse/sentry/
 * datadog blocks above. ALSO proves the extra-config pass-through mechanism
 * generalizes to a FOURTH provider (`prometheusUrl`) riding alongside
 * `secret` in the SAME PUT body, with no prometheus-specific code in this
 * route. UNLIKE datadog/langfuse above, `secret` is a SINGLE field (no
 * composite split) — the "malformed secret" case here is the format gate's
 * own whitespace/length check, not a wrong part count.
 */
describe("PUT /connectors/secret — prometheus, full flow + extra-config pass-through (Task P5)", () => {
  const originalFetch = global.fetch;
  const PROM_SECRET = "sometoken1234567890";
  const PROM_URL = "https://prometheus.internal:9090";

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("PUT prometheus accepted end to end: secret + prometheusUrl in the SAME body + a live verify that succeeds (buildinfo leg) → 200 connected:true, setConnectorSecret called with the trimmed secret (url NOT part of it)", async () => {
    let capturedUrl = "";
    global.fetch = (async (url: string) => {
      capturedUrl = String(url);
      return { ok: true, status: 200, json: async () => ({ status: "success", data: {} }) };
    }) as unknown as typeof fetch;
    vi.mocked(setConnectorSecret).mockResolvedValue({
      provider: "prometheus",
      enabled: true,
      config: { repos: [], triggerLabel: "ready-for-agent", pollIntervalSeconds: 60, prometheusUrl: PROM_URL },
      hasSecret: true,
      updatedAt: "2026-07-30T00:00:00.000Z",
    } as never);

    const res = await PUT(
      putReq({ provider: "prometheus", secret: `  ${PROM_SECRET}  `, prometheusUrl: PROM_URL }),
      { params: params() }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: true });
    expect(capturedUrl).toBe(`${PROM_URL}/api/v1/status/buildinfo`);
    // The route itself never persists prometheusUrl — only the trimmed secret.
    expect(setConnectorSecret).toHaveBeenCalledWith(WS, "prometheus", PROM_SECRET);
  });

  it("PUT prometheus with NO prometheusUrl in the body → 400 with verify's own URL-missing error, setConnectorSecret never called (proves the pass-through, not a hardcoded route branch)", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await PUT(putReq({ provider: "prometheus", secret: PROM_SECRET }), {
      params: params(),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Set the Prometheus base URL before connecting." });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setConnectorSecret).not.toHaveBeenCalled();
  });

  it("PUT prometheus with a well-formed secret but a live verify Prometheus rejects (401) → 400, setConnectorSecret never called", async () => {
    global.fetch = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch;

    const res = await PUT(
      putReq({ provider: "prometheus", secret: PROM_SECRET, prometheusUrl: PROM_URL }),
      { params: params() }
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Prometheus rejected this credential." });
    expect(setConnectorSecret).not.toHaveBeenCalled();
  });

  it("PUT prometheus with a credential containing whitespace fails at the FORMAT gate — never calls fetch, never reads prometheusUrl", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await PUT(
      putReq({ provider: "prometheus", secret: "has a space", prometheusUrl: PROM_URL }),
      { params: params() }
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Prometheus credentials must not contain whitespace." });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setConnectorSecret).not.toHaveBeenCalled();
  });

  it("PUT prometheus accepts a user:pass credential too — same single field, Basic auth sent instead of Bearer", async () => {
    let capturedInit: RequestInit | undefined;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return { ok: true, status: 200, json: async () => ({ status: "success", data: {} }) };
    }) as unknown as typeof fetch;
    vi.mocked(setConnectorSecret).mockResolvedValue({
      provider: "prometheus",
      enabled: true,
      config: { repos: [], triggerLabel: "ready-for-agent", pollIntervalSeconds: 60, prometheusUrl: PROM_URL },
      hasSecret: true,
      updatedAt: "2026-07-30T00:00:00.000Z",
    } as never);

    const res = await PUT(
      putReq({ provider: "prometheus", secret: "myuser:mypass", prometheusUrl: PROM_URL }),
      { params: params() }
    );

    expect(res.status).toBe(200);
    expect((capturedInit?.headers as Record<string, string>)?.Authorization).toBe(
      `Basic ${Buffer.from("myuser:mypass").toString("base64")}`
    );
    expect(setConnectorSecret).toHaveBeenCalledWith(WS, "prometheus", "myuser:mypass");
  });

  it("PUT prometheus with secret:null disconnects without ever calling verify/fetch, and without needing prometheusUrl in the body", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.mocked(setConnectorSecret).mockResolvedValue({
      provider: "prometheus",
      enabled: false,
      config: { repos: [], triggerLabel: "ready-for-agent", pollIntervalSeconds: 60 },
      hasSecret: false,
      updatedAt: "2026-07-30T00:00:00.000Z",
    } as never);

    const res = await PUT(putReq({ provider: "prometheus", secret: null }), {
      params: params(),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setConnectorSecret).toHaveBeenCalledWith(WS, "prometheus", null);
  });
});

/**
 * Full grafana connect flow (Task P6) — both gates run for real (this route
 * doesn't mock `./verify`), so the live-verify HTTP call is exercised via a
 * `global.fetch` swap, same idiom as the railway/langfuse/sentry/datadog/
 * prometheus blocks above. ALSO proves the extra-config pass-through
 * mechanism generalizes to a SIXTH provider (`grafanaUrl`) riding alongside
 * `secret` in the SAME PUT body, with no grafana-specific code in this
 * route. Like prometheus above (unlike datadog/langfuse), `secret` is a
 * SINGLE field (no composite split) — the "malformed secret" case here is
 * the format gate's own prefix check, not a wrong part count.
 */
describe("PUT /connectors/secret — grafana, full flow + extra-config pass-through (Task P6)", () => {
  const originalFetch = global.fetch;
  // FIXTURE, deliberately non-realistic: built from an obviously-fake body
  // ("TESTFIXTURE"/repeated digits, or — for the eyJ… legacy-key shape
  // below — the base64 of a nonsense JSON object) specifically so GitHub
  // push protection's secret scanner never flags it. Do NOT "fix" these to
  // look more like a real token/key — that is what gets them flagged.
  const GRAFANA_SECRET = "glsa_TESTFIXTURE0000000000000000000000AB";
  const GRAFANA_URL = "https://grafana.internal:3000";

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("PUT grafana accepted end to end: secret + grafanaUrl in the SAME body + a live verify that succeeds (/api/org) → 200 connected:true, setConnectorSecret called with the trimmed secret (url NOT part of it)", async () => {
    let capturedUrl = "";
    global.fetch = (async (url: string) => {
      capturedUrl = String(url);
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch;
    vi.mocked(setConnectorSecret).mockResolvedValue({
      provider: "grafana",
      enabled: true,
      config: { repos: [], triggerLabel: "ready-for-agent", pollIntervalSeconds: 60, grafanaUrl: GRAFANA_URL },
      hasSecret: true,
      updatedAt: "2026-07-30T00:00:00.000Z",
    } as never);

    const res = await PUT(
      putReq({ provider: "grafana", secret: `  ${GRAFANA_SECRET}  `, grafanaUrl: GRAFANA_URL }),
      { params: params() }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: true });
    expect(capturedUrl).toBe(`${GRAFANA_URL}/api/org`);
    // The route itself never persists grafanaUrl — only the trimmed secret.
    expect(setConnectorSecret).toHaveBeenCalledWith(WS, "grafana", GRAFANA_SECRET);
  });

  it("PUT grafana with NO grafanaUrl in the body → 400 with verify's own URL-missing error, setConnectorSecret never called (proves the pass-through, not a hardcoded route branch)", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await PUT(putReq({ provider: "grafana", secret: GRAFANA_SECRET }), {
      params: params(),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Set the Grafana base URL before connecting." });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setConnectorSecret).not.toHaveBeenCalled();
  });

  it("PUT grafana with a well-formed secret but a live verify Grafana rejects (401) → 400, setConnectorSecret never called", async () => {
    global.fetch = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch;

    const res = await PUT(
      putReq({ provider: "grafana", secret: GRAFANA_SECRET, grafanaUrl: GRAFANA_URL }),
      { params: params() }
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Grafana rejected this token." });
    expect(setConnectorSecret).not.toHaveBeenCalled();
  });

  it("PUT grafana with a credential matching neither documented prefix fails at the FORMAT gate — never calls fetch, never reads grafanaUrl", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await PUT(
      putReq({ provider: "grafana", secret: "not-a-real-token", grafanaUrl: GRAFANA_URL }),
      { params: params() }
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Grafana tokens start with glsa_ (service account) or eyJ (legacy API key).",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setConnectorSecret).not.toHaveBeenCalled();
  });

  it("PUT grafana accepts a legacy eyJ-prefixed API key too — same single field, same Bearer scheme", async () => {
    let capturedInit: RequestInit | undefined;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch;
    // base64 of {"TEST":"fixture-not-a-key"} — NOT the {"k":...,"n":...,
    // "id":...} shape a real legacy Grafana API key decodes to.
    const legacyKey = "eyJURVNUIjoiZml4dHVyZS1ub3QtYS1rZXkifQ==";
    vi.mocked(setConnectorSecret).mockResolvedValue({
      provider: "grafana",
      enabled: true,
      config: { repos: [], triggerLabel: "ready-for-agent", pollIntervalSeconds: 60, grafanaUrl: GRAFANA_URL },
      hasSecret: true,
      updatedAt: "2026-07-30T00:00:00.000Z",
    } as never);

    const res = await PUT(
      putReq({ provider: "grafana", secret: legacyKey, grafanaUrl: GRAFANA_URL }),
      { params: params() }
    );

    expect(res.status).toBe(200);
    expect((capturedInit?.headers as Record<string, string>)?.Authorization).toBe(`Bearer ${legacyKey}`);
    expect(setConnectorSecret).toHaveBeenCalledWith(WS, "grafana", legacyKey);
  });

  it("PUT grafana with secret:null disconnects without ever calling verify/fetch, and without needing grafanaUrl in the body", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.mocked(setConnectorSecret).mockResolvedValue({
      provider: "grafana",
      enabled: false,
      config: { repos: [], triggerLabel: "ready-for-agent", pollIntervalSeconds: 60 },
      hasSecret: false,
      updatedAt: "2026-07-30T00:00:00.000Z",
    } as never);

    const res = await PUT(putReq({ provider: "grafana", secret: null }), {
      params: params(),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setConnectorSecret).toHaveBeenCalledWith(WS, "grafana", null);
  });
});

/**
 * Full vercel connect flow (Task P7) — both gates run for real (this route
 * doesn't mock `./verify`), same idiom as the grafana block above. ALSO
 * proves the extra-config pass-through mechanism generalizes to a
 * SEVENTH provider carrying TWO extra fields (`vercelProjectId` REQUIRED,
 * `vercelTeamId` OPTIONAL) in the SAME PUT body, with no vercel-specific
 * code in this route. `secret` is a SINGLE field (no composite split),
 * same shape as grafana/prometheus above.
 */
describe("PUT /connectors/secret — vercel, full flow + extra-config pass-through (Task P7)", () => {
  const originalFetch = global.fetch;
  // FIXTURE, deliberately non-realistic (Fix Round 1 — shape asserted
  // explicitly, per review): starts with `TESTFIXTURE_`, NOT `vcp_` — the
  // current, GitHub-secret-scanning-detected personal-access-token prefix
  // (see lib/evidence/vercel.ts's own doc-comment, "AUTH"); cannot match
  // that detector's prefix check by construction.
  const VERCEL_SECRET = "TESTFIXTURE_vercel_token_0000000000000000";
  const PROJECT_ID = "prj_abc123";
  const TEAM_ID = "team_abc123";

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("PUT vercel accepted end to end: secret + vercelProjectId + vercelTeamId in the SAME body + a live verify that succeeds (/v2/user then /v9/projects/{id}) → 200 connected:true, setConnectorSecret called with the trimmed secret (ids NOT part of it)", async () => {
    const calledUrls: string[] = [];
    global.fetch = (async (url: string) => {
      calledUrls.push(String(url));
      if (String(url).includes("/v9/projects/")) {
        return { ok: true, status: 200, json: async () => ({ id: PROJECT_ID }) };
      }
      return { ok: true, status: 200, json: async () => ({ user: { id: "u1" } }) };
    }) as unknown as typeof fetch;
    vi.mocked(setConnectorSecret).mockResolvedValue({
      provider: "vercel",
      enabled: true,
      config: {
        repos: [],
        triggerLabel: "ready-for-agent",
        pollIntervalSeconds: 60,
        vercelProjectId: PROJECT_ID,
        vercelTeamId: TEAM_ID,
      },
      hasSecret: true,
      updatedAt: "2026-07-30T00:00:00.000Z",
    } as never);

    const res = await PUT(
      putReq({
        provider: "vercel",
        secret: `  ${VERCEL_SECRET}  `,
        vercelProjectId: PROJECT_ID,
        vercelTeamId: TEAM_ID,
      }),
      { params: params() }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: true });
    expect(calledUrls).toEqual([
      "https://api.vercel.com/v2/user",
      `https://api.vercel.com/v9/projects/${PROJECT_ID}?teamId=${TEAM_ID}`,
    ]);
    // The route itself never persists vercelProjectId/vercelTeamId — only
    // the trimmed secret.
    expect(setConnectorSecret).toHaveBeenCalledWith(WS, "vercel", VERCEL_SECRET);
  });

  it("PUT vercel with NO vercelTeamId in the body still succeeds — teamId is OPTIONAL (personal scope), unlike vercelProjectId", async () => {
    const calledUrls: string[] = [];
    global.fetch = (async (url: string) => {
      calledUrls.push(String(url));
      if (String(url).includes("/v9/projects/")) {
        return { ok: true, status: 200, json: async () => ({ id: PROJECT_ID }) };
      }
      return { ok: true, status: 200, json: async () => ({ user: { id: "u1" } }) };
    }) as unknown as typeof fetch;
    vi.mocked(setConnectorSecret).mockResolvedValue({
      provider: "vercel",
      enabled: true,
      config: { repos: [], triggerLabel: "ready-for-agent", pollIntervalSeconds: 60, vercelProjectId: PROJECT_ID },
      hasSecret: true,
      updatedAt: "2026-07-30T00:00:00.000Z",
    } as never);

    const res = await PUT(
      putReq({ provider: "vercel", secret: VERCEL_SECRET, vercelProjectId: PROJECT_ID }),
      { params: params() }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: true });
    expect(calledUrls[1]).toBe(`https://api.vercel.com/v9/projects/${PROJECT_ID}`);
    expect(setConnectorSecret).toHaveBeenCalledWith(WS, "vercel", VERCEL_SECRET);
  });

  it("PUT vercel with NO vercelProjectId in the body still passes Gate 2 (token-only verify) — the route itself has no vercel-specific required-field check; the project leg is verify.ts's own additive concern, not this route's", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ user: { id: "u1" } }) }));
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.mocked(setConnectorSecret).mockResolvedValue({
      provider: "vercel",
      enabled: true,
      config: { repos: [], triggerLabel: "ready-for-agent", pollIntervalSeconds: 60 },
      hasSecret: true,
      updatedAt: "2026-07-30T00:00:00.000Z",
    } as never);

    const res = await PUT(putReq({ provider: "vercel", secret: VERCEL_SECRET }), {
      params: params(),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("PUT vercel with a live verify Vercel rejects (401) → 400, setConnectorSecret never called", async () => {
    global.fetch = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch;

    const res = await PUT(
      putReq({ provider: "vercel", secret: VERCEL_SECRET, vercelProjectId: PROJECT_ID }),
      { params: params() }
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Vercel rejected this token." });
    expect(setConnectorSecret).not.toHaveBeenCalled();
  });

  it("PUT vercel with a stale/wrong project id (404 on the project leg) → 400 with the distinct project-not-found error, setConnectorSecret never called", async () => {
    global.fetch = (async (url: string) => {
      if (String(url).includes("/v9/projects/")) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({ user: { id: "u1" } }) };
    }) as unknown as typeof fetch;

    const res = await PUT(
      putReq({ provider: "vercel", secret: VERCEL_SECRET, vercelProjectId: "prj_does_not_exist" }),
      { params: params() }
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Couldn't find this Vercel project — check the project ID." });
    expect(setConnectorSecret).not.toHaveBeenCalled();
  });

  it("PUT vercel with a whitespace-containing credential fails at the FORMAT gate — never calls fetch, never reads the extra config", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await PUT(
      putReq({ provider: "vercel", secret: "has a space", vercelProjectId: PROJECT_ID }),
      { params: params() }
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Vercel tokens must not contain whitespace." });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setConnectorSecret).not.toHaveBeenCalled();
  });

  it("PUT vercel with secret:null disconnects without ever calling verify/fetch, and without needing any extra config in the body", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.mocked(setConnectorSecret).mockResolvedValue({
      provider: "vercel",
      enabled: false,
      config: { repos: [], triggerLabel: "ready-for-agent", pollIntervalSeconds: 60 },
      hasSecret: false,
      updatedAt: "2026-07-30T00:00:00.000Z",
    } as never);

    const res = await PUT(putReq({ provider: "vercel", secret: null }), {
      params: params(),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setConnectorSecret).toHaveBeenCalledWith(WS, "vercel", null);
  });
});

/**
 * Full cloudflare connect flow (Task P8, FINAL Wave-2 provider) — both
 * gates run for real (this route doesn't mock `./verify`), same idiom as
 * the grafana/vercel blocks above. `secret` is a SINGLE field (no
 * composite split). UNLIKE every other Wave-2 provider's full-flow block,
 * cloudflare's live verify needs NO extra config at all (see verify.ts's
 * own doc-comment, "CLOUDFLARE (Task P8)") — this block still proves the
 * extra-config pass-through mechanism generalizes to an EIGHTH provider
 * carrying its own `cloudflareZoneId` field through the SAME PUT body, with
 * no cloudflare-specific code in this route; the field is simply not
 * needed by the verify call itself here.
 */
describe("PUT /connectors/secret — cloudflare, full flow + extra-config pass-through (Task P8)", () => {
  const originalFetch = global.fetch;
  // FIXTURE, deliberately non-realistic (mirrors the vercel/grafana blocks'
  // own shared discipline above): starts with `TESTFIXTURE_`, not
  // `cfut_`/`cfat_`/`cfk_` — the current, GitHub-secret-scanning-detected
  // Cloudflare token prefixes (see lib/evidence/cloudflare.ts's own
  // doc-comment, "AUTH"); cannot match those detectors' prefix checks by
  // construction.
  const CLOUDFLARE_SECRET = "TESTFIXTURE_cloudflare_token_00000000000000";
  const ZONE_ID = "023e105f4ecef8ad9ca31a8372d0c353";

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("PUT cloudflare accepted end to end: secret + cloudflareZoneId in the SAME body + a live verify that succeeds (GET /client/v4/user/tokens/verify) → 200 connected:true, setConnectorSecret called with the trimmed secret (the zone id NOT part of it)", async () => {
    const calledUrls: string[] = [];
    global.fetch = (async (url: string) => {
      calledUrls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ success: true, result: { id: "t1", status: "active" } }) };
    }) as unknown as typeof fetch;
    vi.mocked(setConnectorSecret).mockResolvedValue({
      provider: "cloudflare",
      enabled: true,
      config: {
        repos: [],
        triggerLabel: "ready-for-agent",
        pollIntervalSeconds: 60,
        cloudflareZoneId: ZONE_ID,
      },
      hasSecret: true,
      updatedAt: "2026-07-30T00:00:00.000Z",
    } as never);

    const res = await PUT(
      putReq({ provider: "cloudflare", secret: `  ${CLOUDFLARE_SECRET}  `, cloudflareZoneId: ZONE_ID }),
      { params: params() }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: true });
    expect(calledUrls).toEqual(["https://api.cloudflare.com/client/v4/user/tokens/verify"]);
    // The route itself never persists cloudflareZoneId — only the trimmed
    // secret.
    expect(setConnectorSecret).toHaveBeenCalledWith(WS, "cloudflare", CLOUDFLARE_SECRET);
  });

  it("PUT cloudflare with NO cloudflareZoneId in the body still passes Gate 2 (verify needs no config at all) — the route itself has no cloudflare-specific required-field check; the connector-level config_missing gate is the adapter's own concern at read time, not this route's", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { status: "active" } }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.mocked(setConnectorSecret).mockResolvedValue({
      provider: "cloudflare",
      enabled: true,
      config: { repos: [], triggerLabel: "ready-for-agent", pollIntervalSeconds: 60 },
      hasSecret: true,
      updatedAt: "2026-07-30T00:00:00.000Z",
    } as never);

    const res = await PUT(putReq({ provider: "cloudflare", secret: CLOUDFLARE_SECRET }), {
      params: params(),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("PUT cloudflare with a live verify Cloudflare rejects (401) → 400, setConnectorSecret never called", async () => {
    global.fetch = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch;

    const res = await PUT(putReq({ provider: "cloudflare", secret: CLOUDFLARE_SECRET, cloudflareZoneId: ZONE_ID }), {
      params: params(),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Cloudflare rejected this token." });
    expect(setConnectorSecret).not.toHaveBeenCalled();
  });

  it("PUT cloudflare with a disabled token (success:true, status:'disabled') → 400, setConnectorSecret never called", async () => {
    global.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { status: "disabled" } }),
    })) as unknown as typeof fetch;

    const res = await PUT(putReq({ provider: "cloudflare", secret: CLOUDFLARE_SECRET }), {
      params: params(),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Cloudflare rejected this token." });
    expect(setConnectorSecret).not.toHaveBeenCalled();
  });

  it("PUT cloudflare with a whitespace-containing credential fails at the FORMAT gate — never calls fetch, never reads the extra config", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await PUT(
      putReq({ provider: "cloudflare", secret: "has a space", cloudflareZoneId: ZONE_ID }),
      { params: params() }
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Cloudflare tokens must not contain whitespace." });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setConnectorSecret).not.toHaveBeenCalled();
  });

  it("PUT cloudflare with secret:null disconnects without ever calling verify/fetch, and without needing any extra config in the body", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.mocked(setConnectorSecret).mockResolvedValue({
      provider: "cloudflare",
      enabled: false,
      config: { repos: [], triggerLabel: "ready-for-agent", pollIntervalSeconds: 60 },
      hasSecret: false,
      updatedAt: "2026-07-30T00:00:00.000Z",
    } as never);

    const res = await PUT(putReq({ provider: "cloudflare", secret: null }), {
      params: params(),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setConnectorSecret).toHaveBeenCalledWith(WS, "cloudflare", null);
  });
});
