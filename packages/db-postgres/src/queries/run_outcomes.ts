import { and, eq, sql } from "drizzle-orm";
import { db } from "../db.js";
import { runOutcomes } from "../schema/run_outcomes.js";
import type { TerminalQueueState } from "./runner.js";

/**
 * #1338 PR① — the FUEL for the model-selection learning loop. CAPTURE ONLY:
 * nothing in this file (or anywhere else in this PR) reads `run_outcomes` to
 * change which model runs — that is the next PR's job.
 *
 * TIMING CHOICE (documented, per the brief's own escape hatch): the actual
 * execute-model resolution (ClickHouse `cost_events`, phase='execute') and
 * cost figure are resolved by the CALLER
 * (`apps/console/app/api/v1/runner/result/route.ts`), immediately after
 * `recordRunnerResult` (`./runner.ts`) reports a non-null `terminalState` —
 * NOT inside `recordRunnerResult` itself, and NOT unconditionally on every
 * runner report. Two reasons:
 *   1. `packages/db-postgres` has zero ClickHouse dependency today, by
 *      design — `workspace_costs.ts`'s own doc-comment calls ClickHouse "the
 *      granular... path — not duplicated here"; the workspace/db-clickhouse
 *      packages are only ever composed together at the app layer (the result
 *      route already imports both, for insertFailureEvents/
 *      recordRunLifecycleEvent). Adding a ClickHouse client here would be a
 *      new layering violation for a read that already has a natural home.
 *   2. A `running` heartbeat or a still-has-budget red/error retry is NOT
 *      terminal — querying ClickHouse on every one of those (which can fire
 *      repeatedly per run) would be pure waste. Gating on
 *      `result.terminalState !== null` (the SAME condition the route already
 *      uses for its other terminal-only side effects: notify, merge,
 *      lifecycle events) means the ClickHouse read and this write happen
 *      exactly once per queue entry, at the moment it actually matters.
 */
export type RunOutcomeValue = "success" | "human_review" | "failed";

/**
 * Map a terminal queue state onto the `run_outcomes` vocabulary. Exhaustive
 * over {@link TerminalQueueState} (a switch with no default) so a future
 * terminal state added there forces a decision here too, at compile time.
 *
 * green -> success (the run's objective gate passed).
 * escalated-to-human -> human_review (budget exhausted or a hosted refusal;
 *   a human has to look, but this was not a clean failure).
 * blocked -> failed (present for forward-compatibility only —
 *   `recordRunnerResult` never actually commits this state today, see that
 *   function's own `TERMINAL_QUEUE_STATES` doc-comment).
 */
export function mapTerminalStateToRunOutcome(
  state: TerminalQueueState
): RunOutcomeValue {
  switch (state) {
    case "green":
      return "success";
    case "escalated-to-human":
      return "human_review";
    case "blocked":
      return "failed";
  }
}

/**
 * Record one `run_outcomes` row for a queue entry's terminal transition.
 *
 * Idempotent on `queue_entry_id` (`run_outcomes_queue_entry_id_unique`, DB
 * migration 0038): `ON CONFLICT DO NOTHING`. A queue entry reaches AT MOST
 * one terminal transition in this codebase — there is no requeue path off
 * `green` / `escalated-to-human` / `blocked` (unlike `parked`, which
 * `requeueParkedQueueEntry` explicitly supports) — so a second call for the
 * same `queueEntryId` is necessarily a retried/duplicated HTTP delivery of
 * the SAME fact, not a legitimate second outcome. First write wins; this
 * never throws on a duplicate.
 */
export async function recordRunOutcome(input: {
  queueEntryId: string;
  workspaceId: string;
  taskType: string | null;
  executeModel: string | null;
  outcome: RunOutcomeValue;
  costUsd: number;
}): Promise<void> {
  await db
    .insert(runOutcomes)
    .values({
      queueEntryId: input.queueEntryId,
      workspaceId: input.workspaceId,
      taskType: input.taskType,
      executeModel: input.executeModel,
      outcome: input.outcome,
      costUsd: input.costUsd,
    })
    .onConflictDoNothing({ target: runOutcomes.queueEntryId });
}

/** Per-`(task_type, execute_model)` aggregate the model-selection learning
 * loop's LATER selector PR reads. Mirrors `eval_arm_metrics`' spirit
 * (solve-rate / $-per-solved per arm) — same idea, fed by PRODUCTION
 * `(task_type, model)` outcomes instead of the offline eval harness. */
export interface ModelOutcomeStatsRow {
  taskType: string | null;
  executeModel: string | null;
  runCount: number;
  successCount: number;
  /** In [0, 1]. 0 when runCount is 0 (an empty group never occurs from a
   * GROUP BY, but this keeps the shape total). */
  successRate: number;
  avgCostUsd: number;
  /** NULL = undefined denominator (zero successes yet) — mirrors
   * `eval_arm_metrics.dollarsPerSolved`'s own None-vs-0 rule. Never coalesced
   * to 0: a $0.00 cost-per-success and an "undefined, no successes yet" are
   * different facts a selector must not confuse. */
  costPerSuccess: number | null;
}

/**
 * Aggregate `run_outcomes` into per-`(task_type, execute_model)` stats: run
 * count, success count/rate, average cost, and cost-per-success. This is the
 * READ SIDE of #1338 PR①'s capture — the selector a LATER PR builds reads
 * this helper; nothing in this PR calls it to change behavior.
 *
 * Both filters are optional and independently applicable: `workspaceId`
 * scopes to one workspace (omit for a global, cross-workspace view);
 * `taskType` narrows to one task type (omit to break down every task type at
 * once). Groups with a NULL `task_type`/`execute_model` are included as
 * their own row (a real, if less useful, group — e.g. a hosted-refusal run
 * that never reached the execute phase) rather than silently dropped.
 */
export async function getModelOutcomeStats(
  opts: { workspaceId?: string; taskType?: string } = {}
): Promise<ModelOutcomeStatsRow[]> {
  const conditions = [];
  if (opts.workspaceId) conditions.push(eq(runOutcomes.workspaceId, opts.workspaceId));
  if (opts.taskType) conditions.push(eq(runOutcomes.taskType, opts.taskType));
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      taskType: runOutcomes.taskType,
      executeModel: runOutcomes.executeModel,
      runCount: sql<string>`COUNT(*)`,
      successCount: sql<string>`COUNT(*) FILTER (WHERE ${runOutcomes.outcome} = ${"success"})`,
      totalCostUsd: sql<string>`COALESCE(SUM(${runOutcomes.costUsd}), 0)`,
    })
    .from(runOutcomes)
    .where(whereClause)
    .groupBy(runOutcomes.taskType, runOutcomes.executeModel);

  return rows.map((r) => {
    const runCount = Number(r.runCount);
    const successCount = Number(r.successCount);
    const totalCostUsd = Number(r.totalCostUsd ?? 0);
    return {
      taskType: r.taskType,
      executeModel: r.executeModel,
      runCount,
      successCount,
      successRate: runCount > 0 ? successCount / runCount : 0,
      avgCostUsd: runCount > 0 ? totalCostUsd / runCount : 0,
      costPerSuccess: successCount > 0 ? totalCostUsd / successCount : null,
    };
  });
}
