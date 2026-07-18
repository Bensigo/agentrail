import {
  pgTable,
  uuid,
  text,
  timestamp,
  pgEnum,
  jsonb,
  doublePrecision,
  index,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

export const runStatusEnum = pgEnum("run_status", [
  "queued",
  "running",
  "success",
  "failed",
]);

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    repositoryId: text("repository_id").notNull(),
    agent: text("agent").notNull(),
    runnerName: text("runner_name").default(""),
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
    // Durable run-registration (MVP durable-queue): enough to resume a killed run.
    // queueEntryId ties the run back to its Issue Queue entry; phase / costUsd /
    // updatedAt let the dispatcher pick a partially-finished run back up after a
    // close-laptop-and-resume.
    queueEntryId: uuid("queue_entry_id"),
    phase: text("phase"),
    costUsd: doublePrecision("cost_usd").default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
    // The pull request this run opened (#891a). Lets the dashboard surface the PR
    // and (in #891b) reconcile the displayed status against the PR's real CI,
    // instead of showing a green-CI PR as "failed" from the local gate verdict.
    prUrl: text("pr_url").default(""),
  },
  (t) => ({
    // Backs the workspace monthly-budget-ceiling SUM (#1269 PR ②a,
    // queries/workspace_budget.ts's sumWorkspaceSpendSince) — without it,
    // that query sequential-scans every historical run row for the workspace
    // on every ~10s claim poll once a workspace has a ceiling set.
    workspaceCreatedAtIdx: index("runs_workspace_id_created_at_idx").on(
      t.workspaceId,
      t.createdAt
    ),
  })
);
