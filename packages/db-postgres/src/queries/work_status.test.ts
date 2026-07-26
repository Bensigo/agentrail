import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// Task 5 (console "how's that going" feature, backing Task 6's read route).
// These are the workspace-scoped `runs` / `queue_entries` reads that replace
// an older tool which read every workspace's rows with no WHERE clause at
// all — every query here MUST carry the workspace predicate; there is
// deliberately no unscoped variant. Mocked db chain: same "mock the chain,
// control the terminal value" approach as runs-by-id.test.ts /
// workspace_costs.test.ts.
vi.mock("../db.js", () => ({
  db: {
    select: vi.fn(),
  },
}));

import { db } from "../db.js";
import { runs } from "../schema/runs.js";
import { queueEntries } from "../schema/queue_entries.js";
import {
  getWorkspaceRuns,
  getWorkspaceQueueEntries,
  findWorkspaceWorkByRef,
  WORKSPACE_RUNS_DEFAULT_LIMIT,
  WORKSPACE_QUEUE_ENTRIES_DEFAULT_LIMIT,
} from "./work_status.js";

const mockDb = vi.mocked(db);

/** A chainable mock: every method returns the chain except `terminalMethod`, which resolves `finalValue`. */
function makeChain(terminalMethod: string, finalValue: unknown) {
  const chain: Record<string, unknown> = {};
  const methods = ["from", "where", "orderBy", "limit"];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  chain[terminalMethod] = vi.fn(() => Promise.resolve(finalValue));
  return chain;
}

// Argument-level condition assertions (see runs-by-id.test.ts /
// workspace_costs.test.ts for the full rationale): a mock chain proves a
// method was *called*, not what it was called *with* — render both the
// actual captured `.where(...)`/`.orderBy(...)` argument and an expected one
// (built with the same drizzle operators against the real columns) to
// literal {sql, params} text via PgDialect.sqlToQuery and compare THAT.
const dialect = new PgDialect();
function renderCondition(condition: unknown) {
  return dialect.sqlToQuery(condition as Parameters<typeof dialect.sqlToQuery>[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

const NOW = new Date("2026-07-20T00:00:00Z");

const MOCK_RUN = {
  id: "run-1",
  title: "Fix login bug",
  status: "success",
  phase: null,
  branch: "main",
  agent: "claude",
  prUrl: null,
  costUsd: 1.5,
  startedAt: NOW,
  finishedAt: NOW,
  createdAt: NOW,
};

const MOCK_QUEUE_ENTRY = {
  id: "qe-1",
  externalId: "1468",
  title: "Ship the thing",
  state: "queued",
  tier: 0,
  kind: "issue",
  createdAt: NOW,
  updatedAt: NOW,
};

describe("getWorkspaceRuns", () => {
  it("scopes to the workspace, ordered createdAt DESC, capped at the default limit", async () => {
    const selectChain = makeChain("limit", [MOCK_RUN]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await getWorkspaceRuns("ws-1");

    expect(result).toEqual([MOCK_RUN]);

    const whereArgs = (selectChain.where as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(renderCondition(whereArgs)).toEqual(
      renderCondition(eq(runs.workspaceId, "ws-1"))
    );

    const orderByArgs = (selectChain.orderBy as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(renderCondition(orderByArgs)).toEqual(
      renderCondition(desc(runs.createdAt))
    );

    const limitArgs = (selectChain.limit as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(limitArgs).toBe(WORKSPACE_RUNS_DEFAULT_LIMIT);
    expect(WORKSPACE_RUNS_DEFAULT_LIMIT).toBe(50);
  });

  it("honors an explicit limit override", async () => {
    const selectChain = makeChain("limit", []);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    await getWorkspaceRuns("ws-1", 5);

    const limitArgs = (selectChain.limit as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(limitArgs).toBe(5);
  });

  it("returns an empty array when the workspace has no runs", async () => {
    const selectChain = makeChain("limit", []);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await getWorkspaceRuns("ws-empty");

    expect(result).toEqual([]);
  });
});

describe("getWorkspaceQueueEntries", () => {
  it("scopes to the workspace, ordered updatedAt DESC, capped at the default limit", async () => {
    const selectChain = makeChain("limit", [MOCK_QUEUE_ENTRY]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await getWorkspaceQueueEntries("ws-1");

    expect(result).toEqual([MOCK_QUEUE_ENTRY]);

    const whereArgs = (selectChain.where as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(renderCondition(whereArgs)).toEqual(
      renderCondition(eq(queueEntries.workspaceId, "ws-1"))
    );

    const orderByArgs = (selectChain.orderBy as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(renderCondition(orderByArgs)).toEqual(
      renderCondition(desc(queueEntries.updatedAt))
    );

    const limitArgs = (selectChain.limit as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(limitArgs).toBe(WORKSPACE_QUEUE_ENTRIES_DEFAULT_LIMIT);
    expect(WORKSPACE_QUEUE_ENTRIES_DEFAULT_LIMIT).toBe(50);
  });

  it("honors an explicit limit override", async () => {
    const selectChain = makeChain("limit", []);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    await getWorkspaceQueueEntries("ws-1", 7);

    const limitArgs = (selectChain.limit as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(limitArgs).toBe(7);
  });

  it("returns an empty array when the workspace has no queue entries", async () => {
    const selectChain = makeChain("limit", []);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await getWorkspaceQueueEntries("ws-empty");

    expect(result).toEqual([]);
  });
});

describe("findWorkspaceWorkByRef", () => {
  it("matches a run by id, scoped to the workspace — the run branch's WHERE is AND(workspaceId, id)", async () => {
    const uuidRef = "123e4567-e89b-12d3-a456-426614174000";
    const runChain = makeChain("limit", [MOCK_RUN]);
    const queueChain = makeChain("where", []);
    let call = 0;
    mockDb.select = vi.fn(() => {
      call += 1;
      return (call === 1 ? runChain : queueChain) as ReturnType<typeof db.select>;
    });

    const result = await findWorkspaceWorkByRef("ws-1", uuidRef);

    expect(result.runs).toEqual([MOCK_RUN]);

    const runWhereArgs = (runChain.where as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(renderCondition(runWhereArgs)).toEqual(
      renderCondition(
        and(eq(runs.workspaceId, "ws-1"), eq(runs.id, uuidRef))
      )
    );
  });

  it("matches queue entries by externalId (e.g. \"1468\"), scoped to the workspace", async () => {
    const queueChain = makeChain("where", [MOCK_QUEUE_ENTRY]);
    mockDb.select = vi.fn(() => queueChain as ReturnType<typeof db.select>);

    const result = await findWorkspaceWorkByRef("ws-1", "1468");

    // Only one db.select call for non-UUID refs
    expect(mockDb.select).toHaveBeenCalledTimes(1);
    expect(result.queueEntries).toEqual([MOCK_QUEUE_ENTRY]);

    const queueWhereArgs = (queueChain.where as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(renderCondition(queueWhereArgs)).toEqual(
      renderCondition(
        and(
          eq(queueEntries.workspaceId, "ws-1"),
          eq(queueEntries.externalId, "1468")
        )
      )
    );
  });

  // The cross-tenant assertion: a ref belonging to ANOTHER workspace must
  // return empty, indistinguishable from a ref that does not exist at all —
  // this function must never leak existence across tenants. Proven here by
  // pinning that the WHERE clause ALWAYS conjuncts the caller's workspaceId
  // with the ref match on every query that DOES run — a real database scoped
  // this way returns zero rows for a foreign-workspace ref regardless of
  // whether the underlying row exists in some other tenant.
  it("never leaks existence across tenants: every query that runs has the caller's workspaceId conjuncted with the ref match", async () => {
    const uuidRef = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const runChain = makeChain("limit", []);
    const queueChain = makeChain("where", []);
    let call = 0;
    mockDb.select = vi.fn(() => {
      call += 1;
      return (call === 1 ? runChain : queueChain) as ReturnType<typeof db.select>;
    });

    const result = await findWorkspaceWorkByRef("ws-1", uuidRef);

    expect(result).toEqual({ runs: [], queueEntries: [] });

    const runWhereArgs = (runChain.where as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(renderCondition(runWhereArgs)).toEqual(
      renderCondition(
        and(eq(runs.workspaceId, "ws-1"), eq(runs.id, uuidRef))
      )
    );

    const queueWhereArgs = (queueChain.where as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(renderCondition(queueWhereArgs)).toEqual(
      renderCondition(
        and(eq(queueEntries.workspaceId, "ws-1"), eq(queueEntries.externalId, uuidRef))
      )
    );

    // Neither branch's WHERE is a bare ref-only condition — the workspace
    // scope is never dropped, which is the property that keeps existence
    // from leaking across tenants.
    expect(renderCondition(runWhereArgs)).not.toEqual(
      renderCondition(eq(runs.id, uuidRef))
    );
    expect(renderCondition(queueWhereArgs)).not.toEqual(
      renderCondition(eq(queueEntries.externalId, uuidRef))
    );
  });

  it("returns { runs: [], queueEntries: [] } when nothing matches — for non-UUID refs, only queue query runs", async () => {
    const queueChain = makeChain("where", []);
    mockDb.select = vi.fn(() => queueChain as ReturnType<typeof db.select>);

    const result = await findWorkspaceWorkByRef("ws-1", "unknown-ref");

    // Only one select call for non-UUID ref
    expect(mockDb.select).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ runs: [], queueEntries: [] });
  });

  it("does NOT issue a run-by-id query for non-UUID refs (e.g. issue numbers) — only queue-entry query", async () => {
    const queueChain = makeChain("where", [MOCK_QUEUE_ENTRY]);
    mockDb.select = vi.fn(() => queueChain as ReturnType<typeof db.select>);

    const result = await findWorkspaceWorkByRef("ws-1", "1468");

    // Only one select call for the queue-entry branch
    expect(mockDb.select).toHaveBeenCalledTimes(1);

    expect(result.runs).toEqual([]);
    expect(result.queueEntries).toEqual([MOCK_QUEUE_ENTRY]);

    const queueWhereArgs = (queueChain.where as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(renderCondition(queueWhereArgs)).toEqual(
      renderCondition(
        and(
          eq(queueEntries.workspaceId, "ws-1"),
          eq(queueEntries.externalId, "1468")
        )
      )
    );
  });

  it("DOES issue both queries for UUID-shaped refs, both carrying the workspace predicate", async () => {
    const runChain = makeChain("limit", [MOCK_RUN]);
    const queueChain = makeChain("where", []);
    let call = 0;
    mockDb.select = vi.fn(() => {
      call += 1;
      return (call === 1 ? runChain : queueChain) as ReturnType<typeof db.select>;
    });

    const uuidRef = "123e4567-e89b-12d3-a456-426614174000";
    const result = await findWorkspaceWorkByRef("ws-1", uuidRef);

    // Both select calls issued
    expect(mockDb.select).toHaveBeenCalledTimes(2);

    expect(result.runs).toEqual([MOCK_RUN]);
    expect(result.queueEntries).toEqual([]);

    const runWhereArgs = (runChain.where as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(renderCondition(runWhereArgs)).toEqual(
      renderCondition(
        and(eq(runs.workspaceId, "ws-1"), eq(runs.id, uuidRef))
      )
    );

    const queueWhereArgs = (queueChain.where as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(renderCondition(queueWhereArgs)).toEqual(
      renderCondition(
        and(
          eq(queueEntries.workspaceId, "ws-1"),
          eq(queueEntries.externalId, uuidRef)
        )
      )
    );
  });

  it("returns { runs: [], queueEntries: [...] } for non-UUID refs: runs is an empty array, not undefined", async () => {
    const queueChain = makeChain("where", [MOCK_QUEUE_ENTRY]);
    mockDb.select = vi.fn(() => queueChain as ReturnType<typeof db.select>);

    const result = await findWorkspaceWorkByRef("ws-1", "1468");

    // runs array is empty, not undefined
    expect(Array.isArray(result.runs)).toBe(true);
    expect(result.runs.length).toBe(0);
    expect(result.queueEntries).toEqual([MOCK_QUEUE_ENTRY]);
  });
});
