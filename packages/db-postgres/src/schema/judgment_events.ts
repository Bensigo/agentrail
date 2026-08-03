import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

/**
 * Arc E Judgment Ledger storage (spec:
 * docs/superpowers/specs/2026-07-31-judgment-ledger-design.md).
 *
 * This is the bounded E1 capture substrate only: append-only, workspace/repo
 * scoped judgment events with stable references for later constraint and
 * calibration consumers. Routes, producers, consumers, UI, and calibration
 * math intentionally land in later slices.
 */
export const JUDGMENT_EVENT_TYPES = [
  "review_outcome",
  "requirement_correction",
  "rejected_approach",
  "false_green",
  "missed_check",
] as const;

export type JudgmentEventType = (typeof JUDGMENT_EVENT_TYPES)[number];

export type JudgmentEventRefs = {
  findingId?: string;
  investigationId?: string;
  acId?: string;
  changeRecordId?: string;
  runId?: string;
  [key: string]: unknown;
};

export type JudgmentEventRef = {
  kind: string;
  id?: string;
  [key: string]: unknown;
};

export const judgmentEvents = pgTable(
  "judgment_events",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    repo: text("repo").notNull(),
    eventKey: text("event_key").notNull(),
    type: text("type", { enum: JUDGMENT_EVENT_TYPES }).notNull(),
    refs: jsonb("refs").$type<JudgmentEventRefs>().notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    actorRef: jsonb("actor_ref").$type<JudgmentEventRef>().notNull(),
    sourceRef: jsonb("source_ref").$type<JudgmentEventRef>().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    workspaceRepoEventKey: uniqueIndex(
      "judgment_events_workspace_repo_event_key"
    ).on(t.workspaceId, t.repo, t.eventKey),
    workspaceRepoOccurredIdx: index(
      "judgment_events_workspace_repo_occurred_idx"
    ).on(t.workspaceId, t.repo, t.occurredAt),
    workspaceRepoTypeIdx: index("judgment_events_workspace_repo_type_idx").on(
      t.workspaceId,
      t.repo,
      t.type
    ),
  })
);

export type JudgmentEventRow = typeof judgmentEvents.$inferSelect;
