import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * `replaceMemoryItemsByWriter` is the onboarder's idempotent re-seed: inside ONE
 * transaction it DELETEs every row for a strict (workspace, repo, writer) triple,
 * then INSERTs the new batch — so a re-run replaces its own notes instead of
 * appending duplicates. There is no live-DB harness in this package (every spec
 * mocks `db`), so we mock `db` to make the delete's where-clause and the insert's
 * values observable, and record call order. `db.transaction(cb)` just runs
 * `cb(db)` so the same mock captures both statements.
 *
 * The delete where-clause is opaque as an object, so — mirroring
 * runner-result-sql.test.ts — we render it with drizzle's PgDialect and assert the
 * scoped columns + parameter values.
 */

const mockState = vi.hoisted(() => ({
  // Statement order: ["delete"] or ["delete", "insert"].
  calls: [] as string[],
  // The condition passed to `.where(...)` on the DELETE — a drizzle SQL object.
  deleteWhere: undefined as unknown,
  // The raw array passed to `.values(...)` on the INSERT.
  insertValues: undefined as unknown,
}));

vi.mock("../db.js", () => {
  const db = {
    // Run the callback with the same mock as the tx handle so both statements
    // are captured (delete + insert live inside the transaction).
    transaction: async (cb: (tx: unknown) => unknown) => cb(db),
    delete: () => ({
      where: (w: unknown) => {
        mockState.calls.push("delete");
        mockState.deleteWhere = w;
        return Promise.resolve(undefined);
      },
    }),
    insert: () => ({
      values: (v: unknown) => {
        mockState.calls.push("insert");
        mockState.insertValues = v;
        return Promise.resolve(undefined);
      },
    }),
  };
  return { db };
});

import { replaceMemoryItemsByWriter } from "../queries/index.js";

/** Render a captured drizzle SQL object to `{ sql, params }` for assertions. */
const render = (q: unknown) => new PgDialect().sqlToQuery(q as never);

beforeEach(() => {
  mockState.calls = [];
  mockState.deleteWhere = undefined;
  mockState.insertValues = undefined;
});

describe("replaceMemoryItemsByWriter — idempotent re-seed", () => {
  it("deletes scoped by workspace+repo+writtenBy, THEN inserts the items", async () => {
    await replaceMemoryItemsByWriter({
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      writtenBy: "onboarder",
      source: "onboard",
      items: [{ content: "a", tags: ["x"] }],
    });

    // Both statements ran, delete before insert.
    expect(mockState.calls).toEqual(["delete", "insert"]);

    // The delete is scoped to the exact (workspace, repo, writer) triple.
    const where = render(mockState.deleteWhere);
    expect(where.sql).toContain("workspace_id");
    expect(where.sql).toContain("repository_id");
    expect(where.sql).toContain("written_by");
    expect(where.params).toEqual(["ws-1", "repo-1", "onboarder"]);
  });

  it("items carry through with type preserved and writtenBy/source applied", async () => {
    await replaceMemoryItemsByWriter({
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      writtenBy: "onboarder",
      source: "onboard",
      items: [
        { content: "a fact", tags: ["x"] }, // no type → defaults to "fact"
        { content: "a decision", tags: [], type: "decision" }, // type preserved
      ],
    });

    expect(mockState.insertValues).toEqual([
      {
        workspaceId: "ws-1",
        repositoryId: "repo-1",
        source: "onboard",
        content: "a fact",
        type: "fact",
        writtenBy: "onboarder",
        tags: ["x"],
      },
      {
        workspaceId: "ws-1",
        repositoryId: "repo-1",
        source: "onboard",
        content: "a decision",
        type: "decision",
        writtenBy: "onboarder",
        tags: [],
      },
    ]);
  });

  it("empty items → delete still happens, insert is skipped", async () => {
    await replaceMemoryItemsByWriter({
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      writtenBy: "onboarder",
      source: "onboard",
      items: [],
    });

    // The clear-out still runs (stale notes removed) but nothing is inserted.
    expect(mockState.calls).toEqual(["delete"]);
    expect(mockState.insertValues).toBeUndefined();

    // And the delete kept its strict scope even on a zero-item re-run.
    const where = render(mockState.deleteWhere);
    expect(where.params).toEqual(["ws-1", "repo-1", "onboarder"]);
  });
});
