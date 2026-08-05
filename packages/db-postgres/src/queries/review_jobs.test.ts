import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const state = vi.hoisted(() => ({
  selectRows: [] as unknown[],
  lastWhere: null as unknown,
  lastOrderBy: [] as unknown[],
}));

vi.mock("../db.js", () => {
  const db = {
    select: () => {
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn(() => chain);
      chain.where = vi.fn((condition: unknown) => {
        state.lastWhere = condition;
        return chain;
      });
      chain.orderBy = vi.fn((...args: unknown[]) => {
        state.lastOrderBy = args;
        return Promise.resolve(state.selectRows);
      });
      return chain;
    },
  };
  return { db };
});

import { reviewJobs } from "../schema/review_jobs.js";
import { listReviewJobsForPr, listReviewJobsForPrHead } from "./review_jobs.js";

const dialect = new PgDialect();
function renderCondition(condition: unknown) {
  return dialect.sqlToQuery(condition as Parameters<typeof dialect.sqlToQuery>[0]);
}

beforeEach(() => {
  state.selectRows = [];
  state.lastWhere = null;
  state.lastOrderBy = [];
  vi.clearAllMocks();
});

describe("listReviewJobsForPr", () => {
  it("filters by workspace, repo, and prNumber, oldest first", async () => {
    const rows = [
      {
        id: "job-1",
        workspaceId: "ws-1",
        repo: "ada/widgets",
        prNumber: 42,
        headSha: "a".repeat(40),
        event: "opened",
        state: "queued",
        attempts: 0,
        claimedBy: null,
        claimedAt: null,
        nextEligibleAt: null,
        postedReviewUrl: null,
        verdict: null,
        skipReason: null,
        evidenceKeys: null,
        createdAt: new Date("2026-08-01T09:00:00Z"),
        updatedAt: new Date("2026-08-01T09:00:01Z"),
      },
    ];
    state.selectRows = rows;

    await expect(
      listReviewJobsForPr({ workspaceId: "ws-1", repo: "ada/widgets", prNumber: 42 })
    ).resolves.toEqual(rows);

    expect(renderCondition(state.lastWhere)).toEqual(
      renderCondition(
        and(
          eq(reviewJobs.workspaceId, "ws-1"),
          eq(reviewJobs.repo, "ada/widgets"),
          eq(reviewJobs.prNumber, 42)
        )
      )
    );
    expect(state.lastOrderBy).toEqual([reviewJobs.createdAt]);
  });
});

describe("listReviewJobsForPrHead", () => {
  it("filters by workspace, repo, PR number, and exact head", async () => {
    await listReviewJobsForPrHead({
      workspaceId: "ws-1", repo: "ada/widgets", prNumber: 42, headSha: "head-a",
    });

    expect(renderCondition(state.lastWhere)).toEqual(
      renderCondition(and(
        eq(reviewJobs.workspaceId, "ws-1"),
        eq(reviewJobs.repo, "ada/widgets"),
        eq(reviewJobs.prNumber, 42),
        eq(reviewJobs.headSha, "head-a")
      ))
    );
  });
});
