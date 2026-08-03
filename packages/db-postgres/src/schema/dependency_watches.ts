import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { repositories } from "./repositories.js";

export type DependencyWatchTrigger = "manual" | "scheduled" | "push";
export type DependencyWatchStatus =
  | "idle"
  | "checking"
  | "candidates"
  | "unchanged"
  | "failed";
export type DependencyWatchErrorCode =
  | "unsupported"
  | "insufficient_evidence"
  | "registry_unavailable"
  | "invalid_snapshot"
  | "authorization";

/** Durable operator intent and observation cursor for one connected repo. */
export const dependencyWatches = pgTable(
  "dependency_watches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    // "auto" delegates repository discovery to the manager adapter. Explicit
    // paths remain supported for monorepos and unusual layouts.
    manifestPath: text("manifest_path").notNull().default("auto"),
    lockfilePath: text("lockfile_path").notNull().default("auto"),
    selectedDependencies: jsonb("selected_dependencies")
      .$type<string[]>()
      .notNull()
      .default([]),
    // NULL means operator-triggered only. A positive value enables the
    // scheduled heartbeat fallback; cadence is never a permission to execute.
    cadenceSeconds: integer("cadence_seconds"),
    lastCheckedSha: text("last_checked_sha"),
    selectedFileHashes: jsonb("selected_file_hashes")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    candidateFingerprint: text("candidate_fingerprint"),
    status: text("status")
      .$type<DependencyWatchStatus>()
      .notNull()
      .default("idle"),
    errorCode: text("error_code").$type<DependencyWatchErrorCode>(),
    errorMessage: text("error_message"),
    lastTrigger: text("last_trigger").$type<DependencyWatchTrigger>(),
    lastTriggeredAt: timestamp("last_triggered_at", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    configUnique: uniqueIndex("dependency_watches_workspace_repo_config_idx").on(
      t.workspaceId,
      t.repositoryId,
      t.manifestPath,
      t.lockfilePath
    ),
    dueIdx: index("dependency_watches_due_idx").on(t.nextCheckAt),
    workspaceIdx: index("dependency_watches_workspace_idx").on(t.workspaceId),
  })
);

/** Append-only observation ledger. It is never an Issue Queue or proposal. */
export const dependencyWatchObservations = pgTable(
  "dependency_watch_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    watchId: uuid("watch_id")
      .notNull()
      .references(() => dependencyWatches.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    trigger: text("trigger").$type<DependencyWatchTrigger>().notNull(),
    baselineSha: text("baseline_sha"),
    selectedFileHashes: jsonb("selected_file_hashes")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    // Candidate fingerprints and unchanged snapshots use the same key so
    // retries are idempotent even when the detector returns no candidate.
    observationKey: text("observation_key").notNull(),
    status: text("status").$type<DependencyWatchStatus>().notNull(),
    candidates: jsonb("candidates").$type<unknown[]>().notNull().default([]),
    errorCode: text("error_code").$type<DependencyWatchErrorCode>(),
    errorMessage: text("error_message"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    observationUnique: uniqueIndex("dependency_watch_observations_workspace_repo_key_idx").on(
      t.workspaceId,
      t.repositoryId,
      t.observationKey
    ),
    watchObservedIdx: index("dependency_watch_observations_watch_observed_idx").on(
      t.watchId,
      t.observedAt
    ),
  })
);

export type DependencyWatchRow = typeof dependencyWatches.$inferSelect;
export type NewDependencyWatch = typeof dependencyWatches.$inferInsert;
export type DependencyWatchObservationRow =
  typeof dependencyWatchObservations.$inferSelect;
export type NewDependencyWatchObservation =
  typeof dependencyWatchObservations.$inferInsert;
