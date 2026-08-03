import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspaces } from "./workspaces.js";

/**
 * Arc D Change Record storage (spec:
 * docs/superpowers/specs/2026-07-31-change-record-design.md).
 *
 * `change_records` is the canonical binder for one software change across
 * issue, PR, review, QA, merge, deployment, and later learning. This slice is
 * deliberately storage-only: no routes, UI, or producer adapters live here.
 *
 * A record can be discovered by issue OR PR and later unified when both keys
 * are known. The query layer supplies a deterministic uuid5 id; there is no
 * random default because replay-safe find-or-create depends on deriving the
 * same id for the same logical workspace/repo anchor.
 */
export const changeRecords = pgTable(
  "change_records",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    repo: text("repo").notNull(),
    issueNumber: integer("issue_number"),
    prNumber: integer("pr_number"),
    headShas: text("head_shas").array().notNull().default([]),
    mergedSha: text("merged_sha"),
    state: text("state").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    issueKey: uniqueIndex("change_records_issue_key")
      .on(t.workspaceId, t.repo, t.issueNumber)
      .where(sql`${t.issueNumber} IS NOT NULL`),
    prKey: uniqueIndex("change_records_pr_key")
      .on(t.workspaceId, t.repo, t.prNumber)
      .where(sql`${t.prNumber} IS NOT NULL`),
    workspaceRepoIdx: index("change_records_workspace_repo_idx").on(
      t.workspaceId,
      t.repo
    ),
  })
);

/**
 * Append-only timeline entries attached to a Change Record. The row is
 * immutable by convention and by query helper: append uses
 * `ON CONFLICT (record_id, event_key) DO NOTHING`, never update.
 */
export const changeRecordEvents = pgTable(
  "change_record_events",
  {
    id: uuid("id").primaryKey(),
    recordId: uuid("record_id")
      .notNull()
      .references(() => changeRecords.id, { onDelete: "cascade" }),
    eventKey: text("event_key").notNull(),
    stage: text("stage").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    actor: text("actor").notNull(),
    payloadRef: jsonb("payload_ref").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    recordEventKey: uniqueIndex("change_record_events_record_event_key").on(
      t.recordId,
      t.eventKey
    ),
    timelineIdx: index("change_record_events_timeline_idx").on(t.recordId, t.at),
    stageIdx: index("change_record_events_stage_idx").on(t.recordId, t.stage),
  })
);

export type ChangeRecordRow = typeof changeRecords.$inferSelect;
export type ChangeRecordEventRow = typeof changeRecordEvents.$inferSelect;
