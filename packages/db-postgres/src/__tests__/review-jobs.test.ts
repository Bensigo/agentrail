import { describe, it, expect, vi } from "vitest";

/**
 * Unit coverage for Arc B §2-§3's review-job query layer — the slice provable
 * WITHOUT a live Postgres: `reviewJobId`'s pure determinism, and the JS-side
 * branch logic in `getWorkspaceByGithubInstallationId` /
 * `bindReviewJobSession` that a mocked `db` can exercise honestly (row
 * present vs. absent -> what the function returns/throws). Everything whose
 * correctness actually LIVES in the SQL itself (the supersede's EvalPlanQual
 * guard, the SKIP LOCKED claim, the budget count, the fixed-backoff complete,
 * the real jace_sessions insert/re-bind) is proven against a real Postgres in
 * `review-jobs.integration.test.ts` instead — a mock that just returns canned
 * rows regardless of the WHERE clause cannot tell a correct claim query from
 * a broken one, so asserting against one there would be a hollow test.
 */

vi.mock("../db.js", () => ({
  db: { select: vi.fn() },
}));

import { db } from "../db.js";
import { reviewJobId, bindReviewJobSession } from "../queries/review_jobs.js";
import { getWorkspaceByGithubInstallationId } from "../queries/github-app-token.js";

const mockDb = vi.mocked(db);

// Mirrors github-app-token.test.ts's own selectChain helper (any chain method
// returns the chain itself; `.limit` resolves the canned rows).
function selectChain(finalValue: unknown) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "from", "where", "limit"]) {
    chain[m] = vi.fn(() => chain);
  }
  chain.limit = vi.fn(() => Promise.resolve(finalValue));
  return chain;
}

const BASE = { workspaceId: "ws-1", repo: "acme/widgets", prNumber: 42, headSha: "a".repeat(40) };

describe("reviewJobId (pure, deterministic uuid5)", () => {
  it("is stable: the same (workspaceId, repo, prNumber, headSha) always maps to the same id", () => {
    expect(reviewJobId(BASE)).toBe(reviewJobId({ ...BASE }));
  });

  it("is a valid RFC 4122 v5 uuid (version nibble '5', variant nibble in 8-b)", () => {
    const id = reviewJobId(BASE);
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it("changes when workspaceId differs, all else equal", () => {
    expect(reviewJobId(BASE)).not.toBe(reviewJobId({ ...BASE, workspaceId: "ws-2" }));
  });

  it("changes when repo differs, all else equal", () => {
    expect(reviewJobId(BASE)).not.toBe(reviewJobId({ ...BASE, repo: "acme/other" }));
  });

  it("changes when prNumber differs, all else equal", () => {
    expect(reviewJobId(BASE)).not.toBe(reviewJobId({ ...BASE, prNumber: 43 }));
  });

  it("changes when headSha differs, all else equal — this is what makes each push its own row", () => {
    expect(reviewJobId(BASE)).not.toBe(reviewJobId({ ...BASE, headSha: "b".repeat(40) }));
  });
});

describe("getWorkspaceByGithubInstallationId", () => {
  it("returns { workspaceId } when a workspace has this installation bound", async () => {
    mockDb.select.mockReturnValue(selectChain([{ workspaceId: "ws-42" }]) as never);
    expect(await getWorkspaceByGithubInstallationId(987654321)).toEqual({
      workspaceId: "ws-42",
    });
  });

  it("returns null when no workspace has this installation bound", async () => {
    mockDb.select.mockReturnValue(selectChain([]) as never);
    expect(await getWorkspaceByGithubInstallationId(111)).toBeNull();
  });
});

describe("bindReviewJobSession — not-found contract", () => {
  it("throws (never silently no-ops) when jobId names no review_jobs row — void has no null escape hatch", async () => {
    mockDb.select.mockReturnValue(selectChain([]) as never);
    await expect(
      bindReviewJobSession({ jobId: "missing-job", eveSessionId: "sess-1" })
    ).rejects.toThrow(/missing-job/);
  });
});
