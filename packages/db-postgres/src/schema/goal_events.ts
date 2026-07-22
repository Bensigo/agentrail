import {
  pgTable,
  uuid,
  text,
  numeric,
  timestamp,
  jsonb,
  pgEnum,
  index,
} from "drizzle-orm/pg-core";
import { goals } from "./goals.js";
import { workspaces } from "./workspaces.js";

/**
 * Issue #1289's audit trail: one row per goal lifecycle event — "issue
 * filed", "outcome recorded" (with the leash/stuck-rule decision it drove),
 * or "status changed" (a transition, whether automatic or a human's
 * manual pause/abandon/reached override). This is also the ONLY mechanism
 * that maps a filed GitHub issue back to its goal (an `issue_filed` row's
 * `issueExternalId`) — deliberately NOT a GitHub label round-trip, since
 * `create_issue` has no label input (see `schema/goals.ts`'s `slug` comment)
 * and this keeps the mapping entirely inside AgentRail Postgres, zero-diff
 * under the factory.
 */
export const goalEventTypeEnum = pgEnum("goal_event_type", [
  "issue_filed",
  "outcome_recorded",
  "status_changed",
]);

export const goalEvents = pgTable(
  "goal_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    goalId: uuid("goal_id")
      .notNull()
      .references(() => goals.id, { onDelete: "cascade" }),
    // Denormalized for workspace-scoped reads without a join (mirrors
    // run_outcomes.workspaceId's own rationale).
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    type: goalEventTypeEnum("type").notNull(),
    // The GH issue number/external id this event concerns. Set on
    // `issue_filed` (the mapping write) and `outcome_recorded` (echoes which
    // issue's terminal outcome this is); null on a plain `status_changed`
    // row with no specific triggering issue (e.g. a manual pause).
    issueExternalId: text("issue_external_id"),
    // The terminal outcome vocabulary already on the wire from the console's
    // run-outcome hand-off (queue_entries' own terminal states) — set only
    // on `outcome_recorded`.
    outcome: text("outcome"),
    costUsd: numeric("cost_usd", { precision: 10, scale: 2, mode: "number" }),
    // Free-form extra detail: the decision reason on outcome_recorded/
    // status_changed ("leash exhausted: issues filed 10/10"), or context on
    // issue_filed. Never a substitute for the typed columns above.
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    goalIdx: index("goal_events_goal_id_idx").on(t.goalId),
    workspaceIdx: index("goal_events_workspace_id_idx").on(t.workspaceId),
    // Backs findActiveGoalForIssue's issue->goal mapping lookup.
    issueExternalIdIdx: index("goal_events_issue_external_id_idx").on(
      t.workspaceId,
      t.issueExternalId
    ),
  })
);

export type GoalEvent = typeof goalEvents.$inferSelect;
export type NewGoalEvent = typeof goalEvents.$inferInsert;
