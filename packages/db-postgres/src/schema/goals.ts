import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  timestamp,
  pgEnum,
  index,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { repositories } from "./repositories.js";

/**
 * Issue #1289 (Jace goal loop, PRD `docs/prd/jace-goal-loop.md`, locked
 * 2026-07-10). A workspace goal is a HUMAN-STATED objective — "reach 80%
 * coverage", "burn down the flaky tests" — that Jace pursues by filing
 * issues through the existing gated `create_issue` tool until a
 * machine-checkable condition is met or a leash trips. This is a DIFFERENT
 * entity from the per-issue `workflow.goals` in `.agentrail/state.json`
 * (the run's own execution contract — summary/AC/non-goals injected into
 * context packs, `agentrail/run/state.py:54-147`); that one keeps its name
 * and place and is untouched by this table. See the PRD's "Name collision"
 * risk note.
 *
 * Lifecycle (`goalStatusEnum`): `active` -> exactly one of `reached`
 * (the check was satisfied), `leashed` (max_issues or max_spend_usd
 * exhausted), or `paused` (the stuck rule tripped — N consecutive
 * non-green outcomes). `abandoned` is a human-only manual exit from
 * `active` or `paused`. Every non-`active` status is TERMINAL: the pure
 * decision function (`queries/goal_rules.ts::decideGoalTransition`) proves
 * by construction that once a goal leaves `active` it can never re-enter
 * it or take any further action — see that module's own doc-comment for
 * the "never loops forever" guarantee this schema depends on.
 */
export const goalStatusEnum = pgEnum("goal_status", [
  "active",
  "reached",
  "leashed",
  "paused",
  "abandoned",
]);

/**
 * v1 supports exactly one EVALUATED check type: `metric` — a threshold over
 * data AgentRail Postgres already holds, evaluated read-only by Jace itself
 * (see `checkThreshold` below; the v1 metric formula is always "count of
 * green outcomes recorded for this goal since creation", tracked by
 * `greenCount`). `command` is schema-reserved for the PRD's second check
 * kind (a repo-local command encoded as an issue's acceptance criterion,
 * whose result rides back through the existing verify-gate outcome path) —
 * it is accepted at intake but NOT yet auto-evaluated by
 * `decideGoalTransition`; a command-type goal only ever reaches `reached`
 * via the manual `markGoalReached` escape hatch today. This is a deliberate
 * v1 scope cut (documented, not silent): deciding WHICH filed issue is "the
 * final check issue" is a decomposition-intelligence concern out of this
 * PR's scope, not a safety concern — the leash + stuck rule bound a
 * command-type goal exactly the same as a metric-type one regardless.
 */
export const goalCheckTypeEnum = pgEnum("goal_check_type", [
  "metric",
  "command",
]);

export const goals = pgTable(
  "goals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // v1 is single-repo per goal (PRD non-goal: "No multi-repo goals").
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    // Human-confirmed objective text (free-form). Flows into filed issue
    // bodies, so it crosses the chat->factory trust boundary the same way
    // memory items do — the WRITE side (create_issue's own body builder)
    // already runs every field through hardenUntrusted(); this column
    // stores the raw confirmed text, same posture as `memory_items.content`.
    objective: text("objective").notNull(),
    // Short, workspace-unique handle used to goal-stamp filed issues
    // ("Goal: <objective> (goal:<slug>)" in the issue body — see
    // apps/jace's goal-loop dispatch). Not a GitHub label in v1 (create_issue
    // has no label input; see that tool's own file comment on why labels are
    // server-side only) — a body-embedded stamp, human- and grep-readable,
    // with zero changes to the factory's write path.
    slug: text("slug").notNull(),
    checkType: goalCheckTypeEnum("check_type").notNull().default("metric"),
    // v1's one evaluated metric formula is fixed (see goalCheckTypeEnum's
    // comment): count of green outcomes recorded against this goal. This
    // column is descriptive only (shown on the console card / digest line);
    // decideGoalTransition does not branch on its value.
    checkMetric: text("check_metric"),
    checkThreshold: integer("check_threshold"),
    // Human-readable description of the command-based acceptance criterion,
    // for a checkType='command' goal (not auto-evaluated in v1 — see above).
    checkCommand: text("check_command"),
    status: goalStatusEnum("status").notNull().default("active"),
    // Human/reason for the CURRENT status, e.g. "leash exhausted: issues
    // filed 10/10" or "stuck: 2 consecutive non-green outcomes" or a manual
    // pause/abandon note. Null only for a freshly created, still-active goal.
    statusReason: text("status_reason"),
    // --- Leash (issue #1289's safety heart; mirrors budget_leash's shape) ---
    maxIssues: integer("max_issues").notNull().default(10),
    maxSpendUsd: numeric("max_spend_usd", {
      precision: 10,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(50),
    issuesFiled: integer("issues_filed").notNull().default(0),
    spendUsd: numeric("spend_usd", { precision: 10, scale: 2, mode: "number" })
      .notNull()
      .default(0),
    // --- Stuck rule ---
    stuckThreshold: integer("stuck_threshold").notNull().default(2),
    consecutiveNonGreen: integer("consecutive_non_green").notNull().default(0),
    // Running count of green (success) outcomes recorded for this goal —
    // the v1 metric-check formula's own counter (see checkMetric's comment).
    greenCount: integer("green_count").notNull().default(0),
    // The Eve session (conversation) this goal was confirmed from — a human
    // states every goal (PRD Goals #2), never Jace self-creating one. Used
    // to resolve which chat later receives refill/escalation notifications
    // (via that session's jace_sessions channel/target — resolution lives
    // console-side, this column is just the anchor). Nullable only for a
    // hypothetical console-created goal (no v1 UI does this yet).
    createdByEveSessionId: text("created_by_eve_session_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    workspaceIdx: index("goals_workspace_id_idx").on(t.workspaceId),
    workspaceStatusIdx: index("goals_workspace_status_idx").on(
      t.workspaceId,
      t.status
    ),
    workspaceSlugIdx: index("goals_workspace_slug_idx").on(
      t.workspaceId,
      t.slug
    ),
  })
);

export type Goal = typeof goals.$inferSelect;
export type NewGoal = typeof goals.$inferInsert;
