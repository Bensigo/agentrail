import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the db module before importing queries.
vi.mock("../db.js", () => ({
  db: {
    select: vi.fn(),
  },
}));

import { db } from "../db.js";
import { getUserGithubAccessToken } from "../queries/index.js";

const mockDb = vi.mocked(db);

/** Build a chainable drizzle-like mock whose terminal `limit` resolves a value. */
function makeChain(finalValue: unknown) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "from", "where", "limit"]) {
    chain[m] = vi.fn(() => chain);
  }
  (chain as Record<string, unknown>).limit = vi.fn(() =>
    Promise.resolve(finalValue)
  );
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getUserGithubAccessToken", () => {
  it("returns the signed-in user's own stored GitHub OAuth access_token", async () => {
    const chain = makeChain([{ accessToken: "gho_user_token" }]);
    mockDb.select.mockReturnValue(chain as never);

    const token = await getUserGithubAccessToken("user-1");

    expect(token).toBe("gho_user_token");
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });

  it("returns null when the user has no linked GitHub account", async () => {
    const chain = makeChain([]);
    mockDb.select.mockReturnValue(chain as never);

    const token = await getUserGithubAccessToken("user-2");

    expect(token).toBeNull();
  });

  it("returns null when the stored access_token is null", async () => {
    const chain = makeChain([{ accessToken: null }]);
    mockDb.select.mockReturnValue(chain as never);

    const token = await getUserGithubAccessToken("user-3");

    expect(token).toBeNull();
  });
});
