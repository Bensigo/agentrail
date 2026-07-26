import { and, eq, asc } from "drizzle-orm";
import { db } from "../db.js";
import { queueAttempts } from "../schema/queue_attempts.js";

/** One persisted attempt (#1389) as the console's attempt-history view needs
 * it — timestamp, tier, outcome, error summary. */
export interface QueueAttemptListItem {
  id: string;
  tier: number;
  outcome: string;
  errorSummary: string | null;
  createdAt: string;
}

/**
 * List a queue entry's full attempt history, oldest first (the order a
 * reader wants: "attempt 1, attempt 2, … then it escalated"). Workspace-
 * scoped so a stray/foreign `queueEntryId` never leaks another workspace's
 * attempt log — mirrors every other per-entry read in this package (e.g.
 * `latestRunForIssue`).
 *
 * This is the read side of the write `recordRunnerResult` performs — see
 * that function's own doc-comments for exactly when a row is appended (every
 * red/error/hosted-refusal attempt, plus the terminal green). An entry with
 * zero attempts (never claimed, or claimed and still running with no report
 * yet) returns an empty array — the console's AttemptHistorySection renders
 * nothing for that case, matching FailuresSection's "empty section is no
 * section" convention.
 */
export async function listQueueAttempts(
  workspaceId: string,
  queueEntryId: string
): Promise<QueueAttemptListItem[]> {
  const rows = await db
    .select({
      id: queueAttempts.id,
      tier: queueAttempts.tier,
      outcome: queueAttempts.outcome,
      errorSummary: queueAttempts.errorSummary,
      createdAt: queueAttempts.createdAt,
    })
    .from(queueAttempts)
    .where(
      and(
        eq(queueAttempts.queueEntryId, queueEntryId),
        eq(queueAttempts.workspaceId, workspaceId)
      )
    )
    .orderBy(asc(queueAttempts.createdAt));

  return rows.map((r) => ({
    id: r.id,
    tier: r.tier,
    outcome: r.outcome,
    errorSummary: r.errorSummary ?? null,
    createdAt:
      r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
  }));
}
