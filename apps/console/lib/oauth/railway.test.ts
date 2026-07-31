import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { railwayOauthAdapter } from "./railway";
import { oauthAdapterFor } from "./types";

/**
 * OAuth Connect Wave 3, W3-T2. Fetch mocked at the house-idiom layer (mirrors
 * `lib/evidence/railway.test.ts`'s own `global.fetch` swap) — no HTTP, no
 * network, no env beyond the two OAuth vars this file sets/clears itself.
 */

const CLIENT_ID_KEY = "RAILWAY_OAUTH_CLIENT_ID";
const CLIENT_SECRET_KEY = "RAILWAY_OAUTH_CLIENT_SECRET";
const CLIENT_ID = "test-client-id";
const CLIENT_SECRET = "test-client-secret";

const originalFetch = global.fetch;

beforeEach(() => {
  process.env[CLIENT_ID_KEY] = CLIENT_ID;
  process.env[CLIENT_SECRET_KEY] = CLIENT_SECRET;
});

afterEach(() => {
  delete process.env[CLIENT_ID_KEY];
  delete process.env[CLIENT_SECRET_KEY];
  global.fetch = originalFetch;
});

/** A well-formed token response — every field the docs' own worked JSON
 * examples show on a successful exchange/refresh. */
function tokenResponse(overrides: Record<string, unknown> = {}) {
  const body: Record<string, unknown> = {
    access_token: "acc-1",
    refresh_token: "ref-1",
    expires_in: 3600,
    token_type: "Bearer",
    scope: "openid project:viewer offline_access",
    ...overrides,
  };
  // Lets a test omit a field entirely (rather than sending `undefined`,
  // which JSON.stringify would already drop, but this keeps `json()` below
  // honest about what a REAL malformed response would look like).
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

describe("railwayOauthAdapter — shape + registration", () => {
  it("declares provider 'railway'", () => {
    expect(railwayOauthAdapter.provider).toBe("railway");
  });

  it("self-registers into the shared oauth registry on module load", () => {
    expect(oauthAdapterFor("railway")).toBe(railwayOauthAdapter);
  });
});

describe("railwayOauthAdapter — authorizeUrl", () => {
  it("builds the doc-verified authorize URL (backboard.railway.com/oauth/auth — corrects the plan's provisional railway.com/oauth/authorize guess)", () => {
    const raw = railwayOauthAdapter.authorizeUrl({ state: "state-123", redirectUri: "https://console.example/cb" });
    const url = new URL(raw);
    expect(`${url.origin}${url.pathname}`).toBe("https://backboard.railway.com/oauth/auth");
  });

  it("sets response_type=code, client_id from env, redirect_uri, scope, state, and prompt=consent", () => {
    const url = new URL(
      railwayOauthAdapter.authorizeUrl({ state: "state-123", redirectUri: "https://console.example/cb" })
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe("https://console.example/cb");
    expect(url.searchParams.get("scope")).toBe("openid project:viewer offline_access");
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  it("always sends prompt=consent, unconditionally — never omitted (required to receive a refresh token at all, per the docs)", () => {
    const url1 = new URL(railwayOauthAdapter.authorizeUrl({ state: "s1", redirectUri: "https://x/cb" }));
    const url2 = new URL(railwayOauthAdapter.authorizeUrl({ state: "s2", redirectUri: "https://x/cb" }));
    expect(url1.searchParams.get("prompt")).toBe("consent");
    expect(url2.searchParams.get("prompt")).toBe("consent");
  });

  it("throws a clear error when RAILWAY_OAUTH_CLIENT_ID/SECRET are unset (defensive — both routes already gate on oauthConfigFor before calling this)", () => {
    delete process.env[CLIENT_ID_KEY];
    delete process.env[CLIENT_SECRET_KEY];
    expect(() => railwayOauthAdapter.authorizeUrl({ state: "s", redirectUri: "https://x/cb" })).toThrow(
      /RAILWAY_OAUTH_CLIENT_ID/
    );
  });
});

describe("railwayOauthAdapter — exchange", () => {
  it("POSTs to backboard.railway.com/oauth/token with Basic auth (base64 client_id:client_secret) and form-urlencoded content-type", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => tokenResponse());
    global.fetch = fetchMock as unknown as typeof fetch;

    await railwayOauthAdapter.exchange({ code: "auth-code-1", redirectUri: "https://console.example/cb", params: {} });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://backboard.railway.com/oauth/token");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(
      `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`
    );
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("sends grant_type=authorization_code, code, and redirect_uri as form fields — never a client_secret body field (that rides in the Basic header only)", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => tokenResponse());
    global.fetch = fetchMock as unknown as typeof fetch;

    await railwayOauthAdapter.exchange({ code: "auth-code-1", redirectUri: "https://console.example/cb", params: {} });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = parseFormBody(init as RequestInit);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code-1");
    expect(body.get("redirect_uri")).toBe("https://console.example/cb");
    expect(body.has("client_secret")).toBe(false);
    expect(body.has("client_id")).toBe(false);
  });

  it("ignores ExchangeInput.params entirely (Railway needs nothing beyond code/redirect_uri — unlike Sentry's installationId)", async () => {
    global.fetch = vi.fn(async () => tokenResponse()) as unknown as typeof fetch;
    await expect(
      railwayOauthAdapter.exchange({
        code: "c",
        redirectUri: "https://x/cb",
        params: { iss: "https://backboard.railway.com", unexpected: "1" },
      })
    ).resolves.toBeDefined();
  });

  it("maps a successful response to the OauthEnvelope shape, computing expiresAt from expires_in seconds", async () => {
    const before = Date.now();
    global.fetch = vi.fn(async () =>
      tokenResponse({ access_token: "acc-x", refresh_token: "ref-x", expires_in: 3600 })
    ) as unknown as typeof fetch;

    const envelope = await railwayOauthAdapter.exchange({ code: "c", redirectUri: "https://x/cb", params: {} });

    expect(envelope.access).toBe("acc-x");
    expect(envelope.refresh).toBe("ref-x");
    const expiresAtMs = new Date(envelope.expiresAt).getTime();
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + 3600_000);
    expect(expiresAtMs).toBeLessThanOrEqual(Date.now() + 3600_000 + 5000);
  });

  it("throws on a non-2xx response, without leaking the response body into the thrown message", async () => {
    global.fetch = vi.fn(async () =>
      errorResponse(400, { error: "invalid_grant", error_description: "SUPER-SECRET-DETAIL" })
    ) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await railwayOauthAdapter.exchange({ code: "bad", redirectUri: "https://x/cb", params: {} });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).not.toContain("SUPER-SECRET-DETAIL");
  });

  it("throws when access_token is missing from an otherwise-200 response", async () => {
    global.fetch = vi.fn(async () => tokenResponse({ access_token: undefined })) as unknown as typeof fetch;
    await expect(
      railwayOauthAdapter.exchange({ code: "c", redirectUri: "https://x/cb", params: {} })
    ).rejects.toThrow();
  });

  it("throws when refresh_token is missing from an otherwise-200 response (never silently proceeds without one)", async () => {
    global.fetch = vi.fn(async () => tokenResponse({ refresh_token: undefined })) as unknown as typeof fetch;
    await expect(
      railwayOauthAdapter.exchange({ code: "c", redirectUri: "https://x/cb", params: {} })
    ).rejects.toThrow();
  });

  it("throws when expires_in is missing or non-numeric", async () => {
    global.fetch = vi.fn(async () => tokenResponse({ expires_in: "not-a-number" })) as unknown as typeof fetch;
    await expect(
      railwayOauthAdapter.exchange({ code: "c", redirectUri: "https://x/cb", params: {} })
    ).rejects.toThrow();
  });

  it("throws when the response body isn't valid JSON", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    })) as unknown as typeof fetch;
    await expect(
      railwayOauthAdapter.exchange({ code: "c", redirectUri: "https://x/cb", params: {} })
    ).rejects.toThrow();
  });
});

describe("railwayOauthAdapter — refresh + rotation persistence", () => {
  it("POSTs grant_type=refresh_token with the envelope's own refresh token, Basic auth, form-urlencoded — and never sends redirect_uri (not part of the refresh grant)", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      tokenResponse({ access_token: "acc-2", refresh_token: "ref-2" })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await railwayOauthAdapter.refresh({ access: "acc-1", refresh: "ref-1", expiresAt: "2020-01-01T00:00:00.000Z" });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://backboard.railway.com/oauth/token");
    const body = parseFormBody(init as RequestInit);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("ref-1");
    expect(body.has("redirect_uri")).toBe(false);
    expect(body.has("code")).toBe(false);
  });

  it("returns the rotated {access, refresh} pair from the response — not the old refresh token it was called with", async () => {
    global.fetch = vi.fn(async () =>
      tokenResponse({ access_token: "acc-2", refresh_token: "ref-2" })
    ) as unknown as typeof fetch;
    const rotated = await railwayOauthAdapter.refresh({
      access: "acc-1",
      refresh: "ref-1",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    expect(rotated.access).toBe("acc-2");
    expect(rotated.refresh).toBe("ref-2");
    expect(rotated.refresh).not.toBe("ref-1");
  });

  it("rotation persistence: the SECOND refresh call uses the FIRST refresh's rotated token, never the original — reusing a rotated token immediately revokes the whole authorization per Railway's own docs, so this is not a hypothetical", async () => {
    const seenRefreshTokens: string[] = [];
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = parseFormBody(init);
      const sent = body.get("refresh_token") ?? "";
      seenRefreshTokens.push(sent);
      const next = sent === "ref-0" ? "ref-1" : "ref-2";
      return tokenResponse({ access_token: `acc-for-${next}`, refresh_token: next });
    }) as unknown as typeof fetch;

    const first = await railwayOauthAdapter.refresh({
      access: "acc-0",
      refresh: "ref-0",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    expect(first.refresh).toBe("ref-1");

    // Mirrors core.ts's resolveProviderAuth in production: it persists
    // whatever refresh() returns and hands THAT envelope to the next
    // refresh attempt, never the original.
    const second = await railwayOauthAdapter.refresh(first);
    expect(second.refresh).toBe("ref-2");

    expect(seenRefreshTokens).toEqual(["ref-0", "ref-1"]);
  });

  it("throws when the refresh response is missing a rotated refresh_token — never falls back to silently reusing the old one", async () => {
    global.fetch = vi.fn(async () => tokenResponse({ refresh_token: undefined })) as unknown as typeof fetch;
    await expect(
      railwayOauthAdapter.refresh({ access: "acc-1", refresh: "ref-1", expiresAt: "2020-01-01T00:00:00.000Z" })
    ).rejects.toThrow();
  });

  it("throws on a non-2xx refresh response (e.g. invalid_grant from an already-rotated or expired refresh token) — core.ts's resolveProviderAuth turns this into 'unauthorized', prompting reconnect", async () => {
    global.fetch = vi.fn(async () => errorResponse(400)) as unknown as typeof fetch;
    await expect(
      railwayOauthAdapter.refresh({ access: "acc-1", refresh: "ref-1", expiresAt: "2020-01-01T00:00:00.000Z" })
    ).rejects.toThrow();
  });
});
