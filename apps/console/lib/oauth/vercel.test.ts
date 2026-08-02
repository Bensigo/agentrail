import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vercelOauthAdapter } from "./vercel";
import { oauthAdapterFor } from "./types";

/**
 * OAuth Connect Wave 3, W3-T9 (`.superpowers/sdd/plan-oauth.md`). Fetch
 * mocked at the house-idiom layer (mirrors `railway.test.ts`'s/
 * `cloudflare.test.ts`'s own `global.fetch` swap) — no HTTP, no network, no
 * env beyond the three OAuth vars this file sets/clears itself.
 *
 * No PKCE fields anywhere (see `vercel.ts`'s own doc-comment, "PKCE — NOT
 * USED") — unlike `cloudflare.test.ts`/`railway.test.ts`, no test here needs
 * a `codeChallenge`/`codeVerifier` fixture.
 */

const CLIENT_ID_KEY = "VERCEL_OAUTH_CLIENT_ID";
const CLIENT_SECRET_KEY = "VERCEL_OAUTH_CLIENT_SECRET";
const SLUG_KEY = "VERCEL_OAUTH_INTEGRATION_SLUG";
const CLIENT_ID = "test-client-id";
const CLIENT_SECRET = "test-client-secret";
const SLUG = "test-agentrail-integration";

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

/** A well-formed token response — access_token + team_id, the shape this
 * adapter's own doc-comment discloses as NOT confirmed via a worked JSON
 * example (unlike Railway's), but the prose-confirmed field names. */
function tokenResponse(overrides: Record<string, unknown> = {}) {
  const body: Record<string, unknown> = {
    access_token: "acc-1",
    team_id: "team-abc",
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

function exchangeInput(overrides: Partial<Parameters<typeof vercelOauthAdapter.exchange>[0]> = {}) {
  return {
    code: "auth-code-1",
    redirectUri: "https://console.example/cb",
    params: {},
    ...overrides,
  };
}

describe("vercelOauthAdapter — shape + registration", () => {
  it("declares provider 'vercel'", () => {
    expect(vercelOauthAdapter.provider).toBe("vercel");
  });

  it("self-registers into the shared oauth registry on module load", () => {
    expect(oauthAdapterFor("vercel")).toBe(vercelOauthAdapter);
  });

  it("declares stateTransport 'param' — the External installation flow round-trips state (see vercel.ts's own doc-comment, '(4) STATE TRANSPORT')", () => {
    expect(vercelOauthAdapter.stateTransport).toBe("param");
  });

  it("declares postExchange (team-id auto-fill — see vercel.ts's own doc-comment, '(5)')", () => {
    expect(vercelOauthAdapter.postExchange).toBeInstanceOf(Function);
  });

  describe("envReady (the third env var, VERCEL_OAUTH_INTEGRATION_SLUG)", () => {
    it("is true when VERCEL_OAUTH_INTEGRATION_SLUG is set", () => {
      expect(vercelOauthAdapter.envReady?.()).toBe(true);
    });

    it("is false when VERCEL_OAUTH_INTEGRATION_SLUG is unset, even with client id/secret both present", () => {
      delete process.env[SLUG_KEY];
      expect(vercelOauthAdapter.envReady?.()).toBe(false);
    });
  });

  // W3-T8 (owner-visible OAuth setup state) — the NAME of the same var
  // envReady checks the presence of, for the connectors GET route's
  // `oauthSetup.missingEnv` to report by name.
  it("declares extraEnvKeys as exactly [VERCEL_OAUTH_INTEGRATION_SLUG]", () => {
    expect(vercelOauthAdapter.extraEnvKeys?.()).toEqual(["VERCEL_OAUTH_INTEGRATION_SLUG"]);
  });
});

describe("vercelOauthAdapter — authorizeUrl", () => {
  it("builds the doc-verified, slug-keyed external-install URL (vercel.com/integrations/<slug>/new)", () => {
    const raw = vercelOauthAdapter.authorizeUrl({ state: "state-123", redirectUri: "https://console.example/cb" });
    const url = new URL(raw);
    expect(`${url.origin}${url.pathname}`).toBe(`https://vercel.com/integrations/${SLUG}/new`);
  });

  it("sets state, and ONLY state — no client_id/redirect_uri/scope param on this URL (none confirmed accepted)", () => {
    const url = new URL(
      vercelOauthAdapter.authorizeUrl({ state: "state-123", redirectUri: "https://console.example/cb" })
    );
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(Array.from(url.searchParams.keys())).toEqual(["state"]);
  });

  it("URL-encodes the slug", () => {
    process.env[SLUG_KEY] = "slug with spaces";
    const url = new URL(vercelOauthAdapter.authorizeUrl({ state: "s", redirectUri: "https://x/cb" }));
    expect(url.pathname).toContain("slug%20with%20spaces");
  });

  it("throws a clear error when VERCEL_OAUTH_CLIENT_ID/SECRET are unset (defensive — both routes already gate on oauthConfigFor before calling this)", () => {
    delete process.env[CLIENT_ID_KEY];
    delete process.env[CLIENT_SECRET_KEY];
    expect(() => vercelOauthAdapter.authorizeUrl({ state: "s", redirectUri: "https://x/cb" })).toThrow(
      /VERCEL_OAUTH_CLIENT_ID/
    );
  });

  it("throws a clear error when VERCEL_OAUTH_INTEGRATION_SLUG is unset — never silently builds a garbage /integrations/undefined/new URL", () => {
    delete process.env[SLUG_KEY];
    expect(() => vercelOauthAdapter.authorizeUrl({ state: "s", redirectUri: "https://x/cb" })).toThrow(
      /VERCEL_OAUTH_INTEGRATION_SLUG/
    );
  });
});

describe("vercelOauthAdapter — exchange", () => {
  it("POSTs to api.vercel.com/v2/oauth/access_token with form-urlencoded content-type and NO Authorization header (client_secret_post, not Basic)", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => tokenResponse());
    global.fetch = fetchMock as unknown as typeof fetch;

    await vercelOauthAdapter.exchange(exchangeInput());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.vercel.com/v2/oauth/access_token");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(headers["Authorization"]).toBeUndefined();
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("sends client_id, client_secret, code, and redirect_uri as form fields (all four confirmed required body keys)", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => tokenResponse());
    global.fetch = fetchMock as unknown as typeof fetch;

    await vercelOauthAdapter.exchange(exchangeInput());

    const [, init] = fetchMock.mock.calls[0]!;
    const body = parseFormBody(init as RequestInit);
    expect(body.get("client_id")).toBe(CLIENT_ID);
    expect(body.get("client_secret")).toBe(CLIENT_SECRET);
    expect(body.get("code")).toBe("auth-code-1");
    expect(body.get("redirect_uri")).toBe("https://console.example/cb");
  });

  it("maps a successful response to the OauthEnvelope shape: access from access_token, expiresAt the fixed far-future sentinel", async () => {
    global.fetch = vi.fn(async () => tokenResponse({ access_token: "acc-x" })) as unknown as typeof fetch;

    const envelope = await vercelOauthAdapter.exchange(exchangeInput());

    expect(envelope.access).toBe("acc-x");
    expect(envelope.expiresAt).toBe("2099-12-31T23:59:59.000Z");
  });

  describe("team_id threading (see vercel.ts's own doc-comment, '(5)')", () => {
    it("encodes the response's team_id into the envelope's refresh field", async () => {
      global.fetch = vi.fn(async () => tokenResponse({ team_id: "team-from-response" })) as unknown as typeof fetch;
      const envelope = await vercelOauthAdapter.exchange(exchangeInput());
      expect(JSON.parse(envelope.refresh)).toEqual({ teamId: "team-from-response" });
    });

    it("falls back to params.teamId (the redirect's own query param) when the response omits team_id", async () => {
      global.fetch = vi.fn(async () => tokenResponse({ team_id: undefined })) as unknown as typeof fetch;
      const envelope = await vercelOauthAdapter.exchange(
        exchangeInput({ params: { teamId: "team-from-redirect" } })
      );
      expect(JSON.parse(envelope.refresh)).toEqual({ teamId: "team-from-redirect" });
    });

    it("prefers the response's team_id over params.teamId when both are present (the token's own self-description wins)", async () => {
      global.fetch = vi.fn(async () => tokenResponse({ team_id: "team-from-response" })) as unknown as typeof fetch;
      const envelope = await vercelOauthAdapter.exchange(
        exchangeInput({ params: { teamId: "team-from-redirect" } })
      );
      expect(JSON.parse(envelope.refresh)).toEqual({ teamId: "team-from-response" });
    });

    it("encodes teamId: null (personal scope) when neither the response nor the redirect params carry a team id", async () => {
      global.fetch = vi.fn(async () => tokenResponse({ team_id: undefined })) as unknown as typeof fetch;
      const envelope = await vercelOauthAdapter.exchange(exchangeInput({ params: {} }));
      expect(JSON.parse(envelope.refresh)).toEqual({ teamId: null });
    });

    it("treats a non-string team_id in the response defensively, falling back to params.teamId", async () => {
      global.fetch = vi.fn(async () =>
        tokenResponse({ team_id: 12345 })
      ) as unknown as typeof fetch;
      const envelope = await vercelOauthAdapter.exchange(
        exchangeInput({ params: { teamId: "team-from-redirect" } })
      );
      expect(JSON.parse(envelope.refresh)).toEqual({ teamId: "team-from-redirect" });
    });
  });

  it("throws on a non-2xx response, without leaking the response body into the thrown message", async () => {
    // ZZPROBE-VC1 is an arbitrary, distinctive canary (retrieval-probe
    // hygiene, mirrors cloudflare.test.ts's ZZPROBE-CF1 precedent) — the
    // real invalid_grant/error_description field names stay, since those
    // mirror the actual response shape; only the bait VALUE is arbitrary.
    global.fetch = vi.fn(async () =>
      errorResponse(400, { error: "invalid_grant", error_description: "ZZPROBE-VC1" })
    ) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await vercelOauthAdapter.exchange(exchangeInput({ code: "bad" }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).not.toContain("ZZPROBE-VC1");
  });

  it("throws when access_token is missing from an otherwise-200 response", async () => {
    global.fetch = vi.fn(async () => tokenResponse({ access_token: undefined })) as unknown as typeof fetch;
    await expect(vercelOauthAdapter.exchange(exchangeInput())).rejects.toThrow();
  });

  it("throws when the response body isn't valid JSON", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    })) as unknown as typeof fetch;
    await expect(vercelOauthAdapter.exchange(exchangeInput())).rejects.toThrow();
  });

  it("throws a clear error when VERCEL_OAUTH_CLIENT_ID/SECRET are unset, without ever calling fetch", async () => {
    delete process.env[CLIENT_ID_KEY];
    delete process.env[CLIENT_SECRET_KEY];
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(vercelOauthAdapter.exchange(exchangeInput())).rejects.toThrow(/VERCEL_OAUTH_CLIENT_ID/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("vercelOauthAdapter — refresh (documented no-op — see vercel.ts's own doc-comment, '(3) TOKEN LIFETIME')", () => {
  it("always rejects, never calling fetch", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      vercelOauthAdapter.refresh({ access: "acc-1", refresh: JSON.stringify({ teamId: "team-1" }), expiresAt: "2099-01-01T00:00:00.000Z" })
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects with a clear, non-empty message regardless of the envelope's refresh field content", async () => {
    await expect(
      vercelOauthAdapter.refresh({ access: "acc-1", refresh: "not-even-json", expiresAt: "2099-01-01T00:00:00.000Z" })
    ).rejects.toThrow(/refresh/i);
  });

  it("degrades to unauthorized via core.ts's resolveProviderAuth (generic contract, proven by core.test.ts's own fake-adapter coverage) — this test only proves THIS adapter's own half: refresh() rejects cleanly", async () => {
    let caught: unknown;
    try {
      await vercelOauthAdapter.refresh({ access: "acc-1", refresh: "{}", expiresAt: "2099-01-01T00:00:00.000Z" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
  });
});

describe("vercelOauthAdapter — postExchange (team-id auto-fill, see vercel.ts's own doc-comment, '(5)')", () => {
  function envelopeWithTeam(teamId: string | null): Parameters<NonNullable<typeof vercelOauthAdapter.postExchange>>[0]["envelope"] {
    return { access: "acc-fresh", refresh: JSON.stringify({ teamId }), expiresAt: "2099-12-31T23:59:59.000Z" };
  }

  describe("vercelTeamId unset, grant is team-scoped", () => {
    it("returns {ok:true, configPatch:{vercelTeamId:<team id>}} — auto-fill, no network call", async () => {
      const fetchMock = vi.fn();
      global.fetch = fetchMock as unknown as typeof fetch;
      const result = await vercelOauthAdapter.postExchange!({ envelope: envelopeWithTeam("team-only"), config: {} });
      expect(result).toEqual({ ok: true, configPatch: { vercelTeamId: "team-only" } });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("treats an empty-string vercelTeamId the same as unset", async () => {
      const result = await vercelOauthAdapter.postExchange!({
        envelope: envelopeWithTeam("team-only"),
        config: { vercelTeamId: "   " },
      });
      expect(result).toEqual({ ok: true, configPatch: { vercelTeamId: "team-only" } });
    });
  });

  describe("vercelTeamId unset, grant is personal-scoped (teamId: null)", () => {
    it("returns {ok:true} with no configPatch — nothing to fill", async () => {
      const result = await vercelOauthAdapter.postExchange!({ envelope: envelopeWithTeam(null), config: {} });
      expect(result).toEqual({ ok: true });
    });
  });

  describe("vercelTeamId already configured", () => {
    it("returns {ok:true} with no configPatch, leaving the existing value untouched — even when it disagrees with the grant (see vercel.ts's own doc-comment for why this is NOT a fail-closed mismatch gate)", async () => {
      const result = await vercelOauthAdapter.postExchange!({
        envelope: envelopeWithTeam("team-new"),
        config: { vercelTeamId: "team-existing" },
      });
      expect(result).toEqual({ ok: true });
    });

    it("returns {ok:true} with no configPatch when already configured and the new grant is personal-scoped", async () => {
      const result = await vercelOauthAdapter.postExchange!({
        envelope: envelopeWithTeam(null),
        config: { vercelTeamId: "team-existing" },
      });
      expect(result).toEqual({ ok: true });
    });
  });

  it("throws (does not swallow) when the envelope's own refresh field is malformed — an internal-bug signal, not a vendor rejection", async () => {
    await expect(
      vercelOauthAdapter.postExchange!({
        envelope: { access: "acc", refresh: "not-json", expiresAt: "2099-01-01T00:00:00.000Z" },
        config: {},
      })
    ).rejects.toThrow();
  });

  it("throws when the envelope's refresh field is JSON but missing the teamId key entirely", async () => {
    await expect(
      vercelOauthAdapter.postExchange!({
        envelope: { access: "acc", refresh: "{}", expiresAt: "2099-01-01T00:00:00.000Z" },
        config: {},
      })
    ).rejects.toThrow();
  });
});
