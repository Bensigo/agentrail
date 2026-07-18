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
 */

const mockState = vi.hoisted(() => ({
  execute: vi.fn(),
}));

vi.mock("../db.js", () => ({
  db: { execute: mockState.execute },
}));

import { completeOwnerElectWorkspace } from "../queries/index.js";

function renderExecuteCall(callIndex = 0) {
  const captured = mockState.execute.mock.calls[callIndex]?.[0];
  return new PgDialect().sqlToQuery(captured as never);
}

beforeEach(() => {
  mockState.execute.mockReset();
});

describe("completeOwnerElectWorkspace", () => {
  it("issues ONE INSERT ... SELECT ... WHERE NOT EXISTS ... ON CONFLICT statement, exactly once", async () => {
    mockState.execute.mockResolvedValueOnce([{ user_id: "user-1" }]);

    await completeOwnerElectWorkspace({ workspaceId: "ws-1", userId: "user-1" });

    expect(mockState.execute).toHaveBeenCalledTimes(1);
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

  it("returns completed:false, writes nothing, when the workspace already has an owner (guard blocks it — empty RETURNING)", async () => {
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

    expect(mockState.execute).toHaveBeenCalledTimes(2);
  });

  it("propagates a thrown execute error rather than swallowing it", async () => {
    const err = new Error("connection reset");
    mockState.execute.mockRejectedValueOnce(err);

    await expect(
      completeOwnerElectWorkspace({ workspaceId: "ws-1", userId: "user-1" })
    ).rejects.toThrow(err);
  });
});
