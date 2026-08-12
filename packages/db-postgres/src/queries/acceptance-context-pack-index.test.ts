import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const { chain, database, rows } = vi.hoisted(() => {
  const rows = [{
    id: "pack-1",
    recordId: "record-1",
    repo: "ada/widgets",
    prNumber: 98,
    compilerVersion: "exact-head-v1",
    policyVersion: "policy-v2",
    createdAt: new Date("2026-08-10T09:00:00.000Z"),
  }];
  const chain = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.limit.mockResolvedValue(rows);
  return { chain, database: { select: vi.fn(() => chain) }, rows };
});

vi.mock("../db.js", () => ({ db: database }));

import { listAcceptanceContextPacksForWorkspace } from "./change_records.js";

const workspaceId = "00000000-0000-4000-8000-000000000001";

describe("Context Pack workspace index query", () => {
  it("rejects malformed or unbounded input before database access", async () => {
    for (const input of [
      { workspaceId: "not-a-uuid" },
      { workspaceId, limit: 0 },
      { workspaceId, limit: 201 },
      { workspaceId, limit: 1.5 },
      { workspaceId, recordId: "unexpected" },
    ]) {
      await expect(listAcceptanceContextPacksForWorkspace(input as never))
        .rejects.toThrow("Context Pack index requires only workspace and bounded limit");
    }
    expect(database.select).not.toHaveBeenCalled();
  });

  it("returns only the bounded metadata projection", async () => {
    const result = await listAcceptanceContextPacksForWorkspace({ workspaceId, limit: 7 });

    expect(result).toEqual(rows);
    expect(database.select).toHaveBeenCalledOnce();
    expect(chain.limit).toHaveBeenCalledWith(7);
  });

  it("excludes Packs whose source head is no longer authoritative", async () => {
    await listAcceptanceContextPacksForWorkspace({ workspaceId });

    const headCustodyJoin = chain.innerJoin.mock.calls[1]?.[1];
    const sql = new PgDialect().sqlToQuery(headCustodyJoin).sql.toLowerCase();

    expect(sql).toContain("current_pr_head_authoritative");
    expect(sql).toContain("current_pr_head_sha");
    expect(sql).toContain("current_pr_head_cycle_id");
    expect(sql).toContain("expected_head_sha");
    expect(sql).toContain("review_job_id");
    expect(sql).toContain("repo");
    expect(sql).toContain("pr_number");
  });
});
