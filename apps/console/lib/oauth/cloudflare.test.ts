import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudflareOauthAdapter } from "./cloudflare";
import { oauthAdapterFor } from "./types";

/**
 * OAuth Connect Wave 3, W3-T6 (`.superpowers/sdd/plan-oauth.md`). Fetch
 * mocked at the house-idiom layer (mirrors `railway.test.ts`'s own
 * `global.fetch` swap) — no HTTP, no network, no env beyond the three OAuth
 * vars this file sets/clears itself.
 *
 * `authorizeUrl`/`exchange` REQUIRE PKCE fields (throw without them — see
 * `cloudflare.ts`'s own doc-comment) — every test below that isn't
 * SPECIFICALLY testing that throw passes `CODE_CHALLENGE`/`CODE_VERIFIER`.
 * `authorizeUrl` ALSO requires `CLOUDFLARE_OAUTH_SCOPE` (the resource-scope
 * env var — see "SCOPES" in `cloudflare.ts`'s own doc-comment for why this
 * cannot be a hardcoded constant); every test that isn't specifically
 * testing ITS OWN missing-var throw sets it in `beforeEach`.
 */

const CLIENT_ID_KEY = "CLOUDFLARE_OAUTH_CLIENT_ID";
const CLIENT_SECRET_KEY = "CLOUDFLARE_OAUTH_CLIENT_SECRET";
const SCOPE_KEY = "CLOUDFLARE_OAUTH_SCOPE";
const CLIENT_ID = "test-client-id";
const CLIENT_SECRET = "test-client-secret";
// FIXTURE, deliberately non-realistic — not a real Cloudflare permission
// slug (see cloudflare.ts's own doc-comment, "SCOPES": the real slug is
// genuinely undocumented, never guessed by this codebase).
const OAUTH_SCOPE = "test-analytics.read";
const CODE_CHALLENGE = "test-code-challenge";
const CODE_VERIFIER = "test-code-verifier";

const originalFetch = global.fetch;

beforeEach(() => {
  process.env[CLIENT_ID_KEY] = CLIENT_ID;
  process.env[CLIENT_SECRET_KEY] = CLIENT_SECRET;
  process.env[SCOPE_KEY] = OAUTH_SCOPE;
});

afterEach(() => {
  delete process.env[CLIENT_ID_KEY];
  delete process.env[CLIENT_SECRET_KEY];
  delete process.env[SCOPE_KEY];
  global.fetch = originalFetch;
});

/** A well-formed token response — access_token/refresh_token/expires_in,
 * the RFC 6749 §5.1 baseline shape this adapter's own doc-comment discloses
 * as NOT vendor-confirmed via a worked Cloudflare example (unlike
 * Railway's), but licensed by the live discovery document's own declared
 * support surface. */
function tokenResponse(overrides: Record<string, unknown> = {}) {
  const body: Record<string, unknown> = {
    access_token: "acc-1",
    refresh_token: "ref-1",
    expires_in: 3600,
    token_type: "Bearer",
    ...overrides,
  };
  for (const key of Object.keys(body)) {
    if (body[key] === undefined) delete body[key];
  }
  return { ok: true, status: 200, json: async () => body };
}

function errorResponse(status: number, body: unknown = { error: "invalid_grant" }) {
  return { ok: false, status, json: async () => body };
}

/** Parses a captured fetch call's form-urlencoded body into key/value pairs. */
function parseFormBody(init: RequestInit | undefined): URLSearchParams {
  return new URLSearchParams(String(init?.body ?? ""));
}

/** `exchange` with PKCE fields already filled in — the common case every
 * test that isn't specifically about the PKCE-missing throw uses. */
function exchangeInput(overrides: Partial<Parameters<typeof cloudflareOauthAdapter.exchange>[0]> = {}) {
  return {
    code: "auth-code-1",
    redirectUri: "https://console.example/cb",
    params: {},
    codeVerifier: CODE_VERIFIER,
    ...overrides,
  };
}

describe("cloudflareOauthAdapter — shape + registration", () => {
  it("declares provider 'cloudflare'", () => {
    expect(cloudflareOauthAdapter.provider).toBe("cloudflare");
  });

  it("self-registers into the shared oauth registry on module load", () => {
    expect(oauthAdapterFor("cloudflare")).toBe(cloudflareOauthAdapter);
  });

  it("declares stateTransport 'param' — a standard OAuth2/OIDC redirect echoes state, unlike Sentry's confirmed-absent case", () => {
    expect(cloudflareOauthAdapter.stateTransport).toBe("param");
  });

  it("does NOT declare postExchange — disclosed decision (see cloudflare.ts's own doc-comment, 'NO postExchange')", () => {
    expect(cloudflareOauthAdapter.postExchange).toBeUndefined();
  });

  describe("envReady (the third env var, CLOUDFLARE_OAUTH_SCOPE)", () => {
    it("is true when CLOUDFLARE_OAUTH_SCOPE is set", () => {
      expect(cloudflareOauthAdapter.envReady?.()).toBe(true);
    });

    it("is false when CLOUDFLARE_OAUTH_SCOPE is unset, even with client id/secret both present", () => {
      delete process.env[SCOPE_KEY];
      expect(cloudflareOauthAdapter.envReady?.()).toBe(false);
    });
  });

  // W3-T8 (owner-visible OAuth setup state) — the NAME of the same var
  // envReady checks the presence of, for the connectors GET route's
  // `oauthSetup.missingEnv` to report by name.
  it("declares extraEnvKeys as exactly [CLOUDFLARE_OAUTH_SCOPE]", () => {
    expect(cloudflareOauthAdapter.extraEnvKeys?.()).toEqual(["CLOUDFLARE_OAUTH_SCOPE"]);
  });
});

describe("cloudflareOauthAdapter — authorizeUrl", () => {
  it("builds the doc-verified authorize URL (dash.cloudflare.com/oauth2/auth)", () => {
    const raw = cloudflareOauthAdapter.authorizeUrl({
      state: "state-123",
      redirectUri: "https://console.example/cb",
      codeChallenge: CODE_CHALLENGE,
    });
    const url = new URL(raw);
    expect(`${url.origin}${url.pathname}`).toBe("https://dash.cloudflare.com/oauth2/auth");
  });

  it("sets response_type=code, client_id from env, redirect_uri, scope (base scopes + the operator-supplied resource scope), and state", () => {
    const url = new URL(
      cloudflareOauthAdapter.authorizeUrl({
        state: "state-123",
        redirectUri: "https://console.example/cb",
        codeChallenge: CODE_CHALLENGE,
      })
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe("https://console.example/cb");
    expect(url.searchParams.get("scope")).toBe(`openid offline_access ${OAUTH_SCOPE}`);
    expect(url.searchParams.get("state")).toBe("state-123");
  });

  it("throws a clear error when CLOUDFLARE_OAUTH_CLIENT_ID/SECRET are unset (defensive — both routes already gate on oauthConfigFor before calling this)", () => {
    delete process.env[CLIENT_ID_KEY];
    delete process.env[CLIENT_SECRET_KEY];
    expect(() =>
      cloudflareOauthAdapter.authorizeUrl({ state: "s", redirectUri: "https://x/cb", codeChallenge: CODE_CHALLENGE })
    ).toThrow(/CLOUDFLARE_OAUTH_CLIENT_ID/);
  });

  it("throws a clear error when CLOUDFLARE_OAUTH_SCOPE is unset — never silently authorizes with an incomplete resource scope", () => {
    delete process.env[SCOPE_KEY];
    expect(() =>
      cloudflareOauthAdapter.authorizeUrl({ state: "s", redirectUri: "https://x/cb", codeChallenge: CODE_CHALLENGE })
    ).toThrow(/CLOUDFLARE_OAUTH_SCOPE/);
  });

  describe("PKCE (required, mirrors railway.ts)", () => {
    it("sets code_challenge and code_challenge_method=S256 when a codeChallenge is supplied", () => {
      const url = new URL(
        cloudflareOauthAdapter.authorizeUrl({
          state: "s",
          redirectUri: "https://x/cb",
          codeChallenge: "my-challenge-value",
        })
      );
      expect(url.searchParams.get("code_challenge")).toBe("my-challenge-value");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    });

    it("throws a clear error when codeChallenge is missing (PKCE required, not best-effort — Cloudflare's own docs say it's optional for a confidential client, but this adapter requires it anyway per this task's own brief)", () => {
      expect(() => cloudflareOauthAdapter.authorizeUrl({ state: "s", redirectUri: "https://x/cb" })).toThrow(
        /code_challenge/
      );
    });
  });
});

describe("cloudflareOauthAdapter — exchange", () => {
  it("POSTs to dash.cloudflare.com/oauth2/token with Basic auth (base64 client_id:client_secret) and form-urlencoded content-type", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => tokenResponse());
    global.fetch = fetchMock as unknown as typeof fetch;

    await cloudflareOauthAdapter.exchange(exchangeInput());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://dash.cloudflare.com/oauth2/token");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(
      `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`
    );
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("sends grant_type=authorization_code, code, redirect_uri, and code_verifier as form fields — never a client_secret body field (that rides in the Basic header only)", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => tokenResponse());
    global.fetch = fetchMock as unknown as typeof fetch;

    await cloudflareOauthAdapter.exchange(exchangeInput());

    const [, init] = fetchMock.mock.calls[0]!;
    const body = parseFormBody(init as RequestInit);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code-1");
    expect(body.get("redirect_uri")).toBe("https://console.example/cb");
    expect(body.get("code_verifier")).toBe(CODE_VERIFIER);
    expect(body.has("client_secret")).toBe(false);
    expect(body.has("client_id")).toBe(false);
  });

  it("ignores ExchangeInput.params entirely (no confirmed extra param this adapter needs)", async () => {
    global.fetch = vi.fn(async () => tokenResponse()) as unknown as typeof fetch;
    await expect(
      cloudflareOauthAdapter.exchange(exchangeInput({ params: { iss: "https://dash.cloudflare.com", unexpected: "1" } }))
    ).resolves.toBeDefined();
  });

  it("maps a successful response to the OauthEnvelope shape, computing expiresAt from expires_in seconds", async () => {
    const before = Date.now();
    global.fetch = vi.fn(async () =>
      tokenResponse({ access_token: "acc-x", refresh_token: "ref-x", expires_in: 3600 })
    ) as unknown as typeof fetch;

    const envelope = await cloudflareOauthAdapter.exchange(exchangeInput());

    expect(envelope.access).toBe("acc-x");
    expect(envelope.refresh).toBe("ref-x");
    const expiresAtMs = new Date(envelope.expiresAt).getTime();
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + 3600_000);
    expect(expiresAtMs).toBeLessThanOrEqual(Date.now() + 3600_000 + 5000);
  });

  describe("expires_in leniency (disclosed asymmetry from railway.ts — see cloudflare.ts's own doc-comment, 'ACCESS TTL')", () => {
    it("falls back to a short disclosed default (300s) when expires_in is absent — does NOT throw", async () => {
      const before = Date.now();
      global.fetch = vi.fn(async () =>
        tokenResponse({ expires_in: undefined })
      ) as unknown as typeof fetch;

      const envelope = await cloudflareOauthAdapter.exchange(exchangeInput());
      const expiresAtMs = new Date(envelope.expiresAt).getTime();
      expect(expiresAtMs).toBeGreaterThanOrEqual(before + 300_000);
      expect(expiresAtMs).toBeLessThanOrEqual(Date.now() + 300_000 + 5000);
    });

    it("falls back to the same default when expires_in is non-numeric — does NOT throw", async () => {
      global.fetch = vi.fn(async () =>
        tokenResponse({ expires_in: "not-a-number" })
      ) as unknown as typeof fetch;
      await expect(cloudflareOauthAdapter.exchange(exchangeInput())).resolves.toBeDefined();
    });

    it("falls back to the same default when expires_in is zero or negative — does NOT throw", async () => {
      global.fetch = vi.fn(async () => tokenResponse({ expires_in: 0 })) as unknown as typeof fetch;
      await expect(cloudflareOauthAdapter.exchange(exchangeInput())).resolves.toBeDefined();
    });
  });

  it("throws on a non-2xx response, without leaking the response body into the thrown message", async () => {
    // ZZPROBE-CF1 is an arbitrary, distinctive canary (retrieval-probe
    // hygiene, mirrors railway.test.ts's ZZPROBE7 precedent) — the real
    // invalid_grant/error_description field names stay, since those mirror
    // the actual response shape; only the bait VALUE is arbitrary.
    global.fetch = vi.fn(async () =>
      errorResponse(400, { error: "invalid_grant", error_description: "ZZPROBE-CF1" })
    ) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await cloudflareOauthAdapter.exchange(exchangeInput({ code: "bad" }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).not.toContain("ZZPROBE-CF1");
  });

  it("throws when access_token is missing from an otherwise-200 response", async () => {
    global.fetch = vi.fn(async () => tokenResponse({ access_token: undefined })) as unknown as typeof fetch;
    await expect(cloudflareOauthAdapter.exchange(exchangeInput())).rejects.toThrow();
  });

  it("throws when refresh_token is missing from an otherwise-200 response (never silently proceeds without one)", async () => {
    global.fetch = vi.fn(async () => tokenResponse({ refresh_token: undefined })) as unknown as typeof fetch;
    await expect(cloudflareOauthAdapter.exchange(exchangeInput())).rejects.toThrow();
  });

  it("throws when the response body isn't valid JSON", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    })) as unknown as typeof fetch;
    await expect(cloudflareOauthAdapter.exchange(exchangeInput())).rejects.toThrow();
  });

  it("throws a clear error when codeVerifier is missing (PKCE required, not best-effort), without ever calling fetch", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      cloudflareOauthAdapter.exchange({ code: "c", redirectUri: "https://x/cb", params: {} })
    ).rejects.toThrow(/code_verifier/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("cloudflareOauthAdapter — refresh + rotation persistence", () => {
  it("POSTs grant_type=refresh_token with the envelope's own refresh token, Basic auth, form-urlencoded — and never sends redirect_uri/code/code_verifier (not part of the refresh grant)", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      tokenResponse({ access_token: "acc-2", refresh_token: "ref-2" })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await cloudflareOauthAdapter.refresh({ access: "acc-1", refresh: "ref-1", expiresAt: "2020-01-01T00:00:00.000Z" });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://dash.cloudflare.com/oauth2/token");
    const body = parseFormBody(init as RequestInit);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("ref-1");
    expect(body.has("redirect_uri")).toBe(false);
    expect(body.has("code")).toBe(false);
    expect(body.has("code_verifier")).toBe(false);
  });

  it("returns the rotated {access, refresh} pair from the response — not the old refresh token it was called with", async () => {
    global.fetch = vi.fn(async () =>
      tokenResponse({ access_token: "acc-2", refresh_token: "ref-2" })
    ) as unknown as typeof fetch;
    const rotated = await cloudflareOauthAdapter.refresh({
      access: "acc-1",
      refresh: "ref-1",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    expect(rotated.access).toBe("acc-2");
    expect(rotated.refresh).toBe("ref-2");
    expect(rotated.refresh).not.toBe("ref-1");
  });

  it("rotation persistence: the SECOND refresh call uses the FIRST refresh's rotated token, never the original — defensively safe regardless of whether Cloudflare actually rotates (unconfirmed either way, see cloudflare.ts's own doc-comment, 'REFRESH ROTATION')", async () => {
    const seenRefreshTokens: string[] = [];
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = parseFormBody(init);
      const sent = body.get("refresh_token") ?? "";
      seenRefreshTokens.push(sent);
      const next = sent === "ref-0" ? "ref-1" : "ref-2";
      return tokenResponse({ access_token: `acc-for-${next}`, refresh_token: next });
    }) as unknown as typeof fetch;

    const first = await cloudflareOauthAdapter.refresh({
      access: "acc-0",
      refresh: "ref-0",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    expect(first.refresh).toBe("ref-1");

    const second = await cloudflareOauthAdapter.refresh(first);
    expect(second.refresh).toBe("ref-2");

    expect(seenRefreshTokens).toEqual(["ref-0", "ref-1"]);
  });

  it("throws when the refresh response is missing a refresh_token — never falls back to silently reusing the old one", async () => {
    global.fetch = vi.fn(async () => tokenResponse({ refresh_token: undefined })) as unknown as typeof fetch;
    await expect(
      cloudflareOauthAdapter.refresh({ access: "acc-1", refresh: "ref-1", expiresAt: "2020-01-01T00:00:00.000Z" })
    ).rejects.toThrow();
  });

  it("throws on a non-2xx refresh response (e.g. invalid_grant from an expired/revoked refresh token) — core.ts's resolveProviderAuth turns this into 'unauthorized', prompting reconnect", async () => {
    global.fetch = vi.fn(async () => errorResponse(400)) as unknown as typeof fetch;
    await expect(
      cloudflareOauthAdapter.refresh({ access: "acc-1", refresh: "ref-1", expiresAt: "2020-01-01T00:00:00.000Z" })
    ).rejects.toThrow();
  });

  it("falls back to the disclosed default TTL on refresh too when expires_in is absent", async () => {
    const before = Date.now();
    global.fetch = vi.fn(async () =>
      tokenResponse({ access_token: "acc-2", refresh_token: "ref-2", expires_in: undefined })
    ) as unknown as typeof fetch;
    const rotated = await cloudflareOauthAdapter.refresh({
      access: "acc-1",
      refresh: "ref-1",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    const expiresAtMs = new Date(rotated.expiresAt).getTime();
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + 300_000);
    expect(expiresAtMs).toBeLessThanOrEqual(Date.now() + 300_000 + 5000);
  });
});
