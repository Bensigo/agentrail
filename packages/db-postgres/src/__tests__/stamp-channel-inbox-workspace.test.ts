import { describe, it, expect, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * stampChannelInboxWorkspace takes `db` as an explicit parameter (unlike its
 * sibling functions in queries/channel_inbox.ts, which close over the
 * imported singleton), so the mock here is just a plain object passed
 * directly at the call site — no `vi.mock("../db.js")` module-mocking
 * required. Same "capture the SQL object, render it with drizzle's
 * PgDialect" approach as runner-result-sql.test.ts, which exists precisely
 * because this package has no live-DB test harness (every spec mocks `db`).
 */
import { stampChannelInboxWorkspace } from "../queries/channel_inbox.js";
import type { Db } from "../db.js";

const captured: unknown[] = [];

function mockDbCapturing(calls: unknown[]): Db {
  return {
    execute: (q: unknown) => {
      calls.push(q);
      return Promise.resolve([]);
    },
  } as unknown as Db;
}

const render = (q: unknown) => new PgDialect().sqlToQuery(q as never).sql;
const renderParams = (q: unknown) => new PgDialect().sqlToQuery(q as never).params;

beforeEach(() => {
  captured.length = 0;
});

describe("stampChannelInboxWorkspace", () => {
  it("issues exactly one UPDATE against channel_inbox", async () => {
    const db = mockDbCapturing(captured);
    await stampChannelInboxWorkspace(db, "row-1", "ws-1");

    expect(captured).toHaveLength(1);
    const sql = render(captured[0]);
    expect(sql).toMatch(/update\s+channel_inbox/i);
  });

  it("updates workspace_id only where currently NULL (fill-only — never overwrites an existing stamp)", async () => {
    const db = mockDbCapturing(captured);
    await stampChannelInboxWorkspace(db, "row-1", "ws-1");

    const sql = render(captured[0]);
    expect(sql).toMatch(/set\s+workspace_id/i);
    expect(sql).toMatch(/workspace_id\s+is\s+null/i); // the fill-only WHERE guard
  });

  it("scopes the UPDATE to the given row id, not a blanket update", async () => {
    const db = mockDbCapturing(captured);
    await stampChannelInboxWorkspace(db, "row-1", "ws-1");

    const sql = render(captured[0]);
    expect(sql).toMatch(/where.*\bid\s*=/is);
  });

  it("binds rowId and workspaceId as parameters (never string-interpolated into the SQL text)", async () => {
    const db = mockDbCapturing(captured);
    await stampChannelInboxWorkspace(db, "row-1", "ws-1");

    const sql = render(captured[0]);
    const params = renderParams(captured[0]);
    expect(params).toContain("row-1");
    expect(params).toContain("ws-1");
    expect(sql).not.toContain("row-1");
    expect(sql).not.toContain("ws-1");
  });
});
