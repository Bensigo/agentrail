import { pgTable, uuid, text, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { repositories } from "./repositories.js";

// Typed classification of a memory entry (issue #1032). Advisory context that a
// human or agent asserted about the codebase; the type disambiguates how the
// context compiler should weigh it. See CONTEXT.md: memory is advisory,
// source-linked, and must never outrank current code — so entries are labelled,
// not trusted blindly.
//   decision   — a locked technical/product decision ("we use Eve for Jace")
//   preference — a soft style/tooling preference ("prefer names over IDs in the UI")
//   fact       — an observed, falsifiable statement about the code/system
// Existing rows predate this column and are backfilled to "fact" (the most
// conservative, lowest-authority label) by migration 0024.
export const memoryTypeEnum = pgEnum("memory_type", [
  "decision",
  "preference",
  "fact",
]);

export const memoryItems = pgTable("memory_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  repositoryId: uuid("repository_id").references(() => repositories.id, {
    onDelete: "set null",
  }),
  source: text("source").notNull(),
  content: text("content").notNull(),
  // Typed entry classification (#1032). Defaults to "fact" so rows written by
  // callers that don't yet supply a type — and all pre-migration rows — land on
  // the lowest-authority label rather than silently claiming to be a decision.
  type: memoryTypeEnum("type").notNull().default("fact"),
  // Writer attribution (#1032): who/what asserted this memory. Free-form so it
  // can hold an agent name ("review"), a run ("run:<id>"), or a human actor.
  // Pre-migration rows are backfilled from their existing `source` value, which
  // is the closest attribution signal the old schema captured.
  writtenBy: text("written_by").notNull().default("unknown"),
  tags: text("tags").array().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
});

export type MemoryItem = typeof memoryItems.$inferSelect;
export type NewMemoryItem = typeof memoryItems.$inferInsert;
