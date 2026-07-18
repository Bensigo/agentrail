import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// Covers both of #1273's non-workspace-scoped approval lookups:
// getApprovalByCallbackToken (the Telegram webhook's own read) and
// getApprovalById (the GET /api/v1/runner/approvals/[id] poller's read).
//
// Mocked db chain: same "mock the chain, control the terminal value"
// approach as jace_sessions-connect-link.test.ts.
vi.mock("../db.js", () => ({
  db: {
    select: vi.fn(),
  },
}));

import { db } from "../db.js";
import { jaceApprovals } from "../schema/jace_sessions.js";
import { getApprovalByCallbackToken, getApprovalById } from "./jace_sessions.js";

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

// Argument-level condition assertions (see jace_sessions-connect-link.test.ts /
// jace_sessions-intro-anchor.test.ts for the full rationale): a mock chain
// proves a method was *called*, not what it was called *with* — render both
// the actual captured `.where(...)` condition and an expected one (built with
// the same drizzle operators against the real `jaceApprovals` columns) to
// literal {sql, params} text via PgDialect.sqlToQuery and compare THAT.
const dialect = new PgDialect();
function renderCondition(condition: unknown) {
  return dialect.sqlToQuery(condition as Parameters<typeof dialect.sqlToQuery>[0]);
}

const NOW = new Date("2026-07-18T00:00:00Z");

const MOCK_APPROVAL = {
  id: "approval-1",
  workspaceId: "ws-1",
  chatIdentityId: "chat-identity-1",
  sessionId: "session-1",
  eveSessionId: "eve-session-1",
  requestId: "req-1",
  callbackToken: "cbtoken123456",
  toolName: "create_issue",
  toolInput: { title: "x" },
  approveOptionId: "approve",
  denyOptionId: "deny",
  status: "pending",
  publishedIssueUrl: null,
  createdAt: NOW,
  resolvedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getApprovalByCallbackToken", () => {
  it("looks up by callback_token ALONE — no workspace scope in the WHERE clause", async () => {
    const selectChain = makeChain("limit", [MOCK_APPROVAL]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await getApprovalByCallbackToken("cbtoken123456");

    expect(result).toEqual(MOCK_APPROVAL);

    const whereArgs = (selectChain.where as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    // The key behavioral distinction from findApprovalByCallbackToken: this
    // condition must be EXACTLY eq(callbackToken, token) — a bare single
    // condition, not `and(eq(workspaceId, ...), eq(callbackToken, ...))`.
    // Rendering catches a regression that quietly re-adds workspace scoping.
    expect(renderCondition(whereArgs)).toEqual(
      renderCondition(eq(jaceApprovals.callbackToken, "cbtoken123456"))
    );
  });

  it("returns null when no approval has this callback token", async () => {
    const selectChain = makeChain("limit", []);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await getApprovalByCallbackToken("unknown-token");

    expect(result).toBeNull();
  });
});

describe("getApprovalById", () => {
  it("looks up by primary key id — the GET /api/v1/runner/approvals/[id] poller's own read", async () => {
    const selectChain = makeChain("limit", [MOCK_APPROVAL]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await getApprovalById("approval-1");

    expect(result).toEqual(MOCK_APPROVAL);
    const whereArgs = (selectChain.where as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(renderCondition(whereArgs)).toEqual(
      renderCondition(eq(jaceApprovals.id, "approval-1"))
    );
  });

  it("returns null when no approval has this id", async () => {
    const selectChain = makeChain("limit", []);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await getApprovalById("unknown-id");

    expect(result).toBeNull();
  });
});
