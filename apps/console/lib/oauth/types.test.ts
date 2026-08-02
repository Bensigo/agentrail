import { afterEach, describe, expect, it } from "vitest";
import { missingOauthEnv, oauthAdapterFor, oauthConfigFor, registerOauthAdapter } from "./types";

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

// W3-T8 (owner-visible OAuth setup state, `.superpowers/sdd/plan-oauth.md`)
// — reports the NAMES of missing env vars, mirroring `oauthReady`'s own
// two-gate derivation (generic pair + adapter's own `extraEnvKeys`) but as
// a list rather than a boolean.
describe("missingOauthEnv", () => {
  const CLIENT_ID_KEY = "RAILWAY_OAUTH_CLIENT_ID";
  const CLIENT_SECRET_KEY = "RAILWAY_OAUTH_CLIENT_SECRET";

  afterEach(() => {
    delete process.env[CLIENT_ID_KEY];
    delete process.env[CLIENT_SECRET_KEY];
  });

  it("reports both generic var names when neither is set", () => {
    expect(missingOauthEnv("railway")).toEqual([
      "RAILWAY_OAUTH_CLIENT_ID",
      "RAILWAY_OAUTH_CLIENT_SECRET",
    ]);
  });

  // The task's own literal example: 1 of 2 railway vars set → only the
  // unset one is reported. Exercises the REAL `RAILWAY_OAUTH_CLIENT_ID`/
  // `RAILWAY_OAUTH_CLIENT_SECRET` names directly — this test file never
  // imports `./railway`, so its own module-scoped registry has no
  // `railway` adapter registered either way, proving this partial-env
  // arithmetic is independent of whether an adapter happens to be loaded.
  it("reports only the missing var when the client id is set but the secret is not", () => {
    process.env[CLIENT_ID_KEY] = "id-only";
    expect(missingOauthEnv("railway")).toEqual(["RAILWAY_OAUTH_CLIENT_SECRET"]);
  });

  it("reports only the missing var when the client secret is set but the id is not", () => {
    process.env[CLIENT_SECRET_KEY] = "secret-only";
    expect(missingOauthEnv("railway")).toEqual(["RAILWAY_OAUTH_CLIENT_ID"]);
  });

  it("returns [] once both generic vars are set and no adapter declares any extraEnvKeys", () => {
    process.env[CLIENT_ID_KEY] = "id-123";
    process.env[CLIENT_SECRET_KEY] = "secret-456";
    expect(missingOauthEnv("railway")).toEqual([]);
  });

  it("treats an empty-string env value the same as unset (mirrors oauthConfigFor)", () => {
    process.env[CLIENT_ID_KEY] = "";
    process.env[CLIENT_SECRET_KEY] = "secret-456";
    expect(missingOauthEnv("railway")).toEqual(["RAILWAY_OAUTH_CLIENT_ID"]);
  });

  describe("with a registered adapter declaring extraEnvKeys", () => {
    const EXTRA_KEY_A = "MISSINGENVTEST_EXTRA_A";
    const EXTRA_KEY_B = "MISSINGENVTEST_EXTRA_B";
    const ID_KEY = "MISSINGENVTEST_OAUTH_CLIENT_ID";
    const SECRET_KEY = "MISSINGENVTEST_OAUTH_CLIENT_SECRET";

    afterEach(() => {
      delete process.env[EXTRA_KEY_A];
      delete process.env[EXTRA_KEY_B];
      delete process.env[ID_KEY];
      delete process.env[SECRET_KEY];
    });

    it("appends every extraEnvKeys name that is unset, after the generic pair", () => {
      registerOauthAdapter({
        provider: "missingenvtest",
        authorizeUrl: () => "https://vendor.example/authorize",
        exchange: async () => ({ access: "a", refresh: "r", expiresAt: "x" }),
        refresh: async (e) => e,
        extraEnvKeys: () => [EXTRA_KEY_A, EXTRA_KEY_B],
      });
      expect(missingOauthEnv("missingenvtest")).toEqual([
        ID_KEY,
        SECRET_KEY,
        EXTRA_KEY_A,
        EXTRA_KEY_B,
      ]);
    });

    it("omits an extraEnvKeys name once it is set, while the generic pair is still reported", () => {
      registerOauthAdapter({
        provider: "missingenvtest2",
        authorizeUrl: () => "https://vendor.example/authorize",
        exchange: async () => ({ access: "a", refresh: "r", expiresAt: "x" }),
        refresh: async (e) => e,
        extraEnvKeys: () => ["MISSINGENVTEST2_EXTRA_A", "MISSINGENVTEST2_EXTRA_B"],
      });
      process.env["MISSINGENVTEST2_EXTRA_A"] = "set";
      expect(missingOauthEnv("missingenvtest2")).toEqual([
        "MISSINGENVTEST2_OAUTH_CLIENT_ID",
        "MISSINGENVTEST2_OAUTH_CLIENT_SECRET",
        "MISSINGENVTEST2_EXTRA_B",
      ]);
      delete process.env["MISSINGENVTEST2_EXTRA_A"];
    });

    it("returns [] when the generic pair AND every extraEnvKeys name are all set (fully oauthReady)", () => {
      registerOauthAdapter({
        provider: "missingenvtest3",
        authorizeUrl: () => "https://vendor.example/authorize",
        exchange: async () => ({ access: "a", refresh: "r", expiresAt: "x" }),
        refresh: async (e) => e,
        extraEnvKeys: () => ["MISSINGENVTEST3_EXTRA"],
      });
      process.env["MISSINGENVTEST3_OAUTH_CLIENT_ID"] = "id";
      process.env["MISSINGENVTEST3_OAUTH_CLIENT_SECRET"] = "secret";
      process.env["MISSINGENVTEST3_EXTRA"] = "set";
      expect(missingOauthEnv("missingenvtest3")).toEqual([]);
      delete process.env["MISSINGENVTEST3_OAUTH_CLIENT_ID"];
      delete process.env["MISSINGENVTEST3_OAUTH_CLIENT_SECRET"];
      delete process.env["MISSINGENVTEST3_EXTRA"];
    });
  });

  it("an adapter that declares no extraEnvKeys at all contributes nothing beyond the generic pair (matches every provider before sentry/cloudflare)", () => {
    registerOauthAdapter({
      provider: "missingenvtest-noextra",
      authorizeUrl: () => "https://vendor.example/authorize",
      exchange: async () => ({ access: "a", refresh: "r", expiresAt: "x" }),
      refresh: async (e) => e,
    });
    expect(missingOauthEnv("missingenvtest-noextra")).toEqual([
      "MISSINGENVTEST-NOEXTRA_OAUTH_CLIENT_ID",
      "MISSINGENVTEST-NOEXTRA_OAUTH_CLIENT_SECRET",
    ]);
  });

  it("a provider with no registered adapter at all still reports the generic pair (only extraEnvKeys is adapter-dependent)", () => {
    expect(oauthAdapterFor("totally-unregistered-oauth-provider")).toBeNull();
    expect(missingOauthEnv("totally-unregistered-oauth-provider")).toEqual([
      "TOTALLY-UNREGISTERED-OAUTH-PROVIDER_OAUTH_CLIENT_ID",
      "TOTALLY-UNREGISTERED-OAUTH-PROVIDER_OAUTH_CLIENT_SECRET",
    ]);
  });
});
