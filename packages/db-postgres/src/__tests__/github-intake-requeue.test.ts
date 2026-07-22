import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #1276 PR ② + fix round — `requeueParkedQueueEntry`, the console approvals
 * page's Requeue action. Argument-level (no real Postgres); the db mock
 * dispatches `select` on the COLUMN NAMES asked for, in the style of
 * `github-intake-alignment-gate.test.ts`:
 *   requeue's own row lookup     -> selects `{ state, parkReason, kind,
 *                                    estimatedBudgetUsd }` (keyed on `state`)
 *   workspaceRequiresAlignment   -> selects `{ requireAlignment }`
 *   confirmAlignmentBrief's row lookup (the confirm-after-flip test below)
 *                                -> selects `{ workspaceId, externalId,
 *                                    blockedBy }` (keyed on `workspaceId`)
 *   unmetBlockers                -> selects `{ externalId }` alone
 *
 * THE PIN THIS FILE CARRIES (adversarial review, C1): "alignment-held" is
 * NOT a parkReason string match. A dependency- or guardrail-parked issue
 * under `require_alignment` with no confirmed values (`estimatedBudgetUsd`
 * NULL) is alignment-held even though its stored reason says "Waiting on
 * #N" / "duplicate content: ..." — requeueing it would hand the runner a
 * claimable, unpriced, never-briefed row and orphan its pending brief. The
 * original version of this suite codified exactly that bug ("a dependency
 * park also requeues"); the tests below pin the corrected semantics.
 */
let mockRow:
  | { state: string; parkReason: string | null; kind: string; estimatedBudgetUsd: number | null }
  | undefined;
let mockRequireAlignment: boolean;
let mockConfirmRowLookup: unknown[];
let mockUnmetBlockerRows: unknown[];
let updateCalls: Array<Record<string, unknown>> = [];
let updateMatches: boolean;

// #1341: `confirmAlignmentBrief` is now a single raw `db.execute(sql\`...\`)`
// UPDATE (see that function's own doc-comment) instead of a
// select-then-transaction-update — it no longer issues the `workspaceId`-keyed
// select this mock used to route to `mockConfirmRowLookup`. This re-derives
// the same decision (see the identical idiom's fuller explanation in
// github-intake-alignment-gate.test.ts) by extracting the four bound values
// off the `sql` template (in the production query's own interpolation order)
// and checking them against `mockConfirmRowLookup[0]`/`mockUnmetBlockerRows`
// — kept as the SAME shapes the pre-#1341 select-based lookup used, so the
// "confirm-after-flip" test below keeps working unchanged.
function extractSqlParams(query: unknown): unknown[] {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks ?? [];
  return chunks.filter(
    (c) => !(c && typeof c === "object" && Array.isArray((c as { value?: unknown[] }).value))
  );
}

vi.mock("../db.js", () => {
  const dbMock = {
    select: (cols?: Record<string, unknown>) => ({
      from: () => ({
        where: async () => {
          if (cols && Object.prototype.hasOwnProperty.call(cols, "requireAlignment")) {
            return [{ requireAlignment: mockRequireAlignment }];
          }
          if (cols && Object.prototype.hasOwnProperty.call(cols, "state")) {
            return mockRow ? [mockRow] : [];
          }
          return mockUnmetBlockerRows;
        },
      }),
    }),
    update: vi.fn(() => ({
      set: vi.fn((s: Record<string, unknown>) => {
        updateCalls.push(s);
        return {
          // requeue's alignment-flip UPDATE is awaited WITHOUT `.returning()`,
          // its final UPDATE chains `.returning()` — so `where()`'s result
          // must be BOTH awaitable and carry `.returning`, exactly like
          // drizzle's own thenable builder.
          where: () =>
            Object.assign(Promise.resolve(updateMatches ? [{ id: "row-id" }] : []), {
              returning: async () => (updateMatches ? [{ id: "row-id" }] : []),
            }),
        };
      }),
    })),
    execute: vi.fn(async (query: unknown) => {
      const [queueEntryId, estimatedBudgetUsd, modelOverride, taskType] =
        extractSqlParams(query) as [string, number, string, string | null];
      const row = mockConfirmRowLookup[0] as
        | { workspaceId: string; externalId: string; blockedBy: number[] }
        | undefined;
      if (!row) return [];

      const hash = row.externalId.lastIndexOf("#");
      const repoFullName = hash >= 0 ? row.externalId.slice(0, hash) : row.externalId;
      const greenExternalIds = new Set(
        (mockUnmetBlockerRows as Array<{ externalId: string }>).map((r) => r.externalId)
      );
      const unmet = (row.blockedBy ?? []).filter(
        (n) => !greenExternalIds.has(`${repoFullName}#${n}`)
      );
      updateCalls.push({
        state: unmet.length === 0 ? "queued" : "parked",
        parkReason:
          unmet.length === 0 ? null : `Waiting on ${unmet.map((n) => `#${n}`).join(", ")}`,
        estimatedBudgetUsd,
        modelOverride,
        taskType,
      });
      return [{ id: queueEntryId }];
    }),
    transaction: async (cb: (tx: typeof dbMock) => unknown) => cb(dbMock),
  };
  return { db: dbMock };
});

import {
  requeueParkedQueueEntry,
  confirmAlignmentBrief,
  ALIGNMENT_PARK_REASON,
  ALIGNMENT_DENIED_PARK_REASON,
} from "../queries/github_intake.js";

beforeEach(() => {
  mockRow = undefined;
  mockRequireAlignment = true;
  mockConfirmRowLookup = [];
  mockUnmetBlockerRows = [];
  updateCalls = [];
  updateMatches = true;
});

function parkedIssue(
  parkReason: string | null,
  estimatedBudgetUsd: number | null = null,
  kind = "issue"
) {
  return { state: "parked", parkReason, kind, estimatedBudgetUsd };
}

describe("requeueParkedQueueEntry", () => {
  it("not_found: no row matches (wrong id, or an id from another workspace)", async () => {
    mockRow = undefined;
    const result = await requeueParkedQueueEntry("ws-1", "entry-1");
    expect(result).toBe("not_found");
    expect(updateCalls).toHaveLength(0);
  });

  it("not_parked: the row exists but isn't currently parked", async () => {
    mockRow = { state: "queued", parkReason: null, kind: "issue", estimatedBudgetUsd: null };
    const result = await requeueParkedQueueEntry("ws-1", "entry-1");
    expect(result).toBe("not_parked");
    expect(updateCalls).toHaveLength(0);
  });

  it("denial always wins: ALIGNMENT_DENIED_PARK_REASON is refused even with the gate OFF, row untouched", async () => {
    mockRow = parkedIssue(ALIGNMENT_DENIED_PARK_REASON);
    mockRequireAlignment = false;
    const result = await requeueParkedQueueEntry("ws-1", "entry-1");
    expect(result).toBe("alignment_locked");
    expect(updateCalls).toHaveLength(0);
  });

  it("C1 pin: a DEPENDENCY park with no confirmed values under the gate is alignment-held — stays parked, reason flips to ALIGNMENT_PARK_REASON", async () => {
    mockRow = parkedIssue("Waiting on #9");
    mockRequireAlignment = true;
    const result = await requeueParkedQueueEntry("ws-1", "entry-1");
    expect(result).toBe("alignment_locked");
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.["parkReason"]).toBe(ALIGNMENT_PARK_REASON);
    expect(updateCalls[0]?.["state"]).toBeUndefined(); // never queued
  });

  it("C1 pin: a GUARDRAIL park with no confirmed values under the gate is alignment-held too (it was never briefed)", async () => {
    mockRow = parkedIssue("duplicate content: an issue with identical content is already queued");
    mockRequireAlignment = true;
    const result = await requeueParkedQueueEntry("ws-1", "entry-1");
    expect(result).toBe("alignment_locked");
    expect(updateCalls[0]?.["parkReason"]).toBe(ALIGNMENT_PARK_REASON);
  });

  it("an 'awaiting alignment' park under the gate resolves alignment_locked via the same aligned check", async () => {
    mockRow = parkedIssue(ALIGNMENT_PARK_REASON);
    mockRequireAlignment = true;
    const result = await requeueParkedQueueEntry("ws-1", "entry-1");
    expect(result).toBe("alignment_locked");
  });

  it("a dependency park WITH confirmed values (estimatedBudgetUsd set) requeues — the brief already sanctioned it", async () => {
    mockRow = parkedIssue("Waiting on #9", 7.25);
    mockRequireAlignment = true;
    const result = await requeueParkedQueueEntry("ws-1", "entry-1");
    expect(result).toBe("requeued");
    expect(updateCalls[0]?.["state"]).toBe("queued");
    expect(updateCalls[0]?.["parkReason"]).toBeNull();
  });

  it("gate OFF: a guardrail park requeues (alignment genuinely not required)", async () => {
    mockRow = parkedIssue("duplicate content: ...");
    mockRequireAlignment = false;
    const result = await requeueParkedQueueEntry("ws-1", "entry-1");
    expect(result).toBe("requeued");
  });

  it("kind='onboard' park requeues regardless of the gate — alignment only ever gates kind='issue'", async () => {
    mockRow = parkedIssue("some reason", null, "onboard");
    mockRequireAlignment = true;
    const result = await requeueParkedQueueEntry("ws-1", "entry-1");
    expect(result).toBe("requeued");
  });

  it("a reasonless legacy park with confirmed values requeues", async () => {
    mockRow = parkedIssue(null, 3.5);
    const result = await requeueParkedQueueEntry("ws-1", "entry-1");
    expect(result).toBe("requeued");
  });

  it("not_parked: aligned on the read, but the final guarded UPDATE matches zero rows (raced out from under us)", async () => {
    mockRow = parkedIssue("Waiting on #9", 7.25);
    updateMatches = false;
    const result = await requeueParkedQueueEntry("ws-1", "entry-1");
    expect(result).toBe("not_parked");
  });

  it("confirm-after-flip: after the alignment_locked flip, the REAL confirmAlignmentBrief still lands values and restores the dependency reason while blockers stay unmet", async () => {
    // Step 1: the requeue attempt on a dependency-parked, unbriefed row —
    // reason flips to ALIGNMENT_PARK_REASON, never queued.
    mockRow = parkedIssue("Waiting on #9");
    mockRequireAlignment = true;
    expect(await requeueParkedQueueEntry("ws-1", "entry-1")).toBe("alignment_locked");
    expect(updateCalls[0]?.["parkReason"]).toBe(ALIGNMENT_PARK_REASON);

    // Step 2: the brief's approve — the REAL confirmAlignmentBrief re-derives
    // blocker state from the row's own blockedBy (#9 still not green here),
    // so per the #1274 finding-1 semantics the row STAYS parked, the reason
    // goes back to the dependency's own ("Waiting on #9"), and the
    // sanctioned values land regardless — the ceiling is never lost.
    mockConfirmRowLookup = [
      { workspaceId: "ws-1", externalId: "owner/repo#5", blockedBy: [9] },
    ];
    mockUnmetBlockerRows = []; // no green entry for #9 -> stays unmet
    const confirmed = await confirmAlignmentBrief({
      queueEntryId: "entry-1",
      estimatedBudgetUsd: 7.25,
      modelOverride: "sonnet-5",
      taskType: null,
    });
    expect(confirmed).toBe(true);
    const confirmWrite = updateCalls.at(-1);
    expect(confirmWrite?.["state"]).toBe("parked");
    expect(confirmWrite?.["parkReason"]).toBe("Waiting on #9");
    expect(confirmWrite?.["estimatedBudgetUsd"]).toBe(7.25);
    expect(confirmWrite?.["modelOverride"]).toBe("sonnet-5");
  });
});
