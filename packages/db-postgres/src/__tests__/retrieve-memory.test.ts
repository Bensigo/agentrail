import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * `retrieveMemory` is the reusable BM25 + heuristic-rerank retriever for
 * workspace memory (issue #1215). It runs up to three raw `db.execute(sql\`...\`)`
 * queries — an FTS candidate probe, a recency fallback (only when FTS yields
 * nothing), and a pinned-decisions probe — then does all ranking in JS. There is
 * no live-DB harness in this package (every spec mocks `db`), so we mock
 * `db.execute` and dispatch each call to a fixture array based on which SQL
 * fragment the query contains (FTS uses `websearch_to_tsquery`, the pinned probe
 * filters `type = 'decision'`, and the recency fallback is neither). Rendering
 * with drizzle's PgDialect (mirrors runner-result-sql.test.ts) turns the opaque
 * SQL object into inspectable text.
 */

const mockState = vi.hoisted(() => ({
  fts: [] as Record<string, unknown>[],
  recent: [] as Record<string, unknown>[],
  pinned: [] as Record<string, unknown>[],
}));

vi.mock("../db.js", () => {
  const { PgDialect: Dialect } = require("drizzle-orm/pg-core") as typeof import("drizzle-orm/pg-core");
  const renderText = (q: unknown): string => new Dialect().sqlToQuery(q as never).sql;
  return {
    db: {
      execute: vi.fn(async (query: unknown) => {
        const text = renderText(query);
        if (text.includes("websearch_to_tsquery")) return mockState.fts;
        if (text.includes("type = 'decision'")) return mockState.pinned;
        return mockState.recent;
      }),
    },
  };
});

import { db } from "../db.js";
import { retrieveMemory } from "../queries/index.js";

const mockDb = vi.mocked(db);
const render = (q: unknown) => new PgDialect().sqlToQuery(q as never).sql;

/** Build a raw (snake_case) memory_items row as the driver would return it. */
function row(overrides: Partial<{
  id: string;
  workspace_id: string;
  repository_id: string | null;
  source: string;
  content: string;
  type: "decision" | "preference" | "fact";
  written_by: string;
  tags: string[];
  created_at: Date;
  last_used_at: Date | null;
}>): Record<string, unknown> {
  return {
    id: "row-id",
    workspace_id: "ws-1",
    repository_id: null,
    source: "test",
    content: "content",
    type: "fact",
    written_by: "tester",
    tags: [],
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    last_used_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockState.fts = [];
  mockState.recent = [];
  mockState.pinned = [];
  (mockDb.execute as unknown as ReturnType<typeof vi.fn>).mockClear?.();
});

describe("retrieveMemory — BM25 + heuristic rerank", () => {
  it("orders candidates by BM25 relevance to the query", async () => {
    mockState.fts = [
      row({
        id: "relevant",
        content: "the deploy pipeline uses feature flags for rollout safety",
        created_at: new Date("2026-01-01T00:00:00.000Z"),
      }),
      row({
        id: "irrelevant",
        content: "the weather today is sunny with light clouds across the region",
        created_at: new Date("2026-01-01T00:00:00.000Z"),
      }),
    ];

    const result = await retrieveMemory("ws-1", "deploy pipeline");

    expect(result.map((r) => r.id)).toEqual(["relevant", "irrelevant"]);
  });

  it("breaks a BM25 tie by recency (lastUsedAt, falling back to createdAt)", async () => {
    mockState.fts = [
      row({
        id: "older",
        content: "rollout safety deploy pipeline notes",
        last_used_at: new Date("2026-01-01T00:00:00.000Z"),
      }),
      row({
        id: "newer",
        content: "rollout safety deploy pipeline notes",
        last_used_at: new Date("2026-06-01T00:00:00.000Z"),
      }),
    ];

    const result = await retrieveMemory("ws-1", "rollout safety");

    expect(result.map((r) => r.id)).toEqual(["newer", "older"]);
  });

  it("ranks a decision above a fact at an equal lexical score", async () => {
    mockState.fts = [
      row({
        id: "the-fact",
        type: "fact",
        content: "rollout safety deploy pipeline notes",
        created_at: new Date("2026-01-01T00:00:00.000Z"),
      }),
      row({
        id: "the-decision",
        type: "decision",
        content: "rollout safety deploy pipeline notes",
        created_at: new Date("2026-01-01T00:00:00.000Z"),
      }),
    ];
    mockState.pinned = []; // isolate the blend from the pinned-core merge

    const result = await retrieveMemory("ws-1", "rollout safety");

    expect(result.map((r) => r.id)).toEqual(["the-decision", "the-fact"]);
  });

  it("ranks a repositoryId match above a non-match at an equal lexical score", async () => {
    mockState.fts = [
      row({
        id: "other-repo",
        repository_id: "repo-2",
        content: "rollout safety deploy pipeline notes",
      }),
      row({
        id: "matching-repo",
        repository_id: "repo-1",
        content: "rollout safety deploy pipeline notes",
      }),
    ];

    const result = await retrieveMemory("ws-1", "rollout safety", { repositoryId: "repo-1" });

    expect(result.map((r) => r.id)).toEqual(["matching-repo", "other-repo"]);
  });

  it("always includes pinned decisions, ahead of the ranked top-k", async () => {
    mockState.fts = [row({ id: "topk-fact", type: "fact", content: "rollout safety" })];
    mockState.pinned = [
      row({ id: "pinned-decision", type: "decision", content: "totally unrelated old note" }),
    ];

    const result = await retrieveMemory("ws-1", "rollout safety");

    expect(result.map((r) => r.id)).toEqual(["pinned-decision", "topk-fact"]);
  });

  it("dedupes a pinned decision that also ranked into the top-k", async () => {
    mockState.fts = [row({ id: "dual", type: "decision", content: "rollout safety" })];
    mockState.pinned = [row({ id: "dual", type: "decision", content: "rollout safety" })];

    const result = await retrieveMemory("ws-1", "rollout safety");

    expect(result.map((r) => r.id)).toEqual(["dual"]);
  });

  it("respects the k limit on the ranked portion", async () => {
    mockState.fts = Array.from({ length: 5 }, (_, i) =>
      row({ id: `item-${i}`, content: `rollout safety note ${i}` })
    );
    mockState.pinned = [];

    const result = await retrieveMemory("ws-1", "rollout safety", { k: 2 });

    expect(result).toHaveLength(2);
  });

  it("caps the total (pinned + top-k) at k+3", async () => {
    mockState.fts = Array.from({ length: 10 }, (_, i) =>
      row({ id: `fact-${i}`, content: `rollout safety note ${i}` })
    );
    mockState.pinned = Array.from({ length: 3 }, (_, i) =>
      row({ id: `decision-${i}`, type: "decision", content: `old decision ${i}` })
    );

    const result = await retrieveMemory("ws-1", "rollout safety", { k: 8 });

    expect(result.length).toBeLessThanOrEqual(11); // k + 3
  });

  it("never returns a row from another workspace (candidates or pinned)", async () => {
    mockState.fts = [
      row({ id: "mine", workspace_id: "ws-1", content: "rollout safety" }),
      row({ id: "not-mine", workspace_id: "ws-evil", content: "rollout safety" }),
    ];
    mockState.pinned = [
      row({ id: "evil-decision", workspace_id: "ws-evil", type: "decision", content: "x" }),
    ];

    const result = await retrieveMemory("ws-1", "rollout safety");

    expect(result.every((r) => r.workspaceId === "ws-1")).toBe(true);
    expect(result.map((r) => r.id)).not.toContain("not-mine");
    expect(result.map((r) => r.id)).not.toContain("evil-decision");
  });

  it("falls back to the 30 most-recent notes when the FTS query has no matches", async () => {
    mockState.fts = [];
    mockState.recent = [row({ id: "recent-note", content: "anything" })];

    const result = await retrieveMemory("ws-1", "no such term anywhere");

    expect(result.map((r) => r.id)).toEqual(["recent-note"]);
  });

  it("an empty query returns pinned core (or empty) without throwing", async () => {
    mockState.fts = [];
    mockState.recent = [];
    mockState.pinned = [];

    await expect(retrieveMemory("ws-1", "")).resolves.toEqual([]);
  });

  it("an empty query with pinned decisions returns just the pinned core", async () => {
    mockState.recent = [];
    mockState.pinned = [row({ id: "only-decision", type: "decision", content: "x" })];

    const result = await retrieveMemory("ws-1", "   ");

    expect(result.map((r) => r.id)).toEqual(["only-decision"]);
  });

  it("trims content over 1000 chars and leaves short content untouched", async () => {
    const long = "a".repeat(1500);
    const short = "short note";
    mockState.fts = [
      row({ id: "long", content: long }),
      row({ id: "short", content: short }),
    ];

    const result = await retrieveMemory("ws-1", "note");
    const longItem = result.find((r) => r.id === "long")!;
    const shortItem = result.find((r) => r.id === "short")!;

    expect(longItem.content.length).toBe(1000);
    expect(longItem.content.endsWith("…")).toBe(true);
    expect(shortItem.content).toBe(short);
  });

  it("defaults k to 8", async () => {
    mockState.fts = Array.from({ length: 12 }, (_, i) =>
      row({ id: `item-${i}`, content: `rollout safety note ${i}` })
    );

    const result = await retrieveMemory("ws-1", "rollout safety");

    expect(result.length).toBeLessThanOrEqual(8);
  });

  it("scopes the FTS and recency-fallback queries to the given repositoryId", async () => {
    mockState.fts = [row({ id: "x", repository_id: "repo-1", content: "rollout safety" })];

    await retrieveMemory("ws-1", "rollout safety", { repositoryId: "repo-1" });

    const ftsCall = (mockDb.execute as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      render(c[0]).includes("websearch_to_tsquery")
    );
    expect(ftsCall).toBeDefined();
    expect(render(ftsCall![0])).toContain("repository_id");
  });

  it("every query scopes to the requested workspace_id", async () => {
    mockState.fts = [row({ id: "x", content: "rollout safety" })];

    await retrieveMemory("ws-1", "rollout safety");

    const calls = (mockDb.execute as unknown as ReturnType<typeof vi.fn>).mock.calls;
    for (const call of calls) {
      expect(render(call[0])).toContain("workspace_id");
    }
  });
});
