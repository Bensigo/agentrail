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
    /**
     * Durable caller-owned key for a change that begins before an issue or PR
     * exists. It is intentionally nullable so existing issue/PR records retain
     * their deterministic anchors unchanged.
     */
    workKey: text("work_key"),
    /** The intake surface that created the record (for example codex_mcp). */
    originChannel: text("origin_channel"),
    /** Opaque, bounded references to the originating conversation or thread. */
    sourceReferences: jsonb("source_references")
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default([]),
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
    workKey: uniqueIndex("change_records_work_key")
      .on(t.workspaceId, t.repo, t.workKey)
      .where(sql`${t.workKey} IS NOT NULL`),
    workspaceRepoIdx: index("change_records_workspace_repo_idx").on(
      t.workspaceId,
      t.repo
    ),
  })
);

/**
 * Immutable Acceptance Contract versions for a Change Record. The JSON
 * snapshot intentionally keeps the contract extensible while the lifecycle
 * fields make draft/confirmed authority explicit and queryable.
 */
export const acceptanceContracts = pgTable(
  "acceptance_contracts",
  {
    id: uuid("id").primaryKey(),
    recordId: uuid("record_id")
      .notNull()
      .references(() => changeRecords.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: text("status").notNull().default("draft"),
    contract: jsonb("contract").$type<Record<string, unknown>>().notNull(),
    createdBy: text("created_by").notNull(),
    confirmedBy: text("confirmed_by"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    recordVersion: uniqueIndex("acceptance_contracts_record_version_key").on(
      t.recordId,
      t.version
    ),
    confirmedPerRecord: uniqueIndex("acceptance_contracts_one_confirmed_per_record")
      .on(t.recordId)
      .where(sql`${t.status} = 'confirmed'`),
    recordCreated: index("acceptance_contracts_record_created_idx").on(
      t.recordId,
      t.createdAt
    ),
  })
);

/**
 * The durable, pre-repository start of the acceptance spine. A request may
 * not yet identify a repository, so it cannot safely become a Change Record.
 * This stores only its channel provenance and bounded conversation identity
 * until a later R2 slice supplies the missing scope and drafts a Contract.
 */
export const acceptanceIntakes = pgTable(
  "acceptance_intakes",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    originChannel: text("origin_channel").notNull(),
    conversationKey: text("conversation_key").notNull(),
    sourceReferences: jsonb("source_references")
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default([]),
    status: text("status").notNull().default("collecting_context"),
    recordId: uuid("record_id").references(() => changeRecords.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    conversation: uniqueIndex(
      "acceptance_intakes_workspace_channel_conversation_key"
    ).on(t.workspaceId, t.originChannel, t.conversationKey),
    record: uniqueIndex("acceptance_intakes_record_key")
      .on(t.recordId)
      .where(sql`${t.recordId} IS NOT NULL`),
  })
);

/** Append-only inbound channel evidence for one Acceptance Intake. */
export const acceptanceIntakeMessages = pgTable(
  "acceptance_intake_messages",
  {
    id: uuid("id").primaryKey(),
    intakeId: uuid("intake_id")
      .notNull()
      .references(() => acceptanceIntakes.id, { onDelete: "cascade" }),
    sourceKey: text("source_key").notNull(),
    direction: text("direction").notNull(),
    text: text("text").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    source: uniqueIndex("acceptance_intake_messages_source_key").on(
      t.intakeId,
      t.sourceKey
    ),
    timeline: index("acceptance_intake_messages_timeline_idx").on(
      t.intakeId,
      t.createdAt
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
export type AcceptanceContractRow = typeof acceptanceContracts.$inferSelect;
export type AcceptanceIntakeRow = typeof acceptanceIntakes.$inferSelect;
export type AcceptanceIntakeMessageRow = typeof acceptanceIntakeMessages.$inferSelect;
