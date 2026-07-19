import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #1274 PR③ — `findAlignmentBriefCandidates`'s raw SQL shape. Mocks
 * `db.execute` and inspects the CAPTURED `sql\`...\`` tagged-template's
 * literal string parts (drizzle's `SQLWrapper.queryChunks`: literal text
 * segments arrive as `{ value: [string] }`, interpolated values arrive
 * un-wrapped) — the same "pin the SQL text" idiom
 * `test_insert_entry_sql_does_not_reset_state_on_conflict` uses on the
 * Python side (`agentrail/tests/afk/test_queue_store.py`), adapted for a
 * `sql`-tagged template instead of a plain string.
 *
 * This is the STATIC half of the proof: it pins that the query's WHERE
 * clause asks for the right predicates. The BEHAVIORAL half — that a
 * v2-guardrail-parked entry whose reason `unparkDependents` later
 * overwrites to `ALIGNMENT_PARK_REASON` really is picked up on the next
 * sweep, while a STILL-v2-guardrail-parked entry (untouched reason) is
 * not — ran against a real Postgres in this PR's live dev-DB proof (see
 * the task report); a query built from a `sql` tagged template has no
 * `WHERE`-filtering behavior a mock can simulate (unlike the drizzle
 * query-builder mocks elsewhere in this package), so the live-DB run is
 * the actual behavioral proof, this is the drift guard.
 */
let capturedQuery: unknown;

vi.mock("../db.js", () => ({
  db: {
    execute: vi.fn(async (query: unknown) => {
      capturedQuery = query;
      return [];
    }),
  },
}));

import { findAlignmentBriefCandidates } from "../queries/github_intake.js";

/** Join a captured `sql\`...\`` tagged-template's literal string parts
 * (skipping interpolated values) into one text blob for substring checks. */
function literalText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .filter(
      (c): c is { value: string[] } =>
        !!c && typeof c === "object" && Array.isArray((c as { value?: unknown }).value)
    )
    .map((c) => c.value.join(""))
    .join("");
}

beforeEach(() => {
  capturedQuery = undefined;
});

describe("findAlignmentBriefCandidates: SQL shape", () => {
  it("selects parked, issue-kind rows in a workspace that requires alignment, with no sanctioned budget", async () => {
    await findAlignmentBriefCandidates("ws-1", 5);
    const text = literalText(capturedQuery);
    expect(text).toContain("qe.state = 'parked'");
    expect(text).toContain("qe.kind = 'issue'");
    expect(text).toContain("w.require_alignment = true");
    expect(text).toContain("qe.estimated_budget_usd IS NULL");
  });

  it("I2 fix round: is WORKSPACE-SCOPED — composes a qe.workspace_id predicate binding the caller's workspaceId (the mock can't simulate WHERE filtering; the behavioral cross-tenant isolation + starvation negative run against real Postgres in the live-DB proof)", async () => {
    await findAlignmentBriefCandidates("ws-tenant-a", 5);
    const text = literalText(capturedQuery);
    expect(text).toContain("qe.workspace_id = ");
    const values = ((capturedQuery as { queryChunks?: unknown[] }).queryChunks ?? []).filter(
      (c) => typeof c === "string"
    );
    expect(values).toContain("ws-tenant-a");
  });

  it("excludes any row whose park_reason is a v2-guardrail reason (contains 'parked for human review') — every injection/duplicate/rate-limit/errored reason, in BOTH writers, carries this exact phrase", async () => {
    await findAlignmentBriefCandidates("ws-1", 5);
    const text = literalText(capturedQuery);
    expect(text).toContain("park_reason IS NULL OR qe.park_reason NOT LIKE");
    expect(text).toContain("parked for human review");
  });

  it("excludes any row that already has a jace_approvals row (covers denied entries, which always carry one)", async () => {
    await findAlignmentBriefCandidates("ws-1", 5);
    const text = literalText(capturedQuery);
    expect(text).toContain("NOT EXISTS");
    expect(text).toContain("jace_approvals");
    expect(text).toContain("ja.queue_entry_id = qe.id");
  });

  it("passes the caller's limit through as a bound parameter, not a hardcoded constant", async () => {
    await findAlignmentBriefCandidates("ws-1", 7);
    const values = ((capturedQuery as { queryChunks?: unknown[] }).queryChunks ?? []).filter(
      (c) => typeof c === "number"
    );
    expect(values).toContain(7);

    await findAlignmentBriefCandidates("ws-1", 1);
    const valuesAgain = (
      (capturedQuery as { queryChunks?: unknown[] }).queryChunks ?? []
    ).filter((c) => typeof c === "number");
    expect(valuesAgain).toContain(1);
  });

  it("orders oldest-first", async () => {
    await findAlignmentBriefCandidates("ws-1", 5);
    const text = literalText(capturedQuery);
    expect(text).toContain("ORDER BY qe.created_at ASC");
  });
});
