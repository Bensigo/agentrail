import {
  pgTable,
  uuid,
  text,
  integer,
  doublePrecision,
  timestamp,
  jsonb,
  unique,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

// Per-arm eval metrics produced by the offline eval harness reporter
// (`agentrail/evals/reporter.py::arm_metric_rows`). One row per (eval run, arm).
//
// These are the FALSIFIABLE numbers the Agent Operations Console shows in place
// of the always-zero context-quality placeholders (issue #942): solve-rate,
// dollars-per-solved-task, and the Objective Gate false-green rate. They can all
// come back unfavorable, which is exactly why they're allowed on the console
// (CONTEXT.md console display rule).
//
// None-vs-0.0 is load-bearing and must survive the round-trip: `dollarsPerSolved`
// and `falseGreenRate` are NULLABLE — NULL means "undefined denominator" (no rep
// solved / no gate-passed run), which the reporter distinguishes from a real 0.0.
// Never coalesce these to 0 on ingest or read.
export const evalArmMetrics = pgTable(
  "eval_arm_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The eval run this arm row belongs to (reporter's `run_id`, e.g. "eval-2026-06-23"). */
    runId: text("run_id").notNull(),
    /** Arm name: "baseline" | "full" | "full-minus-<layer>". */
    arm: text("arm").notNull(),
    repetitions: integer("repetitions").notNull(),
    solvedCount: integer("solved_count").notNull(),
    failedCount: integer("failed_count").notNull(),
    /** Mean solve-rate over all repetitions, in [0, 1]. */
    solveRate: doublePrecision("solve_rate").notNull(),
    /** Population stddev of per-task solve fractions. */
    spread: doublePrecision("spread").notNull(),
    totalInputTokens: integer("total_input_tokens").notNull(),
    totalOutputTokens: integer("total_output_tokens").notNull(),
    totalCacheTokens: integer("total_cache_tokens").notNull(),
    totalCacheCreationTokens: integer("total_cache_creation_tokens").notNull(),
    totalTokens: integer("total_tokens").notNull(),
    totalCostUsd: doublePrecision("total_cost_usd").notNull(),
    /** NULL = undefined (no rep solved). NOT the same as 0.0. */
    dollarsPerSolved: doublePrecision("dollars_per_solved"),
    gatePassedCount: integer("gate_passed_count").notNull().default(0),
    falseGreenCount: integer("false_green_count").notNull().default(0),
    /** NULL = undefined (no gate-passed run). NOT the same as 0.0. */
    falseGreenRate: doublePrecision("false_green_rate"),
    /** Difficulty-stratified breakdown (#941), stored verbatim from the reporter. */
    strata: jsonb("strata").$type<Array<Record<string, unknown>>>().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // A given eval run reports each arm exactly once; re-posting the same run
    // upserts rather than duplicating.
    workspaceRunArmUnique: unique("eval_arm_metrics_workspace_run_arm_unique").on(
      t.workspaceId,
      t.runId,
      t.arm
    ),
  })
);

export type EvalArmMetric = typeof evalArmMetrics.$inferSelect;
export type NewEvalArmMetric = typeof evalArmMetrics.$inferInsert;
