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

  it("the derived allowlist includes every real credential-based catalog kind so the error message stays accurate (linear, figma, context7, railway, langfuse, sentry) and excludes factory", async () => {
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
