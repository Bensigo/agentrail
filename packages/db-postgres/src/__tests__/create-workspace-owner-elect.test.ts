import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * `createWorkspaceOwnerElect` is issue #1264 PR ①'s chat-first workspace
 * creation path: inside ONE transaction, insert a workspace row, then bind
 * the CALLING chat identity to it (`chat_identities.workspace_id`) — NO
 * `workspace_memberships` row, unlike `createWorkspace` (owner-elect has no
 * owner yet; that completes at GitHub bind, issue #1264 PR ②). There is no
 * live-DB harness in this package (every spec mocks `db`), so — mirroring
 * replace-memory-items.test.ts — `db.transaction` is mocked to run its
 * callback against the same mock `db`, capturing statement order and
 * arguments. The update's WHERE clause is opaque as a raw object, so —
 * mirroring chat_identities.test.ts — it is rendered via drizzle's
 * `PgDialect` and compared to the literal condition it must encode.
 */

const mockState = vi.hoisted(() => ({
  calls: [] as string[],
  insertTable: undefined as unknown,
  insertValues: undefined as unknown,
  insertError: undefined as Error | undefined,
  returningRow: undefined as unknown,
  updateTable: undefined as unknown,
  updateSet: undefined as unknown,
  updateWhere: undefined as unknown,
}));

vi.mock("../db.js", () => {
  const db = {
    // Run the callback against the same mock so both statements (insert +
    // update) are captured as happening "inside" the one transaction — same
    // idiom as replace-memory-items.test.ts.
    transaction: async (cb: (tx: unknown) => unknown) => cb(db),
    insert: (table: unknown) => {
      mockState.insertTable = table;
      return {
        values: (v: unknown) => {
          mockState.insertValues = v;
          return {
            returning: async () => {
              mockState.calls.push("insert");
              if (mockState.insertError) throw mockState.insertError;
              return [mockState.returningRow];
            },
          };
        },
      };
    },
    update: (table: unknown) => {
      mockState.updateTable = table;
      return {
        set: (s: unknown) => {
          mockState.updateSet = s;
          return {
            where: async (w: unknown) => {
              mockState.calls.push("update");
              mockState.updateWhere = w;
              return undefined;
            },
          };
        },
      };
    },
  };
  return { db };
});

import { workspaces } from "../schema/workspaces.js";
import { chatIdentities } from "../schema/chat_identities.js";
import { createWorkspaceOwnerElect } from "../queries/index.js";

const dialect = new PgDialect();
function renderCondition(condition: unknown) {
  return dialect.sqlToQuery(condition as Parameters<typeof dialect.sqlToQuery>[0]);
}

const NOW = new Date("2026-07-18T00:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockState.calls = [];
  mockState.insertTable = undefined;
  mockState.insertValues = undefined;
  mockState.insertError = undefined;
  mockState.returningRow = {
    id: "ws-new-1",
    name: "Acme",
    slug: "acme",
    createdAt: NOW,
    updatedAt: NOW,
    baselineWindowDays: 30,
    discordWebhookUrl: null,
  };
  mockState.updateTable = undefined;
  mockState.updateSet = undefined;
  mockState.updateWhere = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createWorkspaceOwnerElect", () => {
  it("inserts the workspace row into `workspaces` with exactly {name, slug} — no ownerId/role fields ride along", async () => {
    await createWorkspaceOwnerElect({
      name: "Acme",
      slug: "acme",
      chatIdentityId: "chat-identity-1",
    });

    expect(mockState.insertTable).toBe(workspaces);
    expect(mockState.insertValues).toEqual({ name: "Acme", slug: "acme" });
  });

  it("binds the chat identity to the newly created workspace id and touches updatedAt, scoped to exactly this identity", async () => {
    await createWorkspaceOwnerElect({
      name: "Acme",
      slug: "acme",
      chatIdentityId: "chat-identity-1",
    });

    expect(mockState.updateTable).toBe(chatIdentities);
    expect(mockState.updateSet).toEqual({
      workspaceId: "ws-new-1",
      updatedAt: NOW,
    });
    expect(renderCondition(mockState.updateWhere)).toEqual(
      renderCondition(eq(chatIdentities.id, "chat-identity-1"))
    );
  });

  it("runs the insert THEN the bind, exactly once each — no workspace_memberships row (owner-elect has no owner yet)", async () => {
    await createWorkspaceOwnerElect({
      name: "Acme",
      slug: "acme",
      chatIdentityId: "chat-identity-1",
    });

    expect(mockState.calls).toEqual(["insert", "update"]);
  });

  it("returns the inserted workspace row", async () => {
    const result = await createWorkspaceOwnerElect({
      name: "Acme",
      slug: "acme",
      chatIdentityId: "chat-identity-1",
    });

    expect(result).toEqual(mockState.returningRow);
  });

  it("a different chat identity id binds that exact id, not a stale one", async () => {
    await createWorkspaceOwnerElect({
      name: "Beta",
      slug: "beta",
      chatIdentityId: "chat-identity-2",
    });

    expect(renderCondition(mockState.updateWhere)).toEqual(
      renderCondition(eq(chatIdentities.id, "chat-identity-2"))
    );
  });

  it("propagates a thrown insert error (e.g. a slug unique violation) and never reaches the identity bind", async () => {
    const err = Object.assign(
      new Error("duplicate key value violates unique constraint \"workspaces_slug_unique\""),
      { code: "23505" }
    );
    mockState.insertError = err;

    await expect(
      createWorkspaceOwnerElect({
        name: "Acme",
        slug: "acme",
        chatIdentityId: "chat-identity-1",
      })
    ).rejects.toThrow(err);

    expect(mockState.calls).toEqual(["insert"]);
  });
});
