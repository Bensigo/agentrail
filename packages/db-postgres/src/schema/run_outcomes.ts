import {
  pgTable,
  uuid,
  text,
  doublePrecision,
  timestamp,
  pgEnum,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { queueEntries } from "./queue_entries.js";

/**
 * #1338 PR① — the FUEL for the model-selection learning loop. One row per
 * `queue_entries` TERMINAL transition: `(task_type, execute_model) ->
 * outcome + cost`, the durable, queryable signal a LATER PR's selector reads
 * to learn which model actually works for which task. CAPTURE ONLY — nothing
 * in this PR reads this table to change which model runs; that is the next
 * PR's job.
 *
 * Written by `queries/run_outcomes.ts::recordRunOutcome`, called from the
 * runner-result route (`apps/console/app/api/v1/runner/result/route.ts`)
 * immediately when `recordRunnerResult` reports a non-null `terminalState` —
 * never unconditionally on every runner report (a `running` heartbeat or a
 * still-has-budget red/error retry never reaches here). See that query
 * file's own doc-comment for exactly why the write lives one layer up from
 * `recordRunnerResult` instead of inside it (a ClickHouse read is involved,
 * and `packages/db-postgres` has zero ClickHouse dependency by design).
 */
export const runOutcomeEnum = pgEnum("run_outcome", [
  "success",
  "human_review",
  "failed",
]);

export const runOutcomes = pgTable(
  "run_outcomes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Cascades with its queue entry — a run_outcomes row's every other column
    // (task_type/execute_model/outcome/cost) is meaningless without the queue
    // entry it describes, so there is no "orphaned but still useful" case to
    // preserve here (contrast `jace_approvals.queue_entry_id`, an audit trail
    // deliberately kept via ON DELETE SET NULL — this table isn't that).
    queueEntryId: uuid("queue_entry_id")
      .notNull()
      .references(() => queueEntries.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Denormalized copy of `queue_entries.task_type` AT THE MOMENT this
     * outcome was recorded. Nullable: a brief-less entry (no alignment gate,
     * or a pre-#1338 row) never classified a task type. */
    taskType: text("task_type"),
    /** The ACTUAL execute-phase model, resolved from ClickHouse `cost_events`
     * (phase='execute', run_id=queue_entry_id) at terminal-report time — NOT
     * `queue_entries.model_override` (pre-run intent, re-overridable at
     * dispatch). Null when no execute-phase cost_event exists for this run
     * (e.g. a hosted-refusal error that never reached the execute phase). */
    executeModel: text("execute_model"),
    outcome: runOutcomeEnum("outcome").notNull(),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // One outcome row per queue entry, forever: a queue entry reaches AT MOST
    // one terminal transition in this codebase (there is no requeue path off
    // 'green' / 'escalated-to-human' / 'blocked', unlike 'parked'), so a
    // re-report of the same terminal result (a retried/duplicated HTTP
    // delivery) is necessarily the SAME fact, not a legitimate second
    // outcome — recordRunOutcome upserts ON CONFLICT DO NOTHING against this.
    queueEntryUnique: unique("run_outcomes_queue_entry_id_unique").on(
      t.queueEntryId
    ),
    workspaceIdx: index("run_outcomes_workspace_id_idx").on(t.workspaceId),
    // Backs getModelOutcomeStats' per-(task_type, execute_model) GROUP BY.
    taskTypeModelIdx: index("run_outcomes_task_type_model_idx").on(
      t.taskType,
      t.executeModel
    ),
  })
);

export type RunOutcomeRow = typeof runOutcomes.$inferSelect;
export type NewRunOutcomeRow = typeof runOutcomes.$inferInsert;
