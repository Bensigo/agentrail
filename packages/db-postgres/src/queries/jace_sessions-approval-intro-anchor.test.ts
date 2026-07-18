import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// Mocked db chain: same "mock the chain, control the terminal value"
// approach as jace_sessions-intro-anchor.test.ts / chat_identities.test.ts.
// recordApprovalRequest now needs BOTH insert (values -> onConflictDoNothing
// -> returning) and, on the conflict/replay path, a follow-up select
// (from -> where -> limit) — same two-chain shape as
// getOrCreateIntroJaceSession's own insert+select idiom.
vi.mock("../db.js", () => ({
  db: {
    insert: vi.fn(),
    select: vi.fn(),
  },
}));

import { db } from "../db.js";
import { jaceApprovals } from "../schema/jace_sessions.js";
import { recordApprovalRequest } from "./jace_sessions.js";

const mockDb = vi.mocked(db);

/** A chainable mock: every method returns the chain except `terminalMethod`, which resolves `finalValue`. */
function makeChain(terminalMethod: string, finalValue: unknown) {
  const chain: Record<string, unknown> = {};
  const methods = ["values", "onConflictDoNothing", "from", "where", "limit"];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  chain[terminalMethod] = vi.fn(() => Promise.resolve(finalValue));
  return chain;
}

// Same rendered-SQL comparison idiom as jace_sessions-intro-anchor.test.ts:
// a captured `.onConflictDoNothing(...)`/`.where(...)` argument is a fresh
// drizzle SQL condition tree each call, not reference-comparable — render
// both the actual and an expected condition (built with the same operators
// against the real `jaceApprovals` columns) to literal {sql, params} text.
const dialect = new PgDialect();
function renderCondition(condition: unknown) {
  return dialect.sqlToQuery(condition as Parameters<typeof dialect.sqlToQuery>[0]);
}

const BASE_INPUT = {
  sessionId: "session-1",
  eveSessionId: "eve-session-1",
  requestId: "req-1",
  toolName: "create_issue",
  toolInput: { title: "x" },
  approveOptionId: "approve",
  denyOptionId: "deny",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("recordApprovalRequest — intro-anchor optionality (#1273 PR ①)", () => {
  it("throws before the INSERT when neither workspaceId nor chatIdentityId is provided", async () => {
    await expect(recordApprovalRequest({ ...BASE_INPUT })).rejects.toThrow(
      /recordApprovalRequest: requires either workspaceId or chatIdentityId/
    );
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("inserts an intro approval anchored on chatIdentityId alone (workspaceId omitted)", async () => {
    const returnedRow = {
      id: "approval-1",
      workspaceId: null,
      chatIdentityId: "chat-identity-1",
      sessionId: "session-1",
      eveSessionId: "eve-session-1",
      requestId: "req-1",
      callbackToken: "abc123",
      toolName: "create_workspace",
      toolInput: { name: "Acme" },
      approveOptionId: "approve",
      denyOptionId: "deny",
      status: "pending",
      publishedIssueUrl: null,
      createdAt: new Date("2026-07-18T00:00:00Z"),
      resolvedAt: null,
    };
    const insertChain = makeChain("returning", [returnedRow]);
    mockDb.insert = vi.fn(() => insertChain as ReturnType<typeof db.insert>);

    const result = await recordApprovalRequest({
      ...BASE_INPUT,
      toolName: "create_workspace",
      toolInput: { name: "Acme" },
      chatIdentityId: "chat-identity-1",
    });

    expect(result).toEqual({ approval: returnedRow, created: true });
    const valuesArgs = (insertChain.values as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(valuesArgs.chatIdentityId).toBe("chat-identity-1");
    expect(valuesArgs.workspaceId).toBeUndefined();
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("still inserts a workspace-anchored approval when only workspaceId is provided (pre-#1273 shape unchanged)", async () => {
    const returnedRow = {
      id: "approval-2",
      workspaceId: "ws-1",
      chatIdentityId: null,
      sessionId: "session-1",
      eveSessionId: "eve-session-1",
      requestId: "req-1",
      callbackToken: "def456",
      toolName: "create_issue",
      toolInput: { title: "x" },
      approveOptionId: "approve",
      denyOptionId: "deny",
      status: "pending",
      publishedIssueUrl: null,
      createdAt: new Date("2026-07-18T00:00:00Z"),
      resolvedAt: null,
    };
    const insertChain = makeChain("returning", [returnedRow]);
    mockDb.insert = vi.fn(() => insertChain as ReturnType<typeof db.insert>);

    const result = await recordApprovalRequest({
      ...BASE_INPUT,
      workspaceId: "ws-1",
    });

    expect(result).toEqual({ approval: returnedRow, created: true });
    const valuesArgs = (insertChain.values as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(valuesArgs.workspaceId).toBe("ws-1");
    expect(valuesArgs.chatIdentityId).toBeUndefined();
  });

  it("passes BOTH anchors through when the caller supplies both (graduated session, identity known for the sender check)", async () => {
    const returnedRow = {
      id: "approval-3",
      workspaceId: "ws-1",
      chatIdentityId: "chat-identity-1",
      sessionId: "session-1",
      eveSessionId: "eve-session-1",
      requestId: "req-1",
      callbackToken: "ghi789",
      toolName: "create_repo",
      toolInput: { name: "acme-repo" },
      approveOptionId: "approve",
      denyOptionId: "deny",
      status: "pending",
      publishedIssueUrl: null,
      createdAt: new Date("2026-07-18T00:00:00Z"),
      resolvedAt: null,
    };
    const insertChain = makeChain("returning", [returnedRow]);
    mockDb.insert = vi.fn(() => insertChain as ReturnType<typeof db.insert>);

    const result = await recordApprovalRequest({
      ...BASE_INPUT,
      workspaceId: "ws-1",
      chatIdentityId: "chat-identity-1",
    });

    expect(result).toEqual({ approval: returnedRow, created: true });
    const valuesArgs = (insertChain.values as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(valuesArgs.workspaceId).toBe("ws-1");
    expect(valuesArgs.chatIdentityId).toBe("chat-identity-1");
  });
});

describe("recordApprovalRequest — idempotent on (eveSessionId, requestId) conflict (#1273 PR ②)", () => {
  it("targets the jace_approvals_request_unique columns on conflict, and does nothing (no throw) on the DB side", async () => {
    const returnedRow = {
      id: "approval-1",
      workspaceId: "ws-1",
      chatIdentityId: null,
      sessionId: "session-1",
      eveSessionId: "eve-session-1",
      requestId: "req-1",
      callbackToken: "abc123",
      toolName: "create_issue",
      toolInput: { title: "x" },
      approveOptionId: "approve",
      denyOptionId: "deny",
      status: "pending",
      publishedIssueUrl: null,
      createdAt: new Date("2026-07-18T00:00:00Z"),
      resolvedAt: null,
    };
    const insertChain = makeChain("returning", [returnedRow]);
    mockDb.insert = vi.fn(() => insertChain as ReturnType<typeof db.insert>);

    await recordApprovalRequest({ ...BASE_INPUT, workspaceId: "ws-1" });

    expect(insertChain.onConflictDoNothing).toHaveBeenCalled();
    const conflictArgs = (
      insertChain.onConflictDoNothing as ReturnType<typeof vi.fn>
    ).mock.calls[0]?.[0];
    // Column-identity-checked (toBe against the real schema column objects,
    // not shape-checked) — swapping either column for a different one (e.g.
    // callbackToken) would let a genuinely-new request silently collapse
    // into an unrelated existing row.
    expect(conflictArgs?.target).toHaveLength(2);
    expect(conflictArgs?.target?.[0]).toBe(jaceApprovals.eveSessionId);
    expect(conflictArgs?.target?.[1]).toBe(jaceApprovals.requestId);
  });

  it("returns { approval: existingRow, created: false } when the insert loses the conflict — no throw, one follow-up select", async () => {
    const existingRow = {
      id: "approval-existing",
      workspaceId: "ws-1",
      chatIdentityId: null,
      sessionId: "session-1",
      eveSessionId: "eve-session-1",
      requestId: "req-1",
      callbackToken: "already-sent-token",
      toolName: "create_issue",
      toolInput: { title: "the first attempt's input" },
      approveOptionId: "approve",
      denyOptionId: "deny",
      status: "pending",
      publishedIssueUrl: null,
      createdAt: new Date("2026-07-18T00:00:00Z"),
      resolvedAt: null,
    };
    // The conflict-safe insert returns zero rows (it lost the race / this is
    // a pure replay), same as a real `INSERT ... ON CONFLICT DO NOTHING
    // RETURNING *` with no row inserted.
    const insertChain = makeChain("returning", []);
    mockDb.insert = vi.fn(() => insertChain as ReturnType<typeof db.insert>);
    const selectChain = makeChain("limit", [existingRow]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await recordApprovalRequest({
      ...BASE_INPUT,
      workspaceId: "ws-1",
    });

    expect(result).toEqual({ approval: existingRow, created: false });

    // The fallback SELECT must be scoped to the exact same
    // (eveSessionId, requestId) pair the caller asked for — not just "any
    // pending row" — so a replay can never resolve to a DIFFERENT request's
    // approval by accident.
    const selectWhereArgs = (selectChain.where as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0];
    expect(renderCondition(selectWhereArgs)).toEqual(
      renderCondition(
        and(
          eq(jaceApprovals.eveSessionId, "eve-session-1"),
          eq(jaceApprovals.requestId, "req-1")
        )
      )
    );
  });

  it("throws a prefixed error when the insert loses the conflict AND the fallback select ALSO finds nothing (unreachable in practice)", async () => {
    const insertChain = makeChain("returning", []);
    mockDb.insert = vi.fn(() => insertChain as ReturnType<typeof db.insert>);
    const selectChain = makeChain("limit", []);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    await expect(
      recordApprovalRequest({ ...BASE_INPUT, workspaceId: "ws-1" })
    ).rejects.toThrow(
      /recordApprovalRequest: no row found for eve-session-1\/req-1 after conflict/
    );
  });
});
