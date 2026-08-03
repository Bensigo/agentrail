import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { repositories } from "./repositories.js";
import { dependencyWatches } from "./dependency_watches.js";

export type DependencyUpgradeContractState =
  | "proposed"
  | "needs-human-decision"
  | "approved"
  | "published"
  | "refused"
  | "stale"
  | "failed";

export type DependencyUpgradeContractEvent =
  | "proposed"
  | "approval_requested"
  | "approved"
  | "refused"
  | "stale"
  | "published"
  | "failed"
  | "needs_human_decision";

/**
 * The durable contract between an observed dependency candidate and a normal
 * Jace alignment approval. A row is unique per workspace/candidate
 * fingerprint, so retries reuse the same proposal instead of minting a second
 * approval or issue.
 */
export const dependencyUpgradeContracts = pgTable(
  "dependency_upgrade_contracts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    watchId: uuid("watch_id")
      .notNull()
      .references(() => dependencyWatches.id, { onDelete: "cascade" }),
    observationKey: text("observation_key").notNull(),
    candidateFingerprint: text("candidate_fingerprint").notNull(),
    packageName: text("package_name").notNull(),
    dependencyKind: text("dependency_kind").notNull(),
    specifier: text("specifier").notNull(),
    currentVersion: text("current_version").notNull(),
    targetVersion: text("target_version").notNull(),
    manifestPath: text("manifest_path").notNull(),
    lockfilePath: text("lockfile_path").notNull(),
    baselineSha: text("baseline_sha").notNull(),
    proposal: jsonb("proposal").$type<Record<string, unknown>>().notNull(),
    state: text("state")
      .$type<DependencyUpgradeContractState>()
      .notNull()
      .default("proposed"),
    approvalId: uuid("approval_id"),
    issueUrl: text("issue_url"),
    issueNumber: text("issue_number"),
    lastError: text("last_error"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    candidateUnique: uniqueIndex("dependency_upgrade_contracts_candidate_idx").on(
      t.workspaceId,
      t.candidateFingerprint
    ),
    workspaceStateIdx: index("dependency_upgrade_contracts_workspace_state_idx").on(
      t.workspaceId,
      t.state,
      t.updatedAt
    ),
    watchIdx: index("dependency_upgrade_contracts_watch_idx").on(t.watchId),
  })
);

/** Append-only audit evidence for proposal, approval/refusal, staleness, and publication. */
export const dependencyUpgradeContractEvents = pgTable(
  "dependency_upgrade_contract_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => dependencyUpgradeContracts.id, { onDelete: "cascade" }),
    candidateFingerprint: text("candidate_fingerprint").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    decision: text("decision").$type<DependencyUpgradeContractEvent>().notNull(),
    approvalId: uuid("approval_id"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    contractOccurredIdx: index("dependency_upgrade_contract_events_contract_idx").on(
      t.contractId,
      t.occurredAt
    ),
    workspaceOccurredIdx: index("dependency_upgrade_contract_events_workspace_idx").on(
      t.workspaceId,
      t.occurredAt
    ),
  })
);

export type DependencyUpgradeContractRow = typeof dependencyUpgradeContracts.$inferSelect;
export type NewDependencyUpgradeContract = typeof dependencyUpgradeContracts.$inferInsert;
export type DependencyUpgradeContractEventRow = typeof dependencyUpgradeContractEvents.$inferSelect;
