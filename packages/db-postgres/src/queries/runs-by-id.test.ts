import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// Covers getRunById — the unscoped-by-workspace read behind
// `GET /api/v1/runner/failure-bundle` under the central-secret
// (JACE_CONSOLE_TOKEN) auth model: with no per-workspace bearer to scope by,
// the route resolves its tenant from the run row's OWN workspaceId instead.
//
// Mocked db chain: same "mock the chain, control the terminal value"
// approach as jace_sessions-by-id.test.ts / jace_sessions-connect-link.test.ts.
vi.mock("../db.js", () => ({
  db: {
    select: vi.fn(),
  },
}));

import { db } from "../db.js";
import { runs } from "../schema/runs.js";
import { getRunById } from "./index.js";

const mockDb = vi.mocked(db);

/** A chainable mock: every method returns the chain except `terminalMethod`, which resolves `finalValue`. */
function makeChain(terminalMethod: string, finalValue: unknown) {
  const chain: Record<string, unknown> = {};
  const methods = ["from", "where", "limit"];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  chain[terminalMethod] = vi.fn(() => Promise.resolve(finalValue));
  return chain;
}

// Argument-level condition assertions (see jace_sessions-by-id.test.ts for the
// full rationale): a mock chain proves a method was *called*, not what it was
// called *with* — render both the actual captured `.where(...)` condition and
// an expected one (built with the same drizzle operators against the real
// `runs` columns) to literal {sql, params} text via PgDialect.sqlToQuery and
// compare THAT.
const dialect = new PgDialect();
function renderCondition(condition: unknown) {
  return dialect.sqlToQuery(condition as Parameters<typeof dialect.sqlToQuery>[0]);
}

const NOW = new Date("2026-07-20T00:00:00Z");

const MOCK_RUN = {
  id: "run-1",
  workspaceId: "workspace-other-tenant",
  repositoryId: "repo-1",
  agent: "claude",
  branch: "main",
  title: "fix bug",
  status: "failed",
  startedAt: NOW,
  finishedAt: NOW,
  createdAt: NOW,
  prUrl: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getRunById", () => {
  it("looks up by primary key id alone, with NO workspace scoping condition", async () => {
    const selectChain = makeChain("limit", [MOCK_RUN]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await getRunById("run-1");

    expect(result).toEqual(MOCK_RUN);

    const whereArgs = (selectChain.where as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    // The key behavioral property this read leans on: a bare eq(id, ...)
    // condition, no workspace scoping — the id itself is the security
    // boundary (runs.id is server-minted, uuid().defaultRandom(), never
    // caller-guessable). The CALLER is responsible for reading
    // `.workspaceId` off the returned row and using it downstream.
    expect(renderCondition(whereArgs)).toEqual(
      renderCondition(eq(runs.id, "run-1"))
    );
  });

  it("returns null when no run has this id (never leaks which workspace, if any, was searched)", async () => {
    const selectChain = makeChain("limit", []);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await getRunById("unknown-run-id");

    expect(result).toBeNull();
  });

  it("returns a run belonging to ANY workspace — this function performs no tenant filtering itself", async () => {
    const selectChain = makeChain("limit", [MOCK_RUN]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await getRunById("run-1");

    // Documents the contract explicitly: this is NOT a tenant-scoped read.
    // Safe only because the caller uses the returned workspaceId as the
    // trusted scope for every subsequent read, never a caller-supplied one.
    expect(result?.workspaceId).toBe("workspace-other-tenant");
  });
});
