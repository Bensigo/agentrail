import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sentryOauthAdapter } from "./sentry";
import { oauthAdapterFor } from "./types";

/**
 * OAuth Connect Wave 3, W3-T3 — mirrors `lib/oauth/railway.test.ts`'s own
 * fetch-mocked-at-the-house-idiom-layer convention (no HTTP, no network, no
 * env beyond the three OAuth vars this file sets/clears itself).
 *
 * IMPORTANT CONTEXT (see `sentry.ts`'s own doc-comment, "STATE CANNOT
 * ROUND-TRIP"): this adapter is fully implemented and tested here — every
 * method below is exercised directly, exactly as it will behave once a
 * future task resolves the state-binding gap and wires it into the live
 * routes — but no live route imports `./sentry` today, so none of this is
 * reachable in production yet. That reachability decision is proven
 * separately (by its ABSENCE) in the three route test files, which never
 * import this module.
 */

const CLIENT_ID_KEY = "SENTRY_OAUTH_CLIENT_ID";
const CLIENT_SECRET_KEY = "SENTRY_OAUTH_CLIENT_SECRET";
const SLUG_KEY = "SENTRY_OAUTH_INTEGRATION_SLUG";
const CLIENT_ID = "test-client-id";
const CLIENT_SECRET = "test-client-secret";
const SLUG = "agentrail-test";
const INSTALLATION_ID = "01635075-m30w-4f96-8fc8-ff9680780a13";

const originalFetch = global.fetch;

beforeEach(() => {
  process.env[CLIENT_ID_KEY] = CLIENT_ID;
  process.env[CLIENT_SECRET_KEY] = CLIENT_SECRET;
  process.env[SLUG_KEY] = SLUG;
});

afterEach(() => {
  delete process.env[CLIENT_ID_KEY];
  delete process.env[CLIENT_SECRET_KEY];
  delete process.env[SLUG_KEY];
  global.fetch = originalFetch;
});

/** A well-formed authorization response — every field the docs' own worked
 * JSON example shows on a successful exchange/refresh. `expiresAt` is a
 * real absolute ISO-8601 string (unlike Railway's `expires_in` delta). */
function authorizationResponse(overrides: Record<string, unknown> = {}) {
  const body: Record<string, unknown> = {
    id: "38",
    token: "acc-1",
    refreshToken: "ref-1",
    dateCreated: "2026-07-29T20:25:09.870Z",
    expiresAt: "2026-07-30T04:25:09.870Z",
    state: null,
    application: null,
    ...overrides,
  };
  for (const key of Object.keys(body)) {
    if (body[key] === undefined) delete body[key];
  }
  return { ok: true, status: 200, json: async () => body };
}

function errorResponse(status: number, body: unknown = { detail: "error" }) {
  return { ok: false, status, json: async () => body };
}

function exchangeInput(overrides: Partial<Parameters<typeof sentryOauthAdapter.exchange>[0]> = {}) {
  return {
    code: "grant-code-1",
    redirectUri: "https://console.example/api/v1/connectors/oauth/callback/sentry",
    params: { installationId: INSTALLATION_ID },
    ...overrides,
  };
}

function compoundRefresh(installationId: string, refreshToken: string): string {
  return JSON.stringify({ installationId, refreshToken });
}

describe("sentryOauthAdapter — shape + registration", () => {
  it("declares provider 'sentry'", () => {
    expect(sentryOauthAdapter.provider).toBe("sentry");
  });

  it("self-registers into the shared oauth registry on module load", () => {
    expect(oauthAdapterFor("sentry")).toBe(sentryOauthAdapter);
  });

  it("declares postExchange", () => {
    expect(typeof sentryOauthAdapter.postExchange).toBe("function");
  });

  // W3-T3 fix round (coordinator ruling, option B) — SESSION-TRANSPORT.
  it("declares stateTransport: 'session' — its redirect cannot carry a vendor-echoed state token", () => {
    expect(sentryOauthAdapter.stateTransport).toBe("session");
  });

  it("declares envReady, true only when SENTRY_OAUTH_INTEGRATION_SLUG is set (the third env var beyond the generic client id/secret pair)", () => {
    delete process.env[SLUG_KEY];
    expect(sentryOauthAdapter.envReady?.()).toBe(false);
    process.env[SLUG_KEY] = SLUG;
    expect(sentryOauthAdapter.envReady?.()).toBe(true);
  });
});

describe("sentryOauthAdapter — authorizeUrl", () => {
  it("builds the doc-verified external-install URL from the configured slug", () => {
    const raw = sentryOauthAdapter.authorizeUrl({ state: "state-123", redirectUri: "https://console.example/cb" });
    expect(raw).toBe(`https://sentry.io/sentry-apps/${SLUG}/external-install/`);
  });

  it("URL-encodes the slug", () => {
    process.env[SLUG_KEY] = "my app";
    const raw = sentryOauthAdapter.authorizeUrl({ state: "s", redirectUri: "https://x/cb" });
    expect(raw).toBe("https://sentry.io/sentry-apps/my%20app/external-install/");
  });

  it("does NOT embed state anywhere in the URL — Sentry's external-install flow neither accepts nor echoes one back (doc-confirmed absence)", () => {
    const raw = sentryOauthAdapter.authorizeUrl({ state: "should-not-appear", redirectUri: "https://x/cb" });
    expect(raw).not.toContain("should-not-appear");
    expect(raw).not.toContain("state");
  });

  it("does NOT embed codeChallenge — Sentry's Public Integration exchange has no PKCE concept", () => {
    const raw = sentryOauthAdapter.authorizeUrl({
      state: "s",
      redirectUri: "https://x/cb",
      codeChallenge: "should-not-appear-either",
    });
    expect(raw).not.toContain("should-not-appear-either");
  });

  it("does NOT embed redirectUri — Sentry's Redirect URL is configured vendor-side on the integration itself, not passed per-attempt", () => {
    const raw = sentryOauthAdapter.authorizeUrl({
      state: "s",
      redirectUri: "https://should-not-appear.example/cb",
    });
    expect(raw).not.toContain("should-not-appear.example");
  });

  it("throws a clear error when SENTRY_OAUTH_CLIENT_ID/SECRET are unset", () => {
    delete process.env[CLIENT_ID_KEY];
    delete process.env[CLIENT_SECRET_KEY];
    expect(() => sentryOauthAdapter.authorizeUrl({ state: "s", redirectUri: "https://x/cb" })).toThrow(
      /SENTRY_OAUTH_CLIENT_ID/
    );
  });

  it("throws a clear error when SENTRY_OAUTH_INTEGRATION_SLUG is unset, even though client id/secret ARE set", () => {
    delete process.env[SLUG_KEY];
    expect(() => sentryOauthAdapter.authorizeUrl({ state: "s", redirectUri: "https://x/cb" })).toThrow(
      /SENTRY_OAUTH_INTEGRATION_SLUG/
    );
  });
});

describe("sentryOauthAdapter — exchange", () => {
  it("POSTs to the doc-verified authorizations endpoint with the installationId in the URL path", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => authorizationResponse());
    global.fetch = fetchMock as unknown as typeof fetch;

    await sentryOauthAdapter.exchange(exchangeInput());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://sentry.io/api/0/sentry-app-installations/${INSTALLATION_ID}/authorizations/`);
  });

  it("sends a JSON body (Content-Type: application/json) — not form-urlencoded, unlike Railway", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => authorizationResponse());
    global.fetch = fetchMock as unknown as typeof fetch;

    await sentryOauthAdapter.exchange(exchangeInput());

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
    expect(body).toEqual({
      grant_type: "authorization_code",
      code: "grant-code-1",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
  });

  it("never sends a redirect_uri field — not part of the doc-verified exchange payload", async () => {
    global.fetch = vi.fn(async () => authorizationResponse()) as unknown as typeof fetch;
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    await sentryOauthAdapter.exchange(exchangeInput());
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("redirect_uri");
  });

  // W3-T3 fix round (coordinator's own explicit ask: "PKCE not demanded for
  // sentry — verify the shared callback path doesn't"). The shared callback
  // route threads whatever codeVerifier the consumed state carried (`undefined`
  // when none, per its own doc-comment) straight into ExchangeInput — this
  // adapter must succeed regardless, since Public Integration's exchange
  // payload has no code_verifier field at all (doc-confirmed).
  it("ignores ExchangeInput.codeVerifier entirely — succeeds whether it's supplied or undefined, never sent to Sentry", async () => {
    global.fetch = vi.fn(async () => authorizationResponse()) as unknown as typeof fetch;
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;

    await expect(
      sentryOauthAdapter.exchange(exchangeInput({ codeVerifier: "some-real-verifier-value" }))
    ).resolves.toBeDefined();
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("code_verifier");

    await expect(sentryOauthAdapter.exchange(exchangeInput({ codeVerifier: undefined }))).resolves.toBeDefined();
  });

  it("throws a clear error when params.installationId is missing, without ever calling fetch", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(sentryOauthAdapter.exchange(exchangeInput({ params: {} }))).rejects.toThrow(/installationId/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a successful response to the OauthEnvelope shape: token->access, expiresAt used VERBATIM (no expires_in arithmetic)", async () => {
    global.fetch = vi.fn(async () =>
      authorizationResponse({ token: "acc-x", refreshToken: "ref-x", expiresAt: "2030-05-01T00:00:00.000Z" })
    ) as unknown as typeof fetch;

    const envelope = await sentryOauthAdapter.exchange(exchangeInput());

    expect(envelope.access).toBe("acc-x");
    expect(envelope.expiresAt).toBe("2030-05-01T00:00:00.000Z");
  });

  it("encodes installationId + refreshToken as a compound JSON string in the envelope's refresh field", async () => {
    global.fetch = vi.fn(async () =>
      authorizationResponse({ refreshToken: "ref-x" })
    ) as unknown as typeof fetch;

    const envelope = await sentryOauthAdapter.exchange(exchangeInput({ params: { installationId: "install-77" } }));

    expect(JSON.parse(envelope.refresh)).toEqual({ installationId: "install-77", refreshToken: "ref-x" });
  });

  it("throws on a non-2xx response, without leaking the response body into the thrown message", async () => {
    // ZZPROBE8 is an arbitrary, distinctive canary (orientation-probe
    // retrieval-collision cleanup, W3-T4 follow-up) — only the bait VALUE
    // was arbitrary.
    global.fetch = vi.fn(async () =>
      errorResponse(400, { detail: "ZZPROBE8" })
    ) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await sentryOauthAdapter.exchange(exchangeInput());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).not.toContain("ZZPROBE8");
  });

  it("throws when token is missing from an otherwise-200 response", async () => {
    global.fetch = vi.fn(async () => authorizationResponse({ token: undefined })) as unknown as typeof fetch;
    await expect(sentryOauthAdapter.exchange(exchangeInput())).rejects.toThrow();
  });

  it("throws when refreshToken is missing from an otherwise-200 response", async () => {
    global.fetch = vi.fn(async () => authorizationResponse({ refreshToken: undefined })) as unknown as typeof fetch;
    await expect(sentryOauthAdapter.exchange(exchangeInput())).rejects.toThrow();
  });

  it("throws when expiresAt is missing", async () => {
    global.fetch = vi.fn(async () => authorizationResponse({ expiresAt: undefined })) as unknown as typeof fetch;
    await expect(sentryOauthAdapter.exchange(exchangeInput())).rejects.toThrow();
  });

  it("throws when expiresAt does not parse as a date — never trusts an unconfirmed shape", async () => {
    global.fetch = vi.fn(async () => authorizationResponse({ expiresAt: "not-a-date" })) as unknown as typeof fetch;
    await expect(sentryOauthAdapter.exchange(exchangeInput())).rejects.toThrow();
  });

  it("throws when the response body isn't valid JSON", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    })) as unknown as typeof fetch;
    await expect(sentryOauthAdapter.exchange(exchangeInput())).rejects.toThrow();
  });
});

describe("sentryOauthAdapter — refresh", () => {
  it("decodes the envelope's compound refresh field and POSTs grant_type=refresh_token with the REAL refresh token (not the compound JSON)", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => authorizationResponse());
    global.fetch = fetchMock as unknown as typeof fetch;

    await sentryOauthAdapter.refresh({
      access: "acc-1",
      refresh: compoundRefresh("install-9", "real-refresh-token"),
      expiresAt: "2020-01-01T00:00:00.000Z",
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://sentry.io/api/0/sentry-app-installations/install-9/authorizations/");
    const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
    expect(body).toEqual({
      grant_type: "refresh_token",
      refresh_token: "real-refresh-token",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
  });

  it("returns the rotated {access, refresh} pair — the refresh field re-encodes the SAME installationId with the NEW refreshToken", async () => {
    global.fetch = vi.fn(async () =>
      authorizationResponse({ token: "acc-2", refreshToken: "ref-2" })
    ) as unknown as typeof fetch;

    const rotated = await sentryOauthAdapter.refresh({
      access: "acc-1",
      refresh: compoundRefresh("install-9", "ref-1"),
      expiresAt: "2020-01-01T00:00:00.000Z",
    });

    expect(rotated.access).toBe("acc-2");
    expect(JSON.parse(rotated.refresh)).toEqual({ installationId: "install-9", refreshToken: "ref-2" });
  });

  it("rotation persistence: the SECOND refresh call uses the FIRST refresh's rotated token, never the original", async () => {
    const seenRefreshTokens: string[] = [];
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { refresh_token?: string };
      seenRefreshTokens.push(body.refresh_token ?? "");
      const next = body.refresh_token === "ref-0" ? "ref-1" : "ref-2";
      return authorizationResponse({ token: `acc-for-${next}`, refreshToken: next });
    }) as unknown as typeof fetch;

    const first = await sentryOauthAdapter.refresh({
      access: "acc-0",
      refresh: compoundRefresh("install-1", "ref-0"),
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    expect(JSON.parse(first.refresh)).toEqual({ installationId: "install-1", refreshToken: "ref-1" });

    // Mirrors core.ts's resolveProviderAuth in production: it persists
    // whatever refresh() returns and hands THAT envelope to the next
    // refresh attempt, never the original.
    const second = await sentryOauthAdapter.refresh(first);
    expect(JSON.parse(second.refresh)).toEqual({ installationId: "install-1", refreshToken: "ref-2" });

    expect(seenRefreshTokens).toEqual(["ref-0", "ref-1"]);
  });

  it("throws when the envelope's refresh field is not JSON (a malformed/foreign envelope)", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      sentryOauthAdapter.refresh({ access: "acc-1", refresh: "not-json", expiresAt: "2020-01-01T00:00:00.000Z" })
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when the envelope's refresh field is JSON but missing installationId/refreshToken", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      sentryOauthAdapter.refresh({
        access: "acc-1",
        refresh: JSON.stringify({ installationId: "install-1" }),
        expiresAt: "2020-01-01T00:00:00.000Z",
      })
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on a non-2xx refresh response — core.ts's resolveProviderAuth turns this into 'unauthorized'", async () => {
    global.fetch = vi.fn(async () => errorResponse(400)) as unknown as typeof fetch;
    await expect(
      sentryOauthAdapter.refresh({
        access: "acc-1",
        refresh: compoundRefresh("install-1", "ref-1"),
        expiresAt: "2020-01-01T00:00:00.000Z",
      })
    ).rejects.toThrow();
  });
});

describe("sentryOauthAdapter — postExchange", () => {
  const ENVELOPE = {
    access: "acc-fresh",
    refresh: compoundRefresh("install-fresh", "ref-fresh"),
    expiresAt: "2099-01-01T00:00:00.000Z",
  };

  it("PUTs the verify-install request with Authorization: Bearer <fresh access token> and {status:'installed'}", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, json: async () => ({}) }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await sentryOauthAdapter.postExchange!({ envelope: ENVELOPE, config: {} });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://sentry.io/api/0/sentry-app-installations/install-fresh/");
    expect((init as RequestInit).method).toBe("PUT");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer acc-fresh");
    const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
    expect(body).toEqual({ status: "installed" });
  });

  it("returns {ok:true, configPatch:{sentryInstallationId}} on a successful verify-install", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })) as unknown as typeof fetch;
    const result = await sentryOauthAdapter.postExchange!({ envelope: ENVELOPE, config: {} });
    expect(result).toEqual({ ok: true, configPatch: { sentryInstallationId: "install-fresh" } });
  });

  it("BEST-EFFORT: still returns {ok:true, configPatch} even when the verify-install PUT returns a non-2xx (unlike Railway's fail-closed postExchange)", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({}) })) as unknown as typeof fetch;
    const result = await sentryOauthAdapter.postExchange!({ envelope: ENVELOPE, config: {} });
    expect(result).toEqual({ ok: true, configPatch: { sentryInstallationId: "install-fresh" } });
  });

  it("BEST-EFFORT: still returns {ok:true, configPatch} even when the verify-install fetch itself throws (network error)", async () => {
    global.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const result = await sentryOauthAdapter.postExchange!({ envelope: ENVELOPE, config: {} });
    expect(result).toEqual({ ok: true, configPatch: { sentryInstallationId: "install-fresh" } });
  });

  it("throws (does not swallow) when the envelope's own refresh field is malformed — an internal-bug signal, not a vendor rejection", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      sentryOauthAdapter.postExchange!({
        envelope: { access: "acc", refresh: "not-json", expiresAt: "2099-01-01T00:00:00.000Z" },
        config: {},
      })
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
