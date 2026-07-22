import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the db module before importing queries.
vi.mock("../db.js", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
  },
}));

import { db } from "../db.js";
import {
  hasRepoScope,
  getUserGithubAccount,
  persistGithubAccountTokens,
} from "../queries/index.js";

const mockDb = vi.mocked(db);

/** Chainable drizzle-like mock whose terminal `limit` resolves a value. */
function makeSelectChain(finalValue: unknown) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "from", "where"]) {
    chain[m] = vi.fn(() => chain);
  }
  chain.limit = vi.fn(() => Promise.resolve(finalValue));
  return chain;
}

/** Chainable update mock; captures the `.set()` payload and resolves on `.where()`. */
function makeUpdateChain() {
  const captured: { set?: Record<string, unknown> } = {};
  const chain: Record<string, unknown> = {};
  chain.update = vi.fn(() => chain);
  chain.set = vi.fn((payload: Record<string, unknown>) => {
    captured.set = payload;
    return chain;
  });
  chain.where = vi.fn(() => Promise.resolve(undefined));
  return { chain, captured };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── hasRepoScope — the escalation DECISION ──────────────────────────────────
describe("hasRepoScope (escalation decision)", () => {
  it("is true when the granted scope contains full repo (comma-separated)", () => {
    expect(hasRepoScope("read:user,user:email,repo")).toBe(true);
  });

  it("is true when the granted scope is space-separated", () => {
    expect(hasRepoScope("read:user user:email repo")).toBe(true);
  });

  it("is true for a bare repo scope", () => {
    expect(hasRepoScope("repo")).toBe(true);
  });

  it("is false for identity-only scope (the new default sign-in)", () => {
    expect(hasRepoScope("read:user,user:email")).toBe(false);
  });

  it("is false for public_repo — private push access needs full repo", () => {
    expect(hasRepoScope("read:user,user:email,public_repo")).toBe(false);
  });

  it("is false for null / undefined / empty scope", () => {
    expect(hasRepoScope(null)).toBe(false);
    expect(hasRepoScope(undefined)).toBe(false);
    expect(hasRepoScope("")).toBe(false);
  });

  it("does not match a substring like repo:status without full repo", () => {
    expect(hasRepoScope("read:user,repo:status,repo_deployment")).toBe(false);
  });
});

// ── getUserGithubAccount — token + scope read ───────────────────────────────
describe("getUserGithubAccount", () => {
  it("returns the stored access_token and granted scope", async () => {
    mockDb.select.mockReturnValue(
      makeSelectChain([
        { accessToken: "gho_user_token", scope: "read:user,user:email,repo" },
      ]) as never
    );

    const account = await getUserGithubAccount("user-1");

    expect(account).toEqual({
      accessToken: "gho_user_token",
      scope: "read:user,user:email,repo",
    });
    expect(hasRepoScope(account?.scope)).toBe(true);
  });

  it("returns an identity-only account whose scope fails the repo check", async () => {
    mockDb.select.mockReturnValue(
      makeSelectChain([
        { accessToken: "gho_identity", scope: "read:user,user:email" },
      ]) as never
    );

    const account = await getUserGithubAccount("user-2");

    expect(account?.accessToken).toBe("gho_identity");
    expect(hasRepoScope(account?.scope)).toBe(false);
  });

  it("returns null when the user never linked GitHub", async () => {
    mockDb.select.mockReturnValue(makeSelectChain([]) as never);
    expect(await getUserGithubAccount("user-3")).toBeNull();
  });

  it("coerces missing columns to null", async () => {
    mockDb.select.mockReturnValue(
      makeSelectChain([{ accessToken: null, scope: null }]) as never
    );
    expect(await getUserGithubAccount("user-4")).toEqual({
      accessToken: null,
      scope: null,
    });
  });
});

// ── persistGithubAccountTokens — refresh on re-auth / escalation ────────────
describe("persistGithubAccountTokens", () => {
  it("writes the refreshed access_token + scope for the provider account", async () => {
    const { chain, captured } = makeUpdateChain();
    mockDb.update.mockReturnValue(chain as never);

    await persistGithubAccountTokens({
      providerAccountId: "12345",
      access_token: "gho_escalated",
      scope: "read:user,user:email,repo",
      token_type: "bearer",
    });

    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(captured.set).toMatchObject({
      access_token: "gho_escalated",
      scope: "read:user,user:email,repo",
      token_type: "bearer",
    });
  });
});
