import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  numeric,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

/**
 * Append-only evidence for the cost of accepting a pull request.
 *
 * This is deliberately separate from `review_jobs`: a review job is work Jace
 * queued, while this table is the provider/human evidence used to measure the
 * resulting change. `delivery_id` is GitHub's delivery id (or a stable id from
 * an explicit operator/timer input) and is the replay boundary.
 *
 * Reverts and post-merge rework are explicit event types. GitHub does not emit
 * a reliable first-class "this PR was reverted" event, so the system must not
 * infer either event from elapsed time, a generic push, or a commit message.
 */
export type ReviewEventType =
  | "opened"
  | "head_updated"
  | "review_submitted"
  | "merged"
  | "closed"
  | "reopened"
  | "reverted"
  | "post_merge_rework"
  | "human_review_time";

export type HumanReviewSource = "human_input" | "timer";
export type ReviewActorType = "human" | "agent" | "unknown";

export const reviewEvents = pgTable(
  "review_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    repo: text("repo").notNull(),
    prNumber: integer("pr_number").notNull(),
    // Null means the event was recorded before a task-family label or run
    // association was available. It is reported as unknown, never guessed.
    taskFamily: text("task_family"),
    // GitHub's X-GitHub-Delivery, or a stable explicit-input/timer id.
    deliveryId: text("delivery_id").notNull(),
    eventType: text("event_type").$type<ReviewEventType>().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    headSha: text("head_sha"),
    reviewState: text("review_state"),
    actorType: text("actor_type").$type<ReviewActorType>(),
    additions: integer("additions"),
    deletions: integer("deletions"),
    changedFiles: integer("changed_files"),
    // Populated only by an explicit human input or timer stop. Never derived
    // from opened/merged timestamps.
    humanReviewMinutes: numeric("human_review_minutes", {
      precision: 10,
      scale: 2,
      mode: "number",
    }),
    humanReviewSource: text("human_review_source").$type<HumanReviewSource>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    deliveryUnique: uniqueIndex("review_events_workspace_delivery_idx").on(
      t.workspaceId,
      t.deliveryId
    ),
    prOccurredIdx: index("review_events_pr_occurred_idx").on(
      t.workspaceId,
      t.repo,
      t.prNumber,
      t.occurredAt
    ),
    familyOccurredIdx: index("review_events_family_occurred_idx").on(
      t.workspaceId,
      t.taskFamily,
      t.occurredAt
    ),
  })
);

export type ReviewEventRow = typeof reviewEvents.$inferSelect;
export type NewReviewEvent = typeof reviewEvents.$inferInsert;
