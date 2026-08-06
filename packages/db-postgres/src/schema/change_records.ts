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
import { repositories } from "./repositories.js";

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
 * Metadata-only Context Pack versions delivered for an Acceptance Record.
 *
 * The pack's bounded source snippets remain under workspace custody. This
 * table records the immutable delivery manifest, hash, compiler identity, and
 * artifact references without turning the central database into an unrestricted
 * source mirror.
 */
export const acceptanceContextPacks = pgTable(
  "acceptance_context_packs",
  {
    id: uuid("id").primaryKey(),
    recordId: uuid("record_id")
      .notNull()
      .references(() => changeRecords.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    phase: text("phase").notNull(),
    contentHash: text("content_hash").notNull(),
    compilerVersion: text("compiler_version").notNull(),
    /** Cited metadata only: no raw file/snippet content. */
    manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull(),
    custody: jsonb("custody").$type<Record<string, unknown>>().notNull(),
    freshness: jsonb("freshness").$type<Record<string, unknown>>().notNull(),
    jsonArtifactRef: text("json_artifact_ref"),
    markdownArtifactRef: text("markdown_artifact_ref"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    recordVersion: uniqueIndex("acceptance_context_packs_record_version_key").on(
      t.recordId,
      t.version
    ),
    recordContentHash: uniqueIndex("acceptance_context_packs_record_content_hash_key").on(
      t.recordId,
      t.contentHash
    ),
    recordCreated: index("acceptance_context_packs_record_created_idx").on(
      t.recordId,
      t.createdAt
    ),
  })
);

/**
 * A durable, worker-claimable request to compile one bounded Context Pack.
 *
 * The repository ref is captured at admission rather than resolved at claim
 * time, so a moving default branch cannot silently change the worker's input.
 * Raw checkout content remains exclusively in the disposable compiler worker.
 */
export const acceptanceContextPackCompilations = pgTable(
  "acceptance_context_pack_compilations",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    recordId: uuid("record_id")
      .notNull()
      .references(() => changeRecords.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "restrict" }),
    /** Admission-time snapshot of the connected repository's default branch. */
    repositoryRef: text("repository_ref").notNull(),
    acceptanceContractId: uuid("acceptance_contract_id")
      .notNull()
      .references(() => acceptanceContracts.id, { onDelete: "restrict" }),
    acceptanceContractVersion: integer("acceptance_contract_version").notNull(),
    phase: text("phase").notNull(),
    status: text("status").notNull().default("queued"),
    workerId: text("worker_id"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    contextPackId: uuid("context_pack_id").references(() => acceptanceContextPacks.id, { onDelete: "restrict" }),
    reason: text("reason"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    deterministicJob: uniqueIndex("acceptance_context_pack_compilations_binding_key").on(
      t.recordId, t.acceptanceContractVersion, t.repositoryId, t.phase
    ),
    queued: index("acceptance_context_pack_compilations_queued_idx")
      .on(t.createdAt)
      .where(sql`${t.status} = 'queued'`),
    record: index("acceptance_context_pack_compilations_record_idx").on(t.recordId, t.createdAt),
  })
);

/** An idempotent audit of a pack being exposed through MCP, copy, or download. */
export const acceptanceContextPackDeliveries = pgTable(
  "acceptance_context_pack_deliveries",
  {
    id: uuid("id").primaryKey(),
    contextPackId: uuid("context_pack_id")
      .notNull()
      .references(() => acceptanceContextPacks.id, { onDelete: "cascade" }),
    deliveryKey: text("delivery_key").notNull(),
    method: text("method").notNull(),
    recipient: text("recipient"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    deliveredBy: text("delivered_by").notNull(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    packDeliveryKey: uniqueIndex("acceptance_context_pack_deliveries_pack_key").on(
      t.contextPackId,
      t.deliveryKey
    ),
    packDelivered: index("acceptance_context_pack_deliveries_pack_delivered_idx").on(
      t.contextPackId,
      t.deliveredAt
    ),
  })
);

/** Canonical connected-repository PR attachment, not a caller-supplied repo string. */
export const changeRecordPrs = pgTable(
  "change_record_prs",
  {
    id: uuid("id").primaryKey(),
    recordId: uuid("record_id").notNull().references(() => changeRecords.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id").notNull().references(() => repositories.id, { onDelete: "restrict" }),
    repositoryFullName: text("repository_full_name").notNull(),
    prNumber: integer("pr_number").notNull(),
    prUrl: text("pr_url").notNull(),
    attachedBy: text("attached_by").notNull(),
    attachedAt: timestamp("attached_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    repositoryPr: uniqueIndex("change_record_prs_repository_pr_key").on(t.workspaceId, t.repositoryId, t.prNumber),
    record: index("change_record_prs_record_idx").on(t.recordId),
  })
);

/** A new full SHA creates a new revision; existing revisions are never rewritten. */
export const changeRecordPrRevisions = pgTable(
  "change_record_pr_revisions",
  {
    id: uuid("id").primaryKey(),
    prAttachmentId: uuid("pr_attachment_id").notNull().references(() => changeRecordPrs.id, { onDelete: "cascade" }),
    headSha: text("head_sha").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    source: text("source").notNull(),
  },
  (t) => ({
    attachmentHead: uniqueIndex("change_record_pr_revisions_attachment_head_key").on(t.prAttachmentId, t.headSha),
    activePerAttachment: uniqueIndex("change_record_pr_revisions_active_attachment_key").on(t.prAttachmentId).where(sql`${t.supersededAt} IS NULL`),
  })
);

/**
 * A human-selected external builder handoff.  The branch and opaque task
 * context are deliberately recorded before a PR exists, so a GitHub webhook
 * may correlate only an exact, pre-authorised builder route.  It must never
 * infer a record from PR title, repository, or an arbitrary branch.
 */
export const acceptanceBuilderHandoffs = pgTable(
  "acceptance_builder_handoffs",
  {
    id: uuid("id").primaryKey(),
    recordId: uuid("record_id")
      .notNull()
      .references(() => changeRecords.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "restrict" }),
    builder: text("builder").notNull(),
    /** Opaque builder/MCP task identifier; never a PR title heuristic. */
    taskContextKey: text("task_context_key").notNull(),
    branchName: text("branch_name").notNull(),
    acceptanceContractId: uuid("acceptance_contract_id")
      .notNull()
      .references(() => acceptanceContracts.id, { onDelete: "restrict" }),
    acceptanceContractVersion: integer("acceptance_contract_version").notNull(),
    contextPackId: uuid("context_pack_id")
      .notNull()
      .references(() => acceptanceContextPacks.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("handed_off"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    prAttachedAt: timestamp("pr_attached_at", { withTimezone: true }),
  },
  (t) => ({
    recordTask: uniqueIndex("acceptance_builder_handoffs_record_task_key").on(
      t.recordId,
      t.taskContextKey
    ),
    repositoryBranch: uniqueIndex("acceptance_builder_handoffs_repository_branch_key").on(
      t.workspaceId,
      t.repositoryId,
      t.branchName
    ),
    repositoryBranchLookup: index(
      "acceptance_builder_handoffs_repository_branch_lookup_idx"
    ).on(t.workspaceId, t.repositoryId, t.branchName),
  })
);

/**
 * The canonical pre-repository start of the acceptance spine. A channel
 * message may name no repository, so it cannot safely become a change record
 * yet. This durable intake carries provenance and the conversation identity
 * until Jace has collected the missing repository/context information.
 */
export const acceptanceIntakes = pgTable(
  "acceptance_intakes",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    originChannel: text("origin_channel").notNull(),
    conversationKey: text("conversation_key").notNull(),
    sourceReferences: jsonb("source_references").$type<Record<string, unknown>[]>().notNull().default([]),
    status: text("status").notNull().default("collecting_context"),
    recordId: uuid("record_id").references(() => changeRecords.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    conversation: uniqueIndex("acceptance_intakes_workspace_channel_conversation_key").on(t.workspaceId, t.originChannel, t.conversationKey),
    record: uniqueIndex("acceptance_intakes_record_key").on(t.recordId).where(sql`${t.recordId} IS NOT NULL`),
  })
);

/** Append-only inbound/outbound conversation evidence for one Acceptance Intake. */
export const acceptanceIntakeMessages = pgTable(
  "acceptance_intake_messages",
  {
    id: uuid("id").primaryKey(),
    intakeId: uuid("intake_id").notNull().references(() => acceptanceIntakes.id, { onDelete: "cascade" }),
    sourceKey: text("source_key").notNull(),
    direction: text("direction").notNull(),
    text: text("text").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    source: uniqueIndex("acceptance_intake_messages_source_key").on(t.intakeId, t.sourceKey),
    timeline: index("acceptance_intake_messages_timeline_idx").on(t.intakeId, t.createdAt),
  })
);

/** Immutable independent review for one exact PR revision. */
export const evidenceReviews = pgTable(
  "evidence_reviews",
  {
    id: uuid("id").primaryKey(),
    recordId: uuid("record_id").notNull().references(() => changeRecords.id, { onDelete: "cascade" }),
    prRevisionId: uuid("pr_revision_id").notNull().references(() => changeRecordPrRevisions.id, { onDelete: "restrict" }),
    acceptanceContractId: uuid("acceptance_contract_id").notNull().references(() => acceptanceContracts.id, { onDelete: "restrict" }),
    acceptanceContractVersion: integer("acceptance_contract_version").notNull(),
    headSha: text("head_sha").notNull(),
    diffIdentity: jsonb("diff_identity").$type<Record<string, unknown>>().notNull(),
    overallStatus: text("overall_status").notNull(),
    staticFindings: jsonb("static_findings").$type<Record<string, unknown>[]>().notNull().default([]),
    testResults: jsonb("test_results").$type<Record<string, unknown>[]>().notNull().default([]),
    independentVerifier: jsonb("independent_verifier").$type<Record<string, unknown>>().notNull(),
    reviewabilityResult: jsonb("reviewability_result").$type<Record<string, unknown>>().notNull(),
    environmentRung: text("environment_rung").notNull(),
    refusalReason: text("refusal_reason"),
    verifierName: text("verifier_name").notNull(),
    verifierVersion: text("verifier_version").notNull(),
    promptVersion: text("prompt_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    revision: uniqueIndex("evidence_reviews_revision_key").on(t.prRevisionId),
    recordCreated: index("evidence_reviews_record_created_idx").on(t.recordId, t.createdAt),
  })
);

/** A criterion-specific exact-head verification plan; planning is never proof. */
export const evidenceVerificationPlans = pgTable(
  "evidence_verification_plans",
  {
    id: uuid("id").primaryKey(),
    recordId: uuid("record_id").notNull().references(() => changeRecords.id, { onDelete: "cascade" }),
    prRevisionId: uuid("pr_revision_id").notNull().references(() => changeRecordPrRevisions.id, { onDelete: "restrict" }),
    acceptanceContractId: uuid("acceptance_contract_id").notNull().references(() => acceptanceContracts.id, { onDelete: "restrict" }),
    acceptanceContractVersion: integer("acceptance_contract_version").notNull(),
    criterionId: text("criterion_id").notNull(),
    criterionTextSnapshot: text("criterion_text_snapshot").notNull(),
    modality: text("modality").notNull(),
    environmentId: text("environment_id"),
    flow: text("flow"),
    /** Immutable, bounded browser-user actions for a planned UI proof. */
    uiSteps: jsonb("ui_steps").$type<Array<{ action: string; [key: string]: string }> | null>(),
    /** Immutable, bounded machine-readable API proof request; never a credential container. */
    apiRequest: jsonb("api_request").$type<{ method: "GET"; path: string; expectedStatus: number } | null>(),
    expectedBehavior: text("expected_behavior").notNull(),
    status: text("status").notNull(),
    notTestableReason: text("not_testable_reason"),
    plannedBy: text("planned_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    revisionCriterion: uniqueIndex("evidence_verification_plans_revision_criterion_key").on(t.prRevisionId, t.criterionId),
    recordRevision: index("evidence_verification_plans_record_revision_idx").on(t.recordId, t.prRevisionId),
    modalityCheck: check(
      "evidence_verification_plans_modality_check",
      sql`${t.modality} IN ('ui', 'api', 'job', 'data')`
    ),
    statusCheck: check(
      "evidence_verification_plans_status_check",
      sql`${t.status} IN ('planned', 'not_testable')`
    ),
    plannedProofCheck: check(
      "evidence_verification_plans_planned_proof_check",
      sql`(${t.status} = 'not_testable' AND length(trim(coalesce(${t.notTestableReason}, ''))) > 0)
        OR (${t.status} = 'planned' AND length(trim(coalesce(${t.environmentId}, ''))) > 0 AND length(trim(coalesce(${t.flow}, ''))) > 0)`
    ),
    apiRequestCheck: check(
      "evidence_verification_plans_api_request_check",
      sql`(${t.modality} <> 'api')
        OR (${t.status} = 'not_testable')
        OR (${t.apiRequest} IS NOT NULL
          AND ${t.apiRequest}->>'method' = 'GET'
          AND length(trim(coalesce(${t.apiRequest}->>'path', ''))) > 0
          AND (${t.apiRequest}->>'expectedStatus') ~ '^[0-9]{3}$')`
    ),
    uiStepsCheck: check(
      "evidence_verification_plans_ui_steps_check",
      sql`(${t.modality} <> 'ui')
        OR (${t.status} <> 'planned')
        OR (${t.uiSteps} IS NOT NULL
          AND jsonb_typeof(${t.uiSteps}) = 'array'
          AND jsonb_array_length(${t.uiSteps}) BETWEEN 1 AND 12)`
    ),
  })
);

/** Inspectable immutable reference to evidence collected for one planned criterion. */
export const evidenceVerificationArtifacts = pgTable(
  "evidence_verification_artifacts",
  {
    id: uuid("id").primaryKey(),
    verificationPlanId: uuid("verification_plan_id")
      .notNull()
      .references(() => evidenceVerificationPlans.id, { onDelete: "cascade" }),
    artifactKey: text("artifact_key").notNull(),
    contentType: text("content_type").notNull(),
    contentSha256: text("content_sha256").notNull(),
    collectedBy: text("collected_by").notNull(),
    collectedAt: timestamp("collected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    planCollected: index("evidence_verification_artifacts_plan_collected_idx").on(
      t.verificationPlanId,
      t.collectedAt
    ),
    artifactKey: uniqueIndex("evidence_verification_artifacts_key").on(t.artifactKey),
    contentTypeCheck: check(
      "evidence_verification_artifacts_content_type_check",
      sql`${t.contentType} IN ('image/png', 'image/jpeg', 'application/json')`
    ),
  })
);

/** Isolated worker queue for executing one planned criterion on its exact PR head. */
export const evidenceVerificationExecutions = pgTable(
  "evidence_verification_executions",
  {
    id: uuid("id").primaryKey(),
    verificationPlanId: uuid("verification_plan_id")
      .notNull()
      .references(() => evidenceVerificationPlans.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("queued"),
    workerId: text("worker_id"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    observedBehavior: text("observed_behavior"),
    artifactIds: jsonb("artifact_ids").$type<string[]>().notNull().default([]),
    resultReason: text("result_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    plan: uniqueIndex("evidence_verification_executions_plan_key").on(t.verificationPlanId),
    queued: index("evidence_verification_executions_queued_idx").on(t.createdAt).where(sql`${t.status} = 'queued'`),
    statusCheck: check("evidence_verification_executions_status_check", sql`${t.status} IN ('queued', 'claimed', 'proven', 'not_proven', 'not_testable', 'failed')`),
  })
);

/** One snapshotted status per Acceptance Contract criterion for a review. */
export const evidenceReviewCriteria = pgTable(
  "evidence_review_criteria",
  {
    id: uuid("id").primaryKey(),
    reviewId: uuid("review_id").notNull().references(() => evidenceReviews.id, { onDelete: "cascade" }),
    criterionId: text("criterion_id").notNull(),
    criterionTextSnapshot: text("criterion_text_snapshot").notNull(),
    required: boolean("required").notNull(),
    status: text("status").notNull(),
    observedBehavior: text("observed_behavior").notNull(),
    expectedBehavior: text("expected_behavior").notNull(),
    evidenceRefs: jsonb("evidence_refs").$type<Record<string, unknown>[]>().notNull().default([]),
    /** Criterion-specific PR-head runtime artifact(s), never a generic smoke result. */
    runtimeEvidence: jsonb("runtime_evidence").$type<Record<string, unknown>[]>().notNull().default([]),
    reason: text("reason").notNull(),
  },
  (t) => ({ criterion: uniqueIndex("evidence_review_criteria_review_criterion_key").on(t.reviewId, t.criterionId) })
);

/** A correction packet exists only for a concrete required code correction. */
export const evidenceReviewCorrections = pgTable(
  "evidence_review_corrections",
  {
    id: uuid("id").primaryKey(),
    reviewId: uuid("review_id").notNull().references(() => evidenceReviews.id, { onDelete: "cascade" }),
    criterionId: text("criterion_id"),
    observedBehavior: text("observed_behavior").notNull(),
    expectedBehavior: text("expected_behavior").notNull(),
    evidenceRefs: jsonb("evidence_refs").$type<Record<string, unknown>[]>().notNull(),
    reproductionSteps: jsonb("reproduction_steps").$type<string[]>().notNull().default([]),
    likelyAffectedUnits: jsonb("likely_affected_units").$type<string[]>().notNull().default([]),
    contextRefs: jsonb("context_refs").$type<Record<string, unknown>[]>().notNull().default([]),
    scopeBoundary: text("scope_boundary").notNull(),
    /** Fully durable correction-packet fields; do not reconstruct claims later. */
    concreteImpact: text("concrete_impact").notNull(),
    requiredCorrection: text("required_correction").notNull(),
    reverification: text("reverification").notNull(),
    repairPath: text("repair_path"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ reviewCriterion: uniqueIndex("evidence_review_corrections_review_criterion_key").on(t.reviewId, t.criterionId) })
);

/** Delivery evidence for a correction packet; queued is never equivalent to notified. */
export const evidenceReviewCorrectionDeliveries = pgTable(
  "evidence_review_correction_deliveries",
  {
    id: uuid("id").primaryKey(),
    correctionId: uuid("correction_id").notNull().references(() => evidenceReviewCorrections.id, { onDelete: "cascade" }),
    deliveryKey: text("delivery_key").notNull(),
    channel: text("channel").notNull(),
    target: jsonb("target").$type<Record<string, unknown>>().notNull(),
    reviewRevisionId: uuid("review_revision_id").notNull().references(() => changeRecordPrRevisions.id, { onDelete: "restrict" }),
    /** Queueing is not an attempt. A carrier increments this only when it sends. */
    attempt: integer("attempt").notNull().default(0),
    outcome: text("outcome").notNull().default("queued"),
    outcomeDetail: text("outcome_detail"),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  },
  (t) => ({ correctionDeliveryKey: uniqueIndex("evidence_review_correction_deliveries_key").on(t.correctionId, t.deliveryKey) })
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
export type AcceptanceContextPackRow = typeof acceptanceContextPacks.$inferSelect;
export type AcceptanceContextPackCompilationRow = typeof acceptanceContextPackCompilations.$inferSelect;
export type AcceptanceContextPackDeliveryRow =
  typeof acceptanceContextPackDeliveries.$inferSelect;
export type ChangeRecordPrRow = typeof changeRecordPrs.$inferSelect;
export type ChangeRecordPrRevisionRow = typeof changeRecordPrRevisions.$inferSelect;
export type AcceptanceBuilderHandoffRow = typeof acceptanceBuilderHandoffs.$inferSelect;
export type AcceptanceIntakeRow = typeof acceptanceIntakes.$inferSelect;
export type AcceptanceIntakeMessageRow = typeof acceptanceIntakeMessages.$inferSelect;
export type EvidenceReviewRow = typeof evidenceReviews.$inferSelect;
export type EvidenceVerificationPlanRow = typeof evidenceVerificationPlans.$inferSelect;
export type EvidenceVerificationArtifactRow = typeof evidenceVerificationArtifacts.$inferSelect;
export type EvidenceVerificationExecutionRow = typeof evidenceVerificationExecutions.$inferSelect;
export type EvidenceReviewCriterionRow = typeof evidenceReviewCriteria.$inferSelect;
export type EvidenceReviewCorrectionRow = typeof evidenceReviewCorrections.$inferSelect;
export type EvidenceReviewCorrectionDeliveryRow = typeof evidenceReviewCorrectionDeliveries.$inferSelect;
