import { afterEach, describe, expect, it } from "vitest";
import { oauthAdapterFor, oauthConfigFor, registerOauthAdapter } from "./types";

/**
 * OAuth Connect Wave 3, W3-T1 (`.superpowers/sdd/plan-oauth.md`). Mirrors
 * `lib/evidence/registry.test.ts`'s own `registerAdapter`/`adapterFor`
 * coverage style exactly — unique, throwaway provider slugs per test, no
 * reset needed (the registry Map is module-scoped for this test file only).
 */

describe("registerOauthAdapter / oauthAdapterFor", () => {
  it("returns null for a provider nothing ever registered", () => {
    expect(oauthAdapterFor("totally-unregistered-oauth-provider")).toBeNull();
  });

  it("finds an adapter registered for its own provider slug", async () => {
    registerOauthAdapter({
      provider: "roundtrip-oauth-provider",
      authorizeUrl: ({ state }) => `https://vendor.example/authorize?state=${state}`,
      exchange: async () => ({ access: "a", refresh: "r", expiresAt: "2026-08-01T00:00:00.000Z" }),
      refresh: async (envelope) => envelope,
    });
    const adapter = oauthAdapterFor("roundtrip-oauth-provider");
    expect(adapter).not.toBeNull();
    expect(adapter!.authorizeUrl({ state: "s1", redirectUri: "https://x/cb" })).toBe(
      "https://vendor.example/authorize?state=s1"
    );
  });

  it("re-registering the same provider slug replaces the adapter (last write wins)", () => {
    registerOauthAdapter({
      provider: "dup-oauth-provider",
      authorizeUrl: () => "v1",
      exchange: async () => ({ access: "a", refresh: "r", expiresAt: "x" }),
      refresh: async (e) => e,
    });
    registerOauthAdapter({
      provider: "dup-oauth-provider",
      authorizeUrl: () => "v2",
      exchange: async () => ({ access: "a", refresh: "r", expiresAt: "x" }),
      refresh: async (e) => e,
    });
    expect(oauthAdapterFor("dup-oauth-provider")!.authorizeUrl({ state: "s", redirectUri: "u" })).toBe("v2");
  });
});

describe("oauthConfigFor", () => {
  const CLIENT_ID_KEY = "TESTPROV_OAUTH_CLIENT_ID";
  const CLIENT_SECRET_KEY = "TESTPROV_OAUTH_CLIENT_SECRET";

  afterEach(() => {
    delete process.env[CLIENT_ID_KEY];
    delete process.env[CLIENT_SECRET_KEY];
  });

  it("returns null when both env vars are unset", () => {
    expect(oauthConfigFor("testprov")).toBeNull();
  });

  it("returns null when only the client id is set", () => {
    process.env[CLIENT_ID_KEY] = "id-only";
    expect(oauthConfigFor("testprov")).toBeNull();
  });

  it("returns null when only the client secret is set", () => {
    process.env[CLIENT_SECRET_KEY] = "secret-only";
    expect(oauthConfigFor("testprov")).toBeNull();
  });

  it("returns {clientId, clientSecret} when both are set, reading <PROVIDER>_OAUTH_CLIENT_ID/_SECRET uppercased", () => {
    process.env[CLIENT_ID_KEY] = "id-123";
    process.env[CLIENT_SECRET_KEY] = "secret-456";
    expect(oauthConfigFor("testprov")).toEqual({ clientId: "id-123", clientSecret: "secret-456" });
  });

  it("treats an empty-string env value the same as unset", () => {
    process.env[CLIENT_ID_KEY] = "";
    process.env[CLIENT_SECRET_KEY] = "secret-456";
    expect(oauthConfigFor("testprov")).toBeNull();
  });
});
