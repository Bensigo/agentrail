import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * `wiki.ts` backs the Repo Wiki system of record (delivery plan §7 row 4):
 * `upsertWikiPages` runs a pre-upsert existence check (`select`) then N
 * `insert().values().onConflictDoUpdate()` calls inside ONE `db.transaction`
 * (mirrors `replaceMemoryItemsByWriter`'s transaction-mock shape,
 * `__tests__/replace-memory-items.test.ts`); `listWikiPages`/`getWikiPage`/
 * `searchWikiPages` run raw `db.execute(sql\`...\`)` queries dispatched by
 * which SQL fragment renders (mirrors `retrieveMemory`'s own test,
 * `__tests__/retrieve-memory.test.ts`). There is no live-DB harness in this
 * package — every spec mocks `db`.
 */

const mockState = vi.hoisted(() => ({
  // db.execute dispatch fixtures, by branch.
  ftsRows: [] as Record<string, unknown>[],
  recentRows: [] as Record<string, unknown>[],
  listRows: [] as Record<string, unknown>[],
  getRows: [] as Record<string, unknown>[],
  // upsertWikiPages fixtures/capture.
  existingSelectRows: [] as Record<string, unknown>[],
  selectWhere: undefined as unknown,
  insertCalls: [] as Array<{ values: Record<string, unknown>; onConflict: unknown }>,
}));

vi.mock("../db.js", () => {
  const { PgDialect: Dialect } = require("drizzle-orm/pg-core") as typeof import("drizzle-orm/pg-core");
  const renderText = (q: unknown): string => new Dialect().sqlToQuery(q as never).sql;

  const db = {
    execute: vi.fn(async (query: unknown) => {
      const text = renderText(query);
      if (text.includes("websearch_to_tsquery")) return mockState.ftsRows;
      if (text.includes("slug =")) return mockState.getRows;
      if (text.includes("ORDER BY generated_at DESC")) return mockState.recentRows;
      if (text.includes("ORDER BY slug ASC")) return mockState.listRows;
      return [];
    }),
    transaction: async (cb: (tx: unknown) => unknown) => cb(db),
    select: () => ({
      from: () => ({
        where: (w: unknown) => {
          mockState.selectWhere = w;
          return Promise.resolve(mockState.existingSelectRows);
        },
      }),
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        onConflictDoUpdate: (opts: unknown) => {
          mockState.insertCalls.push({ values: v, onConflict: opts });
          return Promise.resolve(undefined);
        },
      }),
    }),
  };
  return { db };
});

import { db } from "../db.js";
import {
  upsertWikiPages,
  listWikiPages,
  getWikiPage,
  searchWikiPages,
  WIKI_SEARCH_MAX_LIMIT,
  type UpsertWikiPageInput,
} from "./wiki.js";

const render = (q: unknown) => new PgDialect().sqlToQuery(q as never);

function pageInput(overrides: Partial<UpsertWikiPageInput> = {}): UpsertWikiPageInput {
  return {
    slug: "wiki/overview",
    title: "acme/widgets — overview",
    kind: "overview",
    bodyMd: "# Overview",
    commitSha: "abc123",
    inputsHash: "sha256:deadbeef",
    generatedAt: "2026-07-24T00:00:00.000Z",
    ...overrides,
  };
}

/** Build a raw (snake_case) wiki_pages row as the driver would return it. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "page-1",
    workspace_id: "ws-1",
    repository_id: "repo-1",
    slug: "wiki/overview",
    title: "acme/widgets — overview",
    kind: "overview",
    body_md: "# Overview",
    skeleton: {},
    links: { related: [], dependsOn: [], dependedOnBy: [] },
    citations: [],
    commit_sha: "abc123",
    inputs_hash: "sha256:deadbeef",
    model: "claude-haiku-4-5",
    written_by: "wiki-compiler",
    generated_at: new Date("2026-07-24T00:00:00.000Z"),
    stale: false,
    created_at: new Date("2026-07-24T00:00:00.000Z"),
    updated_at: new Date("2026-07-24T00:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  mockState.ftsRows = [];
  mockState.recentRows = [];
  mockState.listRows = [];
  mockState.getRows = [];
  mockState.existingSelectRows = [];
  mockState.selectWhere = undefined;
  mockState.insertCalls = [];
  (db.execute as unknown as ReturnType<typeof vi.fn>).mockClear?.();
});

describe("upsertWikiPages", () => {
  it("returns {inserted:0, replaced:0} for an empty batch without touching the db", async () => {
    const result = await upsertWikiPages({ workspaceId: "ws-1", repositoryId: "repo-1", pages: [] });
    expect(result).toEqual({ inserted: 0, replaced: 0 });
    expect(mockState.insertCalls).toEqual([]);
  });

  it("scopes the pre-upsert existence check to this repository and the pushed slugs", async () => {
    await upsertWikiPages({
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      pages: [pageInput({ slug: "wiki/unit/a" }), pageInput({ slug: "wiki/unit/b" })],
    });
    const where = render(mockState.selectWhere);
    expect(where.sql).toContain("repository_id");
    expect(where.sql).toContain("slug");
    expect(where.params).toContain("repo-1");
    expect(where.params).toContain("wiki/unit/a");
    expect(where.params).toContain("wiki/unit/b");
  });

  it("computes inserted vs replaced from the pre-upsert existence check", async () => {
    mockState.existingSelectRows = [{ slug: "wiki/unit/a" }];

    const result = await upsertWikiPages({
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      pages: [pageInput({ slug: "wiki/unit/a" }), pageInput({ slug: "wiki/unit/b" })],
    });

    expect(result).toEqual({ inserted: 1, replaced: 1 });
    expect(mockState.insertCalls).toHaveLength(2);
  });

  it("every upserted row forces stale:false, both on insert and on the conflict update", async () => {
    await upsertWikiPages({
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      pages: [pageInput()],
    });
    const { values, onConflict } = mockState.insertCalls[0]!;
    expect(values.stale).toBe(false);
    expect((onConflict as { set: Record<string, unknown> }).set.stale).toBe(false);
  });

  it("upserts targeting the (repositoryId, slug) composite conflict key", async () => {
    await upsertWikiPages({ workspaceId: "ws-1", repositoryId: "repo-1", pages: [pageInput()] });
    const { onConflict } = mockState.insertCalls[0]!;
    const target = (onConflict as { target: Array<{ name: string }> }).target;
    expect(target.map((c) => c.name)).toEqual(["repository_id", "slug"]);
  });

  it("applies defaults for every omitted optional field", async () => {
    await upsertWikiPages({
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      pages: [
        {
          slug: "wiki/overview",
          title: "t",
          kind: "overview",
          bodyMd: "b",
          commitSha: "c",
          inputsHash: "h",
          generatedAt: "2026-07-24T00:00:00.000Z",
        },
      ],
    });
    const { values } = mockState.insertCalls[0]!;
    expect(values.skeleton).toEqual({});
    expect(values.links).toEqual({ related: [], dependsOn: [], dependedOnBy: [] });
    expect(values.citations).toEqual([]);
    expect(values.model).toBeNull();
    expect(values.writtenBy).toBe("wiki-compiler");
  });

  it("preserves explicitly supplied optional fields", async () => {
    await upsertWikiPages({
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      pages: [
        pageInput({
          skeleton: { files: ["a.ts"] },
          links: { related: ["wiki/overview"], dependsOn: [], dependedOnBy: [] },
          citations: ["a.ts"],
          model: "claude-haiku-4-5",
          writtenBy: "wiki-compiler",
        }),
      ],
    });
    const { values } = mockState.insertCalls[0]!;
    expect(values.skeleton).toEqual({ files: ["a.ts"] });
    expect(values.links).toEqual({ related: ["wiki/overview"], dependsOn: [], dependedOnBy: [] });
    expect(values.citations).toEqual(["a.ts"]);
    expect(values.model).toBe("claude-haiku-4-5");
  });

  it("converts a string generatedAt into a Date", async () => {
    await upsertWikiPages({
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      pages: [pageInput({ generatedAt: "2026-07-24T12:30:00.000Z" })],
    });
    const { values } = mockState.insertCalls[0]!;
    expect(values.generatedAt).toBeInstanceOf(Date);
    expect((values.generatedAt as Date).toISOString()).toBe("2026-07-24T12:30:00.000Z");
  });
});

describe("listWikiPages", () => {
  it("maps snake_case rows to the typed WikiPage shape", async () => {
    mockState.listRows = [row({ slug: "wiki/overview" }), row({ slug: "wiki/unit/a", kind: "unit" })];

    const result = await listWikiPages("ws-1", "repo-1");

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ slug: "wiki/overview", workspaceId: "ws-1", repositoryId: "repo-1" });
    expect(result[1]).toMatchObject({ slug: "wiki/unit/a", kind: "unit" });
  });

  it("defaults null jsonb columns to their empty shapes", async () => {
    mockState.listRows = [row({ skeleton: null, links: null, citations: null })];
    const [page] = await listWikiPages("ws-1", "repo-1");
    expect(page!.skeleton).toEqual({});
    expect(page!.links).toEqual({ related: [], dependsOn: [], dependedOnBy: [] });
    expect(page!.citations).toEqual([]);
  });
});

describe("getWikiPage", () => {
  it("returns null when no row matches", async () => {
    mockState.getRows = [];
    expect(await getWikiPage("ws-1", "repo-1", "wiki/overview")).toBeNull();
  });

  it("returns the mapped page when found", async () => {
    mockState.getRows = [row({ slug: "wiki/overview", citations: ["README.md"] })];
    const page = await getWikiPage("ws-1", "repo-1", "wiki/overview");
    expect(page).toMatchObject({ slug: "wiki/overview", citations: ["README.md"] });
  });
});

describe("searchWikiPages", () => {
  it("skips the FTS round trip for an empty/whitespace query and falls back to recent", async () => {
    mockState.recentRows = [row({ slug: "wiki/overview" })];
    const result = await searchWikiPages("ws-1", "repo-1", "   ");
    expect(result).toHaveLength(1);
    expect(result[0]!.slug).toBe("wiki/overview");
  });

  it("returns FTS-ranked results when the query matches", async () => {
    mockState.ftsRows = [row({ slug: "wiki/unit/a" })];
    mockState.recentRows = [row({ slug: "wiki/overview" })];
    const result = await searchWikiPages("ws-1", "repo-1", "widgets");
    expect(result[0]!.slug).toBe("wiki/unit/a");
  });

  it("falls back to recent when the FTS query matches nothing", async () => {
    mockState.ftsRows = [];
    mockState.recentRows = [row({ slug: "wiki/overview" })];
    const result = await searchWikiPages("ws-1", "repo-1", "no-such-term");
    expect(result[0]!.slug).toBe("wiki/overview");
  });

  it("defaults the limit to 5 when omitted", async () => {
    mockState.ftsRows = [row()];
    await searchWikiPages("ws-1", "repo-1", "widgets");
    const calls = (db.execute as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const { params } = render(calls[calls.length - 1]![0]);
    expect(params[params.length - 1]).toBe(5);
  });

  it("clamps a limit above the max down to WIKI_SEARCH_MAX_LIMIT", async () => {
    mockState.ftsRows = [row()];
    await searchWikiPages("ws-1", "repo-1", "widgets", 999);
    const calls = (db.execute as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const { params } = render(calls[calls.length - 1]![0]);
    expect(params[params.length - 1]).toBe(WIKI_SEARCH_MAX_LIMIT);
  });

  it("clamps a non-positive limit up to 1", async () => {
    mockState.ftsRows = [row()];
    await searchWikiPages("ws-1", "repo-1", "widgets", 0);
    const calls = (db.execute as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const { params } = render(calls[calls.length - 1]![0]);
    expect(params[params.length - 1]).toBe(1);
  });
});
