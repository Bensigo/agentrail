import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
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
  WORKSPACE_RUNS_MAX_LIMIT,
} from "./work_status.js";

// Important 2: hardcoded INDEPENDENTLY of `work_status.ts`'s own exported
// column maps — built directly from the `runs`/`queueEntries` schema
// imports above, not by importing (and thus mirroring) the production
// object. Asserting a call was made `with(workspaceRunColumns)` (the
// production export) would be tautological: deleting a key from that export
// mutates BOTH the value passed to `db.select()` and the value the test
// compares against, since they're the same object reference — the
// assertion could never fail. These literals are the independent source of
// truth the mutation check (see task report) actually needs.
const EXPECTED_RUN_COLUMNS = {
  id: runs.id,
  title: runs.title,
  status: runs.status,
  phase: runs.phase,
  branch: runs.branch,
  agent: runs.agent,
  prUrl: runs.prUrl,
  costUsd: runs.costUsd,
  startedAt: runs.startedAt,
  finishedAt: runs.finishedAt,
  createdAt: runs.createdAt,
  repositoryId: runs.repositoryId,
  queueEntryId: runs.queueEntryId,
  updatedAt: runs.updatedAt,
  lastLivenessAt: runs.lastLivenessAt,
};

const EXPECTED_QUEUE_ENTRY_COLUMNS = {
  id: queueEntries.id,
  externalId: queueEntries.externalId,
  title: queueEntries.title,
  state: queueEntries.state,
  tier: queueEntries.tier,
  kind: queueEntries.kind,
  createdAt: queueEntries.createdAt,
  updatedAt: queueEntries.updatedAt,
  parkReason: queueEntries.parkReason,
  blockedBy: queueEntries.blockedBy,
  remainingBudget: queueEntries.remainingBudget,
  estimatedBudgetUsd: queueEntries.estimatedBudgetUsd,
};

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

/** Dispatch successive `db.select()` calls to successive chains, in order. */
function dispatchSelect(...chains: Record<string, unknown>[]) {
  let call = 0;
  mockDb.select = vi.fn(() => {
    const chain = chains[call];
    call += 1;
    return chain as ReturnType<typeof db.select>;
  });
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

/** Translate a LIKE pattern (this module only ever uses `%` as a wildcard,
 * always as a PREFIX) to a RegExp, so the Critical-1 anchoring claim can be
 * checked directly against sample strings without a real Postgres. */
function likeToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split("%")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

beforeEach(() => {
  vi.clearAllMocks();
});

const NOW = new Date("2026-07-20T00:00:00Z");
const OLDER = new Date("2026-07-10T00:00:00Z");

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
  repositoryId: "repo-1",
  queueEntryId: "qe-1",
  updatedAt: NOW,
  lastLivenessAt: null,
};

// Real production shape: `github_intake.ts::enqueueGithubIssue` writes
// `${repoFullName}#${number}` — see `${owner}/${repo}#${issueNumber}` below.
// (CRITICAL 1: a bare "1468" fixture matched ZERO real rows; re-fixtured to
// the real format.)
const MOCK_QUEUE_ENTRY = {
  id: "qe-1",
  externalId: "Bensigo/agentrail#1468",
  title: "Ship the thing",
  state: "queued",
  tier: 0,
  kind: "issue",
  createdAt: NOW,
  updatedAt: NOW,
  parkReason: null,
  blockedBy: [],
  remainingBudget: 5,
  estimatedBudgetUsd: null,
};

describe("getWorkspaceRuns", () => {
  it("scopes to the workspace, ordered createdAt DESC, over-fetches by one; truncated=false under the limit", async () => {
    const pageChain = makeChain("limit", [MOCK_RUN]);
    const inFlightChain = makeChain("limit", []);
    dispatchSelect(pageChain, inFlightChain);

    const result = await getWorkspaceRuns("ws-1");

    expect(result.rows).toEqual([MOCK_RUN]);
    expect(result.truncated).toBe(false); // 1 row came back, limit+1 was requested

    // Important 2: assert the exact column map, not just that select() ran —
    // deleting a key here (lastLivenessAt, queueEntryId, ...) must fail this.
    expect(mockDb.select).toHaveBeenNthCalledWith(1, EXPECTED_RUN_COLUMNS);

    const whereArgs = (pageChain.where as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(renderCondition(whereArgs)).toEqual(renderCondition(eq(runs.workspaceId, "ws-1")));

    const orderByArgs = (pageChain.orderBy as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(renderCondition(orderByArgs)).toEqual(renderCondition(desc(runs.createdAt)));

    // Minor 4: requests limit+1, not limit, so an exactly-full page can be
    // told apart from a truncated one.
    const limitArgs = (pageChain.limit as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(limitArgs).toBe(WORKSPACE_RUNS_DEFAULT_LIMIT + 1);
    expect(WORKSPACE_RUNS_DEFAULT_LIMIT).toBe(50);

    // Important 4: the in-flight union query is workspace-scoped AND
    // filtered to queued/running.
    const inFlightWhereArgs = (inFlightChain.where as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(renderCondition(inFlightWhereArgs)).toEqual(
      renderCondition(
        and(eq(runs.workspaceId, "ws-1"), inArray(runs.status, ["queued", "running"]))
      )
    );

    // Minor 5: the in-flight query is capped, not unbounded.
    const inFlightLimitArgs = (inFlightChain.limit as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(inFlightLimitArgs).toBe(WORKSPACE_RUNS_MAX_LIMIT);
    expect(WORKSPACE_RUNS_MAX_LIMIT).toBe(200);
  });

  it("Minor 4: exactly `limit` rows total does NOT falsely report truncated=true", async () => {
    // limit=1 -> requests limit+1=2 rows; only 1 comes back, proving the
    // workspace has exactly 1 row and the page is NOT truncated.
    const pageChain = makeChain("limit", [MOCK_RUN]);
    const inFlightChain = makeChain("limit", []);
    dispatchSelect(pageChain, inFlightChain);

    const result = await getWorkspaceRuns("ws-1", 1);

    expect(result.rows).toEqual([MOCK_RUN]);
    expect(result.truncated).toBe(false);

    const limitArgs = (pageChain.limit as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(limitArgs).toBe(2);
  });

  it("honors an explicit limit override", async () => {
    const pageChain = makeChain("limit", []);
    const inFlightChain = makeChain("limit", []);
    dispatchSelect(pageChain, inFlightChain);

    await getWorkspaceRuns("ws-1", 5);

    const limitArgs = (pageChain.limit as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(limitArgs).toBe(6); // limit + 1
  });

  it("returns empty rows and truncated=false when the workspace has no runs", async () => {
    const pageChain = makeChain("limit", []);
    const inFlightChain = makeChain("limit", []);
    dispatchSelect(pageChain, inFlightChain);

    const result = await getWorkspaceRuns("ws-empty");

    expect(result.rows).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("Important 4: unions an in-flight run NOT present on the recency page, deduped by id, newest first; truncated reflects the over-fetch", async () => {
    const pagedRun = { ...MOCK_RUN, id: "run-recent", createdAt: NOW, status: "success" };
    // An extra row beyond `limit` (1) proves the recency page itself was
    // truncated — the over-fetch (limit+1=2) came back full.
    const extraPageRun = { ...MOCK_RUN, id: "run-extra", createdAt: OLDER, status: "success" };
    // Pushed off a 1-row page by `pagedRun`, but still running — must not
    // vanish from the result.
    const wedgedRun = { ...MOCK_RUN, id: "run-wedged", createdAt: OLDER, status: "running" };

    const pageChain = makeChain("limit", [pagedRun, extraPageRun]);
    const inFlightChain = makeChain("limit", [wedgedRun]);
    dispatchSelect(pageChain, inFlightChain);

    const result = await getWorkspaceRuns("ws-1", 1);

    // `run-extra` was beyond the page's `limit` and is not in-flight, so it
    // is sliced off before the merge.
    expect(result.rows.map((r) => r.id)).toEqual(["run-recent", "run-wedged"]);
    expect(result.truncated).toBe(true);
  });

  it("dedupes a run returned by BOTH the page and the in-flight union (same id)", async () => {
    const runningRun = { ...MOCK_RUN, id: "run-both", status: "running" };
    const pageChain = makeChain("limit", [runningRun]);
    const inFlightChain = makeChain("limit", [runningRun]);
    dispatchSelect(pageChain, inFlightChain);

    const result = await getWorkspaceRuns("ws-1");

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toEqual(runningRun);
  });
});

describe("getWorkspaceQueueEntries", () => {
  it("scopes to the workspace, ordered updatedAt DESC, over-fetches by one; truncated=false under the limit", async () => {
    const selectChain = makeChain("limit", [MOCK_QUEUE_ENTRY]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await getWorkspaceQueueEntries("ws-1");

    expect(result.rows).toEqual([MOCK_QUEUE_ENTRY]);
    expect(result.truncated).toBe(false);

    // Important 2: assert the exact column map, not just that select() ran.
    expect(mockDb.select).toHaveBeenCalledWith(EXPECTED_QUEUE_ENTRY_COLUMNS);

    const whereArgs = (selectChain.where as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(renderCondition(whereArgs)).toEqual(
      renderCondition(eq(queueEntries.workspaceId, "ws-1"))
    );

    const orderByArgs = (selectChain.orderBy as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(renderCondition(orderByArgs)).toEqual(renderCondition(desc(queueEntries.updatedAt)));

    // Minor 4: requests limit+1, not limit.
    const limitArgs = (selectChain.limit as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(limitArgs).toBe(WORKSPACE_QUEUE_ENTRIES_DEFAULT_LIMIT + 1);
    expect(WORKSPACE_QUEUE_ENTRIES_DEFAULT_LIMIT).toBe(50);
  });

  it("honors an explicit limit override", async () => {
    const selectChain = makeChain("limit", []);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    await getWorkspaceQueueEntries("ws-1", 7);

    const limitArgs = (selectChain.limit as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(limitArgs).toBe(8); // limit + 1
  });

  it("returns empty rows and truncated=false when the workspace has no queue entries", async () => {
    const selectChain = makeChain("limit", []);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await getWorkspaceQueueEntries("ws-empty");

    expect(result.rows).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("Minor 4: exactly `limit` rows total does NOT falsely report truncated=true (off-by-one fix)", async () => {
    // limit=1 -> requests limit+1=2 rows; only 1 comes back, proving the
    // workspace has exactly 1 row and the page is NOT truncated. The OLD
    // (buggy) behaviour reported truncated=true here.
    const selectChain = makeChain("limit", [MOCK_QUEUE_ENTRY]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await getWorkspaceQueueEntries("ws-1", 1);

    expect(result.rows).toHaveLength(1);
    expect(result.truncated).toBe(false);

    const limitArgs = (selectChain.limit as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(limitArgs).toBe(2);
  });

  it("truncated=true when more rows exist beyond the limit", async () => {
    const extra = { ...MOCK_QUEUE_ENTRY, id: "qe-2" };
    const selectChain = makeChain("limit", [MOCK_QUEUE_ENTRY, extra]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await getWorkspaceQueueEntries("ws-1", 1);

    // Sliced back down to `limit` (1) even though 2 rows came back.
    expect(result.rows).toEqual([MOCK_QUEUE_ENTRY]);
    expect(result.truncated).toBe(true);
  });
});

describe("findWorkspaceWorkByRef — Critical-1 anchoring proof", () => {
  it("'%#10' matches an externalId ending '#10' but NOT one ending '#101' or '#1010' — pattern taken from the real call, not hardcoded", async () => {
    // Minor 3: the previous version of this test built "%#10" from a
    // hardcoded string and never called findWorkspaceWorkByRef — it would
    // have kept passing even if the production code reverted to eq(). This
    // version calls the real function and pulls the actual LIKE parameter
    // out of the captured .where() argument, so it only passes if the
    // production code still builds that exact pattern.
    const queueChain = makeChain("where", []);
    const prRunChain = makeChain("where", []);
    dispatchSelect(queueChain, prRunChain);

    await findWorkspaceWorkByRef("ws-1", "10");

    const queueWhereArgs = (queueChain.where as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const rendered = renderCondition(queueWhereArgs);
    const likeParam = rendered.params[rendered.params.length - 1] as string;
    expect(likeParam).toBe("%#10");

    const re = likeToRegExp(likeParam);
    expect(re.test("Bensigo/agentrail#10")).toBe(true);
    expect(re.test("Bensigo/agentrail#101")).toBe(false);
    expect(re.test("Bensigo/agentrail#1010")).toBe(false);
  });
});

describe("findWorkspaceWorkByRef", () => {
  it("run-id branch: UUID-shaped ref matches runs.id, scoped to the workspace; resolvedAs='run-id'", async () => {
    const uuidRef = "123e4567-e89b-12d3-a456-426614174000";
    const runChain = makeChain("limit", [MOCK_RUN]);
    dispatchSelect(runChain);

    const result = await findWorkspaceWorkByRef("ws-1", uuidRef);

    expect(result.resolvedAs).toBe("run-id");
    expect(result.runs).toEqual([MOCK_RUN]);
    expect(result.queueEntries).toEqual([]);
    // Only the run-by-id query runs — no queue-entry, join, or pr-number query.
    expect(mockDb.select).toHaveBeenCalledTimes(1);

    const runWhereArgs = (runChain.where as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(renderCondition(runWhereArgs)).toEqual(
      renderCondition(and(eq(runs.workspaceId, "ws-1"), eq(runs.id, uuidRef)))
    );
  });

  it("CRITICAL 1 fix: bare issue number matches queue_entries.externalId by SUFFIX ('%#1468'), not equality — the real stored shape is 'owner/repo#N'", async () => {
    const queueChain = makeChain("where", [MOCK_QUEUE_ENTRY]);
    const joinedRunChain = makeChain("where", [MOCK_RUN]);
    const prRunChain = makeChain("where", []);
    dispatchSelect(queueChain, joinedRunChain, prRunChain);

    const result = await findWorkspaceWorkByRef("ws-1", "1468");

    expect(result.resolvedAs).toBe("issue-ref");
    expect(result.queueEntries).toEqual([MOCK_QUEUE_ENTRY]);

    const queueWhereArgs = (queueChain.where as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(renderCondition(queueWhereArgs)).toEqual(
      renderCondition(
        and(eq(queueEntries.workspaceId, "ws-1"), sql`${queueEntries.externalId} LIKE ${"%#1468"}`)
      )
    );
  });

  it("Important 1: a GitHub issue URL resolves as 'issue-ref', number extracted, matching by SUFFIX just like a bare number", async () => {
    const queueChain = makeChain("where", [MOCK_QUEUE_ENTRY]);
    const joinedRunChain = makeChain("where", [MOCK_RUN]);
    const prRunChain = makeChain("where", []);
    dispatchSelect(queueChain, joinedRunChain, prRunChain);

    const result = await findWorkspaceWorkByRef(
      "ws-1",
      "https://github.com/Bensigo/agentrail/issues/1468"
    );

    expect(result.resolvedAs).toBe("issue-ref");
    expect(result.queueEntries).toEqual([MOCK_QUEUE_ENTRY]);

    const queueWhereArgs = (queueChain.where as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(renderCondition(queueWhereArgs)).toEqual(
      renderCondition(
        and(eq(queueEntries.workspaceId, "ws-1"), sql`${queueEntries.externalId} LIKE ${"%#1468"}`)
      )
    );
  });

  it("Important 1: an issue URL with a trailing slash still resolves", async () => {
    const queueChain = makeChain("where", [MOCK_QUEUE_ENTRY]);
    const joinedRunChain = makeChain("where", [MOCK_RUN]);
    const prRunChain = makeChain("where", []);
    dispatchSelect(queueChain, joinedRunChain, prRunChain);

    const result = await findWorkspaceWorkByRef(
      "ws-1",
      "https://github.com/Bensigo/agentrail/issues/1468/"
    );

    expect(result.resolvedAs).toBe("issue-ref");
    const queueWhereArgs = (queueChain.where as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(renderCondition(queueWhereArgs)).toEqual(
      renderCondition(
        and(eq(queueEntries.workspaceId, "ws-1"), sql`${queueEntries.externalId} LIKE ${"%#1468"}`)
      )
    );
  });

  it("Important 1: an issue URL does not collide with the PR-URL branch — resolvedAs is 'issue-ref', not 'pr-number'", async () => {
    const prRun = { ...MOCK_RUN, id: "run-pr", prUrl: "https://github.com/Bensigo/agentrail/pull/1468" };
    const queueChain = makeChain("where", []);
    const prRunChain = makeChain("where", [prRun]);
    dispatchSelect(queueChain, prRunChain);

    const result = await findWorkspaceWorkByRef(
      "ws-1",
      "https://github.com/Bensigo/agentrail/issues/1468"
    );

    // Ambiguous with a PR number by design (Minor 7's existing rule for bare
    // digits) — resolvedAs stays 'issue-ref', but the pr-number-shaped query
    // is ALSO run and its results included.
    expect(result.resolvedAs).toBe("issue-ref");
    expect(result.runs).toEqual([prRun]);

    const prWhereArgs = (prRunChain.where as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(renderCondition(prWhereArgs)).toEqual(
      renderCondition(
        and(eq(runs.workspaceId, "ws-1"), sql`${runs.prUrl} LIKE ${"%/pull/1468"}`)
      )
    );
  });

  it("CRITICAL 2 fix: matched queue entries pull their runs via queue_entry_id (never runs.id === queueEntries.id)", async () => {
    const queueChain = makeChain("where", [MOCK_QUEUE_ENTRY]);
    const joinedRunChain = makeChain("where", [MOCK_RUN]);
    const prRunChain = makeChain("where", []);
    dispatchSelect(queueChain, joinedRunChain, prRunChain);

    const result = await findWorkspaceWorkByRef("ws-1", "1468");

    expect(result.runs).toEqual([MOCK_RUN]);

    const joinedWhereArgs = (joinedRunChain.where as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(renderCondition(joinedWhereArgs)).toEqual(
      renderCondition(
        and(eq(runs.workspaceId, "ws-1"), inArray(runs.queueEntryId, [MOCK_QUEUE_ENTRY.id]))
      )
    );
    // NOT a bare eq(runs.id, ...) against the queue entry's own id — that
    // would be relying on the undocumented claimQueueEntry coincidence.
    expect(renderCondition(joinedWhereArgs)).not.toEqual(
      renderCondition(and(eq(runs.workspaceId, "ws-1"), eq(runs.id, MOCK_QUEUE_ENTRY.id)))
    );
  });

  it("does not issue the runs-join query when no queue entry matched", async () => {
    const queueChain = makeChain("where", []);
    const prRunChain = makeChain("where", []);
    dispatchSelect(queueChain, prRunChain);

    const result = await findWorkspaceWorkByRef("ws-1", "9999999");

    expect(result.queueEntries).toEqual([]);
    // queue query + pr-number query only — no join query (nothing to join on).
    expect(mockDb.select).toHaveBeenCalledTimes(2);
    expect(result.runs).toEqual([]);
  });

  it("qualified-ref branch: 'owner/repo#N' matches externalId by case-insensitive equality; resolvedAs='qualified-ref'", async () => {
    const qualifiedRef = "Bensigo/agentrail#1468";
    const queueChain = makeChain("where", [MOCK_QUEUE_ENTRY]);
    const joinedRunChain = makeChain("where", [MOCK_RUN]);
    dispatchSelect(queueChain, joinedRunChain);

    const result = await findWorkspaceWorkByRef("ws-1", qualifiedRef);

    expect(result.resolvedAs).toBe("qualified-ref");
    expect(result.runs).toEqual([MOCK_RUN]);
    expect(result.queueEntries).toEqual([MOCK_QUEUE_ENTRY]);
    // No pr-number query for this shape.
    expect(mockDb.select).toHaveBeenCalledTimes(2);

    const queueWhereArgs = (queueChain.where as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(renderCondition(queueWhereArgs)).toEqual(
      renderCondition(
        and(
          eq(queueEntries.workspaceId, "ws-1"),
          sql`lower(${queueEntries.externalId}) = ${qualifiedRef.toLowerCase()}`
        )
      )
    );
  });

  it("Minor 6: qualified-ref matching is case-insensitive — a lowercased owner/repo still resolves", async () => {
    const lowercasedRef = "bensigo/agentrail#1468";
    const queueChain = makeChain("where", [MOCK_QUEUE_ENTRY]);
    const joinedRunChain = makeChain("where", [MOCK_RUN]);
    dispatchSelect(queueChain, joinedRunChain);

    const result = await findWorkspaceWorkByRef("ws-1", lowercasedRef);

    expect(result.resolvedAs).toBe("qualified-ref");
    expect(result.queueEntries).toEqual([MOCK_QUEUE_ENTRY]);

    const queueWhereArgs = (queueChain.where as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(renderCondition(queueWhereArgs)).toEqual(
      renderCondition(
        and(
          eq(queueEntries.workspaceId, "ws-1"),
          sql`lower(${queueEntries.externalId}) = ${"bensigo/agentrail#1468"}`
        )
      )
    );
  });

  it("Minor 7: resolves an explicit PR link/number ('pull/1470') via runs.prUrl SUFFIX match; resolvedAs='pr-number'", async () => {
    const prRun = { ...MOCK_RUN, id: "run-pr", prUrl: "https://github.com/Bensigo/agentrail/pull/1470" };
    const prRunChain = makeChain("where", [prRun]);
    dispatchSelect(prRunChain);

    const result = await findWorkspaceWorkByRef("ws-1", "pull/1470");

    expect(result.resolvedAs).toBe("pr-number");
    expect(result.runs).toEqual([prRun]);
    expect(result.queueEntries).toEqual([]);
    expect(mockDb.select).toHaveBeenCalledTimes(1);

    const prWhereArgs = (prRunChain.where as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(renderCondition(prWhereArgs)).toEqual(
      renderCondition(
        and(eq(runs.workspaceId, "ws-1"), sql`${runs.prUrl} LIKE ${"%/pull/1470"}`)
      )
    );
  });

  it("Minor 7: resolves a full PR URL the same way as a bare 'pull/N' ref", async () => {
    const prRun = { ...MOCK_RUN, id: "run-pr", prUrl: "https://github.com/Bensigo/agentrail/pull/1470" };
    const prRunChain = makeChain("where", [prRun]);
    dispatchSelect(prRunChain);

    const result = await findWorkspaceWorkByRef(
      "ws-1",
      "https://github.com/Bensigo/agentrail/pull/1470"
    );

    expect(result.resolvedAs).toBe("pr-number");
    expect(result.runs).toEqual([prRun]);
  });

  it("Minor 7: a bare digit ref is ambiguous — resolves BOTH issue-ref and pr-number matches, unioned, resolvedAs stays 'issue-ref'", async () => {
    const issueRun = { ...MOCK_RUN, id: "run-from-issue" };
    const prRun = { ...MOCK_RUN, id: "run-from-pr", prUrl: "https://github.com/Bensigo/agentrail/pull/1468" };

    const queueChain = makeChain("where", [MOCK_QUEUE_ENTRY]);
    const joinedRunChain = makeChain("where", [issueRun]);
    const prRunChain = makeChain("where", [prRun]);
    dispatchSelect(queueChain, joinedRunChain, prRunChain);

    const result = await findWorkspaceWorkByRef("ws-1", "1468");

    expect(result.resolvedAs).toBe("issue-ref");
    expect(result.runs.map((r) => r.id).sort()).toEqual(["run-from-issue", "run-from-pr"]);

    const prWhereArgs = (prRunChain.where as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(renderCondition(prWhereArgs)).toEqual(
      renderCondition(
        and(eq(runs.workspaceId, "ws-1"), sql`${runs.prUrl} LIKE ${"%/pull/1468"}`)
      )
    );
  });

  it("dedupes a run matched by BOTH the queue-entry join and the pr-number branch (same run)", async () => {
    const sharedRun = { ...MOCK_RUN, id: "run-shared" };
    const queueChain = makeChain("where", [MOCK_QUEUE_ENTRY]);
    const joinedRunChain = makeChain("where", [sharedRun]);
    const prRunChain = makeChain("where", [sharedRun]);
    dispatchSelect(queueChain, joinedRunChain, prRunChain);

    const result = await findWorkspaceWorkByRef("ws-1", "1468");

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toEqual(sharedRun);
  });

  it("Minor 8: strips a single leading '#' before matching — '#1468' behaves exactly like '1468'", async () => {
    const queueChain = makeChain("where", [MOCK_QUEUE_ENTRY]);
    const joinedRunChain = makeChain("where", []);
    const prRunChain = makeChain("where", []);
    dispatchSelect(queueChain, joinedRunChain, prRunChain);

    const result = await findWorkspaceWorkByRef("ws-1", "#1468");

    expect(result.resolvedAs).toBe("issue-ref");
    const queueWhereArgs = (queueChain.where as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(renderCondition(queueWhereArgs)).toEqual(
      renderCondition(
        and(eq(queueEntries.workspaceId, "ws-1"), sql`${queueEntries.externalId} LIKE ${"%#1468"}`)
      )
    );
  });

  it("Minor 8: caps ref length at 200 chars — an overlong ref resolves 'unrecognised' with ZERO db calls", async () => {
    const overlong = "1".repeat(201);

    const result = await findWorkspaceWorkByRef("ws-1", overlong);

    expect(result).toEqual({ runs: [], queueEntries: [], resolvedAs: "unrecognised" });
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("resolves 'unrecognised' for a ref matching no known shape — zero db calls, no existence leaked", async () => {
    const result = await findWorkspaceWorkByRef("ws-1", "!!!not-a-ref!!!");

    expect(result).toEqual({ runs: [], queueEntries: [], resolvedAs: "unrecognised" });
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  // The cross-tenant assertion: a ref belonging to ANOTHER workspace must
  // return empty, indistinguishable from a ref that does not exist at all —
  // this function must never leak existence across tenants. Proven here by
  // pinning that every WHERE clause that actually runs ALWAYS conjuncts the
  // caller's workspaceId with the ref match — a real database scoped this
  // way returns zero rows for a foreign-workspace ref regardless of whether
  // the underlying row exists in some other tenant.
  it("never leaks existence across tenants (run-id branch): the WHERE always conjuncts workspaceId with the ref match", async () => {
    const uuidRef = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const runChain = makeChain("limit", []);
    dispatchSelect(runChain);

    const result = await findWorkspaceWorkByRef("ws-1", uuidRef);

    expect(result.runs).toEqual([]);
    expect(result.queueEntries).toEqual([]);

    const runWhereArgs = (runChain.where as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(renderCondition(runWhereArgs)).toEqual(
      renderCondition(and(eq(runs.workspaceId, "ws-1"), eq(runs.id, uuidRef)))
    );
    expect(renderCondition(runWhereArgs)).not.toEqual(renderCondition(eq(runs.id, uuidRef)));
  });

  it("never leaks existence across tenants (issue-ref / join / pr-number branches): every WHERE that runs conjuncts workspaceId", async () => {
    const queueChain = makeChain("where", []);
    dispatchSelect(queueChain, makeChain("where", []));

    const result = await findWorkspaceWorkByRef("ws-1", "1468");

    expect(result).toEqual({ runs: [], queueEntries: [], resolvedAs: "issue-ref" });

    const queueWhereArgs = (queueChain.where as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(renderCondition(queueWhereArgs)).toEqual(
      renderCondition(
        and(eq(queueEntries.workspaceId, "ws-1"), sql`${queueEntries.externalId} LIKE ${"%#1468"}`)
      )
    );
    expect(renderCondition(queueWhereArgs)).not.toEqual(
      renderCondition(sql`${queueEntries.externalId} LIKE ${"%#1468"}`)
    );
  });

  it("returns { runs: [], queueEntries: [] } when nothing matches a qualified ref", async () => {
    const queueChain = makeChain("where", []);
    dispatchSelect(queueChain);

    const result = await findWorkspaceWorkByRef("ws-1", "owner/other-repo#42");

    expect(result).toEqual({ runs: [], queueEntries: [], resolvedAs: "qualified-ref" });
    // No join query — nothing matched to join on.
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });
});
