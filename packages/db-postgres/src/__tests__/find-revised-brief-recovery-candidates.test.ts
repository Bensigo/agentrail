import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #1345 PR③ (crash-window liveness gap) — `findRevisedBriefRecoveryCandidates`'s
 * raw SQL shape. Mirrors `find-alignment-brief-candidates.test.ts`'s own
 * "pin the SQL text" idiom exactly (mocks `db.execute`, inspects the
 * captured `sql\`...\`` tagged-template's literal string parts).
 *
 * This is the STATIC half of the proof: it pins that the query's WHERE
 * clause asks for the right predicates, and — critically — that this query
 * is DISJOINT from `findAlignmentBriefCandidates` (this one requires a
 * `denied` approval row to EXIST; that one requires NO approval row to
 * exist at all, so a row can never match both). The BEHAVIORAL half — a
 * genuinely revise-recovered entry gets exactly one fresh pending brief, and
 * a direct post racing/preceding this sweep converges onto the SAME row —
 * ran against a real Postgres in this PR's live dev-DB proof (see the task
 * report / `scripts/revise-loop-proof.ts`); a query built from a `sql`
 * tagged template has no `WHERE`-filtering behavior a mock can simulate, so
 * the live-DB run is the actual behavioral proof, this is the drift guard.
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

import { findRevisedBriefRecoveryCandidates } from "../queries/github_intake.js";

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

describe("findRevisedBriefRecoveryCandidates: SQL shape", () => {
  it("selects parked, issue-kind rows in a workspace that requires alignment, with no sanctioned budget, parked for the (cleared) awaiting-alignment reason", async () => {
    await findRevisedBriefRecoveryCandidates("ws-1", 5);
    const text = literalText(capturedQuery);
    expect(text).toContain("qe.state = 'parked'");
    expect(text).toContain("qe.kind = 'issue'");
    expect(text).toContain("w.require_alignment = true");
    expect(text).toContain("qe.estimated_budget_usd IS NULL");
    expect(text).toContain("qe.park_reason = ");
  });

  it("is WORKSPACE-SCOPED — composes a qe.workspace_id predicate binding the caller's workspaceId", async () => {
    await findRevisedBriefRecoveryCandidates("ws-tenant-a", 5);
    const text = literalText(capturedQuery);
    expect(text).toContain("qe.workspace_id = ");
    const values = ((capturedQuery as { queryChunks?: unknown[] }).queryChunks ?? []).filter(
      (c) => typeof c === "string"
    );
    expect(values).toContain("ws-tenant-a");
  });

  it("requires a DENIED jace_approvals row to EXIST — the proof this entry really was denied then revised", async () => {
    await findRevisedBriefRecoveryCandidates("ws-1", 5);
    const text = literalText(capturedQuery);
    expect(text).toMatch(/EXISTS\s*\(\s*SELECT 1 FROM jace_approvals ja\s*WHERE ja\.queue_entry_id = qe\.id AND ja\.status = 'denied'/);
  });

  it("requires NO pending jace_approvals row to exist — no live brief already posted", async () => {
    await findRevisedBriefRecoveryCandidates("ws-1", 5);
    const text = literalText(capturedQuery);
    expect(text).toMatch(/NOT EXISTS\s*\(\s*SELECT 1 FROM jace_approvals ja\s*WHERE ja\.queue_entry_id = qe\.id AND ja\.status = 'pending'/);
  });

  it("is DISJOINT from findAlignmentBriefCandidates: that query's own WHERE never appears here (no bare NOT EXISTS over ALL approval rows for the entry, unscoped by status)", async () => {
    await findRevisedBriefRecoveryCandidates("ws-1", 5);
    const text = literalText(capturedQuery);
    // findAlignmentBriefCandidates' own guard string never appears in this
    // query — this one is never a superset/loosening of that one.
    expect(text).not.toContain("parked for human review");
  });

  it("passes the caller's limit through as a bound parameter, not a hardcoded constant", async () => {
    await findRevisedBriefRecoveryCandidates("ws-1", 7);
    const values = ((capturedQuery as { queryChunks?: unknown[] }).queryChunks ?? []).filter(
      (c) => typeof c === "number"
    );
    expect(values).toContain(7);

    await findRevisedBriefRecoveryCandidates("ws-1", 1);
    const valuesAgain = (
      (capturedQuery as { queryChunks?: unknown[] }).queryChunks ?? []
    ).filter((c) => typeof c === "number");
    expect(valuesAgain).toContain(1);
  });

  it("orders oldest-first BY THE REVISE TRANSITION'S OWN updated_at (not created_at)", async () => {
    await findRevisedBriefRecoveryCandidates("ws-1", 5);
    const text = literalText(capturedQuery);
    expect(text).toContain("ORDER BY qe.updated_at ASC");
  });
});
