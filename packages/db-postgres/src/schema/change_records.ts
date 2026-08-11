import {
  boolean,
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
    /**
     * Mutable exact tip for the attached PR. `headShas` remains the immutable
     * historical union; exact-head operations must use this pointer instead
     * of treating any historical member as current.
     */
    currentPrHeadSha: text("current_pr_head_sha"),
    /** UUID for the current occurrence of a head, distinct across SHA revisits. */
    currentPrHeadCycleId: uuid("current_pr_head_cycle_id"),
    /** Fail-closed authority bit for operational exact-head consumers. */
    currentPrHeadAuthoritative: boolean("current_pr_head_authoritative")
      .notNull()
      .default(false),
    /**
     * Monotonic revision for every authority-changing PR observation. A
     * reconciler must present the revision it read before it can restore
     * authority, so a later signed delivery cannot be overwritten by a stale
     * GitHub API read.
     */
    currentPrHeadAuthorityGeneration: integer("current_pr_head_authority_generation")
      .notNull()
      .default(0),
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
    currentPrHeadHistoryCheck: check(
      "change_records_current_pr_head_history_check",
      sql`(
        ${t.currentPrHeadSha} IS NULL OR (
          ${t.currentPrHeadSha} ~ '^[A-Fa-f0-9]{40}$'
          AND ${t.currentPrHeadSha} = ANY(${t.headShas})
        )
      ) AND (
        (${t.currentPrHeadSha} IS NULL) = (${t.currentPrHeadCycleId} IS NULL)
      ) AND (
        NOT ${t.currentPrHeadAuthoritative} OR (
          ${t.currentPrHeadSha} IS NOT NULL AND ${t.currentPrHeadCycleId} IS NOT NULL
        )
      )`
    ),
    currentPrHeadAuthorityGenerationCheck: check(
      "change_records_current_pr_head_authority_generation_check",
      sql`${t.currentPrHeadAuthorityGeneration} >= 0`
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
 * Immutable, server-derived authorization configuration for one GitHub-native
 * Builder route revision. This is intentionally not a vendor availability or
 * activity receipt: a later carrier must still record its own acceptance.
 */
export const acceptanceBuilderRouteCapabilityProfiles = pgTable(
  "acceptance_builder_route_capability_profiles",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    routeId: uuid("route_id")
      .notNull()
      .references(() => acceptanceBuilderRoutes.id, { onDelete: "restrict" }),
    repo: text("repo").notNull(),
    adapter: text("adapter").notNull(),
    routeConfigurationVersion: integer("route_configuration_version").notNull(),
    githubInstallationIdentitySha256: text("github_installation_identity_sha256").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    snapshotSha256: text("snapshot_sha256").notNull(),
    recordedBy: text("recorded_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    routeConfiguration: uniqueIndex(
      "acceptance_builder_route_cap_profiles_route_config_key"
    ).on(t.routeId, t.routeConfigurationVersion),
    workspaceRepo: index(
      "acceptance_builder_route_capability_profiles_workspace_repo_idx"
    ).on(t.workspaceId, t.repo, t.createdAt),
    adapterCheck: check(
      "acceptance_builder_route_capability_profiles_adapter_check",
      sql`${t.adapter} IN ('github_codex', 'github_claude')`
    ),
    repoCheck: check(
      "acceptance_builder_route_capability_profiles_repo_check",
      sql`char_length(${t.repo}) BETWEEN 3 AND 512
        AND btrim(${t.repo}) = ${t.repo}
        AND ${t.repo} ~ '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'`
    ),
    configurationVersionCheck: check(
      "acceptance_builder_route_cap_profiles_config_version_check",
      sql`${t.routeConfigurationVersion} > 0`
    ),
    snapshotCheck: check(
      "acceptance_builder_route_capability_profiles_snapshot_check",
      sql`${t.githubInstallationIdentitySha256} ~ '^[A-Fa-f0-9]{64}$'
        AND jsonb_typeof(${t.snapshot}) = 'object'
        AND ${t.snapshotSha256} ~ '^[A-Fa-f0-9]{64}$'`
    ),
    recordedByCheck: check(
      "acceptance_builder_route_capability_profiles_recorded_by_check",
      sql`char_length(${t.recordedBy}) BETWEEN 8 AND 256
        AND ${t.recordedBy} ~ '^server:[A-Za-z0-9][A-Za-z0-9._@+-]*$'`
    ),
  })
);

/**
 * Immutable GitHub Actions acknowledgement policy for one `github_claude`
 * route revision. The generic capability profile above proves only the Jace
 * GitHub installation; this separate policy pins the numeric repository and
 * actor identities plus the exact trusted workflow and Anthropic Action SHAs
 * that may later attest one successful Claude session.
 */
export const acceptanceBuilderRouteGithubClaudeAckProfiles = pgTable(
  "acceptance_builder_route_github_claude_ack_profiles",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    routeId: uuid("route_id")
      .notNull()
      .references(() => acceptanceBuilderRoutes.id, { onDelete: "restrict" }),
    capabilityProfileId: uuid("capability_profile_id")
      .notNull()
      .references(() => acceptanceBuilderRouteCapabilityProfiles.id, { onDelete: "restrict" }),
    capabilityProfileSnapshotSha256: text("capability_profile_snapshot_sha256").notNull(),
    repo: text("repo").notNull(),
    routeConfigurationVersion: integer("route_configuration_version").notNull(),
    githubRepositoryId: text("github_repository_id").notNull(),
    githubRepositoryOwnerId: text("github_repository_owner_id").notNull(),
    githubAppBotUserId: text("github_app_bot_user_id").notNull(),
    githubAppBotLogin: text("github_app_bot_login").notNull(),
    oidcIssuer: text("oidc_issuer").notNull(),
    oidcAudienceContract: text("oidc_audience_contract").notNull(),
    oidcSubjectContract: text("oidc_subject_contract").notNull(),
    callerWorkflowRef: text("caller_workflow_ref").notNull(),
    jobWorkflowRef: text("job_workflow_ref").notNull(),
    jobWorkflowSha: text("job_workflow_sha").notNull(),
    claudeActionSha: text("claude_action_sha").notNull(),
    workflowContract: text("workflow_contract").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    snapshotSha256: text("snapshot_sha256").notNull(),
    recordedBy: text("recorded_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    routeConfiguration: uniqueIndex(
      "acceptance_builder_claude_ack_profiles_route_config_key"
    ).on(t.routeId, t.routeConfigurationVersion),
    workspaceRepo: index("acceptance_builder_claude_ack_profiles_workspace_repo_idx")
      .on(t.workspaceId, t.repo, t.createdAt),
    bindingCheck: check(
      "acceptance_builder_claude_ack_profiles_binding_check",
      sql`${t.routeConfigurationVersion} > 0
        AND char_length(${t.repo}) BETWEEN 3 AND 512
        AND btrim(${t.repo}) = ${t.repo}
        AND ${t.repo} ~ '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'
        AND ${t.capabilityProfileSnapshotSha256} ~ '^[A-Fa-f0-9]{64}$'
        AND ${t.githubRepositoryId} ~ '^[1-9][0-9]{0,39}$'
        AND ${t.githubRepositoryOwnerId} ~ '^[1-9][0-9]{0,39}$'
        AND ${t.githubAppBotUserId} ~ '^[1-9][0-9]{0,39}$'
        AND ${t.githubAppBotLogin} = 'jace[bot]'
        AND ${t.oidcIssuer} = 'https://token.actions.githubusercontent.com'
        AND ${t.oidcAudienceContract} = 'activation_comment_run_attempt_sha256_v1'
        AND ${t.oidcSubjectContract} = 'default_repo_ref_legacy_or_immutable_v1'
        AND char_length(${t.callerWorkflowRef}) BETWEEN 1 AND 1024
        AND ${t.callerWorkflowRef} LIKE ${t.repo} || '/.github/workflows/%@refs/heads/%'
        AND ${t.callerWorkflowRef} !~ '[[:cntrl:]]'
        AND char_length(${t.jobWorkflowRef}) BETWEEN 1 AND 1024
        AND ${t.jobWorkflowRef} ~ '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/\\.github/workflows/[A-Za-z0-9._/-]+\\.ya?ml@[A-Fa-f0-9]{40}$'
        AND right(lower(${t.jobWorkflowRef}), 40) = lower(${t.jobWorkflowSha})
        AND ${t.jobWorkflowSha} ~ '^[A-Fa-f0-9]{40}$'
        AND ${t.claudeActionSha} = '6b082c41935b4c8a3b8b0ef85ba4ba4d9eeb8975'
        AND ${t.workflowContract} = 'github_claude_action_success_session_v1'
        AND jsonb_typeof(${t.snapshot}) = 'object'
        AND ${t.snapshotSha256} ~ '^[A-Fa-f0-9]{64}$'`
    ),
    recordedByCheck: check(
      "acceptance_builder_claude_ack_profiles_recorded_by_check",
      sql`char_length(${t.recordedBy}) BETWEEN 8 AND 256
        AND ${t.recordedBy} ~ '^server:[A-Za-z0-9][A-Za-z0-9._@+-]*$'`
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
 * One server-derived delivery aggregate for one immutable occurrence of a PR
 * head.  This deliberately contains no vendor task locator or credential: a
 * later worker may use the selected route snapshot, but cannot reinterpret
 * the Record, Pack, packets, or current-head authority it was given.
 */
export const acceptanceCorrectionDispatches = pgTable(
  "acceptance_correction_dispatches",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    recordId: uuid("record_id").notNull().references(() => changeRecords.id, { onDelete: "cascade" }),
    repo: text("repo").notNull(),
    prNumber: integer("pr_number").notNull(),
    headSha: text("head_sha").notNull(),
    headCycleId: uuid("head_cycle_id").notNull(),
    authorityGeneration: integer("authority_generation").notNull(),
    sourceSnapshotId: uuid("source_snapshot_id").notNull().references(() => acceptanceContextPackSnapshots.id, { onDelete: "restrict" }),
    reviewJobId: uuid("review_job_id").notNull().references(() => reviewJobs.id, { onDelete: "restrict" }),
    acceptanceContractId: uuid("acceptance_contract_id").notNull().references(() => acceptanceContracts.id, { onDelete: "restrict" }),
    acceptanceContractVersion: integer("acceptance_contract_version").notNull(),
    acceptanceContractSha256: text("acceptance_contract_sha256").notNull(),
    packetIds: jsonb("packet_ids").$type<string[]>().notNull(),
    packetSetSha256: text("packet_set_sha256").notNull(),
    correctionPacketPayloadSetSha256: text("correction_packet_payload_set_sha256").notNull(),
    compiledPackId: uuid("compiled_pack_id").notNull().references(() => acceptanceCompiledContextPacks.id, { onDelete: "restrict" }),
    compiledPackSha256: text("compiled_pack_sha256").notNull(),
    compilerVersion: text("compiler_version").notNull(),
    policyVersion: text("policy_version").notNull(),
    jsonSha256: text("json_sha256").notNull(),
    markdownSha256: text("markdown_sha256").notNull(),
    sourceCustodyIdentitySha256: text("source_custody_identity_sha256").notNull(),
    routeId: uuid("route_id").notNull().references(() => acceptanceBuilderRoutes.id, { onDelete: "restrict" }),
    routeAdapter: text("route_adapter").notNull(),
    routeConfigurationVersion: integer("route_configuration_version").notNull(),
    routeSnapshot: jsonb("route_snapshot").$type<Record<string, unknown>>().notNull(),
    routeSnapshotSha256: text("route_snapshot_sha256").notNull(),
    /** Null for legacy or durable-fallback rows; GitHub vendor execution must reject those rows. */
    capabilityProfileId: uuid("capability_profile_id").references(
      () => acceptanceBuilderRouteCapabilityProfiles.id,
      { onDelete: "restrict" }
    ),
    capabilityProfileSnapshot: jsonb("capability_profile_snapshot").$type<Record<string, unknown>>(),
    capabilityProfileSnapshotSha256: text("capability_profile_snapshot_sha256"),
    dispatchProtocolVersion: integer("dispatch_protocol_version").notNull().default(1),
    dispatchIdentitySha256: text("dispatch_identity_sha256").notNull(),
    deliveryState: text("delivery_state").notNull().default("queued"),
    agentState: text("agent_state").notNull().default("not_observed"),
    findingsState: text("findings_state").notNull().default("not_started"),
    activationState: text("activation_state").notNull().default("not_started"),
    carrier: text("carrier").notNull(),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidationReason: text("invalidation_reason"),
    successorHeadSha: text("successor_head_sha"),
    successorHeadCycleId: uuid("successor_head_cycle_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    recordCycle: uniqueIndex("acceptance_correction_dispatches_record_cycle_key").on(t.recordId, t.headCycleId),
    workspaceRecord: index("acceptance_correction_dispatches_workspace_record_idx").on(t.workspaceId, t.recordId, t.createdAt),
    headCheck: check("acceptance_correction_dispatches_head_check", sql`${t.headSha} ~ '^[A-Fa-f0-9]{40}$' AND ${t.authorityGeneration} >= 0 AND char_length(${t.repo}) BETWEEN 3 AND 512 AND btrim(${t.repo}) = ${t.repo} AND ${t.repo} ~ '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$' AND ${t.prNumber} > 0`),
    contractCheck: check("acceptance_correction_dispatches_contract_check", sql`${t.acceptanceContractVersion} > 0 AND ${t.acceptanceContractSha256} ~ '^[A-Fa-f0-9]{64}$'`),
    packetCheck: check("acceptance_correction_dispatches_packet_check", sql`jsonb_typeof(${t.packetIds}) = 'array' AND jsonb_array_length(${t.packetIds}) BETWEEN 1 AND 100 AND ${t.packetSetSha256} ~ '^[A-Fa-f0-9]{64}$' AND ${t.correctionPacketPayloadSetSha256} ~ '^[A-Fa-f0-9]{64}$'`),
    packCheck: check("acceptance_correction_dispatches_pack_check", sql`${t.compiledPackSha256} ~ '^[A-Fa-f0-9]{64}$' AND ${t.sourceCustodyIdentitySha256} ~ '^[A-Fa-f0-9]{64}$' AND ${t.jsonSha256} ~ '^[A-Fa-f0-9]{64}$' AND ${t.markdownSha256} ~ '^[A-Fa-f0-9]{64}$'`),
    versionCheck: check("acceptance_correction_dispatches_version_check", sql`char_length(${t.compilerVersion}) BETWEEN 1 AND 128 AND btrim(${t.compilerVersion}) = ${t.compilerVersion} AND ${t.compilerVersion} !~ '[[:cntrl:]]' AND char_length(${t.policyVersion}) BETWEEN 1 AND 128 AND btrim(${t.policyVersion}) = ${t.policyVersion} AND ${t.policyVersion} !~ '[[:cntrl:]]' AND ${t.routeConfigurationVersion} > 0 AND ${t.dispatchProtocolVersion} = 1`),
    routeCheck: check("acceptance_correction_dispatches_route_check", sql`${t.routeAdapter} IN ('github_codex', 'github_claude', 'durable_github_fallback', 'durable_jace_fallback') AND jsonb_typeof(${t.routeSnapshot}) = 'object' AND ${t.routeSnapshotSha256} ~ '^[A-Fa-f0-9]{64}$' AND ${t.dispatchIdentitySha256} ~ '^[A-Fa-f0-9]{64}$'`),
    capabilityProfileCheck: check("acceptance_correction_dispatches_capability_profile_check", sql`(
      (${t.capabilityProfileId} IS NULL)
      = (${t.capabilityProfileSnapshot} IS NULL)
      AND (${t.capabilityProfileId} IS NULL)
      = (${t.capabilityProfileSnapshotSha256} IS NULL)
      AND (${t.capabilityProfileSnapshot} IS NULL OR jsonb_typeof(${t.capabilityProfileSnapshot}) = 'object')
      AND (${t.capabilityProfileSnapshotSha256} IS NULL OR ${t.capabilityProfileSnapshotSha256} ~ '^[A-Fa-f0-9]{64}$')
    )`),
    deliveryStateCheck: check("acceptance_correction_dispatches_delivery_state_check", sql`${t.deliveryState} IN ('queued', 'carrier_accepted', 'ambiguous_hold', 'failed', 'fallback')`),
    agentStateCheck: check("acceptance_correction_dispatches_agent_state_check", sql`${t.agentState} IN ('not_observed', 'started', 'acknowledged', 'failed')`),
    findingsStateCheck: check("acceptance_correction_dispatches_findings_state_check", sql`${t.findingsState} IN ('not_started', 'reserved', 'terminal', 'ambiguous_hold', 'failed')`),
    activationStateCheck: check("acceptance_correction_dispatches_activation_state_check", sql`${t.activationState} IN ('not_started', 'reserved', 'carrier_accepted', 'ambiguous_hold', 'failed', 'fallback')`),
    carrierCheck: check("acceptance_correction_dispatches_carrier_check", sql`${t.carrier} IN ('github_comment', 'durable_notice')`),
    invalidationCheck: check("acceptance_correction_dispatches_invalidation_check", sql`(${t.invalidatedAt} IS NULL) = (${t.invalidationReason} IS NULL) AND (${t.successorHeadSha} IS NULL) = (${t.successorHeadCycleId} IS NULL) AND (${t.successorHeadSha} IS NULL OR ${t.successorHeadSha} ~ '^[A-Fa-f0-9]{40}$') AND (${t.invalidationReason} IS NULL OR ${t.invalidationReason} IN ('head_advanced', 'authority_blocked', 'terminal', 'reconciled'))`),
  })
);

/**
 * Immutable-attempt custody for the carrier-inert GitHub App preflight that
 * precedes GitHub-native correction delivery.  This is deliberately not a
 * carrier receipt: a ready result proves only the bounded remote PR check,
 * never that GitHub accepted a comment or a vendor started work. A closed
 * `storage_unavailable` result remains indeterminate so a later reservation
 * can create the bounded successor attempt.
 */
export const acceptanceCorrectionDispatchGithubPreflights = pgTable(
  "acceptance_correction_dispatch_github_preflights",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    dispatchId: uuid("dispatch_id").notNull().references(() => acceptanceCorrectionDispatches.id, { onDelete: "restrict" }),
    recordId: uuid("record_id").notNull().references(() => changeRecords.id, { onDelete: "cascade" }),
    repo: text("repo").notNull(),
    prNumber: integer("pr_number").notNull(),
    headSha: text("head_sha").notNull(),
    baseSha: text("base_sha").notNull(),
    headCycleId: uuid("head_cycle_id").notNull(),
    authorityGeneration: integer("authority_generation").notNull(),
    dispatchIdentitySha256: text("dispatch_identity_sha256").notNull(),
    routeId: uuid("route_id").notNull().references(() => acceptanceBuilderRoutes.id, { onDelete: "restrict" }),
    routeAdapter: text("route_adapter").notNull(),
    routeConfigurationVersion: integer("route_configuration_version").notNull(),
    capabilityProfileId: uuid("capability_profile_id").notNull().references(
      () => acceptanceBuilderRouteCapabilityProfiles.id, { onDelete: "restrict" }
    ),
    capabilityProfileSnapshotSha256: text("capability_profile_snapshot_sha256").notNull(),
    githubInstallationIdentitySha256: text("github_installation_identity_sha256").notNull(),
    preflightProtocolVersion: integer("preflight_protocol_version").notNull().default(1),
    permissionContract: text("permission_contract").notNull(),
    attempt: integer("attempt").notNull(),
    preflightIdentitySha256: text("preflight_identity_sha256").notNull(),
    status: text("status").notNull().default("reserved"),
    /** Closed result variant only; never a token, body, raw error, or receipt. */
    result: jsonb("result").$type<Record<string, unknown>>(),
    reservedAt: timestamp("reserved_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    dispatchAttempt: uniqueIndex("acceptance_correction_github_preflights_dispatch_attempt_key")
      .on(t.dispatchId, t.attempt),
    workspaceDispatch: index("acceptance_correction_github_preflights_workspace_dispatch_idx")
      .on(t.workspaceId, t.dispatchId, t.createdAt),
    bindingCheck: check(
      "acceptance_correction_dispatch_github_preflights_binding_check",
      sql`btrim(${t.repo}) = ${t.repo}
        AND ${t.repo} ~ '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'
        AND split_part(${t.repo}, '/', 1) NOT IN ('.', '..')
        AND split_part(${t.repo}, '/', 2) NOT IN ('.', '..')
        AND ${t.prNumber} > 0
        AND ${t.headSha} ~ '^[A-Fa-f0-9]{40}$'
        AND ${t.baseSha} ~ '^[A-Fa-f0-9]{40}$'
        AND ${t.authorityGeneration} >= 0
        AND ${t.dispatchIdentitySha256} ~ '^[A-Fa-f0-9]{64}$'
        AND ${t.routeAdapter} IN ('github_codex', 'github_claude')
        AND ${t.routeConfigurationVersion} > 0
        AND ${t.capabilityProfileSnapshotSha256} ~ '^[A-Fa-f0-9]{64}$'
        AND ${t.githubInstallationIdentitySha256} ~ '^[A-Fa-f0-9]{64}$'
        AND ${t.preflightProtocolVersion} = 1
        AND ${t.permissionContract} = 'issues_write_and_pull_requests_write_v1'
        AND ${t.attempt} BETWEEN 1 AND 8
        AND ${t.preflightIdentitySha256} ~ '^[A-Fa-f0-9]{64}$'`
    ),
    statusCheck: check(
      "acceptance_correction_dispatch_github_preflights_status_check",
      sql`${t.status} IN ('reserved', 'ready', 'unavailable', 'indeterminate')
        AND ((${t.status} = 'reserved') = (${t.result} IS NULL))
        AND ((${t.status} = 'reserved') = (${t.completedAt} IS NULL))
        AND (${t.result} IS NULL OR jsonb_typeof(${t.result}) = 'object')`
    ),
  })
);

/** One inert PR finding-comment reservation for one immutable, sorted R8.1 packet. */
export const acceptanceCorrectionDispatchGithubFindingPublications = pgTable(
  "acceptance_correction_dispatch_github_finding_publications",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    dispatchId: uuid("dispatch_id").notNull().references(() => acceptanceCorrectionDispatches.id, { onDelete: "restrict" }),
    recordId: uuid("record_id").notNull().references(() => changeRecords.id, { onDelete: "cascade" }),
    packetId: text("packet_id").notNull(),
    criterionId: text("criterion_id").notNull(),
    repo: text("repo").notNull(),
    prNumber: integer("pr_number").notNull(),
    headSha: text("head_sha").notNull(),
    baseSha: text("base_sha").notNull(),
    headCycleId: uuid("head_cycle_id").notNull(),
    authorityGeneration: integer("authority_generation").notNull(),
    dispatchIdentitySha256: text("dispatch_identity_sha256").notNull(),
    routeId: uuid("route_id").notNull().references(() => acceptanceBuilderRoutes.id, { onDelete: "restrict" }),
    routeAdapter: text("route_adapter").notNull(),
    routeConfigurationVersion: integer("route_configuration_version").notNull(),
    capabilityProfileId: uuid("capability_profile_id").notNull().references(
      () => acceptanceBuilderRouteCapabilityProfiles.id, { onDelete: "restrict" }
    ),
    capabilityProfileSnapshotSha256: text("capability_profile_snapshot_sha256").notNull(),
    githubInstallationIdentitySha256: text("github_installation_identity_sha256").notNull(),
    readyPreflightId: uuid("ready_preflight_id").notNull().references(
      () => acceptanceCorrectionDispatchGithubPreflights.id, { onDelete: "restrict" }
    ),
    readyPreflightIdentitySha256: text("ready_preflight_identity_sha256").notNull(),
    publicationProtocolVersion: integer("publication_protocol_version").notNull().default(1),
    publicationIdentitySha256: text("publication_identity_sha256").notNull(),
    carrier: text("carrier").notNull().default("github_issue_comment"),
    packetPayloadSha256: text("packet_payload_sha256").notNull(),
    /** Null only for a terminal, locally rejected unpostable rendering. */
    body: text("body"),
    bodySha256: text("body_sha256"),
    status: text("status").notNull().default("reserved"),
    githubCommentId: text("github_comment_id"),
    githubCommentUrl: text("github_comment_url"),
    resultReason: text("result_reason"),
    reservedAt: timestamp("reserved_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    dispatchPacket: uniqueIndex("acceptance_correction_gh_findings_dispatch_packet_key").on(t.dispatchId, t.packetId),
    commentReceipt: uniqueIndex("acceptance_correction_gh_findings_comment_receipt_key")
      .on(t.githubCommentId).where(sql`${t.githubCommentId} IS NOT NULL`),
    bindingCheck: check(
      "acceptance_correction_gh_findings_binding_check",
      sql`char_length(${t.repo}) BETWEEN 3 AND 512
        AND btrim(${t.repo}) = ${t.repo}
        AND ${t.repo} ~ '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'
        AND split_part(${t.repo}, '/', 1) NOT IN ('.', '..')
        AND split_part(${t.repo}, '/', 2) NOT IN ('.', '..')
        AND ${t.prNumber} > 0
        AND ${t.headSha} ~ '^[A-Fa-f0-9]{40}$'
        AND ${t.baseSha} ~ '^[A-Fa-f0-9]{40}$'
        AND ${t.authorityGeneration} >= 0
        AND ${t.dispatchIdentitySha256} ~ '^[A-Fa-f0-9]{64}$'
        AND ${t.packetId} ~ '^correction-[A-Fa-f0-9]{48}$'
        AND char_length(${t.criterionId}) BETWEEN 1 AND 512
        AND btrim(${t.criterionId}) = ${t.criterionId}
        AND ${t.criterionId} !~ '[[:cntrl:]]'
        AND ${t.routeAdapter} IN ('github_codex', 'github_claude')
        AND ${t.routeConfigurationVersion} > 0
        AND ${t.capabilityProfileSnapshotSha256} ~ '^[A-Fa-f0-9]{64}$'
        AND ${t.githubInstallationIdentitySha256} ~ '^[A-Fa-f0-9]{64}$'
        AND ${t.readyPreflightIdentitySha256} ~ '^[A-Fa-f0-9]{64}$'
        AND ${t.publicationProtocolVersion} = 1
        AND ${t.publicationIdentitySha256} ~ '^[A-Fa-f0-9]{64}$'
        AND ${t.carrier} = 'github_issue_comment'
        AND ${t.packetPayloadSha256} ~ '^[A-Fa-f0-9]{64}$'
        AND (${t.body} IS NULL OR octet_length(${t.body}) BETWEEN 1 AND 12288)
        AND (${t.bodySha256} IS NULL OR ${t.bodySha256} ~ '^[A-Fa-f0-9]{64}$')`
    ),
    stateCheck: check(
      "acceptance_correction_gh_findings_state_check",
      sql`${t.status} IN ('reserved', 'published', 'bounded_failed', 'ambiguous_hold')
        AND ((${t.status} = 'reserved') = (${t.completedAt} IS NULL))
        AND ((${t.status} = 'published') = (${t.githubCommentId} IS NOT NULL))
        AND ((${t.status} = 'published') = (${t.githubCommentUrl} IS NOT NULL))
        AND (${t.githubCommentId} IS NULL OR (char_length(${t.githubCommentId}) BETWEEN 1 AND 40 AND ${t.githubCommentId} ~ '^[1-9][0-9]*$'))
        AND (${t.githubCommentUrl} IS NULL OR ${t.githubCommentUrl} = 'https://github.com/' || ${t.repo} || '/pull/' || (${t.prNumber})::text || '#issuecomment-' || ${t.githubCommentId})
        AND ((${t.status} IN ('bounded_failed', 'ambiguous_hold')) = (${t.resultReason} IS NOT NULL))
        AND (${t.status} <> 'bounded_failed' OR ${t.resultReason} IN ('github_rejected', 'invalid_db_issued_body'))
        AND (${t.status} <> 'ambiguous_hold' OR ${t.resultReason} IN ('github_unavailable', 'ambiguous_response'))
        AND (${t.body} IS NOT NULL OR (${t.status} = 'bounded_failed' AND ${t.resultReason} = 'invalid_db_issued_body'))
        AND ((${t.body} IS NULL) = (${t.bodySha256} IS NULL))
        AND (${t.status} <> 'reserved' OR (${t.githubCommentId} IS NULL AND ${t.githubCommentUrl} IS NULL AND ${t.resultReason} IS NULL))`
    ),
  })
);

/** The one selected-recipient activation reservation after all findings are terminal. */
export const acceptanceCorrectionDispatchGithubActivations = pgTable(
  "acceptance_correction_dispatch_github_activations",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    dispatchId: uuid("dispatch_id").notNull().references(() => acceptanceCorrectionDispatches.id, { onDelete: "restrict" }),
    recordId: uuid("record_id").notNull().references(() => changeRecords.id, { onDelete: "cascade" }),
    repo: text("repo").notNull(),
    prNumber: integer("pr_number").notNull(),
    headSha: text("head_sha").notNull(),
    baseSha: text("base_sha").notNull(),
    headCycleId: uuid("head_cycle_id").notNull(),
    authorityGeneration: integer("authority_generation").notNull(),
    dispatchIdentitySha256: text("dispatch_identity_sha256").notNull(),
    routeId: uuid("route_id").notNull().references(() => acceptanceBuilderRoutes.id, { onDelete: "restrict" }),
    routeAdapter: text("route_adapter").notNull(),
    routeConfigurationVersion: integer("route_configuration_version").notNull(),
    capabilityProfileId: uuid("capability_profile_id").notNull().references(
      () => acceptanceBuilderRouteCapabilityProfiles.id, { onDelete: "restrict" }
    ),
    capabilityProfileSnapshotSha256: text("capability_profile_snapshot_sha256").notNull(),
    githubInstallationIdentitySha256: text("github_installation_identity_sha256").notNull(),
    readyPreflightId: uuid("ready_preflight_id").notNull().references(
      () => acceptanceCorrectionDispatchGithubPreflights.id, { onDelete: "restrict" }
    ),
    readyPreflightIdentitySha256: text("ready_preflight_identity_sha256").notNull(),
    carrier: text("carrier").notNull().default("github_issue_comment"),
    recipient: text("recipient").notNull(),
    findingCoverageSha256: text("finding_coverage_sha256").notNull(),
    packetSetSha256: text("packet_set_sha256").notNull(),
    correctionPacketPayloadSetSha256: text("correction_packet_payload_set_sha256").notNull(),
    packetBundleSha256: text("packet_bundle_sha256"),
    /** Null only when the canonical packet bundle cannot fit the carrier. */
    body: text("body"),
    bodySha256: text("body_sha256"),
    activationProtocolVersion: integer("activation_protocol_version").notNull().default(1),
    activationIdentitySha256: text("activation_identity_sha256").notNull(),
    status: text("status").notNull().default("reserved"),
    githubCommentId: text("github_comment_id"),
    githubCommentUrl: text("github_comment_url"),
    resultReason: text("result_reason"),
    reservedAt: timestamp("reserved_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    dispatch: uniqueIndex("acceptance_correction_gh_activations_dispatch_key").on(t.dispatchId),
    commentReceipt: uniqueIndex("acceptance_correction_gh_activations_comment_receipt_key")
      .on(t.githubCommentId).where(sql`${t.githubCommentId} IS NOT NULL`),
    bindingCheck: check(
      "acceptance_correction_gh_activations_binding_check",
      sql`char_length(${t.repo}) BETWEEN 3 AND 512
        AND btrim(${t.repo}) = ${t.repo}
        AND ${t.repo} ~ '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'
        AND split_part(${t.repo}, '/', 1) NOT IN ('.', '..')
        AND split_part(${t.repo}, '/', 2) NOT IN ('.', '..')
        AND ${t.prNumber} > 0
        AND ${t.headSha} ~ '^[A-Fa-f0-9]{40}$'
        AND ${t.baseSha} ~ '^[A-Fa-f0-9]{40}$'
        AND ${t.authorityGeneration} >= 0
        AND ${t.dispatchIdentitySha256} ~ '^[A-Fa-f0-9]{64}$'
        AND ${t.routeAdapter} IN ('github_codex', 'github_claude')
        AND ${t.routeConfigurationVersion} > 0
        AND ${t.capabilityProfileSnapshotSha256} ~ '^[A-Fa-f0-9]{64}$'
        AND ${t.githubInstallationIdentitySha256} ~ '^[A-Fa-f0-9]{64}$'
        AND ${t.readyPreflightIdentitySha256} ~ '^[A-Fa-f0-9]{64}$'
        AND ${t.carrier} = 'github_issue_comment'
        AND ((${t.routeAdapter} = 'github_codex' AND ${t.recipient} = 'codex')
          OR (${t.routeAdapter} = 'github_claude' AND ${t.recipient} = 'claude'))
        AND ${t.findingCoverageSha256} ~ '^[A-Fa-f0-9]{64}$'
        AND ${t.packetSetSha256} ~ '^[A-Fa-f0-9]{64}$'
        AND ${t.correctionPacketPayloadSetSha256} ~ '^[A-Fa-f0-9]{64}$'
        AND (${t.packetBundleSha256} IS NULL OR ${t.packetBundleSha256} ~ '^[A-Fa-f0-9]{64}$')
        AND (${t.body} IS NULL OR octet_length(${t.body}) BETWEEN 1 AND 61440)
        AND (${t.bodySha256} IS NULL OR ${t.bodySha256} ~ '^[A-Fa-f0-9]{64}$')
        AND ${t.activationProtocolVersion} = 1
        AND ${t.activationIdentitySha256} ~ '^[A-Fa-f0-9]{64}$'`
    ),
    stateCheck: check(
      "acceptance_correction_gh_activations_state_check",
      sql`${t.status} IN ('reserved', 'carrier_accepted', 'bounded_failed', 'ambiguous_hold')
        AND ((${t.status} = 'reserved') = (${t.completedAt} IS NULL))
        AND ((${t.status} = 'carrier_accepted') = (${t.githubCommentId} IS NOT NULL))
        AND ((${t.status} = 'carrier_accepted') = (${t.githubCommentUrl} IS NOT NULL))
        AND (${t.githubCommentId} IS NULL OR (char_length(${t.githubCommentId}) BETWEEN 1 AND 40 AND ${t.githubCommentId} ~ '^[1-9][0-9]*$'))
        AND (${t.githubCommentUrl} IS NULL OR ${t.githubCommentUrl} = 'https://github.com/' || ${t.repo} || '/pull/' || (${t.prNumber})::text || '#issuecomment-' || ${t.githubCommentId})
        AND ((${t.status} IN ('bounded_failed', 'ambiguous_hold')) = (${t.resultReason} IS NOT NULL))
        AND (${t.status} <> 'bounded_failed' OR ${t.resultReason} IN ('github_rejected', 'invalid_db_issued_body', 'activation_body_too_large'))
        AND (${t.status} <> 'ambiguous_hold' OR ${t.resultReason} IN ('github_unavailable', 'ambiguous_response'))
        AND (${t.body} IS NOT NULL OR (${t.status} = 'bounded_failed' AND ${t.resultReason} IN ('invalid_db_issued_body', 'activation_body_too_large')))
        AND ((${t.body} IS NULL) = (${t.bodySha256} IS NULL))
        AND ((${t.packetBundleSha256} IS NULL) = (${t.status} = 'bounded_failed' AND ${t.resultReason} = 'invalid_db_issued_body'))
        AND (${t.status} <> 'reserved' OR (${t.githubCommentId} IS NULL AND ${t.githubCommentUrl} IS NULL AND ${t.resultReason} IS NULL))`
    ),
  })
);

/**
 * One immutable acknowledgement receipt for a carrier-accepted
 * `github_claude` activation. GitHub Actions OIDC authenticates the pinned
 * workflow; only hashes of the resumable Claude session id, OIDC subject, and
 * token jti are retained. No JWT, provider token, transcript, branch, output,
 * or repair-head claim belongs in this table.
 */
export const acceptanceCorrectionDispatchGithubClaudeAckReceipts = pgTable(
  "acceptance_correction_dispatch_github_claude_ack_receipts",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    dispatchId: uuid("dispatch_id").notNull()
      .references(() => acceptanceCorrectionDispatches.id, { onDelete: "restrict" }),
    activationId: uuid("activation_id").notNull()
      .references(() => acceptanceCorrectionDispatchGithubActivations.id, { onDelete: "restrict" }),
    recordId: uuid("record_id").notNull()
      .references(() => changeRecords.id, { onDelete: "cascade" }),
    repo: text("repo").notNull(),
    prNumber: integer("pr_number").notNull(),
    headSha: text("head_sha").notNull(),
    headCycleId: uuid("head_cycle_id").notNull(),
    authorityGeneration: integer("authority_generation").notNull(),
    dispatchIdentitySha256: text("dispatch_identity_sha256").notNull(),
    activationIdentitySha256: text("activation_identity_sha256").notNull(),
    activationGithubCommentId: text("activation_github_comment_id").notNull(),
    activationBodySha256: text("activation_body_sha256").notNull(),
    routeId: uuid("route_id").notNull()
      .references(() => acceptanceBuilderRoutes.id, { onDelete: "restrict" }),
    routeConfigurationVersion: integer("route_configuration_version").notNull(),
    capabilityProfileId: uuid("capability_profile_id").notNull()
      .references(() => acceptanceBuilderRouteCapabilityProfiles.id, { onDelete: "restrict" }),
    ackProfileId: uuid("ack_profile_id").notNull()
      .references(() => acceptanceBuilderRouteGithubClaudeAckProfiles.id, { onDelete: "restrict" }),
    ackProfileSnapshotSha256: text("ack_profile_snapshot_sha256").notNull(),
    acknowledgementProtocolVersion: integer("acknowledgement_protocol_version").notNull().default(1),
    provider: text("provider").notNull(),
    providerConclusion: text("provider_conclusion").notNull(),
    providerSessionIdSha256: text("provider_session_id_sha256").notNull(),
    oidcIssuer: text("oidc_issuer").notNull(),
    oidcAudience: text("oidc_audience").notNull(),
    oidcSubjectSha256: text("oidc_subject_sha256").notNull(),
    oidcRepository: text("oidc_repository").notNull(),
    oidcRepositoryId: text("oidc_repository_id").notNull(),
    oidcRepositoryOwner: text("oidc_repository_owner").notNull(),
    oidcRepositoryOwnerId: text("oidc_repository_owner_id").notNull(),
    oidcActorId: text("oidc_actor_id").notNull(),
    oidcActor: text("oidc_actor").notNull(),
    oidcEventName: text("oidc_event_name").notNull(),
    oidcRef: text("oidc_ref").notNull(),
    oidcWorkflowRef: text("oidc_workflow_ref").notNull(),
    oidcWorkflowSha: text("oidc_workflow_sha").notNull(),
    oidcJobWorkflowRef: text("oidc_job_workflow_ref").notNull(),
    oidcJobWorkflowSha: text("oidc_job_workflow_sha").notNull(),
    oidcRunId: text("oidc_run_id").notNull(),
    oidcRunAttempt: integer("oidc_run_attempt").notNull(),
    oidcCheckRunId: text("oidc_check_run_id").notNull(),
    oidcTokenIssuedAt: timestamp("oidc_token_issued_at", { withTimezone: true }).notNull(),
    oidcTokenNotBefore: timestamp("oidc_token_not_before", { withTimezone: true }).notNull(),
    oidcTokenExpiresAt: timestamp("oidc_token_expires_at", { withTimezone: true }).notNull(),
    oidcJtiSha256: text("oidc_jti_sha256").notNull(),
    receiptIdentitySha256: text("receipt_identity_sha256").notNull(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    dispatch: uniqueIndex("acceptance_claude_ack_receipts_dispatch_key").on(t.dispatchId),
    activation: uniqueIndex("acceptance_claude_ack_receipts_activation_key").on(t.activationId),
    oidcJti: uniqueIndex("acceptance_claude_ack_receipts_oidc_jti_key").on(t.oidcJtiSha256),
    oidcRun: uniqueIndex("acceptance_claude_ack_receipts_oidc_run_key")
      .on(t.oidcRepositoryId, t.oidcRunId),
    bindingCheck: check(
      "acceptance_claude_ack_receipts_binding_check",
      sql`char_length(${t.repo}) BETWEEN 3 AND 512
        AND btrim(${t.repo}) = ${t.repo}
        AND ${t.repo} ~ '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'
        AND ${t.prNumber} > 0
        AND ${t.headSha} ~ '^[A-Fa-f0-9]{40}$'
        AND ${t.authorityGeneration} >= 0
        AND ${t.dispatchIdentitySha256} ~ '^[A-Fa-f0-9]{64}$'
        AND ${t.activationIdentitySha256} ~ '^[A-Fa-f0-9]{64}$'
        AND ${t.activationGithubCommentId} ~ '^[1-9][0-9]{0,39}$'
        AND ${t.activationBodySha256} ~ '^[A-Fa-f0-9]{64}$'
        AND ${t.routeConfigurationVersion} > 0
        AND ${t.ackProfileSnapshotSha256} ~ '^[A-Fa-f0-9]{64}$'
        AND ${t.acknowledgementProtocolVersion} = 1
        AND ${t.provider} = 'anthropic_claude_code_action'
        AND ${t.providerConclusion} = 'success'
        AND ${t.providerSessionIdSha256} ~ '^[A-Fa-f0-9]{64}$'
        AND ${t.oidcIssuer} = 'https://token.actions.githubusercontent.com'
        AND ${t.oidcAudience} ~ '^agentrail://correction-dispatch/github-claude/ack/v1/[A-Fa-f0-9]{64}$'
        AND ${t.oidcSubjectSha256} ~ '^[A-Fa-f0-9]{64}$'
        AND ${t.oidcRepository} = ${t.repo}
        AND ${t.oidcRepositoryId} ~ '^[1-9][0-9]{0,39}$'
        AND char_length(${t.oidcRepositoryOwner}) BETWEEN 1 AND 100
        AND ${t.oidcRepositoryOwner} ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,99}$'
        AND ${t.oidcRepositoryOwnerId} ~ '^[1-9][0-9]{0,39}$'
        AND ${t.oidcActorId} ~ '^[1-9][0-9]{0,39}$'
        AND ${t.oidcActor} = 'jace[bot]'
        AND ${t.oidcEventName} = 'issue_comment'
        AND char_length(${t.oidcRef}) BETWEEN 12 AND 512
        AND ${t.oidcRef} LIKE 'refs/heads/%'
        AND ${t.oidcRef} !~ '[[:cntrl:]]'
        AND char_length(${t.oidcWorkflowRef}) BETWEEN 1 AND 1024
        AND ${t.oidcWorkflowRef} !~ '[[:cntrl:]]'
        AND ${t.oidcWorkflowSha} ~ '^[A-Fa-f0-9]{40}$'
        AND char_length(${t.oidcJobWorkflowRef}) BETWEEN 1 AND 1024
        AND ${t.oidcJobWorkflowRef} !~ '[[:cntrl:]]'
        AND ${t.oidcJobWorkflowSha} ~ '^[A-Fa-f0-9]{40}$'
        AND ${t.oidcRunId} ~ '^[1-9][0-9]{0,39}$'
        AND ${t.oidcRunAttempt} = 1
        AND ${t.oidcCheckRunId} ~ '^[1-9][0-9]{0,39}$'
        AND ${t.oidcTokenNotBefore} <= ${t.oidcTokenExpiresAt}
        AND ${t.oidcTokenIssuedAt} <= ${t.oidcTokenExpiresAt}
        AND ${t.oidcJtiSha256} ~ '^[A-Fa-f0-9]{64}$'
        AND ${t.receiptIdentitySha256} ~ '^[A-Fa-f0-9]{64}$'`
    ),
  })
);

/**
 * One immutable, OIDC-authenticated exact-head observation made by the same
 * pinned GitHub Actions run that produced a verified Claude acknowledgement.
 * This row deliberately does not claim commit authorship: a reader must still
 * join it to GitHub's independently signed synchronize custody before calling
 * the observed successor a repair head. Only hashes of the provider session,
 * OIDC subject, and token jti are retained.
 */
export const acceptanceCorrectionDispatchGithubClaudeRepairObservations = pgTable(
  "acceptance_correction_dispatch_github_claude_repair_obs",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    dispatchId: uuid("dispatch_id").notNull()
      .references(() => acceptanceCorrectionDispatches.id, { onDelete: "restrict" }),
    activationId: uuid("activation_id").notNull()
      .references(() => acceptanceCorrectionDispatchGithubActivations.id, { onDelete: "restrict" }),
    acknowledgementReceiptId: uuid("acknowledgement_receipt_id").notNull()
      .references(() => acceptanceCorrectionDispatchGithubClaudeAckReceipts.id, { onDelete: "restrict" }),
    acknowledgementReceiptIdentitySha256: text("acknowledgement_receipt_identity_sha256").notNull(),
    recordId: uuid("record_id").notNull()
      .references(() => changeRecords.id, { onDelete: "cascade" }),
    repo: text("repo").notNull(),
    prNumber: integer("pr_number").notNull(),
    originalHeadSha: text("original_head_sha").notNull(),
    originalHeadCycleId: uuid("original_head_cycle_id").notNull(),
    authorityGeneration: integer("authority_generation").notNull(),
    dispatchIdentitySha256: text("dispatch_identity_sha256").notNull(),
    activationIdentitySha256: text("activation_identity_sha256").notNull(),
    activationGithubCommentId: text("activation_github_comment_id").notNull(),
    activationBodySha256: text("activation_body_sha256").notNull(),
    routeId: uuid("route_id").notNull()
      .references(() => acceptanceBuilderRoutes.id, { onDelete: "restrict" }),
    routeConfigurationVersion: integer("route_configuration_version").notNull(),
    capabilityProfileId: uuid("capability_profile_id").notNull()
      .references(() => acceptanceBuilderRouteCapabilityProfiles.id, { onDelete: "restrict" }),
    acknowledgementProfileId: uuid("acknowledgement_profile_id").notNull()
      .references(() => acceptanceBuilderRouteGithubClaudeAckProfiles.id, { onDelete: "restrict" }),
    acknowledgementProfileSnapshotSha256: text("acknowledgement_profile_snapshot_sha256").notNull(),
    observationProtocolVersion: integer("observation_protocol_version").notNull().default(1),
    provider: text("provider").notNull(),
    providerSessionIdSha256: text("provider_session_id_sha256").notNull(),
    beforeHeadSha: text("before_head_sha").notNull(),
    afterHeadSha: text("after_head_sha").notNull(),
    oidcIssuer: text("oidc_issuer").notNull(),
    oidcAudience: text("oidc_audience").notNull(),
    oidcSubjectSha256: text("oidc_subject_sha256").notNull(),
    oidcRepository: text("oidc_repository").notNull(),
    oidcRepositoryId: text("oidc_repository_id").notNull(),
    oidcRepositoryOwner: text("oidc_repository_owner").notNull(),
    oidcRepositoryOwnerId: text("oidc_repository_owner_id").notNull(),
    oidcActorId: text("oidc_actor_id").notNull(),
    oidcActor: text("oidc_actor").notNull(),
    oidcEventName: text("oidc_event_name").notNull(),
    oidcRef: text("oidc_ref").notNull(),
    oidcWorkflowRef: text("oidc_workflow_ref").notNull(),
    oidcWorkflowSha: text("oidc_workflow_sha").notNull(),
    oidcJobWorkflowRef: text("oidc_job_workflow_ref").notNull(),
    oidcJobWorkflowSha: text("oidc_job_workflow_sha").notNull(),
    oidcRunId: text("oidc_run_id").notNull(),
    oidcRunAttempt: integer("oidc_run_attempt").notNull(),
    oidcCheckRunId: text("oidc_check_run_id").notNull(),
    oidcTokenIssuedAt: timestamp("oidc_token_issued_at", { withTimezone: true }).notNull(),
    oidcTokenNotBefore: timestamp("oidc_token_not_before", { withTimezone: true }).notNull(),
    oidcTokenExpiresAt: timestamp("oidc_token_expires_at", { withTimezone: true }).notNull(),
    oidcJtiSha256: text("oidc_jti_sha256").notNull(),
    observationIdentitySha256: text("observation_identity_sha256").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    dispatch: uniqueIndex("acceptance_claude_repair_observations_dispatch_key").on(t.dispatchId),
    activation: uniqueIndex("acceptance_claude_repair_observations_activation_key").on(t.activationId),
    acknowledgementReceipt: uniqueIndex("acceptance_claude_repair_observations_ack_key")
      .on(t.acknowledgementReceiptId),
    oidcJti: uniqueIndex("acceptance_claude_repair_observations_oidc_jti_key").on(t.oidcJtiSha256),
    bindingCheck: check(
      "acceptance_claude_repair_observations_binding_check",
      sql`char_length(${t.repo}) BETWEEN 3 AND 512
        AND btrim(${t.repo}) = ${t.repo}
        AND ${t.repo} ~ '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'
        AND ${t.prNumber} > 0
        AND ${t.originalHeadSha} ~ '^[A-Fa-f0-9]{40}$'
        AND ${t.beforeHeadSha} = ${t.originalHeadSha}
        AND ${t.afterHeadSha} ~ '^[A-Fa-f0-9]{40}$'
        AND lower(${t.afterHeadSha}) <> lower(${t.beforeHeadSha})
        AND ${t.authorityGeneration} >= 0
        AND ${t.dispatchIdentitySha256} ~ '^[A-Fa-f0-9]{64}$'
        AND ${t.activationIdentitySha256} ~ '^[A-Fa-f0-9]{64}$'
        AND ${t.activationGithubCommentId} ~ '^[1-9][0-9]{0,39}$'
        AND ${t.activationBodySha256} ~ '^[A-Fa-f0-9]{64}$'
        AND ${t.acknowledgementReceiptIdentitySha256} ~ '^[A-Fa-f0-9]{64}$'
        AND ${t.routeConfigurationVersion} > 0
        AND ${t.acknowledgementProfileSnapshotSha256} ~ '^[A-Fa-f0-9]{64}$'
        AND ${t.observationProtocolVersion} = 1
        AND ${t.provider} = 'anthropic_claude_code_action'
        AND ${t.providerSessionIdSha256} ~ '^[A-Fa-f0-9]{64}$'
        AND ${t.oidcIssuer} = 'https://token.actions.githubusercontent.com'
        AND ${t.oidcAudience} ~ '^agentrail://correction-dispatch/github-claude/repair-observation/v1/[A-Fa-f0-9]{64}$'
        AND ${t.oidcSubjectSha256} ~ '^[A-Fa-f0-9]{64}$'
        AND ${t.oidcRepository} = ${t.repo}
        AND ${t.oidcRepositoryId} ~ '^[1-9][0-9]{0,39}$'
        AND char_length(${t.oidcRepositoryOwner}) BETWEEN 1 AND 100
        AND ${t.oidcRepositoryOwner} ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,99}$'
        AND ${t.oidcRepositoryOwnerId} ~ '^[1-9][0-9]{0,39}$'
        AND ${t.oidcActorId} ~ '^[1-9][0-9]{0,39}$'
        AND ${t.oidcActor} = 'jace[bot]'
        AND ${t.oidcEventName} = 'issue_comment'
        AND char_length(${t.oidcRef}) BETWEEN 12 AND 512
        AND ${t.oidcRef} LIKE 'refs/heads/%'
        AND ${t.oidcRef} !~ '[[:cntrl:]]'
        AND char_length(${t.oidcWorkflowRef}) BETWEEN 1 AND 1024
        AND ${t.oidcWorkflowRef} !~ '[[:cntrl:]]'
        AND ${t.oidcWorkflowSha} ~ '^[A-Fa-f0-9]{40}$'
        AND char_length(${t.oidcJobWorkflowRef}) BETWEEN 1 AND 1024
        AND ${t.oidcJobWorkflowRef} !~ '[[:cntrl:]]'
        AND ${t.oidcJobWorkflowSha} ~ '^[A-Fa-f0-9]{40}$'
        AND ${t.oidcRunId} ~ '^[1-9][0-9]{0,39}$'
        AND ${t.oidcRunAttempt} = 1
        AND ${t.oidcCheckRunId} ~ '^[1-9][0-9]{0,39}$'
        AND ${t.oidcTokenNotBefore} <= ${t.oidcTokenExpiresAt}
        AND ${t.oidcTokenIssuedAt} <= ${t.oidcTokenExpiresAt}
        AND ${t.oidcJtiSha256} ~ '^[A-Fa-f0-9]{64}$'
        AND ${t.observationIdentitySha256} ~ '^[A-Fa-f0-9]{64}$'`
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

/**
 * One human-gated GitHub issue publication for one exact reviewed PR-head
 * occurrence. Identity and rendered request custody are immutable; only the
 * closed external receipt columns transition once from `reserved`.
 */
export const acceptanceGatedGithubIssuePublications = pgTable(
  "acceptance_gated_github_issue_publications",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    recordId: uuid("record_id").notNull()
      .references(() => changeRecords.id, { onDelete: "cascade" }),
    repo: text("repo").notNull(),
    prNumber: integer("pr_number").notNull(),
    headSha: text("head_sha").notNull(),
    headCycleId: uuid("head_cycle_id").notNull(),
    authorityGeneration: integer("authority_generation").notNull(),
    reviewJobId: uuid("review_job_id").notNull()
      .references(() => reviewJobs.id, { onDelete: "restrict" }),
    bindingId: uuid("binding_id").notNull(),
    acceptanceContractId: uuid("acceptance_contract_id").notNull()
      .references(() => acceptanceContracts.id, { onDelete: "restrict" }),
    acceptanceContractVersion: integer("acceptance_contract_version").notNull(),
    acceptanceContractSha256: text("acceptance_contract_sha256").notNull(),
    criterionOutcomeBundleId: uuid("criterion_outcome_bundle_id").notNull(),
    criterionOutcomeBundleEventId: uuid("criterion_outcome_bundle_event_id").notNull(),
    criterionOutcomeBundleSha256: text("criterion_outcome_bundle_sha256").notNull(),
    postedAttestationEventId: uuid("posted_attestation_event_id").notNull(),
    packets: jsonb("packets").$type<Array<{ packetId: string; sha256: string }>>().notNull(),
    packetSetSha256: text("packet_set_sha256").notNull(),
    correctionPacketPayloadSetSha256: text("correction_packet_payload_set_sha256").notNull(),
    requestProtocolVersion: integer("request_protocol_version").notNull().default(1),
    requestIdentitySha256: text("request_identity_sha256").notNull(),
    title: text("title").notNull(),
    titleSha256: text("title_sha256").notNull(),
    body: text("body").notNull(),
    bodySha256: text("body_sha256").notNull(),
    reservedBy: text("reserved_by").notNull(),
    reservedRole: text("reserved_role").notNull(),
    status: text("status").notNull().default("reserved"),
    httpStatus: integer("http_status"),
    githubIssueId: text("github_issue_id"),
    githubIssueNumber: integer("github_issue_number"),
    githubApiUrl: text("github_api_url"),
    githubIssueUrl: text("github_issue_url"),
    githubRequestId: text("github_request_id"),
    responseTitleSha256: text("response_title_sha256"),
    responseBodySha256: text("response_body_sha256"),
    githubState: text("github_state"),
    resultReason: text("result_reason"),
    reservedAt: timestamp("reserved_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    recordCycle: uniqueIndex("acceptance_gated_github_issues_record_cycle_key")
      .on(t.recordId, t.headCycleId),
    githubIssueIdReceipt: uniqueIndex("acceptance_gated_github_issues_github_id_key")
      .on(t.githubIssueId).where(sql`${t.githubIssueId} IS NOT NULL`),
    githubIssueNumberReceipt: uniqueIndex("acceptance_gated_github_issues_repo_number_key")
      .on(t.repo, t.githubIssueNumber).where(sql`${t.githubIssueNumber} IS NOT NULL`),
    bindingCheck: check(
      "acceptance_gated_github_issues_binding_check",
      sql`char_length(${t.repo}) BETWEEN 3 AND 201
        AND btrim(${t.repo}) = ${t.repo}
        AND ${t.repo} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'
        AND split_part(${t.repo}, '/', 1) NOT IN ('.', '..')
        AND split_part(${t.repo}, '/', 2) NOT IN ('.', '..')
        AND ${t.prNumber} > 0
        AND ${t.headSha} ~ '^[a-f0-9]{40}$'
        AND ${t.authorityGeneration} >= 0
        AND ${t.acceptanceContractVersion} > 0
        AND ${t.acceptanceContractSha256} ~ '^[a-f0-9]{64}$'
        AND ${t.criterionOutcomeBundleSha256} ~ '^[a-f0-9]{64}$'
        AND jsonb_typeof(${t.packets}) = 'array'
        AND jsonb_array_length(${t.packets}) BETWEEN 1 AND 100
        AND ${t.packetSetSha256} ~ '^[a-f0-9]{64}$'
        AND ${t.correctionPacketPayloadSetSha256} ~ '^[a-f0-9]{64}$'
        AND ${t.requestProtocolVersion} = 1
        AND ${t.requestIdentitySha256} ~ '^[a-f0-9]{64}$'
        AND octet_length(${t.title}) BETWEEN 1 AND 256
        AND octet_length(${t.body}) BETWEEN 1 AND 24576
        AND ${t.titleSha256} ~ '^[a-f0-9]{64}$'
        AND ${t.bodySha256} ~ '^[a-f0-9]{64}$'
        AND ${t.reservedBy} ~ '^user:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
        AND ${t.reservedRole} IN ('owner', 'admin')`
    ),
    stateCheck: check(
      "acceptance_gated_github_issues_state_check",
      sql`${t.status} IN ('reserved', 'published', 'bounded_failed', 'ambiguous_hold')
        AND ((${t.status} = 'reserved') = (${t.completedAt} IS NULL))
        AND (${t.status} <> 'published' OR (
          ${t.httpStatus} = 201
          AND ${t.githubIssueId} ~ '^[1-9][0-9]{0,39}$'
          AND ${t.githubIssueNumber} > 0
          AND ${t.githubApiUrl} = 'https://api.github.com/repos/' || ${t.repo} || '/issues/' || (${t.githubIssueNumber})::text
          AND ${t.githubIssueUrl} = 'https://github.com/' || ${t.repo} || '/issues/' || (${t.githubIssueNumber})::text
          AND char_length(${t.githubRequestId}) BETWEEN 1 AND 128
          AND ${t.githubRequestId} ~ '^[A-Za-z0-9:-]+$'
          AND ${t.responseTitleSha256} = ${t.titleSha256}
          AND ${t.responseBodySha256} = ${t.bodySha256}
          AND ${t.githubState} = 'open'
          AND ${t.resultReason} IS NULL
        ))
        AND (${t.status} <> 'bounded_failed' OR ${t.resultReason} IN (
          'github_rejected', 'invalid_db_issued_request'
        ))
        AND (${t.status} <> 'ambiguous_hold' OR ${t.resultReason} IN (
          'github_unavailable', 'ambiguous_response'
        ))
        AND ((${t.status} IN ('bounded_failed', 'ambiguous_hold')) = (${t.resultReason} IS NOT NULL))
        AND (${t.status} <> 'reserved' OR (
          ${t.httpStatus} IS NULL AND ${t.githubIssueId} IS NULL AND ${t.githubIssueNumber} IS NULL
          AND ${t.githubApiUrl} IS NULL AND ${t.githubIssueUrl} IS NULL AND ${t.githubRequestId} IS NULL
          AND ${t.responseTitleSha256} IS NULL AND ${t.responseBodySha256} IS NULL
          AND ${t.githubState} IS NULL AND ${t.resultReason} IS NULL
        ))
        AND (${t.status} IN ('reserved', 'published') OR (
          ${t.httpStatus} IS NULL AND ${t.githubIssueId} IS NULL AND ${t.githubIssueNumber} IS NULL
          AND ${t.githubApiUrl} IS NULL AND ${t.githubIssueUrl} IS NULL AND ${t.githubRequestId} IS NULL
          AND ${t.responseTitleSha256} IS NULL AND ${t.responseBodySha256} IS NULL
          AND ${t.githubState} IS NULL
        ))`
    ),
  })
);

export type ChangeRecordRow = typeof changeRecords.$inferSelect;
export type ChangeRecordEventRow = typeof changeRecordEvents.$inferSelect;
export type AcceptanceContractRow = typeof acceptanceContracts.$inferSelect;
export type AcceptanceBuilderRouteRow = typeof acceptanceBuilderRoutes.$inferSelect;
export type AcceptanceBuilderRouteCapabilityProfileRow = typeof acceptanceBuilderRouteCapabilityProfiles.$inferSelect;
export type AcceptanceBuilderRouteGithubClaudeAckProfileRow = typeof acceptanceBuilderRouteGithubClaudeAckProfiles.$inferSelect;
export type AcceptanceContextPackSnapshotRow = typeof acceptanceContextPackSnapshots.$inferSelect;
export type AcceptanceCompiledContextPackRow = typeof acceptanceCompiledContextPacks.$inferSelect;
export type AcceptanceCorrectionDispatchRow = typeof acceptanceCorrectionDispatches.$inferSelect;
export type AcceptanceCorrectionDispatchGithubPreflightRow = typeof acceptanceCorrectionDispatchGithubPreflights.$inferSelect;
export type AcceptanceCorrectionDispatchGithubFindingPublicationRow = typeof acceptanceCorrectionDispatchGithubFindingPublications.$inferSelect;
export type AcceptanceCorrectionDispatchGithubActivationRow = typeof acceptanceCorrectionDispatchGithubActivations.$inferSelect;
export type AcceptanceCorrectionDispatchGithubClaudeAckReceiptRow = typeof acceptanceCorrectionDispatchGithubClaudeAckReceipts.$inferSelect;
export type AcceptanceCorrectionDispatchGithubClaudeRepairObservationRow = typeof acceptanceCorrectionDispatchGithubClaudeRepairObservations.$inferSelect;
export type AcceptanceGatedGithubIssuePublicationRow = typeof acceptanceGatedGithubIssuePublications.$inferSelect;
export type AcceptanceIntakeRow = typeof acceptanceIntakes.$inferSelect;
export type AcceptanceIntakeMessageRow = typeof acceptanceIntakeMessages.$inferSelect;
