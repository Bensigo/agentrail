import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { oauthAdapterFor } from "../oauth/types";
import {
  mcpCodeChallengeFor,
  mcpOauthConfigFor,
  missingMcpOauthEnv,
  registerMcpOauthAdapters,
} from "./mcp-oauth";

const originalFetch = global.fetch;

function setProviderEnv(provider: string) {
  const key = provider.toUpperCase();
  process.env[`JACE_MCP_${key}_OAUTH_CLIENT_ID`] = `${provider}-client-id`;
  process.env[`JACE_MCP_${key}_OAUTH_CLIENT_SECRET`] = `${provider}-client-secret`;
  process.env[`JACE_MCP_${key}_OAUTH_AUTHORIZE_URL`] = `https://${provider}.example.com/oauth/authorize`;
  process.env[`JACE_MCP_${key}_OAUTH_TOKEN_URL`] = `https://${provider}.example.com/oauth/token`;
}

function clearProviderEnv(provider: string) {
  const key = provider.toUpperCase();
  delete process.env[`JACE_MCP_${key}_OAUTH_CLIENT_ID`];
  delete process.env[`JACE_MCP_${key}_OAUTH_CLIENT_SECRET`];
  delete process.env[`JACE_MCP_${key}_OAUTH_AUTHORIZE_URL`];
  delete process.env[`JACE_MCP_${key}_OAUTH_TOKEN_URL`];
}

function parseFormBody(init: RequestInit | undefined): URLSearchParams {
  return new URLSearchParams(String(init?.body ?? ""));
}

function tokenResponse(overrides: Record<string, unknown> = {}) {
  const body: Record<string, unknown> = {
    access_token: "acc-1",
    refresh_token: "ref-1",
    expires_in: 3600,
    ...overrides,
  };
  for (const key of Object.keys(body)) {
    if (body[key] === undefined) delete body[key];
  }
  return { ok: true, status: 200, json: async () => body };
}

beforeEach(() => {
  setProviderEnv("linear");
  setProviderEnv("figma");
  setProviderEnv("context7");
  setProviderEnv("datadog");
  setProviderEnv("grafana");
  registerMcpOauthAdapters();
});

afterEach(() => {
  clearProviderEnv("linear");
  clearProviderEnv("figma");
  clearProviderEnv("context7");
  clearProviderEnv("datadog");
  clearProviderEnv("grafana");
  global.fetch = originalFetch;
});

describe("mcpOauthConfigFor / missingMcpOauthEnv", () => {
  it("reads the four JACE_MCP_<PROVIDER>_OAUTH_* env vars for a remote MCP provider", () => {
    expect(mcpOauthConfigFor("linear")).toEqual({
      clientId: "linear-client-id",
      clientSecret: "linear-client-secret",
      authorizeUrl: "https://linear.example.com/oauth/authorize",
      tokenUrl: "https://linear.example.com/oauth/token",
    });
  });

  it("returns null and reports the missing env names when any required value is absent", () => {
    delete process.env.JACE_MCP_LINEAR_OAUTH_TOKEN_URL;
    delete process.env.JACE_MCP_LINEAR_OAUTH_CLIENT_SECRET;
    expect(mcpOauthConfigFor("linear")).toBeNull();
    expect(missingMcpOauthEnv("linear")).toEqual([
      "JACE_MCP_LINEAR_OAUTH_CLIENT_SECRET",
      "JACE_MCP_LINEAR_OAUTH_TOKEN_URL",
    ]);
  });

  it("rejects a provider that is not registered as remote-mcp-oauth", () => {
    expect(() => mcpOauthConfigFor("github")).toThrow(/not a remote-mcp-oauth/);
    expect(() => missingMcpOauthEnv("github")).toThrow(/not a remote-mcp-oauth/);
  });
});

describe("registerMcpOauthAdapters", () => {
  it("registers adapters for the remote-mcp-oauth connector definitions", () => {
    for (const provider of ["linear", "figma", "context7", "datadog", "grafana"]) {
      expect(oauthAdapterFor(provider)).not.toBeNull();
    }
  });

  it("is idempotent", () => {
    const first = oauthAdapterFor("linear");
    registerMcpOauthAdapters();
    expect(oauthAdapterFor("linear")).toBe(first);
  });
});

describe("remote MCP OAuth adapter", () => {
  it("builds a PKCE authorize URL with state, redirect_uri, client_id, response_type, code_challenge, and S256", () => {
    const adapter = oauthAdapterFor("linear");
    expect(adapter).not.toBeNull();
    const verifier = "test-code-verifier";
    const url = new URL(
      adapter!.authorizeUrl({
        state: "state-123",
        redirectUri: "https://console.example/callback",
        codeChallenge: mcpCodeChallengeFor(verifier),
      })
    );
    expect(`${url.origin}${url.pathname}`).toBe("https://linear.example.com/oauth/authorize");
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("redirect_uri")).toBe("https://console.example/callback");
    expect(url.searchParams.get("client_id")).toBe("linear-client-id");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge")).toBe(mcpCodeChallengeFor(verifier));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("POSTs form-urlencoded exchange and maps access_token/refresh_token/expires_in into the envelope", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => tokenResponse());
    global.fetch = fetchMock as unknown as typeof fetch;
    const adapter = oauthAdapterFor("linear")!;

    const envelope = await adapter.exchange({
      code: "auth-code-1",
      redirectUri: "https://console.example/callback",
      params: {},
      codeVerifier: "test-code-verifier",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://linear.example.com/oauth/token");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      "Content-Type": "application/x-www-form-urlencoded",
    });
    const body = parseFormBody(init);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code-1");
    expect(body.get("redirect_uri")).toBe("https://console.example/callback");
    expect(body.get("client_id")).toBe("linear-client-id");
    expect(body.get("client_secret")).toBe("linear-client-secret");
    expect(body.get("code_verifier")).toBe("test-code-verifier");
    expect(envelope.access).toBe("acc-1");
    expect(envelope.refresh).toBe("ref-1");
    expect(new Date(envelope.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("refreshes with form-urlencoded POST and accepts expires_at when present", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      tokenResponse({
        access_token: "acc-2",
        refresh_token: "ref-2",
        expires_in: undefined,
        expires_at: "2026-08-03T12:00:00.000Z",
      })
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const adapter = oauthAdapterFor("linear")!;

    const envelope = await adapter.refresh({
      access: "old-access",
      refresh: "old-refresh",
      expiresAt: "2026-08-03T10:00:00.000Z",
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = parseFormBody(init);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("old-refresh");
    expect(envelope).toEqual({
      access: "acc-2",
      refresh: "ref-2",
      expiresAt: "2026-08-03T12:00:00.000Z",
    });
  });

  it("fails closed on malformed token responses", async () => {
    global.fetch = vi.fn(async () => tokenResponse({ refresh_token: undefined })) as unknown as typeof fetch;
    const adapter = oauthAdapterFor("linear")!;

    await expect(
      adapter.exchange({
        code: "auth-code-1",
        redirectUri: "https://console.example/callback",
        params: {},
        codeVerifier: "test-code-verifier",
      })
    ).rejects.toThrow(/Malformed OAuth token response/);
  });

  it("fails on non-2xx token responses without leaking token body details", async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: "invalid_grant", refresh_token: "should-not-leak" }),
    })) as unknown as typeof fetch;
    const adapter = oauthAdapterFor("linear")!;

    await expect(
      adapter.exchange({
        code: "auth-code-1",
        redirectUri: "https://console.example/callback",
        params: {},
        codeVerifier: "test-code-verifier",
      })
    ).rejects.toThrow(/^OAuth token exchange failed with status 400$/);
  });
});
