import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * `latestRunForIssue` (#1277 — replyable run-outcome threads) mocked-db unit
 * tests. This package's suites never touch a live Postgres (see
 * runner-result-sql.test.ts's own note on that) — the chain is mocked and the
 * captured drizzle condition trees are rendered to literal {sql, params} via
 * PgDialect, the same convention `workspace_budget.test.ts` /
 * `runner-result-sql.test.ts` already use.
 */

let selectResult: Array<{ runId: string; state: string }> = [];
const captured: {
  joinCondition?: unknown;
  where?: unknown;
  orderBy?: unknown;
  limit?: unknown;
} = {};

function makeChain() {
  const chain: Record<string, unknown> = {};
  chain["from"] = vi.fn(() => chain);
  chain["innerJoin"] = vi.fn((_table: unknown, condition: unknown) => {
    captured.joinCondition = condition;
    return chain;
  });
  chain["where"] = vi.fn((condition: unknown) => {
    captured.where = condition;
    return chain;
  });
  chain["orderBy"] = vi.fn((clause: unknown) => {
    captured.orderBy = clause;
    return chain;
  });
  chain["limit"] = vi.fn((n: unknown) => {
    captured.limit = n;
    return Promise.resolve(selectResult);
  });
  return chain;
}

vi.mock("../db.js", () => ({
  db: {
    select: vi.fn(() => makeChain()),
  },
}));

import { latestRunForIssue } from "../queries/runner.js";

const dialect = new PgDialect();
function render(node: unknown) {
  return dialect.sqlToQuery(node as Parameters<typeof dialect.sqlToQuery>[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  selectResult = [];
  captured.joinCondition = undefined;
  captured.where = undefined;
  captured.orderBy = undefined;
  captured.limit = undefined;
});

describe("latestRunForIssue — query shape", () => {
  it("joins runs to queue_entries on runs.queue_entry_id = queue_entries.id", async () => {
    await latestRunForIssue("ws-1", 42);
    const rendered = render(captured.joinCondition);
    expect(rendered.sql).toContain("queue_entry_id");
  });

  it("scopes WHERE to the caller's workspace on BOTH runs and queue_entries (defense in depth)", async () => {
    await latestRunForIssue("ws-1", 42);
    const rendered = render(captured.where);
    const workspaceOccurrences = rendered.params.filter((p) => p === "ws-1").length;
    expect(workspaceOccurrences).toBeGreaterThanOrEqual(2);
  });

  it("builds an exact-suffix LIKE pattern '%#<issueNumber>' with NO trailing wildcard", async () => {
    await latestRunForIssue("ws-1", 42);
    const rendered = render(captured.where);
    expect(rendered.sql).toContain("LIKE");
    expect(rendered.params).toContain("%#42");
  });

  it("orders by runs.created_at DESC (newest run wins)", async () => {
    await latestRunForIssue("ws-1", 42);
    const rendered = render(captured.orderBy);
    expect(rendered.sql).toContain("created_at");
    expect(rendered.sql).toContain("DESC");
  });

  it("limits to exactly 1", async () => {
    await latestRunForIssue("ws-1", 42);
    expect(captured.limit).toBe(1);
  });
});

describe("latestRunForIssue — result mapping", () => {
  it("returns null when no run matches", async () => {
    selectResult = [];
    const result = await latestRunForIssue("ws-1", 42);
    expect(result).toBeNull();
  });

  it("maps the found row to { runId, state } (runs.status, e.g. 'failed'/'success'/'running')", async () => {
    selectResult = [{ runId: "run-1", state: "failed" }];
    const result = await latestRunForIssue("ws-1", 42);
    expect(result).toEqual({ runId: "run-1", state: "failed" });
  });

  it("takes only the FIRST row (the query already ORDER BY DESC LIMIT 1s server-side)", async () => {
    selectResult = [{ runId: "run-newest", state: "running" }];
    const result = await latestRunForIssue("ws-1", 42);
    expect(result).toEqual({ runId: "run-newest", state: "running" });
  });
});

describe("latestRunForIssue — exact-suffix matching semantics (independent oracle)", () => {
  // A pure re-implementation of Postgres LIKE semantics (% = any sequence, _ =
  // any one char, everything else literal) — an INDEPENDENT check that the
  // pattern latestRunForIssue actually sends Postgres has the anchoring
  // property the brief requires ("#10 must not match #101"), rather than
  // just trusting Postgres LIKE blindly.
  function likeMatches(value: string, pattern: string): boolean {
    const escaped = pattern
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/%/g, ".*")
      .replace(/_/g, ".");
    return new RegExp(`^${escaped}$`).test(value);
  }

  it("issue 10's pattern does NOT match an externalId ending in #101", () => {
    expect(likeMatches("owner/repo#101", "%#10")).toBe(false);
  });

  it("issue 10's pattern DOES match an externalId ending in #10", () => {
    expect(likeMatches("owner/repo#10", "%#10")).toBe(true);
  });

  it("issue 101's pattern does NOT match an externalId ending in #10", () => {
    expect(likeMatches("owner/repo#10", "%#101")).toBe(false);
  });

  it("confirms the ACTUAL pattern latestRunForIssue sends the db has this property", async () => {
    await latestRunForIssue("ws-1", 10);
    const rendered = render(captured.where);
    const sentPattern = rendered.params.find(
      (p) => typeof p === "string" && p.includes("#")
    ) as string;
    expect(sentPattern).toBe("%#10");
    expect(likeMatches("owner/repo#101", sentPattern)).toBe(false);
    expect(likeMatches("owner/repo#10", sentPattern)).toBe(true);
  });
});

describe("latestRunForIssue — workspace scoping is caller-supplied, never payload-derived", () => {
  it("queries exactly the workspaceId argument it was called with, for two different workspaces", async () => {
    await latestRunForIssue("ws-alpha", 7);
    const firstParams = render(captured.where).params;
    expect(firstParams).toContain("ws-alpha");
    expect(firstParams).not.toContain("ws-beta");

    await latestRunForIssue("ws-beta", 7);
    const secondParams = render(captured.where).params;
    expect(secondParams).toContain("ws-beta");
    expect(secondParams).not.toContain("ws-alpha");
  });
});
