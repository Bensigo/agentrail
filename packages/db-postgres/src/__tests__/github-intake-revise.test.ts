import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #1345 PR② — the revise loop's state-transition half:
 * `findQueueEntryByExternalId` (a read-only lookup) and
 * `reviseAlignmentBrief` (the supersede-the-denial write). Argument-level
 * (no real Postgres), mirroring `github-intake-alignment-gate.test.ts`'s own
 * value-capturing mock idiom: `select` is keyed off the COLUMN NAME the
 * caller asked for (so one mock serves both functions' different selects),
 * `update`/`set`/`where`/`returning` records what was written, and
 * `db.transaction` is mocked as `(cb) => cb(dbMock)` since
 * `reviseAlignmentBrief` reads-then-writes inside one.
 *
 * The AC3 invariant this file exists to pin: `reviseAlignmentBrief` must
 * NEVER write `state` to anything (it stays out of the SET entirely — the
 * row's `state` column is simply never touched), and must write
 * `estimatedBudgetUsd`/`modelOverride`/`taskType` to `null` and nothing
 * else. A denied entry can therefore never become claimable through this
 * function alone — only `confirmAlignmentBrief` (untouched by this PR, and
 * itself gated on a fresh `approved` alignment_brief approval) can ever flip
 * `state` to `queued`.
 */
let mockFindRows: unknown[];
let mockReviseReadRows: unknown[];
let updateCalls: Array<Record<string, unknown>> = [];
let updateMatches: boolean;
let updateReturning: unknown[];
let lastFindWhere: unknown;
let lastReviseUpdateWhere: unknown;

vi.mock("../db.js", () => {
  const dbMock = {
    select: (cols?: Record<string, unknown>) => ({
      from: () => ({
        where: async (whereExpr?: unknown) => {
          if (cols && Object.prototype.hasOwnProperty.call(cols, "title")) {
            // findQueueEntryByExternalId's own select shape: {id, state, parkReason, title, body}.
            lastFindWhere = whereExpr;
            return mockFindRows;
          }
          // reviseAlignmentBrief's own read select: {state, parkReason} — no "title" key.
          return mockReviseReadRows;
        },
      }),
    }),
    update: vi.fn(() => ({
      set: vi.fn((s: Record<string, unknown>) => {
        updateCalls.push(s);
        return {
          where: (whereExpr?: unknown) => {
            lastReviseUpdateWhere = whereExpr;
            return {
              returning: async () => (updateMatches ? updateReturning : []),
            };
          },
        };
      }),
    })),
    transaction: async (cb: (tx: typeof dbMock) => unknown) => cb(dbMock),
  };
  return { db: dbMock };
});

import {
  findQueueEntryByExternalId,
  reviseAlignmentBrief,
  ALIGNMENT_PARK_REASON,
  ALIGNMENT_DENIED_PARK_REASON,
} from "../queries/github_intake.js";

const REVISED_UPDATED_AT = new Date("2026-07-21T00:05:00.000Z");

beforeEach(() => {
  mockFindRows = [];
  mockReviseReadRows = [];
  updateCalls = [];
  updateMatches = true;
  updateReturning = [{ updatedAt: REVISED_UPDATED_AT }];
  lastFindWhere = undefined;
  lastReviseUpdateWhere = undefined;
});

describe("findQueueEntryByExternalId", () => {
  it("returns the row when one matches (workspace, source='github', external_id)", async () => {
    mockFindRows = [
      {
        id: "queue-entry-1",
        state: "parked",
        parkReason: ALIGNMENT_DENIED_PARK_REASON,
        title: "Old title",
        body: "old body",
      },
    ];
    const row = await findQueueEntryByExternalId("ws-1", "acme/widgets", 42);
    expect(row).toEqual({
      id: "queue-entry-1",
      state: "parked",
      parkReason: ALIGNMENT_DENIED_PARK_REASON,
      title: "Old title",
      body: "old body",
    });
  });

  it("returns null when no row matches", async () => {
    mockFindRows = [];
    const row = await findQueueEntryByExternalId("ws-1", "acme/widgets", 42);
    expect(row).toBeNull();
  });
});

describe("reviseAlignmentBrief: supersede-the-denial write (#1345 PR②)", () => {
  it("a DENIED entry -> clears parkReason to ALIGNMENT_PARK_REASON, writes the new title/body, resets estimatedBudgetUsd/modelOverride/taskType to null, and NEVER writes `state`", async () => {
    mockReviseReadRows = [{ state: "parked", parkReason: ALIGNMENT_DENIED_PARK_REASON }];
    updateMatches = true;
    updateReturning = [{ updatedAt: REVISED_UPDATED_AT }];

    const result = await reviseAlignmentBrief({
      queueEntryId: "q-1",
      title: "Cheaper version",
      body: "new body",
    });

    expect(result).toEqual({ ok: true, updatedAt: REVISED_UPDATED_AT });
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]).toMatchObject({
      title: "Cheaper version",
      body: "new body",
      parkReason: ALIGNMENT_PARK_REASON,
      estimatedBudgetUsd: null,
      modelOverride: null,
      taskType: null,
    });
    // AC3: `state` must never appear in the write at all — this function
    // must be structurally incapable of ever flipping a row to `queued`.
    expect(updateCalls[0]).not.toHaveProperty("state");
  });

  it("returns { ok: false, reason: 'not_found' } when no row matches the id at all — never attempts the update", async () => {
    mockReviseReadRows = [];
    const result = await reviseAlignmentBrief({
      queueEntryId: "q-missing",
      title: "t",
      body: "b",
    });
    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(updateCalls).toHaveLength(0);
  });

  it("returns { ok: false, reason: 'not_denied' } when the row is parked but NOT for the denial reason (e.g. still 'awaiting alignment' or a dependency park) — never attempts the update", async () => {
    mockReviseReadRows = [{ state: "parked", parkReason: ALIGNMENT_PARK_REASON }];
    const result = await reviseAlignmentBrief({
      queueEntryId: "q-1",
      title: "t",
      body: "b",
    });
    expect(result).toEqual({ ok: false, reason: "not_denied" });
    expect(updateCalls).toHaveLength(0);
  });

  it("returns { ok: false, reason: 'not_denied' } when the row isn't parked at all (e.g. already queued) — never attempts the update", async () => {
    mockReviseReadRows = [{ state: "queued", parkReason: null }];
    const result = await reviseAlignmentBrief({
      queueEntryId: "q-1",
      title: "t",
      body: "b",
    });
    expect(result).toEqual({ ok: false, reason: "not_denied" });
    expect(updateCalls).toHaveLength(0);
  });

  it("returns { ok: false, reason: 'not_denied' } when the final UPDATE's WHERE matches zero rows — a race between the read and the write (belt-and-suspenders, mirrors requeueParkedQueueEntry's own guard)", async () => {
    mockReviseReadRows = [{ state: "parked", parkReason: ALIGNMENT_DENIED_PARK_REASON }];
    updateMatches = false; // simulates a concurrent write moving the row first
    const result = await reviseAlignmentBrief({
      queueEntryId: "q-1",
      title: "t",
      body: "b",
    });
    expect(result).toEqual({ ok: false, reason: "not_denied" });
    // The update WAS attempted (WHERE-clause guard, not a pre-check) — it
    // just matched zero rows.
    expect(updateCalls).toHaveLength(1);
  });

  it("idempotent: a SECOND revise call for the SAME entry after the first already cleared the denial is a safe no-op (not_denied) — this is what makes the caller's re-brief-post safe to retry", async () => {
    // Simulates calling twice in a row against the SAME underlying state: the
    // first call's mockReviseReadRows still shows DENIED (pre-transition);
    // the second call's read would see the ALREADY-CLEARED parkReason.
    mockReviseReadRows = [{ state: "parked", parkReason: ALIGNMENT_DENIED_PARK_REASON }];
    const first = await reviseAlignmentBrief({ queueEntryId: "q-1", title: "t", body: "b" });
    expect(first.ok).toBe(true);

    mockReviseReadRows = [{ state: "parked", parkReason: ALIGNMENT_PARK_REASON }]; // now cleared
    const second = await reviseAlignmentBrief({ queueEntryId: "q-1", title: "t2", body: "b2" });
    expect(second).toEqual({ ok: false, reason: "not_denied" });
    // Only ONE update call happened across both invocations — the second
    // never re-wrote anything.
    expect(updateCalls).toHaveLength(1);
  });
});
