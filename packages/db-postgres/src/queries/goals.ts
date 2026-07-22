import { and, eq, desc } from "drizzle-orm";
import { db } from "../db.js";
import { goals, type Goal } from "../schema/goals.js";
import { goalEvents } from "../schema/goal_events.js";
import { workspaces } from "../schema/workspaces.js";
import {
  decideGoalTransition,
  canFileNextIssue,
  type GoalOutcome,
  type GoalAction,
  type GoalCheckType,
} from "./goal_rules.js";

export type { GoalOutcome, GoalAction, GoalCheckType } from "./goal_rules.js";

/**
 * Issue #1289 (Jace goal loop). This module is the DB-facing wrapper around
 * the pure decision engine in `goal_rules.ts` — see that file's doc-comment
 * for the actual safety guarantee (leash + stuck rule, "never loops
 * forever"). Everything here is plumbing: load the goal row, feed its
 * counters to `decideGoalTransition`/`canFileNextIssue`, persist the result,
 * append the `goal_events` audit row. No decision logic lives here — that
 * would risk drifting from the exhaustively-tested pure function.
 */

/**
 * Read a workspace's goal-loop flag (`jaceGoalLoop`, default false — issue
 * #1289 rollout-safety flag). Every goal-loop entry point (create_goal's
 * console endpoint, the run-outcome evaluate endpoint) MUST call this
 * FIRST and short-circuit to a no-op when false, before any goal-table
 * read/write — see `workspaces.ts`'s own doc-comment on this column for
 * the "no caching, read fresh" contract.
 */
export async function isGoalLoopEnabled(workspaceId: string): Promise<boolean> {
  const [row] = await db
    .select({ jaceGoalLoop: workspaces.jaceGoalLoop })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return row?.jaceGoalLoop ?? false;
}

export interface CreateGoalInput {
  workspaceId: string;
  repositoryId: string;
  objective: string;
  slug: string;
  checkType?: GoalCheckType;
  checkMetric?: string;
  checkThreshold?: number;
  checkCommand?: string;
  maxIssues?: number;
  maxSpendUsd?: number;
  stuckThreshold?: number;
  createdByEveSessionId?: string;
}

/** Create a new `active` goal. A human confirms every field before this is called (the create_goal tool's own gate) — this function trusts its input verbatim. */
export async function createGoal(input: CreateGoalInput): Promise<Goal> {
  const [row] = await db
    .insert(goals)
    .values({
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId,
      objective: input.objective,
      slug: input.slug,
      checkType: input.checkType ?? "metric",
      checkMetric: input.checkMetric,
      checkThreshold: input.checkThreshold,
      checkCommand: input.checkCommand,
      maxIssues: input.maxIssues ?? 10,
      maxSpendUsd: input.maxSpendUsd ?? 50,
      stuckThreshold: input.stuckThreshold ?? 2,
      createdByEveSessionId: input.createdByEveSessionId,
    })
    .returning();
  return row!;
}

export async function getGoalById(goalId: string): Promise<Goal | null> {
  const [row] = await db.select().from(goals).where(eq(goals.id, goalId)).limit(1);
  return row ?? null;
}

export async function listActiveGoalsForWorkspace(workspaceId: string): Promise<Goal[]> {
  return db
    .select()
    .from(goals)
    .where(and(eq(goals.workspaceId, workspaceId), eq(goals.status, "active")))
    .orderBy(desc(goals.createdAt));
}

/**
 * Map a GitHub issue back to the active goal it was filed for, if any —
 * the ONLY issue->goal lookup this feature needs, and it never touches
 * GitHub: it walks this workspace's own `goal_events` audit trail for the
 * most recent `issue_filed` row carrying this `issueExternalId`, then
 * checks that goal is still `active` (a mapped issue whose goal has since
 * gone terminal is intentionally NOT returned — there is nothing further
 * to do for it; see `decideGoalTransition`'s terminal safety net).
 */
export async function findActiveGoalForIssue(
  workspaceId: string,
  issueExternalId: string
): Promise<Goal | null> {
  const [event] = await db
    .select({ goalId: goalEvents.goalId })
    .from(goalEvents)
    .where(
      and(
        eq(goalEvents.workspaceId, workspaceId),
        eq(goalEvents.type, "issue_filed"),
        eq(goalEvents.issueExternalId, issueExternalId)
      )
    )
    .orderBy(desc(goalEvents.createdAt))
    .limit(1);
  if (!event) return null;

  const goal = await getGoalById(event.goalId);
  if (!goal || goal.status !== "active") return null;
  return goal;
}

/**
 * Resolve an ACTIVE goal by its human-facing slug (adversarial-review fix,
 * issue #1289) — the lookup the create_issue write path uses to recognize a
 * goal-stamped issue body ("Goal: <objective> (goal:<slug>)") BEFORE ever
 * shelling out to create it, so the leash can be enforced pre-file rather
 * than only noticed retroactively. Only ever returns an `active` goal — a
 * stamp that names an already-terminal goal (leashed/paused/reached/
 * abandoned) resolves to `null` here, same fail-safe posture as
 * `findActiveGoalForIssue`, and the caller (the console's
 * `/api/v1/runner/goals/file-check` route) reads that as "refuse to file".
 * Slugs are NOT unique (see schema/goals.ts's own comment — a slug
 * collision is a cosmetic ambiguity, never enforced at the DB level); this
 * takes the most recently created match, same tie-break idiom as
 * `getJaceSessionByEveSessionId`.
 */
export async function findActiveGoalBySlug(
  workspaceId: string,
  slug: string
): Promise<Goal | null> {
  const [goal] = await db
    .select()
    .from(goals)
    .where(and(eq(goals.workspaceId, workspaceId), eq(goals.slug, slug), eq(goals.status, "active")))
    .orderBy(desc(goals.createdAt))
    .limit(1);
  return goal ?? null;
}

/**
 * Record that an issue was just filed toward `goalId` (the create_issue
 * tool's own best-effort post-creation side effect — see
 * apps/jace/agent/lib/create_issue.core.mjs's `stampCreatedIssueUrl` for the
 * precedent this mirrors: awaited, but a failure here must never turn a
 * successful issue creation into a failed tool call). Increments
 * `issuesFiled` and appends the `issue_filed` audit row in one transaction.
 *
 * Callers MUST check `canFileNextIssue` (goal_rules.ts) against the goal's
 * CURRENT counters before ever attempting to file — this function trusts
 * that check already happened and does not re-validate the leash itself
 * (the actual GitHub issue is already created by the time this runs; there
 * is no "undo" here, only bookkeeping).
 */
export async function recordIssueFiled(
  goalId: string,
  issueExternalId: string
): Promise<void> {
  await db.transaction(async (tx) => {
    const [goal] = await tx.select().from(goals).where(eq(goals.id, goalId)).limit(1);
    if (!goal) return;

    await tx
      .update(goals)
      .set({ issuesFiled: goal.issuesFiled + 1, updatedAt: new Date() })
      .where(eq(goals.id, goalId));

    await tx.insert(goalEvents).values({
      goalId,
      workspaceId: goal.workspaceId,
      type: "issue_filed",
      issueExternalId,
      payload: {},
    });
  });
}

export interface RecordOutcomeInput {
  workspaceId: string;
  issueExternalId: string;
  outcome: GoalOutcome;
  costUsd: number;
}

export interface RecordOutcomeResult {
  /** false when no active goal maps to this issue — the caller (run-outcome dispatch) should no-op. */
  matched: boolean;
  goal?: Goal;
  action?: GoalAction;
  reason?: string;
}

/**
 * THE evaluate-on-outcome entry point (PRD design point 4): map the issue to
 * its goal, feed the goal's current counters + this outcome to
 * `decideGoalTransition`, persist the resulting status/counters, and append
 * the `outcome_recorded` (+ `status_changed`, when the status actually
 * moved) audit rows — all in one transaction, so a goal's counters and its
 * audit trail can never disagree.
 *
 * Callers (the console's `/api/v1/runner/goals/evaluate` route) MUST call
 * `isGoalLoopEnabled` first and skip this entirely when false — this
 * function itself does not re-check the flag (it operates on a specific
 * goal already resolved to be active, and the flag is a workspace-level
 * gate on ENTERING the feature at all, not a per-call re-check).
 */
export async function recordOutcomeAndTransition(
  input: RecordOutcomeInput
): Promise<RecordOutcomeResult> {
  const goal = await findActiveGoalForIssue(input.workspaceId, input.issueExternalId);
  if (!goal) return { matched: false };

  return db.transaction(async (tx) => {
    // Re-read INSIDE the transaction: two terminal outcomes for two
    // different issues of the same goal could race; the second one to
    // reach here must decide against the FIRST one's already-persisted
    // counters, not a stale snapshot read before the transaction opened.
    const [fresh] = await tx.select().from(goals).where(eq(goals.id, goal.id)).limit(1);
    if (!fresh) return { matched: false };

    const decision = decideGoalTransition(
      {
        status: fresh.status,
        maxIssues: fresh.maxIssues,
        maxSpendUsd: fresh.maxSpendUsd,
        issuesFiled: fresh.issuesFiled,
        spendUsd: fresh.spendUsd,
        stuckThreshold: fresh.stuckThreshold,
        consecutiveNonGreen: fresh.consecutiveNonGreen,
        checkType: fresh.checkType,
        checkThreshold: fresh.checkThreshold,
        greenCount: fresh.greenCount,
      },
      { outcome: input.outcome, costUsd: input.costUsd }
    );

    await tx
      .update(goals)
      .set({
        status: decision.nextStatus,
        statusReason: decision.reason,
        spendUsd: decision.spendUsdAfter,
        consecutiveNonGreen: decision.consecutiveNonGreenAfter,
        greenCount: decision.greenCountAfter,
        updatedAt: new Date(),
      })
      .where(eq(goals.id, goal.id));

    await tx.insert(goalEvents).values({
      goalId: goal.id,
      workspaceId: input.workspaceId,
      type: "outcome_recorded",
      issueExternalId: input.issueExternalId,
      outcome: input.outcome,
      costUsd: input.costUsd,
      payload: { reason: decision.reason },
    });

    if (decision.nextStatus !== fresh.status) {
      await tx.insert(goalEvents).values({
        goalId: goal.id,
        workspaceId: input.workspaceId,
        type: "status_changed",
        payload: { from: fresh.status, to: decision.nextStatus, reason: decision.reason },
      });
    }

    return {
      matched: true,
      goal: { ...fresh, status: decision.nextStatus, statusReason: decision.reason },
      action: decision.action,
      reason: decision.reason,
    };
  });
}

/** Whether the goal's leash currently allows filing one more issue — see `canFileNextIssue` (goal_rules.ts) for the rule itself. */
export async function goalCanFileNextIssue(
  goalId: string
): Promise<{ allow: boolean; reason: string }> {
  const goal = await getGoalById(goalId);
  if (!goal) return { allow: false, reason: "goal not found" };
  return canFileNextIssue(goal);
}

async function setGoalStatus(
  goalId: string,
  status: "paused" | "abandoned" | "reached",
  reason: string
): Promise<Goal | null> {
  return db.transaction(async (tx) => {
    const [goal] = await tx.select().from(goals).where(eq(goals.id, goalId)).limit(1);
    if (!goal) return null;

    const [updated] = await tx
      .update(goals)
      .set({ status, statusReason: reason, updatedAt: new Date() })
      .where(eq(goals.id, goalId))
      .returning();

    await tx.insert(goalEvents).values({
      goalId,
      workspaceId: goal.workspaceId,
      type: "status_changed",
      payload: { from: goal.status, to: status, reason },
    });

    return updated ?? null;
  });
}

/** Human-only manual exit: pause an active goal (e.g. from the console card's pause control). Idempotent-ish: pausing an already-terminal goal still records the attempt as an audit row but the PRD's own terminal-safety-net applies at the decide layer, not here — this is a direct admin action, not routed through decideGoalTransition. */
export async function pauseGoal(goalId: string, reason: string): Promise<Goal | null> {
  return setGoalStatus(goalId, "paused", reason);
}

/** Human-only manual exit: abandon a goal outright. */
export async function abandonGoal(goalId: string, reason: string): Promise<Goal | null> {
  return setGoalStatus(goalId, "abandoned", reason);
}

/** Human-only manual completion — the escape hatch for a `command`-type goal, which `decideGoalTransition` never auto-completes in v1 (see schema/goals.ts's own doc-comment on `goalCheckTypeEnum`). */
export async function markGoalReached(goalId: string, reason: string): Promise<Goal | null> {
  return setGoalStatus(goalId, "reached", reason);
}
