import { pgTable, uuid, text, timestamp, pgEnum, jsonb } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

export const runStatusEnum = pgEnum("run_status", [
  "queued",
  "running",
  "success",
  "failed",
]);

export const runs = pgTable("runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  repositoryId: text("repository_id").notNull(),
  agent: text("agent").notNull(),
  branch: text("branch").notNull(),
  title: text("title"),
  status: runStatusEnum("status").notNull().default("queued"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Context-evidence fields (issue #329 / #331)
  contextPackFile: text("context_pack_file"),
  selectedSources: jsonb("selected_sources").$type<string[]>(),
  retrievalBudget: jsonb("retrieval_budget").$type<Record<string, unknown>>(),
  citations: jsonb("citations").$type<Array<Record<string, unknown>>>(),
});
