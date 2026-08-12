import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  unique,
  uniqueIndex,
  index,
  check,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
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

export type GoDependencySourceInventoryEntry = {
  path: string;
  mode: "100644" | "100755" | "040000";
  type: "blob" | "tree";
  objectSha: string;
};

export type GoDependencySourceInventoryReceipt = {
  kind: "github_exact_tree_dependency_source_inventory";
  schemaVersion: 1;
  identity: {
    ecosystem: "go";
    manager: "go-modules";
    profile: "go_github_exact_tree_source_inventory_v1";
  };
  authority: {
    provider: "github";
    method: "github_app_installation_api";
    apiOrigin: "https://api.github.com";
    repository: string;
    requestedRef: string;
    commitSha: string;
    rootTreeSha: string;
  };
  inventory: {
    recursive: true;
    truncated: false;
    entryCount: number;
    entries: GoDependencySourceInventoryEntry[];
    entriesSha256: string;
  };
  requiredFiles: Array<{
    path: "go.mod" | "go.sum";
    mode: "100644";
    blobSha: string;
    byteCount: number;
    contentSha256: string;
  }>;
  policy: { name: "go_root_source_inventory_v1"; result: "admitted" };
  identitySha256: string;
};

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
    custodyIdentityUnique: uniqueIndex(
      "dependency_watches_custody_identity_idx"
    ).on(t.id, t.workspaceId, t.repositoryId),
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
    // Candidate fingerprint is stored separately from the observation key.
    observationKey: text("observation_key").notNull(),
    candidateFingerprint: text("candidate_fingerprint"),
    sourceInventoryReceipt: jsonb("source_inventory_receipt")
      .$type<GoDependencySourceInventoryReceipt>(),
    sourceInventoryReceiptSha256: text("source_inventory_receipt_sha256"),
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
    sourceCustodyUnique: uniqueIndex(
      "dependency_watch_observations_source_custody_unique_idx"
    ).on(
      t.id,
      t.workspaceId,
      t.watchId,
      t.repositoryId,
      t.sourceInventoryReceiptSha256
    ),
  })
);

export const GO_SUMDB_SIGNED_TREE_NOTE_FORMAT_PROFILE =
  "go_sumdb_v1_retained_signed_tree_note_bytes" as const;

/**
 * Opaque signed-tree-note byte custody for a Go source observation.
 *
 * Postgres preserves the exact bytes and compare-and-set lineage. It does not
 * authenticate the note signature, parse the tree head, or verify inclusion
 * or consistency proofs; those remain Python verifier responsibilities.
 */
export const dependencyWatchGoSumdbSignedTreeNotes = pgTable(
  "dependency_watch_go_sumdb_signed_tree_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    watchId: uuid("watch_id").notNull(),
    repositoryId: uuid("repository_id").notNull(),
    sourceObservationId: uuid("source_observation_id").notNull(),
    sourceInventoryReceiptSha256: text("source_inventory_receipt_sha256").notNull(),
    formatProfile: text("format_profile")
      .$type<typeof GO_SUMDB_SIGNED_TREE_NOTE_FORMAT_PROFILE>()
      .notNull(),
    signedTreeNoteBase64: text("signed_tree_note_base64").notNull(),
    signedTreeNoteSha256: text("signed_tree_note_sha256").notNull(),
    expectedPriorSignedTreeNoteSha256: text(
      "expected_prior_signed_tree_note_sha256"
    ),
    expectedPriorGeneration: integer("expected_prior_generation"),
    generation: integer("generation").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    watchIdentityFk: foreignKey({
      name: "dependency_watch_go_sumdb_notes_watch_identity_fk",
      columns: [t.watchId, t.workspaceId, t.repositoryId],
      foreignColumns: [
        dependencyWatches.id,
        dependencyWatches.workspaceId,
        dependencyWatches.repositoryId,
      ],
    }).onDelete("restrict"),
    sourceObservationFk: foreignKey({
      name: "dependency_watch_go_sumdb_notes_source_custody_fk",
      columns: [
        t.sourceObservationId,
        t.workspaceId,
        t.watchId,
        t.repositoryId,
        t.sourceInventoryReceiptSha256,
      ],
      foreignColumns: [
        dependencyWatchObservations.id,
        dependencyWatchObservations.workspaceId,
        dependencyWatchObservations.watchId,
        dependencyWatchObservations.repositoryId,
        dependencyWatchObservations.sourceInventoryReceiptSha256,
      ],
    }).onDelete("restrict"),
    priorNoteFk: foreignKey({
      name: "dependency_watch_go_sumdb_notes_prior_note_fk",
      columns: [
        t.workspaceId,
        t.watchId,
        t.repositoryId,
        t.expectedPriorSignedTreeNoteSha256,
        t.expectedPriorGeneration,
      ],
      foreignColumns: [
        t.workspaceId,
        t.watchId,
        t.repositoryId,
        t.signedTreeNoteSha256,
        t.generation,
      ],
    }).onDelete("restrict"),
    watchGenerationUnique: unique(
      "dependency_watch_go_sumdb_notes_watch_generation_unique"
    ).on(t.watchId, t.generation),
    watchNoteUnique: unique(
      "dependency_watch_go_sumdb_notes_watch_note_unique"
    ).on(t.watchId, t.signedTreeNoteSha256),
    lineageIdentityUnique: unique(
      "dependency_watch_go_sumdb_notes_lineage_identity_unique"
    ).on(
      t.workspaceId,
      t.watchId,
      t.repositoryId,
      t.signedTreeNoteSha256,
      t.generation
    ),
    watchPriorUnique: uniqueIndex(
      "dependency_watch_go_sumdb_notes_watch_prior_idx"
    ).on(t.watchId, t.expectedPriorSignedTreeNoteSha256)
      .where(sql`${t.expectedPriorSignedTreeNoteSha256} IS NOT NULL`),
    formatCheck: check(
      "dependency_watch_go_sumdb_notes_format_check",
      sql`${t.formatProfile} = ${GO_SUMDB_SIGNED_TREE_NOTE_FORMAT_PROFILE}`
    ),
    lineageCheck: check(
      "dependency_watch_go_sumdb_notes_lineage_check",
      sql`(${t.generation} = 0
          AND ${t.expectedPriorSignedTreeNoteSha256} IS NULL
          AND ${t.expectedPriorGeneration} IS NULL)
        OR (${t.generation} > 0
          AND ${t.expectedPriorSignedTreeNoteSha256} IS NOT NULL
          AND ${t.expectedPriorGeneration} = ${t.generation} - 1)`
    ),
    shaCheck: check(
      "dependency_watch_go_sumdb_notes_sha_check",
      sql`${t.signedTreeNoteSha256} ~ '^[0-9a-f]{64}$'
        AND ${t.sourceInventoryReceiptSha256} ~ '^[0-9a-f]{64}$'
        AND (${t.expectedPriorSignedTreeNoteSha256} IS NULL
          OR (${t.expectedPriorSignedTreeNoteSha256} ~ '^[0-9a-f]{64}$'
            AND ${t.expectedPriorSignedTreeNoteSha256} <> ${t.signedTreeNoteSha256}))`
    ),
    bytesCheck: check(
      "dependency_watch_go_sumdb_notes_bytes_check",
      sql`${t.signedTreeNoteBase64} ~ '^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'
        AND octet_length(${t.signedTreeNoteBase64}) BETWEEN 4 AND 5464
        AND octet_length(decode(${t.signedTreeNoteBase64}, 'base64')) BETWEEN 1 AND 4096
        AND replace(encode(decode(${t.signedTreeNoteBase64}, 'base64'), 'base64'), E'\n', '') = ${t.signedTreeNoteBase64}
        AND encode(sha256(decode(${t.signedTreeNoteBase64}, 'base64')), 'hex') = ${t.signedTreeNoteSha256}`
    ),
  })
);

export type DependencyWatchRow = typeof dependencyWatches.$inferSelect;
export type NewDependencyWatch = typeof dependencyWatches.$inferInsert;
export type DependencyWatchObservationRow =
  typeof dependencyWatchObservations.$inferSelect;
export type NewDependencyWatchObservation =
  typeof dependencyWatchObservations.$inferInsert;
export type DependencyWatchGoSumdbSignedTreeNoteRow =
  typeof dependencyWatchGoSumdbSignedTreeNotes.$inferSelect;
export type NewDependencyWatchGoSumdbSignedTreeNote =
  typeof dependencyWatchGoSumdbSignedTreeNotes.$inferInsert;
