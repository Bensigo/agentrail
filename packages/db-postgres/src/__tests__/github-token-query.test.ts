import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the db module before importing queries.
vi.mock("../db.js", () => ({
  db: {
    select: vi.fn(),
  },
}));

import { db } from "../db.js";
import { getGithubToken } from "../queries/index.js";

const mockDb = vi.mocked(db);

/** Build a chainable drizzle-like mock whose terminal `limit` resolves a value. */
function makeChain(finalValue: unknown) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "from", "innerJoin", "where", "limit"]) {
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

describe("getGithubToken", () => {
  it("returns the workspace owner's stored GitHub OAuth access_token", async () => {
    const chain = makeChain([{ accessToken: "gho_stored_token" }]);
    mockDb.select.mockReturnValue(chain as never);

    const token = await getGithubToken("ws-1");

    expect(token).toBe("gho_stored_token");
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });

  it("returns null when the owner has no linked GitHub account", async () => {
    const chain = makeChain([]);
    mockDb.select.mockReturnValue(chain as never);

    const token = await getGithubToken("ws-2");

    expect(token).toBeNull();
  });

  it("returns null when the stored access_token is null", async () => {
    const chain = makeChain([{ accessToken: null }]);
    mockDb.select.mockReturnValue(chain as never);

    const token = await getGithubToken("ws-3");

    expect(token).toBeNull();
  });
});
