import {
  pgTable,
  uuid,
  text,
  timestamp,
  pgEnum,
  jsonb,
  doublePrecision,
  integer,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspaces } from "./workspaces.js";

export const runStatusEnum = pgEnum("run_status", [
  "queued",
  "running",
  "success",
  "failed",
]);

// Task-family vocabulary (issue #1223) — what KIND of change a run is (bug
// fix / new capability / restructuring / test-only / build-tooling),
// orthogonal to `status`. Fixed and kept in lockstep with the Python side's
// canonical vocabulary (agentrail/shared/task_family.py) and the eval
// corpus's `family` field (agentrail/evals/corpus/loader.py) so a family
// label never means two different things depending on where it was applied.
export const RUN_FAMILY_VALUES = [
  "bug",
  "feature",
  "refactor",
  "test",
  "infra",
] as const;
export type RunFamily = (typeof RUN_FAMILY_VALUES)[number];

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
    // Canonical repository/PR identity corresponding to `prUrl`. Persisting
    // these independently avoids making production attribution re-parse an
    // untrusted string and gives exact run-to-review joins a stable key.
    prRepo: text("pr_repo"),
    prNumber: integer("pr_number"),
    // Exact commit produced by the factory and published to `prUrl`. This is
    // separate from the mutable PR head observed by GitHub webhooks: production
    // outcome metrics may attribute a human result only when the two match.
    // Null means the runner did not provide durable publish provenance.
    prHeadSha: text("pr_head_sha"),
    // #1388: execution-**liveness** timestamp. The fleet worker stamps this
    // (~every 60s) while a claim runs; `reconcileStaleRuns` keys reclaim on its
    // staleness (a still-alive long run is never reaped, a silently-dead runner
    // is reclaimed in minutes). NULL for a run that never pinged (self-hosted /
    // older runners) — reclaim then falls back to the wall-clock `started_at`
    // sweep, byte-identical to the pre-#1388 behavior. NOT a state machine: this
    // is a liveness signal, it opens no new terminal Run Outcome.
    lastLivenessAt: timestamp("last_liveness_at", { withTimezone: true }),
    // Task-family tag (issue #1223 AC4): what KIND of task this run is,
    // mirrored onto the Langfuse trace as a `family:<value>` tag (see
    // agentrail/observability/tracer.py) so solve-rate/$-per-solved can be
    // sliced by family later. Nullable — there is no source that classifies
    // a live GitHub issue's family yet, so most rows stay unclassified; the
    // CHECK still guards against a malformed value on the rows that DO set it.
    family: text("family").$type<RunFamily>(),
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
    familyCheck: check(
      "runs_family_check",
      sql`${t.family} IS NULL OR ${t.family} IN ('bug', 'feature', 'refactor', 'test', 'infra')`
    ),
  })
);
