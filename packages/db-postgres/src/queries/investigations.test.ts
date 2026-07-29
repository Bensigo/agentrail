import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * `investigations.ts` backs the durable investigation artifact (debugging
 * design spec, spec PR #1501; `.superpowers/sdd/spec.md` is the working
 * copy). Follows the EXACT mocking idiom `briefs.test.ts` established (that
 * file's own doc-comment: "there is no live-DB harness in this package, so
 * every spec mocks `db`") — confirmed still current by
 * `jace_sessions.brief-anchor.test.ts`, the closest structural sibling to
 * the investigation-anchor trio added alongside this file:
 *
 * - `db.select().from().where()[.orderBy()][.limit()]` is a single reusable
 *   chain object: every terminal call (`.limit()`, or awaiting the chain
 *   directly via its own `.then`) shifts the next fixture off
 *   `mockState.selectQueue`, in call order.
 * - `db.insert()...returning()` / `db.insert()...onConflictDoUpdate()...returning()`
 *   and `db.update()...where().returning()` capture what was written
 *   (`insertCalls`/`onConflictCalls`/`updateCalls`) so assertions can inspect
 *   the actual patch/target rather than a simulated row.
 * - `db.execute(sql\`…\`)` dispatches on the rendered SQL text —
 *   `searchInvestigations`' FTS branch vs its recency fallback.
 * - `db.transaction(cb)` just calls `cb(db)` against the SAME mock, so
 *   `tx.select()`/`tx.insert()`/`tx.update()` inside `patchInvestigationItems`/
 *   `recordVerdict` route through the identical queues.
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
  // linkInvestigationIssue (Task 12 fix round 1) — INSERT ... ON CONFLICT DO
  // NOTHING, distinct from onConflictCalls above (which is the
  // onConflictDoUpdate shape upsertInvestigation uses).
  onConflictDoNothingCalls: [] as Array<{
    values: Record<string, unknown>;
    opts: { target: Array<{ name: string }> };
  }>,
  updateCalls: [] as Array<{ set: Record<string, unknown>; where: unknown }>,
  deleteReturningQueue: [] as unknown[][],
  deleteCalls: [] as Array<{ where: unknown }>,
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
      values: (v: Record<string, unknown>) => {
        let recorded = false;
        const record = () => {
          if (!recorded) {
            recorded = true;
            mockState.insertCalls.push({ values: v });
          }
        };
        return {
          returning: async () => {
            record();
            return [mockState.insertReturningQueue.shift() ?? { id: "generated-id", ...v }];
          },
          onConflictDoUpdate: (opts: { target: Array<{ name: string }>; set: Record<string, unknown> }) => ({
            returning: async () => {
              mockState.onConflictCalls.push({ values: v, opts });
              return [mockState.insertReturningQueue.shift() ?? { id: "generated-id", ...v, ...opts.set }];
            },
          }),
          // linkInvestigationIssue (Task 12 fix round 1) — no `.returning()`,
          // `Promise<void>`, resolved via the bare `.then()` below once
          // recorded into its OWN queue (distinct from onConflictCalls,
          // which is the onConflictDoUpdate shape).
          onConflictDoNothing: (opts: { target: Array<{ name: string }> }) => {
            let onConflictRecorded = false;
            const recordOnConflict = () => {
              if (!onConflictRecorded) {
                onConflictRecorded = true;
                mockState.onConflictDoNothingCalls.push({ values: v, opts });
              }
            };
            return {
              then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
                recordOnConflict();
                return Promise.resolve(undefined).then(resolve, reject);
              },
            };
          },
          // Bare `await db.insert(...).values(...)` with no `.returning()` —
          // e.g. `linkInvestigations`, which returns `Promise<void>` and has
          // no use for the inserted row.
          then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
            record();
            return Promise.resolve(undefined).then(resolve, reject);
          },
        };
      },
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
    delete: (_table: unknown) => ({
      where: (w: unknown) => {
        let recorded = false;
        const record = () => {
          if (!recorded) {
            recorded = true;
            mockState.deleteCalls.push({ where: w });
          }
        };
        return {
          returning: async () => {
            record();
            return mockState.deleteReturningQueue.shift() ?? [];
          },
          // Bare `await db.delete(...).where(...)` — `deleteInvestigationItem`
          // returns `Promise<void>` and never calls `.returning()`.
          then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
            record();
            return Promise.resolve(undefined).then(resolve, reject);
          },
        };
      },
    }),
  };
  return { db };
});

import { db } from "../db.js";
import {
  upsertInvestigation,
  getInvestigationBySlug,
  getInvestigationById,
  listInvestigations,
  searchInvestigations,
  patchInvestigationItems,
  appendEvidenceItem,
  computeVerdictEligibility,
  recordVerdict,
  confirmVerdictAsHuman,
  linkInvestigations,
  linkInvestigationIssue,
  updateInvestigationItemAsHuman,
  createInvestigationItemAsHuman,
  deleteInvestigationItem,
  INVESTIGATION_SEARCH_DEFAULT_LIMIT,
  INVESTIGATION_SEARCH_MAX_LIMIT,
} from "./investigations.js";

const render = (q: unknown) => new PgDialect().sqlToQuery(q as never);

beforeEach(() => {
  mockState.selectQueue = [];
  mockState.insertReturningQueue = [];
  mockState.updateReturningQueue = [];
  mockState.insertCalls = [];
  mockState.onConflictCalls = [];
  mockState.onConflictDoNothingCalls = [];
  mockState.updateCalls = [];
  mockState.deleteReturningQueue = [];
  mockState.deleteCalls = [];
  mockState.ftsRows = [];
  mockState.recentRows = [];
  mockState.txCalls = 0;
  (db.execute as unknown as ReturnType<typeof vi.fn>).mockClear?.();
});

function investigationRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "inv-1",
    workspaceId: "ws-1",
    repositoryId: null,
    slug: "checkout-500s",
    title: "Checkout returns 500",
    status: "open",
    severity: "medium",
    openedBy: "chat",
    symptomStatement: "checkout returns 500 intermittently",
    symptomSignature: "checkout 500 intermittent",
    affectedSurface: "",
    firstSeenAt: null,
    verdict: null,
    confidence: null,
    depthBudget: 8,
    jaceSessionIds: [],
    createdAt: new Date("2026-07-29T00:00:00.000Z"),
    updatedAt: new Date("2026-07-29T00:00:00.000Z"),
    ...overrides,
  };
}

function investigationItemRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "item-1",
    investigationId: "inv-1",
    kind: "hypothesis",
    body: "connection pool exhaustion",
    mechanism: "",
    state: "open",
    evidenceRefs: [],
    data: {},
    authority: "jace",
    createdAt: new Date("2026-07-29T00:00:00.000Z"),
    updatedAt: new Date("2026-07-29T00:00:00.000Z"),
    ...overrides,
  };
}

/** Raw (snake_case) execute-row shape — what searchInvestigations' FTS branch and its recency fallback both return. */
function execInvestigationRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "inv-1",
    workspace_id: "ws-1",
    repository_id: null,
    slug: "checkout-500s",
    title: "Checkout returns 500",
    status: "open",
    severity: "medium",
    opened_by: "chat",
    symptom_statement: "checkout returns 500 intermittently",
    symptom_signature: "checkout 500 intermittent",
    affected_surface: "",
    first_seen_at: null,
    verdict: null,
    confidence: null,
    depth_budget: 8,
    jace_session_ids: [],
    created_at: new Date("2026-07-29T00:00:00.000Z"),
    updated_at: new Date("2026-07-29T00:00:00.000Z"),
    ...overrides,
  };
}

describe("upsertInvestigation", () => {
  it("is idempotent: both the first write and a same-identity re-write target (workspace_id, slug) via onConflictDoUpdate, never a plain insert", async () => {
    await upsertInvestigation({ workspaceId: "ws-1", slug: "checkout-500s", title: "Checkout 500s" });
    await upsertInvestigation({ workspaceId: "ws-1", slug: "checkout-500s", title: "Checkout 500s (renamed)" });

    expect(mockState.onConflictCalls).toHaveLength(2);
    for (const call of mockState.onConflictCalls) {
      expect(call.opts.target.map((c) => c.name)).toEqual(["workspace_id", "slug"]);
    }
    expect(mockState.onConflictCalls[0]!.values.workspaceId).toBe("ws-1");
    expect(mockState.onConflictCalls[0]!.values.slug).toBe("checkout-500s");
  });

  it("is a PARTIAL patch on conflict: an omitted field is left out of the update set, not defaulted, so a later call touching only the title cannot erase an already-set symptomStatement", async () => {
    await upsertInvestigation({
      workspaceId: "ws-1",
      slug: "checkout-500s",
      title: "Checkout 500s",
      symptomStatement: "returns 500 under load",
    });
    await upsertInvestigation({ workspaceId: "ws-1", slug: "checkout-500s", title: "Checkout 500s (renamed)" });

    const secondPatch = mockState.onConflictCalls[1]!.opts.set;
    expect(secondPatch.title).toBe("Checkout 500s (renamed)");
    expect(secondPatch).not.toHaveProperty("symptomStatement");
  });

  it("applies schema defaults on first insert for every omitted optional field", async () => {
    await upsertInvestigation({ workspaceId: "ws-1", slug: "checkout-500s", title: "Checkout 500s" });
    const { values } = mockState.onConflictCalls[0]!;
    expect(values.status).toBeUndefined(); // status is never set on upsert — server-derived (concluded via recordVerdict)
    expect(values.severity).toBe("medium");
    expect(values.openedBy).toBe("chat");
    expect(values.symptomStatement).toBe("");
    expect(values.symptomSignature).toBe("");
    expect(values.affectedSurface).toBe("");
    expect(values.jaceSessionIds).toEqual([]);
    expect(values.repositoryId).toBeNull();
  });

  it("falls back to slug for title when omitted on first insert (title is NOT NULL with no schema default)", async () => {
    await upsertInvestigation({ workspaceId: "ws-1", slug: "checkout-500s" });
    expect(mockState.onConflictCalls[0]!.values.title).toBe("checkout-500s");
  });

  it("appendSessionId seeds jaceSessionIds as a single-element array on first insert", async () => {
    await upsertInvestigation({ workspaceId: "ws-1", slug: "checkout-500s", appendSessionId: "sess-1" });
    expect(mockState.onConflictCalls[0]!.values.jaceSessionIds).toEqual(["sess-1"]);
  });

  it("appendSessionId on the UPDATE branch writes an append-with-dedup SQL expression, not a plain overwrite value", async () => {
    await upsertInvestigation({ workspaceId: "ws-1", slug: "checkout-500s", appendSessionId: "sess-2" });
    const patch = mockState.onConflictCalls[0]!.opts.set;
    expect(patch).toHaveProperty("jaceSessionIds");
    const rendered = render(patch.jaceSessionIds).sql;
    // Must reference the existing column (append/dedup), not a bare replace.
    expect(rendered.toUpperCase()).toContain("CASE");
    expect(rendered).toContain("||");
  });

  it("omitting appendSessionId leaves jaceSessionIds out of the update patch entirely", async () => {
    await upsertInvestigation({ workspaceId: "ws-1", slug: "checkout-500s", title: "x" });
    expect(mockState.onConflictCalls[0]!.opts.set).not.toHaveProperty("jaceSessionIds");
  });
});

describe("getInvestigationBySlug", () => {
  it("returns null when no investigation matches", async () => {
    mockState.selectQueue.push([]);
    expect(await getInvestigationBySlug("ws-1", "no-such-investigation")).toBeNull();
  });

  it("returns { investigation, items } — nested, not flattened", async () => {
    mockState.selectQueue.push([investigationRow()]);
    mockState.selectQueue.push([investigationItemRow(), investigationItemRow({ id: "item-2" })]);
    const result = await getInvestigationBySlug("ws-1", "checkout-500s");
    expect(result?.investigation.slug).toBe("checkout-500s");
    expect(result?.items).toHaveLength(2);
    // Nested shape per the brief's exact signature — not a flattened spread.
    expect((result as unknown as Record<string, unknown>)?.slug).toBeUndefined();
  });
});

describe("getInvestigationById", () => {
  it("returns null when no investigation matches this id", async () => {
    mockState.selectQueue.push([]);
    expect(await getInvestigationById("inv-1")).toBeNull();
  });

  it("returns { investigation, items } keyed by id alone, unscoped by workspace (the id is the security boundary, matching getJaceSessionById/getApprovalById precedent)", async () => {
    mockState.selectQueue.push([investigationRow()]);
    mockState.selectQueue.push([investigationItemRow()]);
    const result = await getInvestigationById("inv-1");
    expect(result?.investigation.id).toBe("inv-1");
    expect(result?.items).toHaveLength(1);
  });
});

describe("listInvestigations", () => {
  it("returns the compact index without items, ordered updated_at desc", async () => {
    mockState.selectQueue.push([investigationRow(), investigationRow({ id: "inv-2", slug: "other" })]);
    const result = await listInvestigations("ws-1");
    expect(result).toHaveLength(2);
    expect(result[0]).not.toHaveProperty("items");
  });

  it("honors an explicit limit", async () => {
    mockState.selectQueue.push([investigationRow()]);
    const result = await listInvestigations("ws-1", 1);
    expect(result).toHaveLength(1);
  });
});

describe("patchInvestigationItems", () => {
  it("skips human-authority items (brief Step 1, test 1)", async () => {
    mockState.selectQueue.push([{ id: "item-1", authority: "human", kind: "hypothesis", state: "open", evidenceRefs: [] }]);

    const result = await patchInvestigationItems("inv-1", [{ id: "item-1", body: "actually the DB" }]);

    expect(result.skippedHumanAuthorityIds).toEqual(["item-1"]);
    expect(result.applied).toEqual([]);
    expect(mockState.updateCalls).toEqual([]);
  });

  it("refuses any write to kind:'evidence' — both editing an existing one and creating a new one (brief Step 1, test 2)", async () => {
    mockState.selectQueue.push([{ id: "ev-1", authority: "jace", kind: "evidence", state: null, evidenceRefs: [] }]);

    const res1 = await patchInvestigationItems("inv-1", [{ id: "ev-1", body: "edited" }]);
    expect(res1.skippedEvidenceImmutableIds).toEqual(["ev-1"]);
    expect(mockState.updateCalls).toEqual([]);

    const res2 = await patchInvestigationItems("inv-1", [{ kind: "evidence", body: "x" }]);
    expect(res2.skippedEvidenceImmutableIds.length).toBe(1);
    expect(mockState.insertCalls).toEqual([]);
  });

  it("hypothesis cannot enter supported/refuted without evidence_refs (brief Step 1, test 3)", async () => {
    const result = await patchInvestigationItems("inv-1", [
      { kind: "hypothesis", body: "pool exhaustion", state: "supported", evidenceRefs: [] },
    ]);
    expect(result.skippedHypothesisNeedsEvidence.length).toBe(1);
    expect(mockState.insertCalls).toEqual([]);
  });

  it("allows a hypothesis to enter supported WITH a non-empty evidence_refs", async () => {
    mockState.insertReturningQueue.push(
      investigationItemRow({ id: "hyp-1", kind: "hypothesis", state: "supported", evidenceRefs: ["ev-1"] })
    );
    const result = await patchInvestigationItems("inv-1", [
      { kind: "hypothesis", body: "pool exhaustion", mechanism: "conn pool starves", state: "supported", evidenceRefs: ["ev-1"] },
    ]);
    expect(result.skippedHypothesisNeedsEvidence).toEqual([]);
    expect(result.applied).toEqual(["hyp-1"]);
  });

  it("still patches a jace-authority item in the same batch that skips a human-authority one", async () => {
    mockState.selectQueue.push([
      { id: "item-human", authority: "human", kind: "hypothesis", state: "open", evidenceRefs: [] },
      { id: "item-jace", authority: "jace", kind: "timeline_event", state: null, evidenceRefs: [] },
    ]);
    mockState.updateReturningQueue.push([investigationItemRow({ id: "item-jace", body: "updated" })]);

    const result = await patchInvestigationItems("inv-1", [
      { id: "item-human", body: "blocked write" },
      { id: "item-jace", body: "updated" },
    ]);

    expect(result.skippedHumanAuthorityIds).toEqual(["item-human"]);
    expect(result.applied).toEqual(["item-jace"]);
    expect(mockState.updateCalls).toHaveLength(1);
  });

  it("inserts a new item (no id) as a plain delta, never touching the pre-check select", async () => {
    mockState.insertReturningQueue.push(investigationItemRow({ id: "new-item" }));
    const result = await patchInvestigationItems("inv-1", [{ kind: "timeline_event", body: "deploy at 14:02 UTC" }]);
    expect(mockState.insertCalls).toHaveLength(1);
    expect(mockState.insertCalls[0]!.values.investigationId).toBe("inv-1");
    expect(result.applied).toEqual(["new-item"]);
  });

  it("runs inside one transaction", async () => {
    mockState.insertReturningQueue.push(investigationItemRow());
    await patchInvestigationItems("inv-1", [{ kind: "timeline_event", body: "x" }]);
    expect(mockState.txCalls).toBe(1);
  });

  it("is a no-op for an empty batch (no transaction started)", async () => {
    const result = await patchInvestigationItems("inv-1", []);
    expect(result).toEqual({
      applied: [],
      skippedHumanAuthorityIds: [],
      skippedEvidenceImmutableIds: [],
      skippedHypothesisNeedsEvidence: [],
      skippedKindChangeIds: [],
      unmatchedIds: [],
    });
    expect(mockState.txCalls).toBe(0);
  });

  it("field-level partial update: only fields the caller supplied land in the UPDATE set", async () => {
    mockState.selectQueue.push([{ id: "item-1", authority: "jace", kind: "hypothesis", state: "open", evidenceRefs: [] }]);
    mockState.updateReturningQueue.push([investigationItemRow({ id: "item-1" })]);

    await patchInvestigationItems("inv-1", [{ id: "item-1", body: "typo fixed" }]);

    const { set } = mockState.updateCalls[0]!;
    expect(set.body).toBe("typo fixed");
    expect(set).not.toHaveProperty("kind");
    expect(set).not.toHaveProperty("mechanism");
    expect(set).not.toHaveProperty("state");
    expect(set).not.toHaveProperty("evidenceRefs");
    expect(set).not.toHaveProperty("data");
  });

  it("the evidence-linkage guard reads the EFFECTIVE (merged) state/refs, not just the fields this call names — an update that only sends state:'supported' on an existing hypothesis with empty stored evidence_refs is still refused", async () => {
    mockState.selectQueue.push([{ id: "item-1", authority: "jace", kind: "hypothesis", state: "open", evidenceRefs: [] }]);

    const result = await patchInvestigationItems("inv-1", [{ id: "item-1", state: "supported" }]);

    expect(result.skippedHypothesisNeedsEvidence).toEqual(["item-1"]);
    expect(mockState.updateCalls).toEqual([]);
  });

  // --- Fix round 1: kind-change bypass -------------------------------------
  // Fixed bug: the evidence-immutable and hypothesis-evidence guards read the
  // row's EXISTING kind, so a patch that CHANGES kind slipped both. Kind is
  // now immutable through this path — an existing item's kind never moves,
  // only its state does (unlike `brief_items`, where re-kinding IS the
  // resolution mechanism).

  it("refuses a kind CHANGE on an existing item — hypothesis -> evidence would otherwise convert a row into evidence out from under appendEvidenceItem's sole-writer invariant", async () => {
    mockState.selectQueue.push([{ id: "hyp-1", authority: "jace", kind: "hypothesis", state: "open", evidenceRefs: [] }]);

    const result = await patchInvestigationItems("inv-1", [{ id: "hyp-1", kind: "evidence" }]);

    expect(result.skippedKindChangeIds).toEqual(["hyp-1"]);
    // Caught by the kind-change guard specifically, not misattributed to the evidence guard.
    expect(result.skippedEvidenceImmutableIds).toEqual([]);
    expect(mockState.updateCalls).toEqual([]);
  });

  it("refuses a kind CHANGE on an existing item — finding -> hypothesis(supported, []) would otherwise smuggle an unevidenced supported hypothesis past the evidence-gate guard", async () => {
    mockState.selectQueue.push([{ id: "find-1", authority: "jace", kind: "finding", state: null, evidenceRefs: [] }]);

    const result = await patchInvestigationItems("inv-1", [
      { id: "find-1", kind: "hypothesis", state: "supported", evidenceRefs: [] },
    ]);

    expect(result.skippedKindChangeIds).toEqual(["find-1"]);
    // Caught by the kind-change guard BEFORE the hypothesis-gate guard would even run.
    expect(result.skippedHypothesisNeedsEvidence).toEqual([]);
    expect(mockState.updateCalls).toEqual([]);
  });

  it("does not refuse a patch that names the SAME kind as the existing row — only an actual CHANGE is refused", async () => {
    mockState.selectQueue.push([{ id: "item-1", authority: "jace", kind: "timeline_event", state: null, evidenceRefs: [] }]);
    mockState.updateReturningQueue.push([investigationItemRow({ id: "item-1", kind: "timeline_event" })]);

    const result = await patchInvestigationItems("inv-1", [{ id: "item-1", kind: "timeline_event", body: "updated" }]);

    expect(result.skippedKindChangeIds).toEqual([]);
    expect(result.applied).toEqual(["item-1"]);
  });

  // --- Fix round 1: TOCTOU on the UPDATE's own WHERE -----------------------
  // Fixed bug: the pre-check SELECT is a snapshot under READ COMMITTED, not a
  // lock. The guard that actually holds is on the UPDATE's own WHERE
  // (ne(authority,'human') AND ne(kind,'evidence')); the pre-check is only
  // used to CLASSIFY a zero-row UPDATE result afterward.

  it("TOCTOU: pre-check found the row, but the guarded UPDATE matches zero rows (a concurrent human edit or delete landed in between) — reported as skippedHumanAuthorityIds, not silently dropped or wrongly applied", async () => {
    mockState.selectQueue.push([{ id: "item-1", authority: "jace", kind: "timeline_event", state: null, evidenceRefs: [] }]);
    mockState.updateReturningQueue.push([]); // simulates the guarded UPDATE losing the race

    const result = await patchInvestigationItems("inv-1", [{ id: "item-1", body: "updated" }]);

    expect(result.skippedHumanAuthorityIds).toEqual(["item-1"]);
    expect(result.applied).toEqual([]);
    expect(result.unmatchedIds).toEqual([]);
  });

  it("reports an id that belongs to a DIFFERENT investigation as unmatchedIds, not a silent vanish — the pre-check SELECT (scoped to THIS investigationId) never finds it, and the guarded UPDATE (same scope) then confirms zero rows matched", async () => {
    mockState.selectQueue.push([]); // pre-check: scoped to inv-1, this id belongs elsewhere
    mockState.updateReturningQueue.push([]); // guarded UPDATE, same scope, also matches nothing

    const result = await patchInvestigationItems("inv-1", [{ id: "item-from-another-investigation", body: "x" }]);

    expect(result.unmatchedIds).toEqual(["item-from-another-investigation"]);
    expect(result.applied).toEqual([]);
    expect(result.skippedHumanAuthorityIds).toEqual([]);
    expect(mockState.updateCalls).toHaveLength(1); // the UPDATE's own WHERE is the real source of truth, not the pre-check
  });

  it("reports a completely nonexistent id as unmatchedIds too", async () => {
    mockState.selectQueue.push([]);
    mockState.updateReturningQueue.push([]);

    const result = await patchInvestigationItems("inv-1", [{ id: "no-such-item-ever", body: "x" }]);

    expect(result.unmatchedIds).toEqual(["no-such-item-ever"]);
    expect(mockState.updateCalls).toHaveLength(1);
  });

  it("the guarded UPDATE's WHERE carries the authority/kind TOCTOU re-check predicates (shape assertion only — the mocked suite proves this code CONSTRUCTS the guarded predicate with the right bound values; it cannot prove Postgres enforces them at commit time, since nothing here executes against a real database)", async () => {
    mockState.selectQueue.push([{ id: "item-1", authority: "jace", kind: "timeline_event", state: null, evidenceRefs: [] }]);
    mockState.updateReturningQueue.push([investigationItemRow({ id: "item-1" })]);

    await patchInvestigationItems("inv-1", [{ id: "item-1", body: "updated" }]);

    const whereArg = mockState.updateCalls[0]!.where;
    const rendered = render(whereArg);
    expect(rendered.params).toContain("human");
    expect(rendered.params).toContain("evidence");
  });
});

describe("appendEvidenceItem", () => {
  it("inserts a kind:'evidence' item and returns just its id", async () => {
    mockState.insertReturningQueue.push({ id: "ev-1" });
    const result = await appendEvidenceItem("inv-1", {
      body: "railway search_events excerpt",
      data: { provider: "railway", verb: "search_events" },
    });
    expect(result).toEqual({ id: "ev-1" });
    expect(mockState.insertCalls[0]!.values.kind).toBe("evidence");
    expect(mockState.insertCalls[0]!.values.investigationId).toBe("inv-1");
  });
});

describe("computeVerdictEligibility", () => {
  it("is ineligible with no items at all, blocking both reasons", async () => {
    mockState.selectQueue.push([]);
    const result = await computeVerdictEligibility("inv-1");
    expect(result.eligible).toBe(false);
    expect(result.blocking).toEqual([
      "no supported hypothesis with mechanism and evidence",
      "no refuted rival hypothesis and no solePlausible finding",
    ]);
  });

  it("blocks on missing supported hypothesis even when a refuted rival exists", async () => {
    mockState.selectQueue.push([
      investigationItemRow({ id: "h2", kind: "hypothesis", state: "refuted", evidenceRefs: ["ev-1"] }),
    ]);
    const result = await computeVerdictEligibility("inv-1");
    expect(result.eligible).toBe(false);
    expect(result.blocking).toEqual(["no supported hypothesis with mechanism and evidence"]);
  });

  it("a supported hypothesis with empty mechanism does not count as eligible-supporting", async () => {
    mockState.selectQueue.push([
      investigationItemRow({ id: "h1", kind: "hypothesis", state: "supported", mechanism: "", evidenceRefs: ["ev-1"] }),
    ]);
    const result = await computeVerdictEligibility("inv-1");
    expect(result.blocking).toContain("no supported hypothesis with mechanism and evidence");
  });

  it("blocks on missing refuted rival even with a supported hypothesis (no solePlausible finding either)", async () => {
    mockState.selectQueue.push([
      investigationItemRow({ id: "h1", kind: "hypothesis", state: "supported", mechanism: "conn pool starves", evidenceRefs: ["ev-1"] }),
    ]);
    const result = await computeVerdictEligibility("inv-1");
    expect(result.eligible).toBe(false);
    expect(result.blocking).toEqual(["no refuted rival hypothesis and no solePlausible finding"]);
  });

  it("is eligible with a supported hypothesis (mechanism+evidence) AND a refuted rival (evidence)", async () => {
    mockState.selectQueue.push([
      investigationItemRow({ id: "h1", kind: "hypothesis", state: "supported", mechanism: "conn pool starves", evidenceRefs: ["ev-1"] }),
      investigationItemRow({ id: "h2", kind: "hypothesis", state: "refuted", evidenceRefs: ["ev-1"] }),
    ]);
    const result = await computeVerdictEligibility("inv-1");
    expect(result).toEqual({ eligible: true, blocking: [] });
  });

  it("a solePlausible finding substitutes for a refuted rival", async () => {
    mockState.selectQueue.push([
      investigationItemRow({ id: "h1", kind: "hypothesis", state: "supported", mechanism: "conn pool starves", evidenceRefs: ["ev-1"] }),
      investigationItemRow({ id: "f1", kind: "finding", data: { solePlausible: true } }),
    ]);
    const result = await computeVerdictEligibility("inv-1");
    expect(result).toEqual({ eligible: true, blocking: [] });
  });

  it("the eligibility transition end-to-end (brief Step 2, test 1 — mirrors the write sequence, mocked per-call)", async () => {
    // Call 1: brand new investigation, nothing yet.
    mockState.selectQueue.push([]);
    expect((await computeVerdictEligibility("inv-1")).eligible).toBe(false);

    // Call 2: after H1 (supported, mechanism+evidence) — still no refuted rival.
    mockState.selectQueue.push([
      investigationItemRow({ id: "h1", kind: "hypothesis", body: "H1", state: "supported", mechanism: "conn pool starves", evidenceRefs: ["ev-1"] }),
    ]);
    expect((await computeVerdictEligibility("inv-1")).eligible).toBe(false);

    // Call 3: after H2 (refuted, with evidence) too — now eligible.
    mockState.selectQueue.push([
      investigationItemRow({ id: "h1", kind: "hypothesis", body: "H1", state: "supported", mechanism: "conn pool starves", evidenceRefs: ["ev-1"] }),
      investigationItemRow({ id: "h2", kind: "hypothesis", body: "H2", state: "refuted", evidenceRefs: ["ev-1"] }),
    ]);
    expect((await computeVerdictEligibility("inv-1")).eligible).toBe(true);
  });
});

describe("recordVerdict", () => {
  // Every path — including the fail-closed ones — first confirms the
  // investigation row exists (Fix round 1, FIX 3), so every test pushes that
  // existence-check fixture first, before any branch-specific fixture.

  it("root_caused fails closed when ineligible, surfacing computeVerdictEligibility's own blocking reasons", async () => {
    mockState.selectQueue.push([{ id: "inv-1" }]); // existence check
    mockState.selectQueue.push([]); // no items -> ineligible
    const result = await recordVerdict("inv-1", { verdict: "root_caused", confidence: "probable" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocking).toEqual([
        "no supported hypothesis with mechanism and evidence",
        "no refuted rival hypothesis and no solePlausible finding",
      ]);
    }
    expect(mockState.insertCalls).toEqual([]);
    expect(mockState.updateCalls).toEqual([]);
  });

  it("root_caused fails closed when eligible but confidence is missing", async () => {
    mockState.selectQueue.push([{ id: "inv-1" }]); // existence check
    mockState.selectQueue.push([
      investigationItemRow({ id: "h1", kind: "hypothesis", state: "supported", mechanism: "conn pool starves", evidenceRefs: ["ev-1"] }),
      investigationItemRow({ id: "h2", kind: "hypothesis", state: "refuted", evidenceRefs: ["ev-1"] }),
    ]);
    const result = await recordVerdict("inv-1", { verdict: "root_caused" });
    expect(result.ok).toBe(false);
    expect(mockState.insertCalls).toEqual([]);
  });

  it("root_caused succeeds when eligible AND confidence is supplied — appends a verdict item and denormalizes the investigation row", async () => {
    mockState.selectQueue.push([{ id: "inv-1" }]); // existence check
    mockState.selectQueue.push([
      investigationItemRow({ id: "h1", kind: "hypothesis", state: "supported", mechanism: "conn pool starves", evidenceRefs: ["ev-1"] }),
      investigationItemRow({ id: "h2", kind: "hypothesis", state: "refuted", evidenceRefs: ["ev-1"] }),
    ]);
    mockState.insertReturningQueue.push(investigationItemRow({ id: "verdict-1", kind: "verdict" }));
    mockState.updateReturningQueue.push([investigationRow({ verdict: "root_caused", confidence: "confirmed", status: "concluded" })]);

    const result = await recordVerdict("inv-1", {
      verdict: "root_caused",
      confidence: "confirmed",
      mechanismSummary: "connection pool starved under load",
    });

    expect(result.ok).toBe(true);
    expect(mockState.insertCalls[0]!.values.kind).toBe("verdict");
    expect(mockState.insertCalls[0]!.values.body).toBe("connection pool starved under load");
    expect(mockState.updateCalls[0]!.set.verdict).toBe("root_caused");
    expect(mockState.updateCalls[0]!.set.confidence).toBe("confirmed");
    expect(mockState.updateCalls[0]!.set.status).toBe("concluded");
  });

  it("undetermined fails closed when missingEvidence is empty (brief Step 2, test 2)", async () => {
    mockState.selectQueue.push([{ id: "inv-1" }]); // existence check
    const result = await recordVerdict("inv-1", { verdict: "undetermined", missingEvidence: [] });
    expect(result.ok).toBe(false);
    expect(mockState.insertCalls).toEqual([]);
  });

  it("undetermined fails closed when missingEvidence is omitted entirely", async () => {
    mockState.selectQueue.push([{ id: "inv-1" }]); // existence check
    const result = await recordVerdict("inv-1", { verdict: "undetermined" });
    expect(result.ok).toBe(false);
  });

  it("undetermined succeeds with a non-empty missingEvidence (brief Step 2, test 2) — no ELIGIBILITY check for undetermined (only the existence check, shared by both branches)", async () => {
    mockState.selectQueue.push([{ id: "inv-1" }]); // existence check — the only select undetermined ever does
    mockState.insertReturningQueue.push(investigationItemRow({ id: "verdict-1", kind: "verdict" }));
    mockState.updateReturningQueue.push([investigationRow({ verdict: "undetermined", status: "concluded" })]);

    const result = await recordVerdict("inv-1", {
      verdict: "undetermined",
      missingEvidence: ["metrics for checkout during window"],
    });

    expect(result.ok).toBe(true);
    // undetermined never reads investigation_items for eligibility — only the shared existence check above.
    expect(mockState.insertCalls[0]!.values.data).toEqual({
      confidence: null,
      missingEvidence: ["metrics for checkout during window"],
    });
  });

  it("never updates an existing verdict item — calling twice inserts two separate items", async () => {
    mockState.selectQueue.push([{ id: "inv-1" }]); // existence check, call 1
    mockState.insertReturningQueue.push(investigationItemRow({ id: "verdict-1", kind: "verdict" }));
    mockState.updateReturningQueue.push([investigationRow()]);
    mockState.selectQueue.push([{ id: "inv-1" }]); // existence check, call 2
    mockState.insertReturningQueue.push(investigationItemRow({ id: "verdict-2", kind: "verdict" }));
    mockState.updateReturningQueue.push([investigationRow()]);

    await recordVerdict("inv-1", { verdict: "undetermined", missingEvidence: ["a"] });
    await recordVerdict("inv-1", { verdict: "undetermined", missingEvidence: ["b"] });

    expect(mockState.insertCalls).toHaveLength(2);
    expect(mockState.updateCalls).toHaveLength(2); // two UPDATEs, never a second insert being skipped
  });

  it("runs inside one transaction", async () => {
    mockState.selectQueue.push([{ id: "inv-1" }]); // existence check
    mockState.insertReturningQueue.push(investigationItemRow());
    mockState.updateReturningQueue.push([investigationRow()]);
    await recordVerdict("inv-1", { verdict: "undetermined", missingEvidence: ["a"] });
    expect(mockState.txCalls).toBe(1);
  });

  // --- Fix round 1: recordVerdict asymmetry on a missing investigation ----
  // Fixed bug: `undetermined` skipped straight to an INSERT and threw a raw
  // Postgres FK violation for a nonexistent investigationId, while
  // `root_caused` happened to fail "gracefully" only by accident (an empty
  // items SELECT reads as ineligible, with a misleading blocking reason).
  // Both branches now share one existence check ahead of any branch logic.

  it("root_caused returns a tagged 'investigation not found' result — never reaches the eligibility check or attempts a write", async () => {
    mockState.selectQueue.push([]); // existence check finds nothing
    const result = await recordVerdict("no-such-investigation", { verdict: "root_caused", confidence: "confirmed" });
    expect(result).toEqual({ ok: false, blocking: ["investigation not found"] });
    expect(mockState.insertCalls).toEqual([]);
    expect(mockState.updateCalls).toEqual([]);
  });

  it("undetermined returns a tagged 'investigation not found' result — previously this branch threw an unhandled FK violation instead", async () => {
    mockState.selectQueue.push([]); // existence check finds nothing
    const result = await recordVerdict("no-such-investigation", { verdict: "undetermined", missingEvidence: ["a"] });
    expect(result).toEqual({ ok: false, blocking: ["investigation not found"] });
    expect(mockState.insertCalls).toEqual([]);
    expect(mockState.updateCalls).toEqual([]);
  });
});

describe("confirmVerdictAsHuman", () => {
  it("returns { ok: false, reason: 'no_verdict' } when the investigation has no verdict item yet", async () => {
    mockState.selectQueue.push([]); // latest-verdict lookup finds nothing
    const result = await confirmVerdictAsHuman("inv-1");
    expect(result).toEqual({ ok: false, reason: "no_verdict" });
    expect(mockState.updateCalls).toEqual([]);
  });

  it("sets data.humanConfirmed = true on the latest verdict item, preserving its other data fields", async () => {
    mockState.selectQueue.push([
      investigationItemRow({
        id: "verdict-2",
        kind: "verdict",
        data: { confidence: "probable", missingEvidence: [] },
      }),
    ]);
    mockState.updateReturningQueue.push([
      investigationItemRow({
        id: "verdict-2",
        kind: "verdict",
        data: { confidence: "probable", missingEvidence: [], humanConfirmed: true },
      }),
    ]);

    const result = await confirmVerdictAsHuman("inv-1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.item.id).toBe("verdict-2");
      expect(result.item.data).toEqual({ confidence: "probable", missingEvidence: [], humanConfirmed: true });
    }
    expect(mockState.updateCalls[0]!.set.data).toEqual({
      confidence: "probable",
      missingEvidence: [],
      humanConfirmed: true,
    });
    // Never flips authority — see this function's own doc-comment.
    expect(mockState.updateCalls[0]!.set).not.toHaveProperty("authority");
  });

  it("does NOT reuse updateInvestigationItemAsHuman's guards — targets the item by id directly, so a verdict item (never kind:'evidence'/'hypothesis') is always writable here", async () => {
    mockState.selectQueue.push([investigationItemRow({ id: "verdict-1", kind: "verdict", data: {} })]);
    mockState.updateReturningQueue.push([
      investigationItemRow({ id: "verdict-1", kind: "verdict", data: { humanConfirmed: true } }),
    ]);
    const result = await confirmVerdictAsHuman("inv-1");
    expect(result).toEqual({
      ok: true,
      item: investigationItemRow({ id: "verdict-1", kind: "verdict", data: { humanConfirmed: true } }),
    });
  });
});

describe("linkInvestigations", () => {
  it("records a recurrence_of link and round-trips it (brief: 'also test')", async () => {
    await linkInvestigations("inv-new", "inv-old", "recurrence_of");
    expect(mockState.insertCalls).toHaveLength(1);
    expect(mockState.insertCalls[0]!.values).toMatchObject({
      investigationId: "inv-new",
      targetInvestigationId: "inv-old",
      role: "recurrence_of",
    });
  });

  it("records a related link with its own role", async () => {
    await linkInvestigations("inv-a", "inv-b", "related");
    expect(mockState.insertCalls[0]!.values.role).toBe("related");
  });
});

describe("linkInvestigationIssue", () => {
  it("records the issue an investigation produced, with its role", async () => {
    await linkInvestigationIssue("inv-1", "acme/widgets", 42, "mitigative");
    expect(mockState.onConflictDoNothingCalls[0]!.values).toMatchObject({
      investigationId: "inv-1",
      repo: "acme/widgets",
      issueNumber: 42,
      role: "mitigative",
    });
  });

  // Task 12 fix round 1 (review finding): the approvals seam
  // (POST .../approvals/[id]/published) calls this with NO read-check
  // ahead of it — stampPublishedIssueUrl's own "stamped" outcome covers
  // both a fresh stamp and a same-value replay, so this function can
  // genuinely run twice for the identical (investigationId, repo,
  // issueNumber) triple. Idempotency is now enforced by the database's
  // unique index (migration 0063, investigation_issue_links_unique) via
  // ON CONFLICT DO NOTHING, not an application-level SELECT-then-INSERT
  // guard (the now-removed hasInvestigationIssueLink).
  it("targets the (investigation_id, repo, issue_number) unique index via ON CONFLICT DO NOTHING — calling it twice with the SAME triple issues two identically-shaped calls (shape assertion only, mirroring the TOCTOU WHERE-shape test above: the mocked suite proves this code CONSTRUCTS the right ON CONFLICT target; it cannot prove Postgres's unique index actually collapses them to one row at commit time, since nothing here executes against a real database — that guarantee lives in migration 0063's CREATE UNIQUE INDEX)", async () => {
    await linkInvestigationIssue("inv-1", "acme/widgets", 42, "mitigative");
    await linkInvestigationIssue("inv-1", "acme/widgets", 42, "mitigative");

    expect(mockState.onConflictDoNothingCalls).toHaveLength(2);
    for (const call of mockState.onConflictDoNothingCalls) {
      expect(call.opts.target.map((c) => c.name)).toEqual([
        "investigation_id",
        "repo",
        "issue_number",
      ]);
    }
  });

  it("never touches the plain-insert path (insertCalls) — this write only ever goes through the ON CONFLICT DO NOTHING branch", async () => {
    await linkInvestigationIssue("inv-1", "acme/widgets", 42, "preventative");
    expect(mockState.insertCalls).toEqual([]);
  });
});

describe("updateInvestigationItemAsHuman", () => {
  it("returns item: null when the item doesn't exist", async () => {
    mockState.selectQueue.push([]);
    const result = await updateInvestigationItemAsHuman("no-such-item", { body: "x" });
    expect(result).toEqual({ item: null, refusedEvidenceImmutable: false, refusedHypothesisNeedsEvidence: false });
    expect(mockState.updateCalls).toEqual([]);
  });

  it("CAN overwrite a row that is already authority:'human' — that is the whole point of this function", async () => {
    mockState.selectQueue.push([{ kind: "hypothesis", state: "open", evidenceRefs: [] }]);
    mockState.updateReturningQueue.push([investigationItemRow({ id: "item-1", body: "corrected again", authority: "human" })]);

    const result = await updateInvestigationItemAsHuman("item-1", { body: "corrected again" });

    expect(result.item?.body).toBe("corrected again");
    expect(mockState.updateCalls[0]!.set.authority).toBe("human");
  });

  it("refuses state:supported|refuted on a hypothesis with empty EFFECTIVE evidence_refs — the evidence-linkage invariant binds humans too", async () => {
    mockState.selectQueue.push([{ kind: "hypothesis", state: "open", evidenceRefs: [] }]);

    const result = await updateInvestigationItemAsHuman("item-1", { state: "supported" });

    expect(result).toEqual({ item: null, refusedEvidenceImmutable: false, refusedHypothesisNeedsEvidence: true });
    expect(mockState.updateCalls).toEqual([]);
  });

  it("allows state:supported when the stored evidence_refs is already non-empty, even though this call doesn't mention evidenceRefs", async () => {
    mockState.selectQueue.push([{ kind: "hypothesis", state: "open", evidenceRefs: ["ev-1"] }]);
    mockState.updateReturningQueue.push([investigationItemRow({ id: "item-1", state: "supported", evidenceRefs: ["ev-1"] })]);

    const result = await updateInvestigationItemAsHuman("item-1", { state: "supported" });

    expect(result.refusedHypothesisNeedsEvidence).toBe(false);
    expect(mockState.updateCalls).toHaveLength(1);
  });

  it("refuses editing a kind:'evidence' item — evidence stays immutable regardless of authority", async () => {
    mockState.selectQueue.push([{ kind: "evidence", state: null, evidenceRefs: [] }]);

    const result = await updateInvestigationItemAsHuman("ev-1", { body: "redacted" });

    expect(result).toEqual({ item: null, refusedEvidenceImmutable: true, refusedHypothesisNeedsEvidence: false });
    expect(mockState.updateCalls).toEqual([]);
  });

  it("is a partial patch: a field omitted from the patch is left out of the update set entirely", async () => {
    mockState.selectQueue.push([{ kind: "hypothesis", state: "open", evidenceRefs: [] }]);
    mockState.updateReturningQueue.push([investigationItemRow({ id: "item-1" })]);

    await updateInvestigationItemAsHuman("item-1", { body: "typo fixed" });

    const { set } = mockState.updateCalls[0]!;
    expect(set.body).toBe("typo fixed");
    expect(set).not.toHaveProperty("kind");
    expect(set).not.toHaveProperty("mechanism");
    expect(set).not.toHaveProperty("state");
    expect(set).not.toHaveProperty("evidenceRefs");
    expect(set).not.toHaveProperty("data");
  });
});

describe("createInvestigationItemAsHuman", () => {
  it("inserts a new item with authority forced to 'human'", async () => {
    mockState.insertReturningQueue.push(investigationItemRow({ id: "item-new", authority: "human", kind: "timeline_event" }));

    const result = await createInvestigationItemAsHuman("inv-1", { kind: "timeline_event", body: "human note" });

    expect(result.refusedEvidenceImmutable).toBe(false);
    expect(result.refusedHypothesisNeedsEvidence).toBe(false);
    expect(mockState.insertCalls[0]!.values.authority).toBe("human");
    expect(mockState.insertCalls[0]!.values.investigationId).toBe("inv-1");
  });

  it("refuses a brand-new item with kind:'evidence' — appendEvidenceItem is the only inserter of that kind", async () => {
    const result = await createInvestigationItemAsHuman("inv-1", { kind: "evidence", body: "x" });
    expect(result).toEqual({ item: null, refusedEvidenceImmutable: true, refusedHypothesisNeedsEvidence: false });
    expect(mockState.insertCalls).toEqual([]);
  });

  it("refuses a brand-new hypothesis entering supported/refuted with empty evidenceRefs (brief's own literal test snippet uses this shape with state:'open', which does NOT trigger this guard)", async () => {
    const result = await createInvestigationItemAsHuman("inv-1", {
      kind: "hypothesis",
      body: "not the DB",
      state: "supported",
      evidenceRefs: [],
    });
    expect(result).toEqual({ item: null, refusedEvidenceImmutable: false, refusedHypothesisNeedsEvidence: true });
    expect(mockState.insertCalls).toEqual([]);
  });

  it("the brief's own literal test snippet: kind:'hypothesis', state:'open' — no evidence gate triggered", async () => {
    mockState.insertReturningQueue.push(
      investigationItemRow({ id: "item-new", authority: "human", kind: "hypothesis", body: "not the DB", state: "open" })
    );
    const result = await createInvestigationItemAsHuman("inv-1", { kind: "hypothesis", body: "not the DB", state: "open" });
    expect(result.item?.body).toBe("not the DB");
    expect(result.refusedHypothesisNeedsEvidence).toBe(false);
  });

  it("defaults mechanism/evidenceRefs/data/state when omitted", async () => {
    mockState.insertReturningQueue.push(investigationItemRow({ id: "item-new" }));
    await createInvestigationItemAsHuman("inv-1", { kind: "timeline_event", body: "note" });
    expect(mockState.insertCalls[0]!.values.mechanism).toBe("");
    expect(mockState.insertCalls[0]!.values.evidenceRefs).toEqual([]);
    expect(mockState.insertCalls[0]!.values.data).toEqual({});
    expect(mockState.insertCalls[0]!.values.state).toBeNull();
  });
});

describe("deleteInvestigationItem", () => {
  it("is unrestricted — same doctrine as briefs' deleteBriefItem: no authority/kind check, deletion is the visible bypass", async () => {
    mockState.deleteReturningQueue.push([{ id: "item-1" }]);
    await deleteInvestigationItem("item-1");
    expect(mockState.deleteCalls).toHaveLength(1);
  });

  it("is a no-op (never throws) when nothing matches", async () => {
    mockState.deleteReturningQueue.push([]);
    await expect(deleteInvestigationItem("no-such-item")).resolves.toBeUndefined();
  });
});

describe("searchInvestigations", () => {
  it("finds a seeded investigation by a word in symptom_signature", async () => {
    mockState.ftsRows = [execInvestigationRow({ symptom_signature: "checkout 500 intermittent under load" })];
    const result = await searchInvestigations("ws-1", "intermittent");
    expect(result).toHaveLength(1);
    expect(result[0]!.slug).toBe("checkout-500s");
  });

  it("skips the FTS round trip for an empty/whitespace query and falls back to recency", async () => {
    mockState.recentRows = [execInvestigationRow()];
    const result = await searchInvestigations("ws-1", "   ");
    expect(result).toHaveLength(1);
    expect(result[0]!.slug).toBe("checkout-500s");
  });

  it("falls back to most-recently-updated on zero FTS hits (brief: 'also test')", async () => {
    mockState.ftsRows = [];
    mockState.recentRows = [execInvestigationRow({ slug: "other-recent-incident" })];
    const result = await searchInvestigations("ws-1", "no-such-term-anywhere");
    expect(result[0]!.slug).toBe("other-recent-incident");
  });

  it("returns index rows with no items attached (unlike searchBriefs)", async () => {
    mockState.ftsRows = [execInvestigationRow()];
    const result = await searchInvestigations("ws-1", "checkout");
    expect(result[0]).not.toHaveProperty("items");
  });

  it("clamps a limit above the max down to INVESTIGATION_SEARCH_MAX_LIMIT", async () => {
    mockState.ftsRows = [execInvestigationRow()];
    await searchInvestigations("ws-1", "checkout", 999);
    const calls = (db.execute as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const { params } = render(calls[0]![0]);
    expect(params[params.length - 1]).toBe(INVESTIGATION_SEARCH_MAX_LIMIT);
  });

  it("defaults to INVESTIGATION_SEARCH_DEFAULT_LIMIT when omitted", async () => {
    mockState.ftsRows = [execInvestigationRow()];
    await searchInvestigations("ws-1", "checkout");
    const calls = (db.execute as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const { params } = render(calls[0]![0]);
    expect(params[params.length - 1]).toBe(INVESTIGATION_SEARCH_DEFAULT_LIMIT);
  });
});
