import { beforeEach, describe, expect, it, vi } from "vitest";

// Mirrors railway.test.ts's mocking idiom (mock the package's named exports
// directly) — resolveProviderAuth's only I/O is through these three.
vi.mock("@agentrail/db-postgres", () => ({
  getConnectorSecret: vi.fn(),
  setConnectorSecret: vi.fn(),
  parseSecretEnvelope: vi.fn(),
  serializeOauthEnvelope: vi.fn(),
}));

import {
  getConnectorSecret,
  setConnectorSecret,
  parseSecretEnvelope,
  serializeOauthEnvelope,
} from "@agentrail/db-postgres";
import { resolveProviderAuth } from "./core";
import { registerOauthAdapter, type OauthEnvelope, type OauthProviderAdapter } from "./types";

const mockGetConnectorSecret = vi.mocked(getConnectorSecret);
const mockSetConnectorSecret = vi.mocked(setConnectorSecret);
const mockParseSecretEnvelope = vi.mocked(parseSecretEnvelope);
const mockSerializeOauthEnvelope = vi.mocked(serializeOauthEnvelope);

const WS = "00000000-0000-0000-0000-000000000001";

/** A deferred promise — lets a test control exactly when `refresh` resolves,
 * so it can assert BOTH concurrent callers are still in flight before either
 * resolves (the single-flight proof). */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function farFutureEnvelope(): OauthEnvelope {
  return { access: "acc-fresh", refresh: "ref-1", expiresAt: "2099-01-01T00:00:00.000Z" };
}

function expiringEnvelope(): OauthEnvelope {
  // Within the pinned 2-minute skew (30s from "now" at call time — mocked
  // Date isn't needed since this is always in the past/near-future relative
  // to whenever the test runs, well inside 2026+).
  return { access: "acc-stale", refresh: "ref-1", expiresAt: new Date(Date.now() + 30_000).toISOString() };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveProviderAuth — no stored credential", () => {
  it("returns config_missing when nothing is stored", async () => {
    mockGetConnectorSecret.mockResolvedValue(null);
    const res = await resolveProviderAuth(WS, "railway");
    expect(res).toEqual({ ok: false, reason: "config_missing" });
    expect(mockParseSecretEnvelope).not.toHaveBeenCalled();
  });

  it("never throws when getConnectorSecret itself throws (e.g. a tampered ciphertext) — degrades to unauthorized", async () => {
    mockGetConnectorSecret.mockRejectedValue(new Error("Malformed encrypted secret"));
    await expect(resolveProviderAuth(WS, "railway")).resolves.toEqual({
      ok: false,
      reason: "unauthorized",
    });
  });
});

describe("resolveProviderAuth — legacy token (kind:'token')", () => {
  it("returns the raw token verbatim, never calling any oauth adapter or persisting anything", async () => {
    mockGetConnectorSecret.mockResolvedValue("lin_api_abcdef");
    mockParseSecretEnvelope.mockReturnValue({ kind: "token", value: "lin_api_abcdef" });
    const res = await resolveProviderAuth(WS, "linear");
    expect(res).toEqual({ ok: true, secret: "lin_api_abcdef" });
    expect(mockSetConnectorSecret).not.toHaveBeenCalled();
  });
});

describe("resolveProviderAuth — oauth envelope, not within the refresh skew", () => {
  it("returns the current access token unchanged, no refresh performed", async () => {
    const envelope = farFutureEnvelope();
    mockGetConnectorSecret.mockResolvedValue("enc-plaintext");
    mockParseSecretEnvelope.mockReturnValue({ kind: "oauth", credential: envelope });

    const adapter: OauthProviderAdapter = {
      provider: "not-within-skew-provider",
      authorizeUrl: () => "url",
      exchange: async () => envelope,
      refresh: vi.fn(async () => envelope),
    };
    registerOauthAdapter(adapter);

    const res = await resolveProviderAuth(WS, "not-within-skew-provider");
    expect(res).toEqual({ ok: true, secret: "acc-fresh" });
    expect(adapter.refresh).not.toHaveBeenCalled();
    expect(mockSetConnectorSecret).not.toHaveBeenCalled();
  });
});

describe("resolveProviderAuth — oauth envelope within the refresh skew", () => {
  it("refreshes via the registered adapter, persists the rotated envelope, and returns the new access token", async () => {
    const stale = expiringEnvelope();
    const rotated: OauthEnvelope = { access: "acc-rotated", refresh: "ref-2", expiresAt: "2099-01-01T00:00:00.000Z" };
    mockGetConnectorSecret.mockResolvedValue("enc-plaintext");
    mockParseSecretEnvelope.mockReturnValue({ kind: "oauth", credential: stale });
    mockSerializeOauthEnvelope.mockReturnValue("serialized-rotated");
    mockSetConnectorSecret.mockResolvedValue({
      provider: "refresh-me-provider" as never,
      enabled: true,
      config: { repos: [], triggerLabel: "x", pollIntervalSeconds: 60 },
      hasSecret: true,
      updatedAt: null,
    });

    const refreshFn = vi.fn(async () => rotated);
    registerOauthAdapter({
      provider: "refresh-me-provider",
      authorizeUrl: () => "url",
      exchange: async () => rotated,
      refresh: refreshFn,
    });

    const res = await resolveProviderAuth(WS, "refresh-me-provider");
    expect(res).toEqual({ ok: true, secret: "acc-rotated" });
    expect(refreshFn).toHaveBeenCalledTimes(1);
    expect(refreshFn).toHaveBeenCalledWith(stale);
    expect(mockSerializeOauthEnvelope).toHaveBeenCalledWith(rotated);
    expect(mockSetConnectorSecret).toHaveBeenCalledWith(WS, "refresh-me-provider", "serialized-rotated");
  });

  it("degrades to unauthorized (never throws) when the adapter's refresh() rejects", async () => {
    const stale = expiringEnvelope();
    mockGetConnectorSecret.mockResolvedValue("enc-plaintext");
    mockParseSecretEnvelope.mockReturnValue({ kind: "oauth", credential: stale });
    registerOauthAdapter({
      provider: "refresh-fails-provider",
      authorizeUrl: () => "url",
      exchange: async () => stale,
      refresh: vi.fn(async () => {
        throw new Error("vendor rejected the refresh token");
      }),
    });

    await expect(resolveProviderAuth(WS, "refresh-fails-provider")).resolves.toEqual({
      ok: false,
      reason: "unauthorized",
    });
    expect(mockSetConnectorSecret).not.toHaveBeenCalled();
  });

  it("degrades to unauthorized when no oauth adapter is registered for the provider", async () => {
    const stale = expiringEnvelope();
    mockGetConnectorSecret.mockResolvedValue("enc-plaintext");
    mockParseSecretEnvelope.mockReturnValue({ kind: "oauth", credential: stale });
    // Deliberately never registered: "totally-unknown-oauth-provider".
    await expect(resolveProviderAuth(WS, "totally-unknown-oauth-provider")).resolves.toEqual({
      ok: false,
      reason: "unauthorized",
    });
  });

  it("treats an unparseable expiresAt as needing refresh (fails toward refreshing, never trusts garbage)", async () => {
    const garbage: OauthEnvelope = { access: "a", refresh: "r", expiresAt: "not-a-date" };
    const rotated: OauthEnvelope = { access: "acc-rotated", refresh: "r2", expiresAt: "2099-01-01T00:00:00.000Z" };
    mockGetConnectorSecret.mockResolvedValue("enc-plaintext");
    mockParseSecretEnvelope.mockReturnValue({ kind: "oauth", credential: garbage });
    mockSerializeOauthEnvelope.mockReturnValue("x");
    const refreshFn = vi.fn(async () => rotated);
    registerOauthAdapter({
      provider: "garbage-expiry-provider",
      authorizeUrl: () => "url",
      exchange: async () => rotated,
      refresh: refreshFn,
    });

    const res = await resolveProviderAuth(WS, "garbage-expiry-provider");
    expect(refreshFn).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ ok: true, secret: "acc-rotated" });
  });

  it("single-flight: two simultaneous resolves for the SAME (workspaceId, provider) trigger exactly ONE refresh() call", async () => {
    const stale = expiringEnvelope();
    const rotated: OauthEnvelope = { access: "acc-rotated", refresh: "r2", expiresAt: "2099-01-01T00:00:00.000Z" };
    mockGetConnectorSecret.mockResolvedValue("enc-plaintext");
    mockParseSecretEnvelope.mockReturnValue({ kind: "oauth", credential: stale });
    mockSerializeOauthEnvelope.mockReturnValue("x");
    mockSetConnectorSecret.mockResolvedValue({
      provider: "single-flight-provider" as never,
      enabled: true,
      config: { repos: [], triggerLabel: "x", pollIntervalSeconds: 60 },
      hasSecret: true,
      updatedAt: null,
    });

    const gate = deferred<OauthEnvelope>();
    let refreshCallCount = 0;
    registerOauthAdapter({
      provider: "single-flight-provider",
      authorizeUrl: () => "url",
      exchange: async () => rotated,
      refresh: async () => {
        refreshCallCount += 1;
        return gate.promise;
      },
    });

    const call1 = resolveProviderAuth(WS, "single-flight-provider");
    const call2 = resolveProviderAuth(WS, "single-flight-provider");

    // Let both calls reach the in-flight check before the refresh resolves.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(refreshCallCount).toBe(1); // the second caller joined the first's in-flight promise, not a new one

    gate.resolve(rotated);
    const [res1, res2] = await Promise.all([call1, call2]);
    expect(res1).toEqual({ ok: true, secret: "acc-rotated" });
    expect(res2).toEqual({ ok: true, secret: "acc-rotated" });
    expect(refreshCallCount).toBe(1);
    expect(mockSetConnectorSecret).toHaveBeenCalledTimes(1);
  });

  it("a refresh for a DIFFERENT provider is not coalesced with an in-flight one for the same workspace", async () => {
    const staleA = expiringEnvelope();
    const staleB = expiringEnvelope();
    const rotated: OauthEnvelope = { access: "acc-rotated", refresh: "r2", expiresAt: "2099-01-01T00:00:00.000Z" };
    mockGetConnectorSecret.mockResolvedValue("enc-plaintext");
    mockSerializeOauthEnvelope.mockReturnValue("x");
    mockSetConnectorSecret.mockResolvedValue({
      provider: "x" as never,
      enabled: true,
      config: { repos: [], triggerLabel: "x", pollIntervalSeconds: 60 },
      hasSecret: true,
      updatedAt: null,
    });
    mockParseSecretEnvelope.mockImplementation((plaintext: string) =>
      plaintext === "A" ? { kind: "oauth", credential: staleA } : { kind: "oauth", credential: staleB }
    );

    let callsA = 0;
    let callsB = 0;
    registerOauthAdapter({
      provider: "isolated-provider-a",
      authorizeUrl: () => "url",
      exchange: async () => rotated,
      refresh: async () => {
        callsA += 1;
        return rotated;
      },
    });
    registerOauthAdapter({
      provider: "isolated-provider-b",
      authorizeUrl: () => "url",
      exchange: async () => rotated,
      refresh: async () => {
        callsB += 1;
        return rotated;
      },
    });

    mockGetConnectorSecret.mockImplementation(async (_ws, provider: string) =>
      provider === "isolated-provider-a" ? "A" : "B"
    );

    await Promise.all([
      resolveProviderAuth(WS, "isolated-provider-a"),
      resolveProviderAuth(WS, "isolated-provider-b"),
    ]);
    expect(callsA).toBe(1);
    expect(callsB).toBe(1);
  });

  // -----------------------------------------------------------------------
  // W3-T1 fix round — review MINOR-1: a refresh() that never settles must
  // not wedge the (workspaceId,provider) key forever. Mirrors
  // `channel-dispatch.test.ts`'s own "aborts a hanging fetch after the
  // bounded timeout" idiom: fake timers + a promise that only resolves via
  // an external signal (here, never — it hangs until the timeout fires).
  // -----------------------------------------------------------------------
  it("a refresh() that never settles times out (~30s), degrades to unauthorized, and clears the map key for the NEXT call", async () => {
    vi.useFakeTimers();
    try {
      const stale = expiringEnvelope();
      mockGetConnectorSecret.mockResolvedValue("enc-plaintext");
      mockParseSecretEnvelope.mockReturnValue({ kind: "oauth", credential: stale });

      let refreshCalls = 0;
      registerOauthAdapter({
        provider: "hanging-refresh-provider",
        authorizeUrl: () => "url",
        exchange: async () => stale,
        refresh: () => {
          refreshCalls += 1;
          return new Promise<OauthEnvelope>(() => {}); // never settles on its own
        },
      });

      const pending = resolveProviderAuth(WS, "hanging-refresh-provider");
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await pending;

      expect(result).toEqual({ ok: false, reason: "unauthorized" });
      expect(mockSetConnectorSecret).not.toHaveBeenCalled();
      expect(refreshCalls).toBe(1);

      // The map key was cleared on timeout (not left permanently wedged) —
      // the NEXT call for the SAME (workspaceId,provider) starts a fresh
      // attempt, proven by a second refresh() invocation rather than
      // hanging on the first's already-abandoned (never-settling) promise.
      const secondPending = resolveProviderAuth(WS, "hanging-refresh-provider");
      await vi.advanceTimersByTimeAsync(30_000);
      const secondResult = await secondPending;
      expect(secondResult).toEqual({ ok: false, reason: "unauthorized" });
      expect(refreshCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a refresh() that settles WELL BEFORE the timeout is unaffected (no spurious timeout race)", async () => {
    vi.useFakeTimers();
    try {
      const stale = expiringEnvelope();
      const rotated: OauthEnvelope = { access: "acc-fast", refresh: "r2", expiresAt: "2099-01-01T00:00:00.000Z" };
      mockGetConnectorSecret.mockResolvedValue("enc-plaintext");
      mockParseSecretEnvelope.mockReturnValue({ kind: "oauth", credential: stale });
      mockSerializeOauthEnvelope.mockReturnValue("x");
      mockSetConnectorSecret.mockResolvedValue({
        provider: "fast-refresh-provider" as never,
        enabled: true,
        config: { repos: [], triggerLabel: "x", pollIntervalSeconds: 60 },
        hasSecret: true,
        updatedAt: null,
      });
      registerOauthAdapter({
        provider: "fast-refresh-provider",
        authorizeUrl: () => "url",
        exchange: async () => rotated,
        refresh: async () => rotated,
      });

      const result = await resolveProviderAuth(WS, "fast-refresh-provider");
      expect(result).toEqual({ ok: true, secret: "acc-fast" });
    } finally {
      vi.useRealTimers();
    }
  });
});
