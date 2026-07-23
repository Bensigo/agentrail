import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the db module before importing queries. `ensureFreshGithubToken` reads
// the owner's account via `db.select(...)` and persists a rotated token via
// `persistGithubAccountTokens` → `db.update(...)`, so both chains are mocked.
vi.mock("../db.js", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
  },
}));

import { db } from "../db.js";
import {
  ensureFreshGithubToken,
  EXECUTION_CEILING_SECONDS,
  type FetchLike,
} from "../queries/index.js";

const mockDb = vi.mocked(db);

/** Chainable drizzle-like SELECT mock whose terminal `limit` resolves rows. */
function selectChain(rows: unknown) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "from", "innerJoin", "where"]) {
    chain[m] = vi.fn(() => chain);
  }
  chain.limit = vi.fn(() => Promise.resolve(rows));
  return chain;
}

/** Chainable UPDATE mock (persistGithubAccountTokens): update→set→where. */
function updateChain() {
  const where = vi.fn(() => Promise.resolve(undefined));
  const set = vi.fn(() => ({ where }));
  return { chain: { set }, where, set };
}

const NOW_MS = 1_700_000_000_000; // fixed clock
const NOW_S = Math.floor(NOW_MS / 1000);

const OWNER_ROW = {
  providerAccountId: "gh-user-1",
  accessToken: "gho_stored",
  refreshToken: "ghr_stored",
  expiresAt: NOW_S + 7200, // 2h left — ample by default
  scope: "read:user user:email repo",
  tokenType: "bearer",
};

/** A fetch double that returns a scripted JSON payload and counts its calls
 * on a live, mutable `box` (read `box.calls` AFTER awaiting the helper). */
function fakeFetch(
  payload: unknown,
  { ok = true, status = 200 }: { ok?: boolean; status?: number } = {}
): { fn: FetchLike; box: { calls: number } } {
  const box = { calls: 0 };
  const fn: FetchLike = async () => {
    box.calls += 1;
    return { ok, status, json: async () => payload };
  };
  return { fn, box };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env["GITHUB_CLIENT_ID"] = "cid";
  process.env["GITHUB_CLIENT_SECRET"] = "csecret";
  mockDb.update.mockImplementation(() => updateChain().chain as never);
});

afterEach(() => {
  delete process.env["GITHUB_CLIENT_ID"];
  delete process.env["GITHUB_CLIENT_SECRET"];
});

describe("ensureFreshGithubToken", () => {
  it("EXECUTION_CEILING_SECONDS matches the host runner's 1h wall-clock ceiling", () => {
    expect(EXECUTION_CEILING_SECONDS).toBe(3600);
  });

  it("no-op when the token has ample TTL — no GitHub round-trip, current token handed out", async () => {
    mockDb.select.mockReturnValue(selectChain([OWNER_ROW]) as never);
    const { fn, box } = fakeFetch({});

    const res = await ensureFreshGithubToken("ws-1", {
      now: NOW_MS,
      fetchImpl: fn,
    });

    expect(res.outcome).toBe("no-op");
    expect(res.accessToken).toBe("gho_stored");
    expect(box.calls).toBe(0); // never called GitHub
    expect(mockDb.update).not.toHaveBeenCalled(); // never persisted
  });

  it("no-op for a non-expiring token (expires_at null) — never refreshes", async () => {
    mockDb.select.mockReturnValue(
      selectChain([{ ...OWNER_ROW, expiresAt: null }]) as never
    );
    const { fn, box } = fakeFetch({});

    const res = await ensureFreshGithubToken("ws-1", { now: NOW_MS, fetchImpl: fn });

    expect(res.outcome).toBe("no-op");
    expect(res.accessToken).toBe("gho_stored");
    expect(box.calls).toBe(0);
  });

  it("AC2: refreshes when remaining TTL is below the execution ceiling, persists the rotated token, returns the fresh one", async () => {
    // 10 min left — below the 1h ceiling ⇒ a claim would otherwise hand out a
    // token that dies mid-run. Must refresh FIRST.
    mockDb.select.mockReturnValue(
      selectChain([{ ...OWNER_ROW, expiresAt: NOW_S + 600 }]) as never
    );
    const upd = updateChain();
    mockDb.update.mockReturnValue(upd.chain as never);
    const { fn, box } = fakeFetch({
      access_token: "ghu_fresh",
      refresh_token: "ghr_fresh",
      expires_in: 28800,
      token_type: "bearer",
    });

    const res = await ensureFreshGithubToken("ws-1", { now: NOW_MS, fetchImpl: fn });

    expect(res.outcome).toBe("refreshed");
    expect(res.accessToken).toBe("ghu_fresh");
    expect(box.calls).toBe(1);
    // Persisted the rotated access + refresh tokens and the new absolute expiry.
    expect(upd.set).toHaveBeenCalledTimes(1);
    const persisted = upd.set.mock.calls[0]![0] as Record<string, unknown>;
    expect(persisted.access_token).toBe("ghu_fresh");
    expect(persisted.refresh_token).toBe("ghr_fresh"); // rotation persisted
    expect(persisted.expires_at).toBe(NOW_S + 28800);
  });

  it("force refreshes regardless of TTL (mid-run recovery path)", async () => {
    mockDb.select.mockReturnValue(selectChain([OWNER_ROW]) as never); // ample TTL
    const { fn, box } = fakeFetch({
      access_token: "ghu_fresh",
      refresh_token: "ghr_fresh",
      expires_in: 28800,
    });

    const res = await ensureFreshGithubToken("ws-1", {
      now: NOW_MS,
      fetchImpl: fn,
      force: true,
    });

    expect(res.outcome).toBe("refreshed");
    expect(res.accessToken).toBe("ghu_fresh");
    expect(box.calls).toBe(1);
  });

  it("refresh-failed (returns the stale token) on a bad_refresh_token response", async () => {
    mockDb.select.mockReturnValue(
      selectChain([{ ...OWNER_ROW, expiresAt: NOW_S + 600 }]) as never
    );
    // GitHub returns 200 with an `error` field on a bad refresh token.
    const { fn } = fakeFetch({
      error: "bad_refresh_token",
      error_description: "The refresh token is invalid or expired.",
    });

    const res = await ensureFreshGithubToken("ws-1", { now: NOW_MS, fetchImpl: fn });

    expect(res.outcome).toBe("refresh-failed");
    expect(res.accessToken).toBe("gho_stored"); // stale token, best-effort
    expect(mockDb.update).not.toHaveBeenCalled(); // nothing persisted
  });

  it("refresh-failed on a network/HTTP error, never throwing", async () => {
    mockDb.select.mockReturnValue(
      selectChain([{ ...OWNER_ROW, expiresAt: NOW_S + 600 }]) as never
    );
    const throwing: FetchLike = async () => {
      throw new Error("ECONNRESET");
    };

    const res = await ensureFreshGithubToken("ws-1", {
      now: NOW_MS,
      fetchImpl: throwing,
    });

    expect(res.outcome).toBe("refresh-failed");
    expect(res.accessToken).toBe("gho_stored");
  });

  it("refresh-failed when no refresh_token is stored", async () => {
    mockDb.select.mockReturnValue(
      selectChain([{ ...OWNER_ROW, expiresAt: NOW_S + 600, refreshToken: null }]) as never
    );
    const { fn, box } = fakeFetch({});

    const res = await ensureFreshGithubToken("ws-1", { now: NOW_MS, fetchImpl: fn });

    expect(res.outcome).toBe("refresh-failed");
    expect(res.accessToken).toBe("gho_stored");
    expect(box.calls).toBe(0); // never attempted a refresh without a refresh token
  });

  it("no-account when the workspace owner has no linked GitHub token", async () => {
    mockDb.select.mockReturnValue(selectChain([]) as never);

    const res = await ensureFreshGithubToken("ws-1", { now: NOW_MS });

    expect(res.outcome).toBe("no-account");
    expect(res.accessToken).toBeNull();
  });

  it("does not throw when the db read fails — degrades to no-account", async () => {
    mockDb.select.mockImplementation(() => {
      throw new Error("db down");
    });

    const res = await ensureFreshGithubToken("ws-1", { now: NOW_MS });

    expect(res.outcome).toBe("no-account");
    expect(res.accessToken).toBeNull();
  });
});
