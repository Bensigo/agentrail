import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * `completeOwnerElectWorkspace` (issue #1264 PR ②) issues a raw `sql` INSERT
 * (via `db.execute`), not the query builder — same reason as
 * `channel_inbox.ts`'s guarded statements: the "insert only if the workspace
 * has zero owners" guard is a `WHERE NOT EXISTS` subquery the fluent builder
 * has no ergonomic way to express alongside `ON CONFLICT` + `RETURNING`. So,
 * mirroring `channel_inbox-enqueue.test.ts`, `db.execute` is mocked directly
 * and the captured `sql` argument is rendered via drizzle's own `PgDialect`
 * to get at `{sql, params}` text — the argument-level assertion surface for
 * a raw-SQL query. The zero-owner guard is load-bearing (the whole point of
 * this function): a mutation that weakens or drops the `WHERE NOT EXISTS`
 * clause changes the rendered SQL text and is caught by the exact-text
 * assertions below (empirically confirmed in the task report by performing
 * that exact mutation and re-running this file to a RED).
 *
 * Slice 3 Task 6 wraps the function body in `db.transaction` so its new
 * trial-billing-account statement (second `describe` block below) joins the
 * SAME transaction as the ownership grant, instead of firing as an
 * unwrapped second statement. `db.transaction` is mocked to run its
 * callback against this same mock `db` (mirrors
 * `create-workspace-owner-elect.test.ts`) so every `tx.execute(...)` call —
 * old and new — still funnels through the one captured `mockState.execute`
 * mock, and every pre-existing exact-text assertion below keeps working
 * unchanged at whatever call index it captures. `mockState.transactionCalls`
 * separately counts `db.transaction` invocations, so a test can pin "both
 * statements share ONE transaction, never a second one" directly.
 */

const mockState = vi.hoisted(() => ({
  execute: vi.fn(),
  transactionCalls: 0,
}));

vi.mock("../db.js", () => {
  const db = {
    execute: mockState.execute,
    transaction: async (cb: (tx: unknown) => unknown) => {
      mockState.transactionCalls += 1;
      return cb(db);
    },
  };
  return { db };
});

import { completeOwnerElectWorkspace } from "../queries/index.js";

function renderExecuteCall(callIndex = 0) {
  const captured = mockState.execute.mock.calls[callIndex]?.[0];
  return new PgDialect().sqlToQuery(captured as never);
}

beforeEach(() => {
  mockState.execute.mockReset();
  mockState.transactionCalls = 0;
});

describe("completeOwnerElectWorkspace", () => {
  it("issues the ownership-grant INSERT ... SELECT ... WHERE NOT EXISTS ... ON CONFLICT statement exactly once, as the FIRST of two statements (the second is the trial-billing-account write — see that describe block below)", async () => {
    mockState.execute.mockResolvedValueOnce([{ user_id: "user-1" }]);

    await completeOwnerElectWorkspace({ workspaceId: "ws-1", userId: "user-1" });

    expect(mockState.execute).toHaveBeenCalledTimes(2);
  });

  it("targets workspace_memberships(user_id, workspace_id, role) via INSERT ... SELECT, not INSERT ... VALUES", async () => {
    mockState.execute.mockResolvedValueOnce([{ user_id: "user-1" }]);

    await completeOwnerElectWorkspace({ workspaceId: "ws-1", userId: "user-1" });

    const rendered = renderExecuteCall();
    expect(rendered.sql).toContain(
      "INSERT INTO workspace_memberships (user_id, workspace_id, role)"
    );
    expect(rendered.sql).toContain("SELECT");
    expect(rendered.sql).not.toContain("VALUES");
  });

  it("the zero-owner guard: WHERE NOT EXISTS a role='owner' row for THIS workspace_id — load-bearing, see file header", async () => {
    mockState.execute.mockResolvedValueOnce([{ user_id: "user-1" }]);

    await completeOwnerElectWorkspace({ workspaceId: "ws-1", userId: "user-1" });

    const rendered = renderExecuteCall();
    expect(rendered.sql).toContain("WHERE NOT EXISTS (");
    expect(rendered.sql).toContain("SELECT 1 FROM workspace_memberships");
    expect(rendered.sql).toContain("AND role = 'owner'");
  });

  it("ON CONFLICT (user_id, workspace_id) DO NOTHING — defensive second layer for the identical-retry race", async () => {
    mockState.execute.mockResolvedValueOnce([{ user_id: "user-1" }]);

    await completeOwnerElectWorkspace({ workspaceId: "ws-1", userId: "user-1" });

    const rendered = renderExecuteCall();
    expect(rendered.sql).toContain("ON CONFLICT (user_id, workspace_id) DO NOTHING");
    expect(rendered.sql).toContain("RETURNING user_id");
  });

  it("binds the exact (userId, workspaceId) pair positionally, workspaceId reused for the guard's own subquery — not swapped, not stale", async () => {
    mockState.execute.mockResolvedValueOnce([{ user_id: "user-42" }]);

    await completeOwnerElectWorkspace({ workspaceId: "ws-42", userId: "user-42" });

    const rendered = renderExecuteCall();
    // Order of appearance in the statement: userId (SELECT list), workspaceId
    // (SELECT list), workspaceId again (the guard's own subquery condition).
    expect(rendered.params).toEqual(["user-42", "ws-42", "ws-42"]);
  });

  it("a different (userId, workspaceId) pair binds that exact pair, not a stale one from a prior call", async () => {
    mockState.execute.mockResolvedValueOnce([{ user_id: "user-7" }]);

    await completeOwnerElectWorkspace({ workspaceId: "ws-7", userId: "user-7" });

    const rendered = renderExecuteCall();
    expect(rendered.params).toEqual(["user-7", "ws-7", "ws-7"]);
  });

  it("returns completed:true when the guarded insert returns a row (workspace had zero owners)", async () => {
    mockState.execute.mockResolvedValueOnce([{ user_id: "user-1" }]);

    const result = await completeOwnerElectWorkspace({ workspaceId: "ws-1", userId: "user-1" });

    expect(result).toEqual({ completed: true });
  });

  it("returns completed:false, writes no membership row, when the workspace already has an owner (guard blocks it — empty RETURNING; the trial-billing-account write is independent — see that describe block below)", async () => {
    mockState.execute.mockResolvedValueOnce([]);

    const result = await completeOwnerElectWorkspace({ workspaceId: "ws-owned", userId: "user-2" });

    expect(result).toEqual({ completed: false });
  });

  it("re-running for the same (userId, workspaceId) pair after a first success also returns completed:false — idempotent, no error", async () => {
    mockState.execute.mockResolvedValueOnce([{ user_id: "user-1" }]);
    const first = await completeOwnerElectWorkspace({ workspaceId: "ws-1", userId: "user-1" });
    expect(first).toEqual({ completed: true });

    // Second call: the workspace now has an owner (itself, from the first
    // call), so the guard blocks it the same way it blocks any other
    // already-owned workspace — the mock models this as an empty RETURNING.
    mockState.execute.mockResolvedValueOnce([]);
    const second = await completeOwnerElectWorkspace({ workspaceId: "ws-1", userId: "user-1" });
    expect(second).toEqual({ completed: false });

    // 2 calls per invocation (ownership grant + billing-account write) x 2
    // invocations.
    expect(mockState.execute).toHaveBeenCalledTimes(4);
  });

  it("propagates a thrown execute error rather than swallowing it", async () => {
    const err = new Error("connection reset");
    mockState.execute.mockRejectedValueOnce(err);

    await expect(
      completeOwnerElectWorkspace({ workspaceId: "ws-1", userId: "user-1" })
    ).rejects.toThrow(err);
  });

  /**
   * Slice 3 Task 6 (subscription-platform spec §9) — the trial-billing-
   * account write added to this function's SAME transaction. See this
   * function's own top doc-comment (in `queries/index.ts`) and its inline
   * comment right above this statement for the full design rationale;
   * these tests pin the rendered SQL shape the same exact-text way the
   * ownership-grant tests above pin theirs.
   */
  describe("trial billing account (subscription-platform spec §9)", () => {
    it("runs both statements inside exactly ONE db.transaction — never a second, separate transaction for the billing-account write", async () => {
      mockState.execute.mockResolvedValueOnce([{ user_id: "user-1" }]);

      await completeOwnerElectWorkspace({ workspaceId: "ws-1", userId: "user-1" });

      expect(mockState.transactionCalls).toBe(1);
    });

    it("issues a guarded INSERT ... SELECT ... FROM workspaces, RETURNING id, feeding an UPDATE that stamps billing_account_id — as the SECOND statement", async () => {
      mockState.execute.mockResolvedValueOnce([{ user_id: "user-1" }]);

      await completeOwnerElectWorkspace({ workspaceId: "ws-1", userId: "user-1" });

      const rendered = renderExecuteCall(1);
      expect(rendered.sql).toContain("WITH inserted AS (");
      expect(rendered.sql).toContain("INSERT INTO billing_accounts (name, plan, trial_ends_at)");
      expect(rendered.sql).toContain("'trial'");
      expect(rendered.sql).toMatch(/now\(\)\s*\+\s*interval '14 days'/);
      expect(rendered.sql).toContain("FROM workspaces w");
      expect(rendered.sql).toContain("RETURNING id");
      expect(rendered.sql).toContain("UPDATE workspaces");
      expect(rendered.sql).toContain("SET billing_account_id = inserted.id");
      expect(rendered.sql).toContain("FROM inserted");
    });

    it("the NULL guard sits on BOTH the inserted CTE's own WHERE and the outer UPDATE's own WHERE — not left solely inside the CTE (EvalPlanQual: a CTE-only qualifier is snapshot-only under READ COMMITTED and is not re-checked when the UPDATE finally locks the row)", async () => {
      mockState.execute.mockResolvedValueOnce([{ user_id: "user-1" }]);

      await completeOwnerElectWorkspace({ workspaceId: "ws-1", userId: "user-1" });

      const rendered = renderExecuteCall(1);
      // Guard #1: inside the `inserted` CTE's own WHERE.
      expect(rendered.sql).toMatch(/WHERE w\.id = \$\d+ AND w\.billing_account_id IS NULL/);
      // Guard #2: repeated on the outer UPDATE's own WHERE against the
      // target table — the load-bearing copy per the EvalPlanQual gotcha.
      expect(rendered.sql).toMatch(
        /WHERE workspaces\.id = \$\d+ AND workspaces\.billing_account_id IS NULL/
      );
    });

    it("binds workspaceId (not userId) at both guard sites, positionally — not the SQL text", async () => {
      mockState.execute.mockResolvedValueOnce([{ user_id: "user-1" }]);

      await completeOwnerElectWorkspace({ workspaceId: "ws-77", userId: "user-1" });

      const rendered = renderExecuteCall(1);
      expect(rendered.params).toEqual(["ws-77", "ws-77"]);
      expect(rendered.sql).not.toContain("ws-77");
    });

    it("runs even when the ownership grant itself completed this call (completed:true case)", async () => {
      mockState.execute.mockResolvedValueOnce([{ user_id: "user-1" }]);

      const result = await completeOwnerElectWorkspace({ workspaceId: "ws-1", userId: "user-1" });

      expect(result).toEqual({ completed: true });
      expect(mockState.execute).toHaveBeenCalledTimes(2);
      expect(renderExecuteCall(1).sql).toContain("INSERT INTO billing_accounts");
    });

    it("runs even when the ownership grant is blocked (completed:false case) — gated purely on the workspace's OWN billing_account_id, since this function can run against a workspace that already has an owner (or already has a billing account) via some other path", async () => {
      mockState.execute.mockResolvedValueOnce([]); // guard blocks the ownership grant

      const result = await completeOwnerElectWorkspace({ workspaceId: "ws-owned", userId: "user-2" });

      expect(result).toEqual({ completed: false });
      expect(mockState.execute).toHaveBeenCalledTimes(2);
      expect(renderExecuteCall(1).sql).toContain("INSERT INTO billing_accounts");
    });

    it("propagates a thrown error from the billing-account statement rather than swallowing it", async () => {
      mockState.execute.mockResolvedValueOnce([{ user_id: "user-1" }]);
      const err = new Error("billing_accounts insert failed");
      mockState.execute.mockRejectedValueOnce(err);

      await expect(
        completeOwnerElectWorkspace({ workspaceId: "ws-1", userId: "user-1" })
      ).rejects.toThrow(err);
    });
  });
});
