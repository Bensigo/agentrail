import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { railwayOauthAdapter } from "./railway";
import { oauthAdapterFor } from "./types";

/**
 * OAuth Connect Wave 3, W3-T2 (+ fix round: PKCE upgrade, postExchange
 * project-grant check — `.superpowers/sdd/review-W3T2.md`). Fetch mocked at
 * the house-idiom layer (mirrors `lib/evidence/railway.test.ts`'s own
 * `global.fetch` swap) — no HTTP, no network, no env beyond the two OAuth
 * vars this file sets/clears itself.
 *
 * `authorizeUrl`/`exchange` now REQUIRE PKCE fields (throw without them —
 * see `railway.ts`'s own doc-comment) — every test below that isn't
 * SPECIFICALLY testing that throw passes `CODE_CHALLENGE`/`CODE_VERIFIER`.
 */

const CLIENT_ID_KEY = "RAILWAY_OAUTH_CLIENT_ID";
const CLIENT_SECRET_KEY = "RAILWAY_OAUTH_CLIENT_SECRET";
const CLIENT_ID = "test-client-id";
const CLIENT_SECRET = "test-client-secret";
const CODE_CHALLENGE = "test-code-challenge";
const CODE_VERIFIER = "test-code-verifier";

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

/** `exchange` with PKCE fields already filled in — the common case every
 * test that isn't specifically about the PKCE-missing throw uses. */
function exchangeInput(overrides: Partial<Parameters<typeof railwayOauthAdapter.exchange>[0]> = {}) {
  return {
    code: "auth-code-1",
    redirectUri: "https://console.example/cb",
    params: {},
    codeVerifier: CODE_VERIFIER,
    ...overrides,
  };
}

describe("railwayOauthAdapter — shape + registration", () => {
  it("declares provider 'railway'", () => {
    expect(railwayOauthAdapter.provider).toBe("railway");
  });

  it("self-registers into the shared oauth registry on module load", () => {
    expect(oauthAdapterFor("railway")).toBe(railwayOauthAdapter);
  });

  it("declares postExchange (W3-T2 fix round — optional on the interface, present on this adapter)", () => {
    expect(typeof railwayOauthAdapter.postExchange).toBe("function");
  });
});

describe("railwayOauthAdapter — authorizeUrl", () => {
  it("builds the doc-verified authorize URL (backboard.railway.com/oauth/auth — corrects the plan's provisional railway.com/oauth/authorize guess)", () => {
    const raw = railwayOauthAdapter.authorizeUrl({
      state: "state-123",
      redirectUri: "https://console.example/cb",
      codeChallenge: CODE_CHALLENGE,
    });
    const url = new URL(raw);
    expect(`${url.origin}${url.pathname}`).toBe("https://backboard.railway.com/oauth/auth");
  });

  it("sets response_type=code, client_id from env, redirect_uri, scope, state, and prompt=consent", () => {
    const url = new URL(
      railwayOauthAdapter.authorizeUrl({
        state: "state-123",
        redirectUri: "https://console.example/cb",
        codeChallenge: CODE_CHALLENGE,
      })
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe("https://console.example/cb");
    expect(url.searchParams.get("scope")).toBe("openid project:viewer offline_access");
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  it("always sends prompt=consent, unconditionally — never omitted (required to receive a refresh token at all, per the docs)", () => {
    const url1 = new URL(
      railwayOauthAdapter.authorizeUrl({ state: "s1", redirectUri: "https://x/cb", codeChallenge: CODE_CHALLENGE })
    );
    const url2 = new URL(
      railwayOauthAdapter.authorizeUrl({ state: "s2", redirectUri: "https://x/cb", codeChallenge: CODE_CHALLENGE })
    );
    expect(url1.searchParams.get("prompt")).toBe("consent");
    expect(url2.searchParams.get("prompt")).toBe("consent");
  });

  it("throws a clear error when RAILWAY_OAUTH_CLIENT_ID/SECRET are unset (defensive — both routes already gate on oauthConfigFor before calling this)", () => {
    delete process.env[CLIENT_ID_KEY];
    delete process.env[CLIENT_SECRET_KEY];
    expect(() =>
      railwayOauthAdapter.authorizeUrl({ state: "s", redirectUri: "https://x/cb", codeChallenge: CODE_CHALLENGE })
    ).toThrow(/RAILWAY_OAUTH_CLIENT_ID/);
  });

  // W3-T2 fix round (PKCE upgrade).
  describe("PKCE (W3-T2 fix round)", () => {
    it("sets code_challenge and code_challenge_method=S256 when a codeChallenge is supplied", () => {
      const url = new URL(
        railwayOauthAdapter.authorizeUrl({
          state: "s",
          redirectUri: "https://x/cb",
          codeChallenge: "my-challenge-value",
        })
      );
      expect(url.searchParams.get("code_challenge")).toBe("my-challenge-value");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    });

    it("throws a clear error when codeChallenge is missing (PKCE required, not best-effort)", () => {
      expect(() => railwayOauthAdapter.authorizeUrl({ state: "s", redirectUri: "https://x/cb" })).toThrow(
        /code_challenge/
      );
    });
  });
});

describe("railwayOauthAdapter — exchange", () => {
  it("POSTs to backboard.railway.com/oauth/token with Basic auth (base64 client_id:client_secret) and form-urlencoded content-type", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => tokenResponse());
    global.fetch = fetchMock as unknown as typeof fetch;

    await railwayOauthAdapter.exchange(exchangeInput());

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

  it("sends grant_type=authorization_code, code, redirect_uri, and code_verifier as form fields — never a client_secret body field (that rides in the Basic header only)", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => tokenResponse());
    global.fetch = fetchMock as unknown as typeof fetch;

    await railwayOauthAdapter.exchange(exchangeInput());

    const [, init] = fetchMock.mock.calls[0]!;
    const body = parseFormBody(init as RequestInit);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code-1");
    expect(body.get("redirect_uri")).toBe("https://console.example/cb");
    expect(body.get("code_verifier")).toBe(CODE_VERIFIER);
    expect(body.has("client_secret")).toBe(false);
    expect(body.has("client_id")).toBe(false);
  });

  it("ignores ExchangeInput.params entirely (Railway needs nothing beyond code/redirect_uri/code_verifier — unlike Sentry's installationId)", async () => {
    global.fetch = vi.fn(async () => tokenResponse()) as unknown as typeof fetch;
    await expect(
      railwayOauthAdapter.exchange(
        exchangeInput({ params: { iss: "https://backboard.railway.com", unexpected: "1" } })
      )
    ).resolves.toBeDefined();
  });

  it("maps a successful response to the OauthEnvelope shape, computing expiresAt from expires_in seconds", async () => {
    const before = Date.now();
    global.fetch = vi.fn(async () =>
      tokenResponse({ access_token: "acc-x", refresh_token: "ref-x", expires_in: 3600 })
    ) as unknown as typeof fetch;

    const envelope = await railwayOauthAdapter.exchange(exchangeInput());

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
      await railwayOauthAdapter.exchange(exchangeInput({ code: "bad" }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).not.toContain("SUPER-SECRET-DETAIL");
  });

  it("throws when access_token is missing from an otherwise-200 response", async () => {
    global.fetch = vi.fn(async () => tokenResponse({ access_token: undefined })) as unknown as typeof fetch;
    await expect(railwayOauthAdapter.exchange(exchangeInput())).rejects.toThrow();
  });

  it("throws when refresh_token is missing from an otherwise-200 response (never silently proceeds without one)", async () => {
    global.fetch = vi.fn(async () => tokenResponse({ refresh_token: undefined })) as unknown as typeof fetch;
    await expect(railwayOauthAdapter.exchange(exchangeInput())).rejects.toThrow();
  });

  it("throws when expires_in is missing or non-numeric", async () => {
    global.fetch = vi.fn(async () => tokenResponse({ expires_in: "not-a-number" })) as unknown as typeof fetch;
    await expect(railwayOauthAdapter.exchange(exchangeInput())).rejects.toThrow();
  });

  it("throws when the response body isn't valid JSON", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    })) as unknown as typeof fetch;
    await expect(railwayOauthAdapter.exchange(exchangeInput())).rejects.toThrow();
  });

  // W3-T2 fix round (PKCE upgrade).
  it("throws a clear error when codeVerifier is missing (PKCE required, not best-effort), without ever calling fetch", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      railwayOauthAdapter.exchange({ code: "c", redirectUri: "https://x/cb", params: {} })
    ).rejects.toThrow(/code_verifier/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("railwayOauthAdapter — refresh + rotation persistence", () => {
  it("POSTs grant_type=refresh_token with the envelope's own refresh token, Basic auth, form-urlencoded — and never sends redirect_uri/code_verifier (not part of the refresh grant)", async () => {
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
    expect(body.has("code_verifier")).toBe(false);
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

// -----------------------------------------------------------------------
// W3-T2 fix round (independent review Finding #1) — postExchange's
// project-grant check, cases (a)/(b)/(c) per the coordinator's own pinned
// behavior.
// -----------------------------------------------------------------------
describe("railwayOauthAdapter — postExchange (W3-T2 fix round, review Finding #1)", () => {
  const ENVELOPE = { access: "acc-fresh", refresh: "ref-fresh", expiresAt: "2099-01-01T00:00:00.000Z" };

  /** Mocks the externalWorkspaces GraphQL call's response shape. */
  function externalWorkspacesResponse(
    workspaces: Array<{ id: string; name: string; projects: Array<{ id: string; name: string }> }>
  ) {
    return { ok: true, status: 200, json: async () => ({ data: { externalWorkspaces: workspaces } }) };
  }

  function oneWorkspace(projects: Array<{ id: string; name: string }>) {
    return [{ id: "ws-1", name: "My Workspace", projects }];
  }

  it("queries backboard.railway.com/graphql/v2 with Authorization: Bearer <fresh access token> and the doc-confirmed externalWorkspaces query", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      externalWorkspacesResponse(oneWorkspace([{ id: "proj-a", name: "proj-a-name" }]))
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await railwayOauthAdapter.postExchange!({ envelope: ENVELOPE, config: {} });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://backboard.railway.com/graphql/v2");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer acc-fresh");
    const parsedBody = JSON.parse(String((init as RequestInit).body)) as { query: string };
    expect(parsedBody.query).toContain("externalWorkspaces");
    expect(parsedBody.query).toContain("projects");
  });

  describe("case (a): railwayProjectId configured, NOT in the granted set", () => {
    it("returns {ok:false, reason:'project_not_granted'}", async () => {
      global.fetch = vi.fn(async () =>
        externalWorkspacesResponse(oneWorkspace([{ id: "proj-granted", name: "granted" }]))
      ) as unknown as typeof fetch;

      const result = await railwayOauthAdapter.postExchange!({
        envelope: ENVELOPE,
        config: { railwayProjectId: "proj-NOT-granted" },
      });
      expect(result).toEqual({ ok: false, reason: "project_not_granted" });
    });
  });

  describe("case: railwayProjectId configured AND in the granted set", () => {
    it("returns {ok:true} with no configPatch — nothing to fix", async () => {
      global.fetch = vi.fn(async () =>
        externalWorkspacesResponse(oneWorkspace([{ id: "proj-match", name: "match" }]))
      ) as unknown as typeof fetch;

      const result = await railwayOauthAdapter.postExchange!({
        envelope: ENVELOPE,
        config: { railwayProjectId: "proj-match" },
      });
      expect(result).toEqual({ ok: true });
    });
  });

  describe("case (b): railwayProjectId unset, grant covers EXACTLY ONE project", () => {
    it("returns {ok:true, configPatch:{railwayProjectId:<the one granted id>}} — auto-fill", async () => {
      global.fetch = vi.fn(async () =>
        externalWorkspacesResponse(oneWorkspace([{ id: "proj-only", name: "only project" }]))
      ) as unknown as typeof fetch;

      const result = await railwayOauthAdapter.postExchange!({ envelope: ENVELOPE, config: {} });
      expect(result).toEqual({ ok: true, configPatch: { railwayProjectId: "proj-only" } });
    });

    it("treats an empty-string railwayProjectId the same as unset", async () => {
      global.fetch = vi.fn(async () =>
        externalWorkspacesResponse(oneWorkspace([{ id: "proj-only", name: "only project" }]))
      ) as unknown as typeof fetch;

      const result = await railwayOauthAdapter.postExchange!({
        envelope: ENVELOPE,
        config: { railwayProjectId: "   " },
      });
      expect(result).toEqual({ ok: true, configPatch: { railwayProjectId: "proj-only" } });
    });
  });

  describe("case (c): railwayProjectId unset, grant covers MULTIPLE projects", () => {
    it("returns {ok:true} with no configPatch — leaves it unset (existing not-configured handling applies: config_missing on the NEXT evidence call, same as today's legacy no-project-id flow)", async () => {
      global.fetch = vi.fn(async () =>
        externalWorkspacesResponse(
          oneWorkspace([
            { id: "proj-1", name: "one" },
            { id: "proj-2", name: "two" },
          ])
        )
      ) as unknown as typeof fetch;

      const result = await railwayOauthAdapter.postExchange!({ envelope: ENVELOPE, config: {} });
      expect(result).toEqual({ ok: true });
    });
  });

  describe("case: railwayProjectId unset, grant covers ZERO projects (generalizes case (c) — not literally in the coordinator's a/b/c but the same restraint)", () => {
    it("returns {ok:true} with no configPatch", async () => {
      global.fetch = vi.fn(async () =>
        externalWorkspacesResponse([])
      ) as unknown as typeof fetch;

      const result = await railwayOauthAdapter.postExchange!({ envelope: ENVELOPE, config: {} });
      expect(result).toEqual({ ok: true });
    });

    it("case (a) also degrades project_not_granted when the grant is empty and something IS configured", async () => {
      global.fetch = vi.fn(async () => externalWorkspacesResponse([])) as unknown as typeof fetch;
      const result = await railwayOauthAdapter.postExchange!({
        envelope: ENVELOPE,
        config: { railwayProjectId: "proj-anything" },
      });
      expect(result).toEqual({ ok: false, reason: "project_not_granted" });
    });
  });

  it("flattens projects across MULTIPLE granted workspaces, not just the first", async () => {
    global.fetch = vi.fn(async () =>
      externalWorkspacesResponse([
        { id: "ws-1", name: "Workspace A", projects: [{ id: "proj-a", name: "a" }] },
        { id: "ws-2", name: "Workspace B", projects: [{ id: "proj-b", name: "b" }] },
      ])
    ) as unknown as typeof fetch;

    const result = await railwayOauthAdapter.postExchange!({
      envelope: ENVELOPE,
      config: { railwayProjectId: "proj-b" },
    });
    expect(result).toEqual({ ok: true });
  });

  describe("fail-closed on the verification call itself", () => {
    it("throws (does not swallow) on a non-2xx externalWorkspaces response", async () => {
      global.fetch = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch;
      await expect(railwayOauthAdapter.postExchange!({ envelope: ENVELOPE, config: {} })).rejects.toThrow();
    });

    it("throws on a 200 body carrying a GraphQL errors array", async () => {
      global.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ errors: [{ message: "not authorized" }] }),
      })) as unknown as typeof fetch;
      await expect(railwayOauthAdapter.postExchange!({ envelope: ENVELOPE, config: {} })).rejects.toThrow();
    });

    it("throws on a malformed (non-JSON) response body", async () => {
      global.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("not json");
        },
      })) as unknown as typeof fetch;
      await expect(railwayOauthAdapter.postExchange!({ envelope: ENVELOPE, config: {} })).rejects.toThrow();
    });

    it("a thrown/aborted fetch propagates uncaught (the callback route's job to convert to exchange_failed)", async () => {
      global.fetch = (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch;
      await expect(railwayOauthAdapter.postExchange!({ envelope: ENVELOPE, config: {} })).rejects.toThrow(
        "network down"
      );
    });
  });

  it("skips a project node with a missing/non-string id defensively rather than throwing", async () => {
    global.fetch = vi.fn(async () =>
      externalWorkspacesResponse(
        oneWorkspace([{ id: undefined as unknown as string, name: "bad" }, { id: "proj-good", name: "good" }])
      )
    ) as unknown as typeof fetch;

    const result = await railwayOauthAdapter.postExchange!({ envelope: ENVELOPE, config: {} });
    // Exactly one VALID project survives the defensive filter -> case (b).
    expect(result).toEqual({ ok: true, configPatch: { railwayProjectId: "proj-good" } });
  });
});
