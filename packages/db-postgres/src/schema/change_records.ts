import {
  check,
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
import { reviewJobs } from "./review_jobs.js";

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
 * Server-owned builder delivery registrations. Public selection surfaces only
 * the route UUID. Direct task/MCP locators are intentionally absent until a
 * later server-owned binding table can prove their authorization.
 */
export const acceptanceBuilderRoutes = pgTable(
  "acceptance_builder_routes",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    repo: text("repo").notNull(),
    adapter: text("adapter").notNull(),
    status: text("status").notNull().default("active"),
    configurationVersion: integer("configuration_version").notNull(),
    registeredBy: text("registered_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    adapterCheck: check(
      "acceptance_builder_routes_adapter_check",
      sql`${t.adapter} IN ('github_codex', 'github_claude', 'durable_github_fallback', 'durable_jace_fallback')`
    ),
    statusCheck: check(
      "acceptance_builder_routes_status_check",
      sql`${t.status} IN ('active', 'disabled')`
    ),
    configurationVersionCheck: check(
      "acceptance_builder_routes_configuration_version_check",
      sql`${t.configurationVersion} > 0`
    ),
    repoCheck: check(
      "acceptance_builder_routes_repo_check",
      sql`char_length(${t.repo}) BETWEEN 1 AND 512
        AND btrim(${t.repo}) = ${t.repo}
        AND ${t.repo} !~ '[[:cntrl:]]'`
    ),
    registeredByCheck: check(
      "acceptance_builder_routes_registered_by_check",
      sql`char_length(${t.registeredBy}) BETWEEN 6 AND 256
        AND ${t.registeredBy} ~ '^(user|server):[A-Za-z0-9][A-Za-z0-9._@+-]*$'`
    ),
    workspaceRepoStatus: index("acceptance_builder_routes_workspace_repo_status_idx").on(
      t.workspaceId,
      t.repo,
      t.status
    ),
  })
);

/**
 * Immutable, metadata-only source identity admitted for one exact review head.
 * It is not a compiled or delivered Context Pack. Later compiler/resolver
 * slices may only consume a row whose exact source identity is already bound.
 */
export const acceptanceContextPackSnapshots = pgTable(
  "acceptance_context_pack_snapshots",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    recordId: uuid("record_id")
      .notNull()
      .references(() => changeRecords.id, { onDelete: "cascade" }),
    reviewJobId: uuid("review_job_id")
      .notNull()
      .references(() => reviewJobs.id, { onDelete: "restrict" }),
    acceptanceContractId: uuid("acceptance_contract_id")
      .notNull()
      .references(() => acceptanceContracts.id, { onDelete: "restrict" }),
    acceptanceContractVersion: integer("acceptance_contract_version").notNull(),
    /** SHA-256 of the exact confirmed Contract snapshot. */
    acceptanceContractSha256: text("acceptance_contract_sha256"),
    repo: text("repo").notNull(),
    prNumber: integer("pr_number").notNull(),
    expectedHeadSha: text("expected_head_sha").notNull(),
    baseSha: text("base_sha"),
    mergeBaseSha: text("merge_base_sha"),
    headTreeSha: text("head_tree_sha"),
    packetIds: jsonb("packet_ids").$type<string[]>().notNull(),
    packetSetSha256: text("packet_set_sha256").notNull(),
    /** SHA-256 of every validated immutable R8.1 packet payload, not just IDs. */
    correctionPacketPayloadSetSha256: text("correction_packet_payload_set_sha256"),
    compilerVersion: text("compiler_version").notNull(),
    baseIndex: jsonb("base_index").$type<Record<string, unknown>>(),
    overlay: jsonb("overlay").$type<Record<string, unknown>>(),
    provenance: jsonb("provenance").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    replay: uniqueIndex("acceptance_context_pack_snapshots_replay_key").on(
      t.reviewJobId,
      t.compilerVersion,
      t.packetSetSha256
    ),
    reviewJob: index("acceptance_context_pack_snapshots_review_job_idx").on(t.reviewJobId),
    record: index("acceptance_context_pack_snapshots_record_idx").on(t.recordId, t.createdAt),
    statusCheck: check(
      "acceptance_context_pack_snapshots_status_check",
      sql`${t.status} IN ('admitted', 'not_proven')`
    ),
    repoCheck: check(
      "acceptance_context_pack_snapshots_repo_check",
      sql`char_length(${t.repo}) BETWEEN 3 AND 512
        AND btrim(${t.repo}) = ${t.repo}
        AND ${t.repo} ~ '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'
        AND split_part(${t.repo}, '/', 1) NOT IN ('.', '..')
        AND split_part(${t.repo}, '/', 2) NOT IN ('.', '..')`
    ),
    exactHeadCheck: check(
      "acceptance_context_pack_snapshots_expected_head_sha_check",
      sql`${t.expectedHeadSha} ~ '^[A-Fa-f0-9]{40}$'`
    ),
    prNumberCheck: check(
      "acceptance_context_pack_snapshots_pr_number_check",
      sql`${t.prNumber} > 0`
    ),
    packetSetCheck: check(
      "acceptance_context_pack_snapshots_packet_set_sha256_check",
      sql`${t.packetSetSha256} ~ '^[A-Fa-f0-9]{64}$'`
    ),
    acceptanceContractCheck: check(
      "acceptance_context_pack_snapshots_contract_sha_check",
      sql`${t.acceptanceContractSha256} IS NULL OR ${t.acceptanceContractSha256} ~ '^[A-Fa-f0-9]{64}$'`
    ),
    correctionPacketPayloadSetCheck: check(
      "acceptance_context_pack_snapshots_packet_payload_sha_check",
      sql`${t.correctionPacketPayloadSetSha256} IS NULL OR ${t.correctionPacketPayloadSetSha256} ~ '^[A-Fa-f0-9]{64}$'`
    ),
    compilerVersionCheck: check(
      "acceptance_context_pack_snapshots_compiler_version_check",
      sql`char_length(${t.compilerVersion}) BETWEEN 1 AND 128
        AND btrim(${t.compilerVersion}) = ${t.compilerVersion}
        AND ${t.compilerVersion} !~ '[[:cntrl:]]'`
    ),
    identityJsonCheck: check(
      "acceptance_context_pack_snapshots_identity_json_check",
      sql`jsonb_typeof(${t.packetIds}) = 'array'
        AND (${t.baseIndex} IS NULL OR jsonb_typeof(${t.baseIndex}) = 'object')
        AND (${t.overlay} IS NULL OR jsonb_typeof(${t.overlay}) = 'object')
        AND jsonb_typeof(${t.provenance}) = 'object'`
    ),
    reasonCheck: check(
      "acceptance_context_pack_snapshots_reason_check",
      sql`${t.reason} IS NULL OR (
        char_length(${t.reason}) BETWEEN 1 AND 2000
        AND btrim(${t.reason}) = ${t.reason}
        AND ${t.reason} !~ '[[:cntrl:]]'
      )`
    ),
    sourceStateCheck: check(
      "acceptance_context_pack_snapshots_source_state_check",
      sql`(
        ${t.status} = 'admitted'
        AND ${t.baseSha} ~ '^[A-Fa-f0-9]{40}$'
        AND ${t.mergeBaseSha} ~ '^[A-Fa-f0-9]{40}$'
        AND ${t.headTreeSha} ~ '^[A-Fa-f0-9]{40}$'
        AND ${t.baseIndex} IS NOT NULL
        AND ${t.overlay} IS NOT NULL
        AND ${t.reason} IS NULL
      ) OR (
        ${t.status} = 'not_proven'
        AND ${t.baseSha} IS NULL
        AND ${t.mergeBaseSha} IS NULL
        AND ${t.headTreeSha} IS NULL
        AND ${t.baseIndex} IS NULL
        AND ${t.overlay} IS NULL
        AND ${t.reason} IS NOT NULL
      )`
    ),
  })
);

/**
 * Immutable, metadata-only output of the exact-head Context Pack compiler.
 * Rendered representations and source text deliberately remain ephemeral.
 */
export const acceptanceCompiledContextPacks = pgTable(
  "acceptance_compiled_context_packs",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceSnapshotId: uuid("source_snapshot_id")
      .notNull()
      .references(() => acceptanceContextPackSnapshots.id, { onDelete: "restrict" }),
    compilerVersion: text("compiler_version").notNull(),
    policyVersion: text("policy_version").notNull(),
    packSha256: text("pack_sha256").notNull(),
    sourceCustodyIdentitySha256: text("source_custody_identity_sha256").notNull(),
    jsonSha256: text("json_sha256").notNull(),
    markdownSha256: text("markdown_sha256").notNull(),
    renderedByteCount: integer("rendered_byte_count").notNull(),
    binding: jsonb("binding").$type<Record<string, unknown>>().notNull(),
    manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull(),
    sourceCustodyReceipt: jsonb("source_custody_receipt").$type<Record<string, unknown>>().notNull(),
    exactHeadDependencyTreeProofs: jsonb("exact_head_dependency_tree_proofs").$type<Array<{
      path: string;
      blobSha: string;
      proofIdentitySha256: string;
    }>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    replay: uniqueIndex("acceptance_compiled_context_packs_replay_key").on(
      t.sourceSnapshotId, t.compilerVersion, t.policyVersion
    ),
    workspaceSnapshot: index("acceptance_compiled_context_packs_workspace_snapshot_idx").on(
      t.workspaceId, t.sourceSnapshotId
    ),
    shaCheck: check(
      "acceptance_compiled_context_packs_sha_check",
      sql`${t.packSha256} ~ '^[A-Fa-f0-9]{64}$'
        AND ${t.sourceCustodyIdentitySha256} ~ '^[A-Fa-f0-9]{64}$'
        AND ${t.jsonSha256} ~ '^[A-Fa-f0-9]{64}$'
        AND ${t.markdownSha256} ~ '^[A-Fa-f0-9]{64}$'`
    ),
    versionCheck: check(
      "acceptance_compiled_context_packs_version_check",
      sql`char_length(${t.compilerVersion}) BETWEEN 1 AND 128
        AND btrim(${t.compilerVersion}) = ${t.compilerVersion}
        AND ${t.compilerVersion} !~ '[[:cntrl:]]'
        AND char_length(${t.policyVersion}) BETWEEN 1 AND 128
        AND btrim(${t.policyVersion}) = ${t.policyVersion}
        AND ${t.policyVersion} !~ '[[:cntrl:]]'`
    ),
    renderedByteCountCheck: check(
      "acceptance_compiled_context_packs_rendered_byte_count_check",
      sql`${t.renderedByteCount} > 0 AND ${t.renderedByteCount} <= 65536`
    ),
    metadataCheck: check(
      "acceptance_compiled_context_packs_metadata_check",
      sql`jsonb_typeof(${t.binding}) = 'object'
        AND jsonb_typeof(${t.manifest}) = 'object'
        AND jsonb_typeof(${t.sourceCustodyReceipt}) = 'object'
        AND jsonb_typeof(${t.exactHeadDependencyTreeProofs}) = 'array'`
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
export type AcceptanceBuilderRouteRow = typeof acceptanceBuilderRoutes.$inferSelect;
export type AcceptanceContextPackSnapshotRow = typeof acceptanceContextPackSnapshots.$inferSelect;
export type AcceptanceCompiledContextPackRow = typeof acceptanceCompiledContextPacks.$inferSelect;
export type AcceptanceIntakeRow = typeof acceptanceIntakes.$inferSelect;
export type AcceptanceIntakeMessageRow = typeof acceptanceIntakeMessages.$inferSelect;
