import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { queueEntries } from "./queue_entries.js";

/**
 * #1389 — the per-attempt log a `queue_entries` row accumulates across its
 * retry lifecycle. Every time `recordRunnerResult` maps a runner outcome onto
 * a queue transition (green / red / error / the hosted-refusal escalation),
 * it appends ONE row here BEFORE computing the next state — this is the
 * "preserved state" CONTEXT.md's Run Outcome promises for an
 * `escalated-to-human` entry (today there was none: a deterministic failure
 * burned the whole Budget Leash in minutes with nothing to show for it).
 *
 * `outcome` carries the raw `RunnerStatus` ('green'|'red'|'error'|'running')
 * plus the synthetic `'escalated-to-human'` value for a hosted-refusal jump
 * (see `recordRunnerResult`'s hosted-refusal branch) — free text, not an enum,
 * so a future terminal/outcome vocabulary addition never needs a migration
 * here (mirrors `queue_entries.state`'s own free-text convention).
 *
 * This is ALSO the single source of truth `recordRunnerResult` counts from to
 * compute the next backoff delay (`COUNT(*) ... WHERE queue_entry_id = $1`,
 * taken INCLUDING the row just inserted in the same statement) — there is no
 * separate "attempt number" counter column to drift out of sync with what's
 * actually logged.
 *
 * Cascades with its queue entry (same rationale as `run_outcomes`'s own
 * doc-comment: every column here is meaningless without the queue entry it
 * describes).
 */
export const queueAttempts = pgTable(
  "queue_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    queueEntryId: uuid("queue_entry_id")
      .notNull()
      .references(() => queueEntries.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // The tier this attempt ran at (the queue entry's tier BEFORE this
    // attempt's own tier bump, if any) — so the log reads "attempt N ran at
    // tier T", not the tier the NEXT attempt will use.
    tier: integer("tier").notNull(),
    // Raw RunnerStatus ('green'|'red'|'error'|'running') or the synthetic
    // 'escalated-to-human' hosted-refusal outcome. Free text — see doc-comment.
    outcome: text("outcome").notNull(),
    // The runner's `gate_reason` (bounded/scrubbed the same way the failure-
    // evidence write in the runner-result route already bounds `logs_tail`),
    // or null when the runner reported no reason (a bare green/running ping).
    errorSummary: text("error_summary"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // Backs both the count-attempts-so-far read and the console's
    // attempt-history list (ORDER BY created_at).
    queueEntryCreatedAtIdx: index("queue_attempts_queue_entry_id_created_at_idx").on(
      t.queueEntryId,
      t.createdAt
    ),
  })
);

export type QueueAttemptRow = typeof queueAttempts.$inferSelect;
export type NewQueueAttemptRow = typeof queueAttempts.$inferInsert;
