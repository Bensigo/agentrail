import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * `briefs.ts` backs the briefs system of record (spec PR #1487). Follows the
 * same mocking idiom as `wiki.test.ts` and `goals.test.ts` — there is no
 * live-DB harness in this package, so every spec mocks `db`:
 *
 * - `db.select().from().where()[.orderBy()][.limit()]` is a single reusable
 *   chain object (mirrors `goals.test.ts`'s FIFO-queue idiom): every terminal
 *   call (`.limit()`, or awaiting the chain directly via its own `.then`)
 *   shifts the next fixture off `mockState.selectQueue`, in call order.
 * - `db.insert()...returning()` / `db.insert()...onConflictDoUpdate()...returning()`
 *   and `db.update()...where().returning()` capture what was written
 *   (`insertCalls`/`onConflictCalls`/`updateCalls`) so assertions can inspect
 *   the actual patch/target rather than a simulated row.
 * - `db.execute(sql\`…\`)` dispatches on the rendered SQL text (mirrors
 *   `wiki.test.ts`) — `searchBriefs`' FTS branch vs its recency fallback.
 */

const mockState = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  insertReturningQueue: [] as unknown[],
  updateReturningQueue: [] as unknown[][],
  insertCalls: [] as Array<{ values: Record<string, unknown> }>,
  onConflictCalls: [] as Array<{
    values: Record<string, unknown>;
    opts: { target: Array<{ name: string }>; set: Record<string, unknown> };
  }>,
  updateCalls: [] as Array<{ set: Record<string, unknown>; where: unknown }>,
  ftsRows: [] as Record<string, unknown>[],
  recentRows: [] as Record<string, unknown>[],
  txCalls: 0,
}));

vi.mock("../db.js", () => {
  const { PgDialect: Dialect } = require("drizzle-orm/pg-core") as typeof import("drizzle-orm/pg-core");
  const renderText = (q: unknown): string => new Dialect().sqlToQuery(q as never).sql;

  function selectChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = (_w?: unknown) => chain;
    chain.orderBy = () => chain;
    chain.limit = () => Promise.resolve(mockState.selectQueue.shift() ?? []);
    chain.then = (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
      Promise.resolve(mockState.selectQueue.shift() ?? []).then(resolve, reject);
    return chain;
  }

  const db: Record<string, unknown> = {
    execute: vi.fn(async (query: unknown) => {
      const text = renderText(query);
      if (text.includes("websearch_to_tsquery")) return mockState.ftsRows;
      if (text.includes("ORDER BY updated_at DESC")) return mockState.recentRows;
      return [];
    }),
    transaction: async (cb: (tx: unknown) => unknown) => {
      mockState.txCalls += 1;
      return cb(db);
    },
    select: (_cols?: unknown) => selectChain(),
    insert: (_table: unknown) => ({
      values: (v: Record<string, unknown>) => ({
        returning: async () => {
          mockState.insertCalls.push({ values: v });
          return [mockState.insertReturningQueue.shift() ?? { id: "generated-id", ...v }];
        },
        onConflictDoUpdate: (opts: { target: Array<{ name: string }>; set: Record<string, unknown> }) => ({
          returning: async () => {
            mockState.onConflictCalls.push({ values: v, opts });
            return [mockState.insertReturningQueue.shift() ?? { id: "generated-id", ...v, ...opts.set }];
          },
        }),
      }),
    }),
    update: (_table: unknown) => ({
      set: (s: Record<string, unknown>) => ({
        where: (w: unknown) => ({
          returning: async () => {
            mockState.updateCalls.push({ set: s, where: w });
            return mockState.updateReturningQueue.shift() ?? [];
          },
        }),
      }),
    }),
  };
  return { db };
});

import { db } from "../db.js";
import {
  upsertBrief,
  getBriefBySlug,
  listBriefs,
  searchBriefs,
  patchBriefItems,
  setBriefStatus,
  linkBriefWork,
  computeBriefReadiness,
} from "./briefs.js";

const render = (q: unknown) => new PgDialect().sqlToQuery(q as never);

beforeEach(() => {
  mockState.selectQueue = [];
  mockState.insertReturningQueue = [];
  mockState.updateReturningQueue = [];
  mockState.insertCalls = [];
  mockState.onConflictCalls = [];
  mockState.updateCalls = [];
  mockState.ftsRows = [];
  mockState.recentRows = [];
  mockState.txCalls = 0;
  (db.execute as unknown as ReturnType<typeof vi.fn>).mockClear?.();
});

function briefRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "brief-1",
    workspaceId: "ws-1",
    repositoryId: null,
    slug: "blog",
    title: "Add a blog",
    status: "draft",
    openQuestion: "",
    grounding: { wikiPageSlugs: [], memoryItemIds: [], commitSha: null },
    jaceSessionIds: [],
    createdAt: new Date("2026-07-27T00:00:00.000Z"),
    updatedAt: new Date("2026-07-27T00:00:00.000Z"),
    ...overrides,
  };
}

function briefItemRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "item-1",
    briefId: "brief-1",
    area: "scope",
    statement: "Publish flow supports a single approver",
    evidence: "for now since am the only one approve to publish it",
    kind: "required",
    state: "open",
    resolution: null,
    authority: "jace",
    createdAt: new Date("2026-07-27T00:00:00.000Z"),
    updatedAt: new Date("2026-07-27T00:00:00.000Z"),
    ...overrides,
  };
}

/** Raw (snake_case) execute-row shape for briefs — the shape searchBriefs' FTS branch and its recency fallback both return. */
function execBriefRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "brief-1",
    workspace_id: "ws-1",
    repository_id: null,
    slug: "blog",
    title: "Add a blog",
    status: "draft",
    open_question: "",
    grounding: { wikiPageSlugs: [], memoryItemIds: [], commitSha: null },
    jace_session_ids: [],
    created_at: new Date("2026-07-27T00:00:00.000Z"),
    updated_at: new Date("2026-07-27T00:00:00.000Z"),
    ...overrides,
  };
}

describe("upsertBrief", () => {
  it("is idempotent: both the first write and a same-identity re-write target (workspace_id, slug) via onConflictDoUpdate, never a plain insert", async () => {
    await upsertBrief({ workspaceId: "ws-1", slug: "blog", title: "Add a blog" });
    await upsertBrief({ workspaceId: "ws-1", slug: "blog", title: "Add a blog with auth" });

    expect(mockState.onConflictCalls).toHaveLength(2);
    for (const call of mockState.onConflictCalls) {
      expect(call.opts.target.map((c) => c.name)).toEqual(["workspace_id", "slug"]);
    }
    // Both writes carry the same (workspaceId, slug) identity — this is what
    // makes the second call a re-write of the SAME row, not a fork.
    expect(mockState.onConflictCalls[0]!.values.workspaceId).toBe("ws-1");
    expect(mockState.onConflictCalls[0]!.values.slug).toBe("blog");
    expect(mockState.onConflictCalls[1]!.values.workspaceId).toBe("ws-1");
    expect(mockState.onConflictCalls[1]!.values.slug).toBe("blog");
  });

  it("is a PARTIAL patch on conflict: an omitted field is left out of the update set, not defaulted, so a later call touching only the title cannot erase an already-set openQuestion", async () => {
    await upsertBrief({
      workspaceId: "ws-1",
      slug: "blog",
      title: "Add a blog",
      openQuestion: "what CMS?",
    });
    await upsertBrief({ workspaceId: "ws-1", slug: "blog", title: "Add a blog (renamed)" });

    const secondPatch = mockState.onConflictCalls[1]!.opts.set;
    expect(secondPatch.title).toBe("Add a blog (renamed)");
    expect(secondPatch).not.toHaveProperty("openQuestion");
  });

  it("applies schema defaults on first insert for every omitted optional field", async () => {
    await upsertBrief({ workspaceId: "ws-1", slug: "blog", title: "Add a blog" });
    const { values } = mockState.onConflictCalls[0]!;
    expect(values.status).toBe("draft");
    expect(values.openQuestion).toBe("");
    expect(values.grounding).toEqual({ wikiPageSlugs: [], memoryItemIds: [], commitSha: null });
    expect(values.jaceSessionIds).toEqual([]);
    expect(values.repositoryId).toBeNull();
  });
});

describe("getBriefBySlug", () => {
  it("returns null when no brief matches", async () => {
    mockState.selectQueue.push([]);
    expect(await getBriefBySlug("ws-1", "no-such-brief")).toBeNull();
  });

  it("returns the brief with all of its items in one call", async () => {
    mockState.selectQueue.push([briefRow()]); // the brief lookup
    mockState.selectQueue.push([briefItemRow(), briefItemRow({ id: "item-2", area: "problem" })]); // its items
    const result = await getBriefBySlug("ws-1", "blog");
    expect(result?.slug).toBe("blog");
    expect(result?.items).toHaveLength(2);
  });
});

describe("listBriefs", () => {
  it("returns the compact index without fetching items", async () => {
    mockState.selectQueue.push([briefRow(), briefRow({ id: "brief-2", slug: "changelog" })]);
    const result = await listBriefs("ws-1");
    expect(result).toHaveLength(2);
    expect(result[0]).not.toHaveProperty("items");
  });
});

describe("patchBriefItems", () => {
  it("refuses to overwrite an existing human-authority item: it is left untouched and reported as skipped", async () => {
    // The pre-check select finds the target item already authority: 'human'.
    mockState.selectQueue.push([{ id: "item-1", authority: "human" }]);

    const result = await patchBriefItems("brief-1", [
      { id: "item-1", area: "scope", statement: "agent tries to overwrite this", kind: "required" },
    ]);

    expect(result.skippedHumanAuthorityIds).toEqual(["item-1"]);
    expect(result.upserted).toEqual([]);
    expect(mockState.updateCalls).toEqual([]); // no write of any kind reached this row
  });

  it("still patches a jace-authority item in the same batch that skips a human-authority one", async () => {
    mockState.selectQueue.push([
      { id: "item-human", authority: "human" },
      { id: "item-jace", authority: "jace" },
    ]);
    mockState.updateReturningQueue.push([
      briefItemRow({ id: "item-jace", statement: "updated statement" }),
    ]);

    const result = await patchBriefItems("brief-1", [
      { id: "item-human", area: "scope", statement: "blocked write", kind: "required" },
      { id: "item-jace", area: "scope", statement: "updated statement", kind: "required" },
    ]);

    expect(result.skippedHumanAuthorityIds).toEqual(["item-human"]);
    expect(result.upserted).toHaveLength(1);
    expect(result.upserted[0]!.id).toBe("item-jace");
    expect(mockState.updateCalls).toHaveLength(1);
  });

  it("inserts a new item (no id) as a plain delta, never touching the pre-check select", async () => {
    const result = await patchBriefItems("brief-1", [
      { area: "problem", statement: "no dashboard exists today", kind: "required" },
    ]);
    expect(mockState.insertCalls).toHaveLength(1);
    expect(mockState.insertCalls[0]!.values.briefId).toBe("brief-1");
    expect(result.skippedHumanAuthorityIds).toEqual([]);
  });

  it("runs inside one transaction", async () => {
    await patchBriefItems("brief-1", [
      { area: "problem", statement: "x", kind: "required" },
    ]);
    expect(mockState.txCalls).toBe(1);
  });

  it("is a no-op for an empty batch", async () => {
    const result = await patchBriefItems("brief-1", []);
    expect(result).toEqual({
      upserted: [],
      skippedHumanAuthorityIds: [],
      skippedUnknownDeferredIds: [],
    });
    expect(mockState.insertCalls).toEqual([]);
  });

  // Regression: the UPDATE branch used to write `evidence`/`state`/
  // `resolution` unconditionally (`item.state ?? "open"`, etc.), so a caller
  // patching only the fields it actually changed silently reset every field
  // it didn't mention. Concretely: fixing the wording of an item that is
  // already `resolved` / `implemented` — sending only
  // `{id, area, statement, kind}` — flipped it back to `state: 'open'` and
  // wiped its `resolution` and `evidence`. This test fails against that old
  // code (the captured `set` used to contain `state: 'open'`,
  // `resolution: null`, `evidence: ''`) and passes now that the UPDATE
  // branch only includes a field in `set` when the caller's patch actually
  // supplied it.
  it("leaves evidence/state/resolution untouched when a patch to an existing item omits them", async () => {
    mockState.selectQueue.push([
      { id: "item-1", authority: "jace", state: "resolved", resolution: "implemented" },
    ]);
    mockState.updateReturningQueue.push([
      briefItemRow({
        id: "item-1",
        statement: "single approver model (typo fixed)",
        state: "resolved",
        resolution: "implemented",
        evidence: "for now since am the only one approve to publish it",
      }),
    ]);

    await patchBriefItems("brief-1", [
      {
        id: "item-1",
        area: "scope",
        statement: "single approver model (typo fixed)",
        kind: "required",
      },
    ]);

    const { set } = mockState.updateCalls[0]!;
    expect(set).not.toHaveProperty("evidence");
    expect(set).not.toHaveProperty("state");
    expect(set).not.toHaveProperty("resolution");
    expect(set.statement).toBe("single approver model (typo fixed)");
  });

  it("does still overwrite evidence/state/resolution when the caller explicitly supplies them", async () => {
    mockState.selectQueue.push([{ id: "item-1", authority: "jace", state: "open", resolution: null }]);
    mockState.updateReturningQueue.push([briefItemRow({ id: "item-1" })]);

    await patchBriefItems("brief-1", [
      {
        id: "item-1",
        area: "scope",
        statement: "single approver model",
        kind: "required",
        evidence: "the human's own words",
        state: "resolved",
        resolution: "implemented",
      },
    ]);

    const { set } = mockState.updateCalls[0]!;
    expect(set.evidence).toBe("the human's own words");
    expect(set.state).toBe("resolved");
    expect(set.resolution).toBe("implemented");
  });

  it("refuses a NEW item that lands as kind: unknown + state: resolved + resolution: deferred — an unknown is never a requirement, so there is nothing to schedule", async () => {
    const result = await patchBriefItems("brief-1", [
      {
        area: "scope",
        statement: "something nobody has answered yet",
        kind: "unknown",
        state: "resolved",
        resolution: "deferred",
      },
    ]);
    expect(result.skippedUnknownDeferredIds).toEqual(["something nobody has answered yet"]);
    expect(result.upserted).toEqual([]);
    expect(mockState.insertCalls).toEqual([]);
  });

  it("refuses an EXISTING item where this patch's kind: unknown combines with the row's own already-stored state/resolution into the forbidden shape, even though this call never touched state/resolution", async () => {
    mockState.selectQueue.push([
      { id: "item-1", authority: "jace", state: "resolved", resolution: "deferred" },
    ]);

    const result = await patchBriefItems("brief-1", [
      { id: "item-1", area: "scope", statement: "re-kinded to unknown", kind: "unknown" },
    ]);

    expect(result.skippedUnknownDeferredIds).toEqual(["item-1"]);
    expect(mockState.updateCalls).toEqual([]);
  });

  it("allows kind: unknown paired with resolution: satisfied-elsewhere — the pinned contract forbids only the specific (unknown, resolved, deferred) combination, not every resolution on an unknown item", async () => {
    mockState.selectQueue.push([{ id: "item-1", authority: "jace", state: "open", resolution: null }]);
    mockState.updateReturningQueue.push([briefItemRow({ id: "item-1", kind: "unknown" })]);

    const result = await patchBriefItems("brief-1", [
      {
        id: "item-1",
        area: "scope",
        statement: "answered via docs, not code",
        kind: "unknown",
        state: "resolved",
        resolution: "satisfied-elsewhere",
      },
    ]);

    expect(result.skippedUnknownDeferredIds).toEqual([]);
    expect(mockState.updateCalls).toHaveLength(1);
  });
});

describe("setBriefStatus", () => {
  it("updates only the status (a human-only label, never inferred readiness)", async () => {
    mockState.updateReturningQueue.push([briefRow({ status: "ready" })]);
    const result = await setBriefStatus("brief-1", "ready");
    expect(result?.status).toBe("ready");
    expect(mockState.updateCalls[0]!.set.status).toBe("ready");
  });

  it("returns null when the brief id doesn't exist", async () => {
    mockState.updateReturningQueue.push([]);
    expect(await setBriefStatus("no-such-id", "ready")).toBeNull();
  });
});

describe("linkBriefWork", () => {
  it("records the issue produced from a brief, with its role", async () => {
    mockState.insertReturningQueue.push({
      id: "link-1",
      briefId: "brief-1",
      briefItemId: null,
      repo: "acme/widgets",
      issueNumber: 42,
      role: "epic-parent",
      createdAt: new Date(),
    });
    const result = await linkBriefWork({
      briefId: "brief-1",
      repo: "acme/widgets",
      issueNumber: 42,
      role: "epic-parent",
    });
    expect(result.issueNumber).toBe(42);
    expect(result.role).toBe("epic-parent");
  });
});

describe("computeBriefReadiness", () => {
  it("is false while an open item has kind: unknown, and names it as a blocker", async () => {
    mockState.selectQueue.push([briefItemRow({ id: "item-unknown", kind: "unknown", state: "open" })]);
    const result = await computeBriefReadiness("brief-1");
    expect(result.ready).toBe(false);
    expect(result.blockingItems).toHaveLength(1);
    expect(result.blockingItems[0]!.id).toBe("item-unknown");
  });

  it("becomes true once that item is marked out-of-scope (no more open+unknown items)", async () => {
    // The item is now kind: 'out-of-scope', so the WHERE (state=open AND
    // kind=unknown) predicate matches nothing.
    mockState.selectQueue.push([]);
    const result = await computeBriefReadiness("brief-1");
    expect(result.ready).toBe(true);
    expect(result.blockingItems).toEqual([]);
  });
});

describe("searchBriefs", () => {
  it("finds a brief by a word appearing only in an item statement, not the title", async () => {
    // The brief's title is "Add a blog" — no mention of "approver" — but one
    // of its items' statement says "single approver", which is what the FTS
    // join over title || item statements must catch.
    mockState.ftsRows = [execBriefRow()];
    mockState.selectQueue.push([
      briefItemRow({ statement: "Publish flow supports a single approver" }),
    ]);

    const result = await searchBriefs("ws-1", "approver");

    expect(result).toHaveLength(1);
    expect(result[0]!.slug).toBe("blog");
    expect(result[0]!.items[0]!.statement).toContain("approver");
  });

  it("skips the FTS round trip for an empty/whitespace query and falls back to recency", async () => {
    mockState.recentRows = [execBriefRow()];
    mockState.selectQueue.push([]); // no items for this brief in this fixture
    const result = await searchBriefs("ws-1", "   ");
    expect(result).toHaveLength(1);
    expect(result[0]!.slug).toBe("blog");
  });

  it("falls back to recency when the FTS query matches nothing", async () => {
    mockState.ftsRows = [];
    mockState.recentRows = [execBriefRow({ slug: "changelog" })];
    mockState.selectQueue.push([]);
    const result = await searchBriefs("ws-1", "no-such-term-anywhere");
    expect(result[0]!.slug).toBe("changelog");
  });

  it("clamps a limit above the max down to BRIEF_SEARCH_MAX_LIMIT", async () => {
    mockState.ftsRows = [execBriefRow()];
    mockState.selectQueue.push([]);
    await searchBriefs("ws-1", "blog", 999);
    const calls = (db.execute as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const { params } = render(calls[0]![0]);
    expect(params[params.length - 1]).toBe(10);
  });
});
