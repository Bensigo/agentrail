import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createHash, randomUUID } from "crypto";
import { readFile } from "node:fs/promises";
import { db } from "../db.js";
import { workspaces } from "../schema/workspaces.js";
import { repositories } from "../schema/repositories.js";
import { wikiPages } from "../schema/wiki_pages.js";
import {
  acceptanceIntakeMessages,
  acceptanceIntakes,
  acceptanceBuilderRouteCapabilityProfiles,
  acceptanceBuilderRouteGithubClaudeAckProfiles,
  acceptanceBuilderRoutes,
  acceptanceCompiledContextPacks,
  acceptanceCorrectionDispatchGithubActivations,
  acceptanceCorrectionDispatchGithubClaudeAckReceipts,
  acceptanceCorrectionDispatchGithubClaudeRepairObservations,
  acceptanceCorrectionDispatchGithubFindingPublications,
  acceptanceCorrectionDispatches,
  acceptanceCorrectionDispatchGithubPreflights,
  acceptanceContextPackSnapshots,
  acceptanceContracts,
  changeRecordEvents,
  changeRecords,
} from "../schema/change_records.js";
import { reviewJobs } from "../schema/review_jobs.js";
import { workspaceMemberships } from "../schema/workspace_memberships.js";
import { previewBoots } from "../schema/preview_boots.js";
import { jaceApprovals, jaceSessions } from "../schema/jace_sessions.js";
import {
  appendChangeRecordEvent,
  appendChangeRecordEventsAtomically,
  appendCurrentReviewJobEventsAtomically,
  acceptanceRecordPullRequestHeadCycleId,
  acceptanceContextPackCustodyBaseIndexRevisionSha256,
  acceptanceContextPackCustodyOverlayManifestSha256,
  acceptanceContextOverlayHeadRangeCoordinateSha256,
  acceptanceContextOverlayManifestSha256,
  acceptanceContextPackCanonicalSha256,
  acceptanceCompiledContextPackId,
  acceptanceContextPacketSetSha256,
  acceptanceContractSha256,
  acceptanceCorrectionPacketPayloadSetSha256,
  reviewJobCorrectionPacketId,
  wikiPageBodySha256,
  attachConfirmedAcceptanceRecordToExternalPullRequest,
  advanceConfirmedAcceptanceRecordPullRequestHead,
  invalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEvent,
  reconcileConfirmedAcceptanceRecordPullRequestHead,
  enqueueCurrentReviewJobPreviewBoot,
  changeRecordId,
  createDraftAcceptanceContract,
  createDraftAcceptanceRecord,
  createDraftAcceptanceRecordFromIntake,
  findOrCreateChangeRecord,
  recordAcceptancePostMergeOutcome,
  recordAcceptanceBuilderRouteSelection,
  recordAcceptanceContextPackSnapshot,
  resolveAcceptanceContextPackCustody,
  recordAcceptanceCompiledContextPack,
  resolveAcceptanceCompiledContextPack,
  recordAcceptanceDependencyObservation,
  readCurrentAcceptanceDependencyObservations,
  approveAcceptanceDependencyObservationAndMintExternalBuilderPack,
  AcceptanceDependencyObservationConflictError,
  AcceptanceDependencyObservationInvalidEvidenceError,
  type RecordAcceptanceDependencyObservationInput,
  AcceptanceDependencyExternalBuilderPackConflictError,
  registerAcceptanceBuilderRoute,
  recordAcceptanceBuilderRouteCapabilityProfile,
  recordAcceptanceBuilderRouteGithubClaudeAckProfile,
  recordGithubClaudeAgentAcknowledgement,
  readGithubClaudeAgentAcknowledgement,
  githubClaudeAcknowledgementAudience,
  recordGithubClaudeRepairHeadObservation,
  readGithubClaudeRepairHeadEvidence,
  githubClaudeRepairObservationAudience,
  GithubClaudeAgentAcknowledgementConflictError,
  GithubClaudeRepairObservationConflictError,
  readCurrentAcceptanceCorrectionPackets,
  readCurrentAcceptancePrDecision,
  readAcceptanceOutcomeHistory,
  recordAcceptancePrDecision,
  AcceptancePrDecisionConflictError,
  recordAcceptancePrReviewEffort,
  readAcceptancePrReviewMetrics,
  AcceptancePrReviewEffortConflictError,
  recordSignedAcceptanceRecordMerge,
  SignedAcceptanceRecordMergeConflictError,
  recordAcceptanceInboundIntake,
  readAcceptanceBuilderRouteSelection,
  resolveAcceptanceBuilderRouteCapabilityProfile,
  readAcceptanceContracts,
  readChangeRecordByPr,
  readChangeRecordTimeline,
  queueSelectedCorrectionDispatch,
  reserveGithubCorrectionCarrierPreflight,
  reportGithubCorrectionCarrierPreflight,
  reserveNextGithubCorrectionFindingPublication,
  reportGithubCorrectionFindingPublication,
  reserveGithubCorrectionActivation,
  reportGithubCorrectionActivation,
  readDurableCorrectionDispatchFallback,
  recordDurableCorrectionDispatchFallback,
  readAcceptanceRecordSummaries,
  readAcceptanceRecordDetail,
} from "../queries/change_records.js";
import { exactGitTreeInclusionProofIdentity, type ExactGitTreeInclusionProof } from "../exact-git-tree-path-proof.js";
import { previewBootId } from "../queries/preview_boots.js";
import {
  recordApprovalRequest,
  resolveAcceptanceContractApproval,
} from "../queries/jace_sessions.js";

const DB_AVAILABLE: boolean = await (async () => {
  try {
    const rows = Array.from(
      await db.execute(sql`
        SELECT to_regclass('public.change_records') AS change_records,
               to_regclass('public.change_record_events') AS change_record_events,
               to_regclass('public.acceptance_contracts') AS acceptance_contracts,
               to_regclass('public.acceptance_builder_routes') AS acceptance_builder_routes,
               to_regclass('public.acceptance_builder_route_capability_profiles') AS acceptance_builder_route_capability_profiles,
               to_regclass('public.acceptance_builder_route_github_claude_ack_profiles') AS acceptance_builder_route_github_claude_ack_profiles,
               to_regclass('public.acceptance_context_pack_snapshots') AS acceptance_context_pack_snapshots,
               to_regclass('public.acceptance_compiled_context_packs') AS acceptance_compiled_context_packs,
               to_regclass('public.acceptance_correction_dispatches') AS acceptance_correction_dispatches,
               to_regclass('public.acceptance_correction_dispatch_github_preflights') AS acceptance_correction_dispatch_github_preflights,
               to_regclass('public.acceptance_correction_dispatch_github_finding_publications') AS acceptance_correction_dispatch_github_finding_publications,
               to_regclass('public.acceptance_correction_dispatch_github_activations') AS acceptance_correction_dispatch_github_activations,
               to_regclass('public.acceptance_correction_dispatch_github_claude_ack_receipts') AS acceptance_correction_dispatch_github_claude_ack_receipts,
               to_regclass('public.acceptance_correction_dispatch_github_claude_repair_obs') AS github_claude_repair_observations,
               EXISTS (
                 SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'acceptance_context_pack_snapshots'
                   AND column_name = 'acceptance_contract_sha256'
               ) AND EXISTS (
                 SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'acceptance_context_pack_snapshots'
                   AND column_name = 'correction_packet_payload_set_sha256'
               ) AS acceptance_context_pack_custody,
               EXISTS (
                 SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'acceptance_compiled_context_packs'
                   AND column_name = 'exact_head_dependency_tree_proofs'
               ) AS acceptance_compiled_context_pack_tree_proofs,
               EXISTS (
                 SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'change_records'
                   AND column_name = 'current_pr_head_sha'
               ) AND EXISTS (
                 SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'change_records'
                   AND column_name = 'current_pr_head_authoritative'
               ) AND EXISTS (
                 SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'change_records'
                   AND column_name = 'current_pr_head_cycle_id'
               ) AND EXISTS (
                 SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'change_records'
                   AND column_name = 'current_pr_head_authority_generation'
               ) AS change_record_current_pr_head,
               to_regclass('public.acceptance_intakes') AS acceptance_intakes,
               to_regclass('public.acceptance_intake_messages') AS acceptance_intake_messages
      `)
    ) as Array<{
      change_records: string | null;
      change_record_events: string | null;
      acceptance_contracts: string | null;
      acceptance_builder_routes: string | null;
      acceptance_builder_route_capability_profiles: string | null;
      acceptance_builder_route_github_claude_ack_profiles: string | null;
      acceptance_context_pack_snapshots: string | null;
      acceptance_compiled_context_packs: string | null;
      acceptance_correction_dispatches: string | null;
      acceptance_correction_dispatch_github_preflights: string | null;
      acceptance_correction_dispatch_github_finding_publications: string | null;
      acceptance_correction_dispatch_github_activations: string | null;
      acceptance_correction_dispatch_github_claude_ack_receipts: string | null;
      github_claude_repair_observations: string | null;
      acceptance_context_pack_custody: boolean;
      acceptance_compiled_context_pack_tree_proofs: boolean;
      change_record_current_pr_head: boolean;
      acceptance_intakes: string | null;
      acceptance_intake_messages: string | null;
    }>;
    return (
      rows[0]?.change_records === "change_records" &&
      rows[0]?.change_record_events === "change_record_events" &&
      rows[0]?.acceptance_contracts === "acceptance_contracts" &&
      rows[0]?.acceptance_builder_routes === "acceptance_builder_routes" &&
      rows[0]?.acceptance_builder_route_capability_profiles === "acceptance_builder_route_capability_profiles" &&
      rows[0]?.acceptance_builder_route_github_claude_ack_profiles === "acceptance_builder_route_github_claude_ack_profiles" &&
      rows[0]?.acceptance_context_pack_snapshots === "acceptance_context_pack_snapshots" &&
      rows[0]?.acceptance_compiled_context_packs === "acceptance_compiled_context_packs" &&
      rows[0]?.acceptance_correction_dispatches === "acceptance_correction_dispatches" &&
      rows[0]?.acceptance_correction_dispatch_github_preflights === "acceptance_correction_dispatch_github_preflights" &&
      rows[0]?.acceptance_correction_dispatch_github_finding_publications === "acceptance_correction_dispatch_github_finding_publications" &&
      rows[0]?.acceptance_correction_dispatch_github_activations === "acceptance_correction_dispatch_github_activations" &&
      rows[0]?.acceptance_correction_dispatch_github_claude_ack_receipts === "acceptance_correction_dispatch_github_claude_ack_receipts" &&
      rows[0]?.github_claude_repair_observations === "acceptance_correction_dispatch_github_claude_repair_obs" &&
      rows[0]?.acceptance_context_pack_custody === true &&
      rows[0]?.acceptance_compiled_context_pack_tree_proofs === true &&
      rows[0]?.change_record_current_pr_head === true &&
      rows[0]?.acceptance_intakes === "acceptance_intakes" &&
      rows[0]?.acceptance_intake_messages === "acceptance_intake_messages"
    );
  } catch {
    return false;
  }
})();

function completeContract(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    originalRequest: "Add saved filters",
    normalizedRequirements: ["Users can save and reuse a filter"],
    acceptanceCriteria: [
      { id: "AC-1", text: "A user can save a filter", userVisible: true },
    ],
    nonGoals: [],
    risks: [],
    environment: { kind: "existing_preview" },
    stops: [],
    unresolvedQuestions: [],
    ...overrides,
  };
}

function exactCorrectionPacket(input: {
  workspaceId: string;
  recordId: string;
  jobId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  acceptanceContractId: string;
  acceptanceContractVersion?: number;
  observed?: string;
}) {
  const acceptanceContractVersion = input.acceptanceContractVersion ?? 1;
  const packetId = reviewJobCorrectionPacketId({
    jobId: input.jobId,
    criterionId: "AC-1",
    headSha: input.headSha,
    recordId: input.recordId,
    acceptanceContractId: input.acceptanceContractId,
    acceptanceContractVersion,
  });
  return {
    kind: "review_job_correction_packet",
    version: 1,
    packetId,
    workspaceId: input.workspaceId,
    repo: input.repo,
    prNumber: input.prNumber,
    headSha: input.headSha,
    recordId: input.recordId,
    jobId: input.jobId,
    acceptanceContract: { id: input.acceptanceContractId, version: acceptanceContractVersion },
    criterion: { id: "AC-1", snapshot: "A user can save a filter" },
    basis: "acceptance_contract",
    state: "failed",
    expected: "A user can save a filter",
    observed: input.observed ?? "The saved filter was not retained.",
    affectedContext: {
      modality: "ui",
      environmentKind: "isolated_preview",
      flow: "Save a filter, reload, and inspect it.",
      reproduction: {
        modality: "ui",
        steps: [
          { action: "open", path: "/filters" },
          { action: "expect_text", text: "Saved filters" },
          { action: "screenshot", label: "saved-filter" },
        ],
      },
    },
    evidence: {
      evidenceRef: "ui-execution:execution-1",
      artifactKey: "review/ui/execution-1.png",
      executionId: "execution-1",
      previewBootId: "preview-boot-1",
    },
    scopeBoundary: `Only AC-1 for ${input.repo}#${input.prNumber} at ${input.headSha}.`,
    impact: "The server-attested UI receipt shows this confirmed criterion failed on the exact head.",
    requiredCorrection: "Make the persisted UI flow retain the saved filter.",
    reverification: "Rerun the persisted UI plan against the next exact head.",
  };
}

async function appendExactCurrentCorrectionPacket(input: Parameters<typeof exactCorrectionPacket>[0]) {
  await db.update(reviewJobs).set({ state: "running" }).where(eq(reviewJobs.id, input.jobId));
  const packet = exactCorrectionPacket(input);
  await appendCurrentReviewJobEventsAtomically({
    workspaceId: input.workspaceId,
    recordId: input.recordId,
    jobId: input.jobId,
    repo: input.repo,
    prNumber: input.prNumber,
    headSha: input.headSha,
    events: [{
      eventKey: `review:correction:${input.jobId}:AC-1`,
      stage: "review",
      actor: "reviewer-of-record",
      payloadRef: packet,
    }],
  });
  return packet;
}

async function recordExactPostedReview(input: {
  workspaceId: string;
  recordId: string;
  jobId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  acceptanceContractId: string;
  acceptanceContractVersion?: number;
  verdict: "proven" | "failed" | "not_proven" | "not_testable";
}) {
  const postedReviewUrl = `https://github.com/${input.repo}/pull/${input.prNumber}#pullrequestreview-1`;
  const outcomeDigest = "a".repeat(64);
  const postPayloadDigest = "b".repeat(64);
  const event = await appendChangeRecordEvent({
    recordId: input.recordId,
    eventKey: `review:github-posted:${input.jobId}`,
    stage: "review",
    actor: "reviewer-of-record",
    payloadRef: {
      kind: "review_job_github_posted",
      jobId: input.jobId,
      workspaceId: input.workspaceId,
      repo: input.repo,
      prNumber: input.prNumber,
      headSha: input.headSha,
      recordId: input.recordId,
      acceptanceContractId: input.acceptanceContractId,
      acceptanceContractVersion: input.acceptanceContractVersion ?? 1,
      outcomeDigest,
      postPayloadDigest,
      postedReviewUrl,
      inlineCommentsPosted: 0,
      commentsFolded: false,
    },
  });
  await db.update(reviewJobs).set({
    state: "posted",
    verdict: input.verdict,
    postedReviewUrl,
  }).where(eq(reviewJobs.id, input.jobId));
  return { event: event.event, postedReviewUrl, outcomeDigest, postPayloadDigest };
}

async function addAcceptanceDecisionActor(
  workspaceId: string,
  role: "owner" | "admin" | "member" | "viewer"
): Promise<string> {
  const userId = randomUUID();
  await db.insert(workspaceMemberships).values({ workspaceId, userId, role });
  return `user:${userId}`;
}

async function createReadyAcceptanceDecisionRecord(input: {
  workspaceId: string;
  workKey: string;
  prNumber: number;
  headSha: string;
  verdict: "proven" | "failed" | "not_proven" | "not_testable";
}) {
  const repo = "acme/widgets";
  const draft = await createDraftAcceptanceRecord({
    workspaceId: input.workspaceId,
    repo,
    workKey: input.workKey,
    originChannel: "codex_mcp",
    contract: completeContract(),
    createdBy: "user:lead",
  });
  await db.update(acceptanceContracts).set({
    status: "confirmed",
    confirmedBy: "console_user:user-1",
    confirmedAt: new Date(),
  }).where(eq(acceptanceContracts.id, draft.contract.id));
  const advanced = await advanceConfirmedAcceptanceRecordPullRequestHead({
    workspaceId: input.workspaceId,
    recordId: draft.record.id,
    repo,
    prNumber: input.prNumber,
    headSha: input.headSha,
    event: "opened",
    deliveryId: `${input.workKey}:opened`,
    admitReviewJob: true,
    headTransition: null,
    source: "github_webhook",
  });
  if (advanced.kind !== "advanced") throw new Error("expected current decision head cycle");
  const posted = await recordExactPostedReview({
    workspaceId: input.workspaceId,
    recordId: draft.record.id,
    jobId: advanced.jobId,
    repo,
    prNumber: input.prNumber,
    headSha: input.headSha,
    acceptanceContractId: draft.contract.id,
    verdict: input.verdict,
  });
  const current = await readCurrentAcceptancePrDecision({
    workspaceId: input.workspaceId,
    recordId: draft.record.id,
  });
  if (current.kind !== "current" || current.decision !== null) {
    throw new Error("expected an undecided current decision binding");
  }
  return { repo, draft, advanced, posted, binding: current.binding };
}

function signedMergeInput(input: {
  workspaceId: string;
  recordId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  deliveryId: string;
  mergeSha: string;
}) {
  return {
    ...input,
    baseSha: "b".repeat(40),
    mergedAt: new Date("2026-08-11T10:00:00.000Z"),
    prUrl: `https://github.com/${input.repo}/pull/${input.prNumber}`,
    githubActor: { id: 991, login: "jace[bot]", type: "Bot" as const },
    source: "github_webhook" as const,
  };
}

async function createAcceptanceDependencyObservationFixture(input: {
  workspaceId: string;
  workKey: string;
  prNumber: number;
  headSha: string;
  lockfileReadReason?: "path_not_found" | "github_unavailable";
  yarnConfigurationRead?: "path_not_found" | "github_unavailable" | "record" | "unsafe_content";
  yarnConfigurationChangedContent?: string;
  manifestPath?: string;
  manifestContent?: string;
  lockfilePath?: string;
  lockfileContent?: string;
  compiledPackCompilerVersion?: string;
  compiledPackPolicyVersion?: string;
  contractOverrides?: Record<string, unknown>;
}) {
  const repoName = "acme/widgets";
  const contractInput = completeContract(input.contractOverrides);
  const draft = await createDraftAcceptanceRecord({
    workspaceId: input.workspaceId,
    repo: repoName,
    workKey: input.workKey,
    originChannel: "codex_mcp",
    contract: contractInput,
    createdBy: "user:lead",
  });
  await db.update(acceptanceContracts).set({
    status: "confirmed",
    confirmedBy: "console_user:user-1",
    confirmedAt: new Date(),
  }).where(eq(acceptanceContracts.id, draft.contract.id));
  const advanced = await advanceConfirmedAcceptanceRecordPullRequestHead({
    workspaceId: input.workspaceId,
    recordId: draft.record.id,
    repo: repoName,
    prNumber: input.prNumber,
    headSha: input.headSha,
    event: "opened",
    deliveryId: `${input.workKey}:opened`,
    admitReviewJob: true,
    headTransition: null,
    source: "github_webhook",
  });
  if (advanced.kind !== "advanced") throw new Error("expected dependency observation head");
  const packet = await appendExactCurrentCorrectionPacket({
    workspaceId: input.workspaceId,
    recordId: draft.record.id,
    jobId: advanced.jobId,
    repo: repoName,
    prNumber: input.prNumber,
    headSha: input.headSha,
    acceptanceContractId: draft.contract.id,
  });

  let repository = (await db.select().from(repositories).where(and(
    eq(repositories.workspaceId, input.workspaceId),
    eq(repositories.name, repoName),
  )).limit(1))[0];
  if (!repository) {
    repository = (await db.insert(repositories).values({
      workspaceId: input.workspaceId,
      name: repoName,
      url: `https://github.com/${repoName}`,
    }).returning())[0]!;
  }
  const wikiBody = `Dependency observation background for ${input.workKey}`;
  const wiki = (await db.insert(wikiPages).values({
    workspaceId: input.workspaceId,
    repositoryId: repository.id,
    slug: `wiki/${input.workKey}`,
    title: "Dependency observation",
    kind: "overview",
    commitSha: "d".repeat(40),
    inputsHash: "e".repeat(64),
    bodyMd: wikiBody,
    generatedAt: new Date(),
  }).returning())[0]!;
  const baseIndexCore = {
    schemaVersion: 2 as const,
    backgroundOnly: true as const,
    pages: [{
      id: wiki.id,
      repositoryId: repository.id,
      slug: wiki.slug,
      commitSha: wiki.commitSha,
      inputsHashSha256: wiki.inputsHash,
      pageBodySha256: wikiPageBodySha256(wikiBody),
      stale: false,
    }],
    gaps: [],
  };

  const manifestPath = input.manifestPath ?? "package.json";
  const lockfilePath = input.lockfilePath ?? "pnpm-lock.yaml";
  const fileInput = [
    { path: manifestPath, content: input.manifestContent ?? JSON.stringify({
      packageManager: "pnpm@10.14.0",
      engines: { node: "22.17.0" },
      dependencies: { lodash: "^4.17.20" },
    }) },
    ...(input.lockfileReadReason ? [] : [{
      path: lockfilePath,
      content: input.lockfileContent ?? "lockfileVersion: '9.0'\n",
    }]),
    ...(input.yarnConfigurationChangedContent === undefined ? [] : [{
      path: ".yarnrc.yml",
      content: input.yarnConfigurationChangedContent,
    }]),
  ];
  const fileProofs = fileInput.map(({ path, content }, index) => {
    const bytes = Buffer.from(content, "utf8");
    const blobSha = createHash("sha1")
      .update(`blob ${bytes.length}\0`, "utf8").update(bytes).digest("hex");
    const patchSha256 = createHash("sha256").update(`patch:${path}`, "utf8").digest("hex");
    const lineCount = content.split("\n").length;
    return {
      path,
      content,
      bytes,
      blobSha,
      contentSha256: createHash("sha256").update(bytes).digest("hex"),
      patchSha256,
      patchByteCount: bytes.length,
      lineCount,
      range: {
        startLine: 1,
        endLine: lineCount,
        coordinateSha256: acceptanceContextOverlayHeadRangeCoordinateSha256({
          path,
          patchSha256,
          startLine: 1,
          endLine: lineCount,
        }),
      },
      order: index,
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const manifestFile = fileProofs.find((file) => file.path === manifestPath)!;
  const lockfile = fileProofs.find((file) => file.path === lockfilePath) ?? null;
  const baseSha = "b".repeat(40);
  const mergeBaseSha = "8".repeat(40);
  const headTreeSha = "c".repeat(40);
  const overlayCore = {
    schemaVersion: 2 as const,
    baseSha,
    mergeBaseSha,
    headSha: input.headSha,
    files: fileProofs.map((file) => ({
      path: file.path,
      status: "modified" as const,
      blobSha: file.blobSha,
      previousPath: null,
      patchSha256: file.patchSha256,
      patchByteCount: file.patchByteCount,
      headRanges: [file.range],
    })),
  };
  const packetIds = [packet.packetId];
  const snapshot = await recordAcceptanceContextPackSnapshot({
    workspaceId: input.workspaceId,
    recordId: draft.record.id,
    reviewJobId: advanced.jobId,
    acceptanceContractId: draft.contract.id,
    acceptanceContractVersion: draft.contract.version,
    acceptanceContractSha256: acceptanceContractSha256({
      acceptanceContractId: draft.contract.id,
      acceptanceContractVersion: draft.contract.version,
      contract: draft.contract.contract,
    }),
    repo: repoName,
    prNumber: input.prNumber,
    expectedHeadSha: input.headSha,
    baseSha,
    mergeBaseSha,
    headTreeSha,
    packetIds,
    packetSetSha256: acceptanceContextPacketSetSha256({ packetIds }),
    correctionPacketPayloadSetSha256: acceptanceCorrectionPacketPayloadSetSha256({ packets: [packet] }),
    compilerVersion: "dependency-observation-source-v1",
    baseIndex: {
      ...baseIndexCore,
      revisionSha256: acceptanceContextPackCustodyBaseIndexRevisionSha256(baseIndexCore),
    },
    overlay: {
      ...overlayCore,
      manifestSha256: acceptanceContextPackCustodyOverlayManifestSha256(overlayCore),
    },
    provenance: {
      schemaVersion: 1,
      included: [
        { path: wiki.slug, source: "base_index" as const, reason: "Background only" },
        ...fileProofs.map((file) => ({
          path: file.path,
          source: "overlay" as const,
          reason: "Exact dependency evidence source",
        })),
      ],
      excluded: [],
    },
    status: "admitted",
    reason: null,
  });

  const exactSources = fileProofs.filter((file) => file.path !== ".yarnrc.yml").map((file) => ({
    kind: "exact_head_overlay" as const,
    path: file.path,
    blobSha: file.blobSha,
    fullContentSha256: file.contentSha256,
    startLine: 1,
    endLine: file.lineCount,
    rangeSha256: file.contentSha256,
    byteCount: file.bytes.length,
    reason: "exact_patch_head_range",
    citation: `${file.path}@${file.blobSha}#L1-L${file.lineCount}`,
  }));
  const directReadReceipts: Record<string, unknown>[] = [];
  if (input.lockfileReadReason) {
    directReadReceipts.push({
      requestedPath: lockfilePath,
      headSha: input.headSha,
      headTreeSha,
      outcome: "not_proven",
      reason: input.lockfileReadReason,
    });
  }
  if (input.yarnConfigurationRead) {
    const requestedPath = ".yarnrc.yml";
    if (input.yarnConfigurationRead === "record") {
      const content = "enableScripts: false\n";
      const bytes = Buffer.from(content, "utf8");
      directReadReceipts.push({
        requestedPath,
        headSha: input.headSha,
        headTreeSha,
        outcome: "record",
        record: {
          path: requestedPath,
          blobSha: createHash("sha1")
            .update(`blob ${bytes.length}\0`, "utf8").update(bytes).digest("hex"),
          previousPath: null,
          contentSha256: createHash("sha256").update(bytes).digest("hex"),
          byteCount: bytes.length,
          lineCount: content.split("\n").length,
          source: "exact_head_tree_fallback",
          reason: "exact_head_tree_path",
        },
      });
    } else if (input.yarnConfigurationRead === "unsafe_content") {
      directReadReceipts.push({
        requestedPath,
        headSha: input.headSha,
        headTreeSha,
        outcome: "not_proven",
        reason: "unsafe_content",
        exclusion: {
          path: requestedPath,
          source: "exact_head_tree_fallback",
          blobSha: "7".repeat(40),
          byteCount: 64,
          reason: "secret_content_policy",
          secretKinds: ["credential"],
          findingCount: 1,
        },
      });
    } else {
      directReadReceipts.push({
        requestedPath,
        headSha: input.headSha,
        headTreeSha,
        outcome: "not_proven",
        reason: input.yarnConfigurationRead,
      });
    }
  }
  directReadReceipts.sort((left, right) => {
    const key = (value: Record<string, unknown>) => {
      const record = value["record"] as Record<string, unknown> | undefined;
      return `${value["requestedPath"]}\0${value["outcome"]}\0${record?.["blobSha"] ?? value["reason"] ?? ""}`;
    };
    return Buffer.compare(Buffer.from(key(left), "utf8"), Buffer.from(key(right), "utf8"));
  });
  const receiptCore = {
    kind: "exact_head_source_custody" as const,
    schemaVersion: 2 as const,
    repo: repoName,
    prNumber: input.prNumber,
    baseSha,
    mergeBaseSha,
    headSha: input.headSha,
    headTreeSha,
    manifestSha256: acceptanceContextOverlayManifestSha256({
      schemaVersion: 1,
      baseSha,
      mergeBaseSha,
      headSha: input.headSha,
      files: fileProofs.map((file) => ({
        path: file.path,
        status: "modified" as const,
        blobSha: file.blobSha,
        previousPath: null,
      })),
    }),
    changedManifest: fileProofs.map((file) => ({
      path: file.path,
      status: "modified",
      blobSha: file.blobSha,
      previousPath: null,
      headRanges: [{ startLine: 1, endLine: file.lineCount }],
      patchSha256: file.patchSha256,
      patchByteCount: file.patchByteCount,
    })),
    records: fileProofs.map((file) => ({
      path: file.path,
      blobSha: file.blobSha,
      previousPath: null,
      contentSha256: file.contentSha256,
      byteCount: file.bytes.length,
      lineCount: file.lineCount,
      source: "exact_head_overlay",
      reason: "exact_base_to_head_compare",
    })),
    exclusions: [],
    directReadReceipts,
    selectedExactRanges: exactSources.map(({ reason: _reason, citation: _citation, ...source }) => source),
  };
  const receipt = {
    ...receiptCore,
    identitySha256: acceptanceContextPackCanonicalSha256(receiptCore),
  };
  const binding = {
    sourceSnapshotId: snapshot.snapshot.id,
    workspaceId: input.workspaceId,
    recordId: draft.record.id,
    reviewJobId: advanced.jobId,
    acceptanceContractId: draft.contract.id,
    acceptanceContractVersion: draft.contract.version,
    acceptanceContractSha256: acceptanceContractSha256({
      acceptanceContractId: draft.contract.id,
      acceptanceContractVersion: draft.contract.version,
      contract: draft.contract.contract,
    }),
    repo: repoName,
    prNumber: input.prNumber,
    baseSha,
    mergeBaseSha,
    headSha: input.headSha,
    headTreeSha,
    packetSetSha256: acceptanceContextPacketSetSha256({ packetIds }),
    correctionPacketPayloadSetSha256: acceptanceCorrectionPacketPayloadSetSha256({ packets: [packet] }),
    sourceSnapshotCompilerVersion: "dependency-observation-source-v1",
    baseIndexRevisionSha256: acceptanceContextPackCustodyBaseIndexRevisionSha256(baseIndexCore),
    overlayManifestSha256: acceptanceContextPackCustodyOverlayManifestSha256(overlayCore),
  };
  const compiler = {
    version: input.compiledPackCompilerVersion ?? "dependency-observation-pack-v1",
    policyVersion: input.compiledPackPolicyVersion ?? "dependency-observation-policy-v1",
    byteCounter: "utf8_byte_upper_bound_v1",
    byteBudget: 65_536,
  };
  const manifest = {
    version: 1,
    acceptanceCriterionIds: ["AC-1"],
    unresolvedQuestionIds: [],
    packetIds,
    sources: exactSources,
    architectureBoundaries: [
      ...(contractInput["nonGoals"] as string[]).map((value) => `non_goal:${value}`),
      ...(contractInput["stops"] as string[]).map((value) => `stop:${value}`),
    ].sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))),
    tests: [],
    decisions: [],
    exclusions: [],
    sourceCustody: {
      kind: "exact_head_source_custody",
      schemaVersion: 2,
      identitySha256: receipt.identitySha256,
    },
    budget: { counter: "utf8_byte_upper_bound_v1", limitBytes: 65_536 },
    custody: { fullSourceUploadAllowed: false, rawSourcePersisted: false, snippetsPersisted: false },
  };
  const representations = { jsonSha256: "7".repeat(64), markdownSha256: "9".repeat(64) };
  const core = {
    kind: "compiled_acceptance_context_pack" as const,
    version: 1 as const,
    binding,
    compiler,
    manifest,
    sourceCustodyReceipt: {
      kind: receipt.kind,
      schemaVersion: receipt.schemaVersion,
      identitySha256: receipt.identitySha256,
    },
    exactHeadDependencyTreeProofs: [],
    representations,
    renderedByteCount: 256,
  };
  const compiled = {
    ...core,
    sourceCustodyReceipt: receipt,
    packSha256: acceptanceContextPackCanonicalSha256(core),
  };
  const persisted = await recordAcceptanceCompiledContextPack({
    workspaceId: input.workspaceId,
    sourceSnapshotId: snapshot.snapshot.id,
    compiled,
    exactSourceProofs: fileProofs.filter((file) => file.path !== ".yarnrc.yml").map((file) => ({
      kind: "exact_head_overlay" as const,
      path: file.path,
      content: file.content,
    })),
    exactGitTreeInclusionProofs: [],
  });
  return {
    repo: repoName,
    draft,
    advanced,
    pack: persisted.pack,
    manifestBlobSha: manifestFile.blobSha,
    lockfileBlobSha: lockfile?.blobSha ?? null,
  };
}

function acceptanceDependencyObservationInput(input: {
  workspaceId: string;
  recordId: string;
  compiledPackId: string;
  headSha: string;
  manifestBlobSha: string;
  lockfileBlobSha: string | null;
  targetVersion?: string;
  lockfileDisposition?: "present" | "missing" | "uncommitted" | "unavailable" | "ambiguous";
}) {
  const targetVersion = input.targetVersion ?? "4.17.21";
  const lockfileDisposition = input.lockfileDisposition ?? "present";
  return {
    workspaceId: input.workspaceId,
    recordId: input.recordId,
    compiledPackId: input.compiledPackId,
    candidate: {
      identity: { ecosystem: "node", manager: "pnpm", profile: "pnpm_lockfile_only_v1" },
      package: "lodash",
      dependencyKind: "dependencies" as const,
      specifier: "^4.17.20",
      currentVersion: "4.17.20",
      targetVersion,
    },
    runtime: { identity: { ecosystem: "node", manager: "pnpm", profile: "pnpm_lockfile_only_v1" }, disposition: "safe" as const, version: "22.17.0", evidenceSha256: "1".repeat(64) },
    packageManager: {
      disposition: "safe" as const,
      name: "pnpm",
      version: "10.14.0",
      profile: "pnpm_lockfile_only_v1",
      updateArgv: ["pnpm", "update", `lodash@${targetVersion}`, "--lockfile-only", "--ignore-scripts"],
      evidenceSha256: "2".repeat(64),
    },
    manifest: { path: "package.json", blobSha: input.manifestBlobSha },
    lockfile: {
      disposition: lockfileDisposition,
      path: "pnpm-lock.yaml",
      blobSha: lockfileDisposition === "present" ? input.lockfileBlobSha : null,
      evidenceSha256: "3".repeat(64),
    },
    baseline: { headSha: input.headSha },
    security: {
      identity: { ecosystem: "node", manager: "pnpm", profile: "pnpm_lockfile_only_v1" },
      disposition: "clear" as const,
      provider: "osv",
      reference: `osv:npm:lodash@${targetVersion}`,
      reportSha256: "4".repeat(64),
    },
  };
}

function npmAcceptanceDependencyObservationInput(input: {
  workspaceId: string;
  recordId: string;
  compiledPackId: string;
  headSha: string;
  manifestBlobSha: string;
  lockfileBlobSha: string;
  targetVersion?: string;
  dependencyKind?: "dependencies" | "devDependencies" | "optionalDependencies" | "peerDependencies";
}) {
  const targetVersion = input.targetVersion ?? "4.17.21";
  const dependencyKind = input.dependencyKind ?? "dependencies";
  const identity = {
    ecosystem: "node",
    manager: "npm",
    profile: "npm_package_lock_only_v1",
  };
  const saveFlag = {
    dependencies: "--save-prod",
    devDependencies: "--save-dev",
    optionalDependencies: "--save-optional",
    peerDependencies: "--save-peer",
  }[dependencyKind];
  return {
    workspaceId: input.workspaceId,
    recordId: input.recordId,
    compiledPackId: input.compiledPackId,
    candidate: {
      identity,
      package: "lodash",
      dependencyKind,
      specifier: "^4.17.20",
      currentVersion: "4.17.20",
      targetVersion,
    },
    runtime: {
      identity,
      disposition: "safe" as const,
      version: "22.17.0",
      evidenceSha256: "1".repeat(64),
    },
    packageManager: {
      disposition: "safe" as const,
      name: "npm",
      version: "10.9.0",
      profile: "npm_package_lock_only_v1",
      updateArgv: [
        "npm", "install", `lodash@${targetVersion}`, "--package-lock-only",
        "--ignore-scripts", "--no-audit", saveFlag,
      ],
      evidenceSha256: "2".repeat(64),
    },
    manifest: { path: "package.json", blobSha: input.manifestBlobSha },
    lockfile: {
      disposition: "present" as const,
      path: "package-lock.json",
      blobSha: input.lockfileBlobSha,
      evidenceSha256: "3".repeat(64),
    },
    baseline: { headSha: input.headSha },
    security: {
      identity,
      disposition: "clear" as const,
      provider: "osv",
      reference: `osv:npm:lodash@${targetVersion}`,
      reportSha256: "4".repeat(64),
    },
  };
}

function yarnAcceptanceDependencyObservationInput(input: {
  workspaceId: string;
  recordId: string;
  compiledPackId: string;
  headSha: string;
  manifestBlobSha: string;
  lockfileBlobSha: string;
  targetVersion?: string;
  dependencyKind?: "dependencies" | "devDependencies" | "optionalDependencies" | "peerDependencies";
}) {
  const targetVersion = input.targetVersion ?? "4.17.21";
  const dependencyKind = input.dependencyKind ?? "dependencies";
  const identity = {
    ecosystem: "node",
    manager: "yarn",
    profile: "yarn_berry_v4_root_lockfile_only_v1",
  };
  const kindFlag = {
    dependencies: null,
    devDependencies: "--dev",
    optionalDependencies: "--optional",
    peerDependencies: "--peer",
  }[dependencyKind];
  return {
    workspaceId: input.workspaceId,
    recordId: input.recordId,
    compiledPackId: input.compiledPackId,
    candidate: {
      identity,
      package: "lodash",
      dependencyKind,
      specifier: "^4.17.20",
      currentVersion: "4.17.20",
      targetVersion,
    },
    runtime: {
      identity,
      disposition: "safe" as const,
      version: "22.17.0",
      evidenceSha256: "1".repeat(64),
    },
    packageManager: {
      disposition: "safe" as const,
      name: "yarn",
      version: "4.18.0",
      profile: "yarn_berry_v4_root_lockfile_only_v1",
      updateArgv: [
        "yarn", "add", `lodash@${targetVersion}`, "--mode=update-lockfile",
        ...(kindFlag ? [kindFlag] : []),
      ],
      evidenceSha256: "2".repeat(64),
    },
    manifest: { path: "package.json", blobSha: input.manifestBlobSha },
    lockfile: {
      disposition: "present" as const,
      path: "yarn.lock",
      blobSha: input.lockfileBlobSha,
      evidenceSha256: "3".repeat(64),
    },
    baseline: { headSha: input.headSha },
    security: {
      identity,
      disposition: "clear" as const,
      provider: "osv",
      reference: `osv:npm:lodash@${targetVersion}`,
      reportSha256: "4".repeat(64),
    },
  };
}

function uvAcceptanceDependencyObservationInput(input: {
  workspaceId: string;
  recordId: string;
  compiledPackId: string;
  headSha: string;
  manifestBlobSha: string;
  lockfileBlobSha: string;
  currentVersion?: string;
  targetVersion?: string;
  specifier?: string;
}) {
  const currentVersion = input.currentVersion ?? "0.27.0";
  const targetVersion = input.targetVersion ?? "0.28.1";
  const identity = {
    ecosystem: "python",
    manager: "uv",
    profile: "uv_project_lockfile_only_v1",
  };
  return {
    workspaceId: input.workspaceId,
    recordId: input.recordId,
    compiledPackId: input.compiledPackId,
    candidate: {
      identity,
      package: "httpx",
      dependencyKind: "dependencies" as const,
      specifier: input.specifier ?? ">=0.27.0",
      currentVersion,
      targetVersion,
    },
    runtime: {
      identity,
      disposition: "safe" as const,
      version: "3.12.8",
      evidenceSha256: "1".repeat(64),
    },
    packageManager: {
      disposition: "safe" as const,
      name: "uv",
      version: "0.12.0",
      profile: "uv_project_lockfile_only_v1",
      updateArgv: [
        "uv", "lock", "--no-cache", "--no-config", "--no-python-downloads",
        "--no-sources", "--no-build", "--upgrade-package", `httpx==${targetVersion}`,
      ],
      evidenceSha256: "2".repeat(64),
    },
    manifest: { path: "pyproject.toml", blobSha: input.manifestBlobSha },
    lockfile: {
      disposition: "present" as const,
      path: "uv.lock",
      blobSha: input.lockfileBlobSha,
      evidenceSha256: "3".repeat(64),
    },
    baseline: { headSha: input.headSha },
    security: {
      identity,
      disposition: "clear" as const,
      provider: "osv",
      reference: `osv:PyPI:httpx@${targetVersion}`,
      reportSha256: "4".repeat(64),
    },
  };
}

async function appendHistoricalUnsupportedDependencyObservationV2(
  evidence: RecordAcceptanceDependencyObservationInput,
) {
  const record = (await db.select().from(changeRecords).where(and(
    eq(changeRecords.id, evidence.recordId),
    eq(changeRecords.workspaceId, evidence.workspaceId),
  )))[0]!;
  const contract = (await db.select().from(acceptanceContracts).where(and(
    eq(acceptanceContracts.recordId, evidence.recordId),
    eq(acceptanceContracts.status, "confirmed"),
  )))[0]!;
  const pack = (await db.select().from(acceptanceCompiledContextPacks).where(and(
    eq(acceptanceCompiledContextPacks.id, evidence.compiledPackId),
    eq(acceptanceCompiledContextPacks.workspaceId, evidence.workspaceId),
  )))[0]!;
  if (record.prNumber === null || record.currentPrHeadSha === null
    || record.currentPrHeadCycleId === null) throw new Error("expected current dependency observation fixture");
  const candidateFingerprint = `sha256:${acceptanceContextPackCanonicalSha256({
    identity: evidence.candidate.identity,
    manifestPath: evidence.manifest.path,
    package: evidence.candidate.package,
    dependencyKind: evidence.candidate.dependencyKind,
    specifier: evidence.candidate.specifier,
    currentVersion: evidence.candidate.currentVersion,
    targetVersion: evidence.candidate.targetVersion,
  })}`;
  const eventKey = `acceptance-dependency-observation:v2:${record.currentPrHeadCycleId}:${candidateFingerprint.slice("sha256:".length)}`;
  const binding = {
    workspaceId: evidence.workspaceId,
    recordId: evidence.recordId,
    repo: record.repo,
    prNumber: record.prNumber,
    headSha: record.currentPrHeadSha,
    headCycleId: record.currentPrHeadCycleId,
    authorityGeneration: record.currentPrHeadAuthorityGeneration,
    reviewJobId: record.currentPrHeadCycleId,
    acceptanceContract: {
      id: contract.id,
      version: contract.version,
      sha256: acceptanceContractSha256({
        acceptanceContractId: contract.id,
        acceptanceContractVersion: contract.version,
        contract: contract.contract,
      }),
    },
    compiledPack: {
      id: pack.id,
      sha256: pack.packSha256,
      sourceSnapshotId: pack.sourceSnapshotId,
      sourceCustodyIdentitySha256: pack.sourceCustodyIdentitySha256,
      compilerVersion: pack.compilerVersion,
      policyVersion: pack.policyVersion,
      exactHeadDependencyTreeProofsSha256: acceptanceContextPackCanonicalSha256({
        kind: "acceptance_dependency_tree_proof_set",
        version: 1,
        proofs: pack.exactHeadDependencyTreeProofs,
      }),
    },
  };
  const appended = await appendChangeRecordEvent({
    recordId: evidence.recordId,
    eventKey,
    stage: "dependency_observation",
    actor: "server:dependency-observation",
    payloadRef: {
      kind: "acceptance_dependency_observation",
      version: 2,
      binding,
      candidateFingerprint,
      candidate: evidence.candidate,
      runtime: evidence.runtime,
      packageManager: evidence.packageManager,
      manifest: evidence.manifest,
      lockfile: evidence.lockfile,
      baseline: evidence.baseline,
      security: evidence.security,
      status: "refused_unsupported_profile",
      reasons: ["unsupported_manager_profile"],
    },
  });
  return { event: appended.event, eventKey, candidateFingerprint, binding };
}

async function selectDependencyExternalBuilderRoute(input: {
  workspaceId: string;
  recordId: string;
  repo: string;
  adapter: "github_codex" | "github_claude" | "durable_github_fallback" | "durable_jace_fallback";
  configurationVersion?: number;
}) {
  const registered = await registerAcceptanceBuilderRoute({
    workspaceId: input.workspaceId,
    repo: input.repo,
    adapter: input.adapter,
    configurationVersion: input.configurationVersion ?? 1,
    registeredBy: "server:dependency-pack-test",
  });
  const selection = await recordAcceptanceBuilderRouteSelection({
    workspaceId: input.workspaceId,
    recordId: input.recordId,
    routeId: registered.route.id,
    selectedBy: "user:dependency.pack.test",
  });
  return { route: registered.route, selection: selection.event };
}

async function insertActiveCorrectionDispatchFixture(input: {
  workspaceId: string;
  recordId: string;
  reviewJobId: string;
  acceptanceContractId: string;
  acceptanceContractVersion: number;
  repo: string;
  prNumber: number;
  headSha: string;
  headCycleId: string;
  authorityGeneration: number;
}): Promise<string> {
  const sourceSnapshotId = randomUUID();
  const compiledPackId = randomUUID();
  const routeId = randomUUID();
  const dispatchId = randomUUID();
  const sha = "1".repeat(64);
  const packetId = `correction-${"2".repeat(48)}`;
  await db.insert(acceptanceBuilderRoutes).values({
    id: routeId,
    workspaceId: input.workspaceId,
    repo: input.repo,
    adapter: "durable_jace_fallback",
    status: "active",
    configurationVersion: 1,
    registeredBy: "server:merge-test",
  });
  await db.insert(acceptanceContextPackSnapshots).values({
    id: sourceSnapshotId,
    workspaceId: input.workspaceId,
    recordId: input.recordId,
    reviewJobId: input.reviewJobId,
    acceptanceContractId: input.acceptanceContractId,
    acceptanceContractVersion: input.acceptanceContractVersion,
    acceptanceContractSha256: sha,
    repo: input.repo,
    prNumber: input.prNumber,
    expectedHeadSha: input.headSha,
    baseSha: null,
    mergeBaseSha: null,
    headTreeSha: null,
    packetIds: [packetId],
    packetSetSha256: sha,
    correctionPacketPayloadSetSha256: sha,
    compilerVersion: "signed-merge-test",
    baseIndex: null,
    overlay: null,
    provenance: {},
    status: "not_proven",
    reason: "signed merge terminalization fixture",
  });
  await db.insert(acceptanceCompiledContextPacks).values({
    id: compiledPackId,
    workspaceId: input.workspaceId,
    sourceSnapshotId,
    compilerVersion: "signed-merge-test",
    policyVersion: "signed-merge-test-v1",
    packSha256: sha,
    sourceCustodyIdentitySha256: sha,
    jsonSha256: sha,
    markdownSha256: sha,
    renderedByteCount: 1,
    binding: {},
    manifest: {},
    sourceCustodyReceipt: {},
    exactHeadDependencyTreeProofs: [],
  });
  await db.insert(acceptanceCorrectionDispatches).values({
    id: dispatchId,
    workspaceId: input.workspaceId,
    recordId: input.recordId,
    repo: input.repo,
    prNumber: input.prNumber,
    headSha: input.headSha,
    headCycleId: input.headCycleId,
    authorityGeneration: input.authorityGeneration,
    sourceSnapshotId,
    reviewJobId: input.reviewJobId,
    acceptanceContractId: input.acceptanceContractId,
    acceptanceContractVersion: input.acceptanceContractVersion,
    acceptanceContractSha256: sha,
    packetIds: [packetId],
    packetSetSha256: sha,
    correctionPacketPayloadSetSha256: sha,
    compiledPackId,
    compiledPackSha256: sha,
    compilerVersion: "signed-merge-test",
    policyVersion: "signed-merge-test-v1",
    jsonSha256: sha,
    markdownSha256: sha,
    sourceCustodyIdentitySha256: sha,
    routeId,
    routeAdapter: "durable_jace_fallback",
    routeConfigurationVersion: 1,
    routeSnapshot: {},
    routeSnapshotSha256: sha,
    dispatchIdentitySha256: sha,
    carrier: "durable_notice",
  });
  return dispatchId;
}

describe.skipIf(!DB_AVAILABLE)(
  "change_records queries — real Postgres integration (Arc D storage)",
  () => {
    let wsId: string;

    beforeEach(async () => {
      const rows = await db
        .insert(workspaces)
        .values({
          name: "change-records test workspace",
          slug: `test-change-records-${randomUUID()}`,
        })
        .returning({ id: workspaces.id });
      wsId = rows[0]!.id;
    });

    it("returns absent for a deterministic fallback lookup before its dispatch exists", async () => {
      await expect(readDurableCorrectionDispatchFallback({
        workspaceId: wsId, dispatchId: randomUUID(),
      })).resolves.toEqual({ kind: "absent" });
    });

    afterEach(async () => {
      await db.delete(workspaces).where(eq(workspaces.id, wsId));
    });

    it("returns a bounded stable tenant list with explicit draft and unattached unknowns", async () => {
      await expect(readAcceptanceRecordSummaries({ workspaceId: wsId }))
        .resolves.toEqual({ kind: "records", records: [] });
      const older = await createDraftAcceptanceRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        workKey: "acceptance-summary-order-older",
        originChannel: "codex_mcp",
        contract: completeContract(),
        createdBy: "user:lead",
      });
      const newer = await createDraftAcceptanceRecord({
        workspaceId: wsId,
        repo: "acme/gadgets",
        workKey: "acceptance-summary-order-newer",
        originChannel: "codex_mcp",
        contract: completeContract(),
        createdBy: "user:lead",
      });
      await db.update(changeRecords).set({
        createdAt: new Date("2026-08-11T08:00:00.000Z"),
        updatedAt: new Date("2026-08-11T08:00:00.000Z"),
      }).where(eq(changeRecords.id, older.record.id));
      await db.update(changeRecords).set({
        createdAt: new Date("2026-08-11T09:00:00.000Z"),
        updatedAt: new Date("2026-08-11T09:00:00.000Z"),
      }).where(eq(changeRecords.id, newer.record.id));
      await appendChangeRecordEvent({
        recordId: newer.record.id,
        eventKey: "legacy:unrelated-review-metric",
        stage: "evidence",
        actor: "legacy-worker",
        payloadRef: { kind: "legacy_review_metric", elapsedSeconds: 0 },
      });

      const bounded = await readAcceptanceRecordSummaries({ workspaceId: wsId, limit: 1 });
      expect(bounded.records.map((record) => record.recordId)).toEqual([newer.record.id]);
      expect(bounded.records[0]).toMatchObject({
        requestedWork: { kind: "unknown" },
        suppliedContext: { kind: "unknown" },
        pullRequest: { kind: "not_attached" },
        proof: { kind: "unknown" },
        neededDecision: { kind: "not_required", reason: "pr_not_attached" },
        outcome: { kind: "not_recorded" },
      });
      expect(bounded.records[0]!.unknownReasons).toEqual([
        "context_not_recorded",
        "outcome_not_recorded",
        "proof_not_recorded",
        "requested_work_not_confirmed",
      ]);
      await expect(readAcceptanceRecordSummaries({
        workspaceId: wsId,
        repo: "acme/widgets",
      })).resolves.toMatchObject({
        kind: "records",
        records: [{ recordId: older.record.id, repo: "acme/widgets" }],
      });
    });

    it("projects one complete current Acceptance Record summary without crossing tenants", async () => {
      const fixture = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "acceptance-summary-complete",
        prNumber: 611,
        headSha: "1".repeat(40),
      });
      const posted = await recordExactPostedReview({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        jobId: fixture.advanced.jobId,
        repo: fixture.repo,
        prNumber: 611,
        headSha: "1".repeat(40),
        acceptanceContractId: fixture.draft.contract.id,
        verdict: "failed",
      });

      const result = await readAcceptanceRecordSummaries({
        workspaceId: wsId,
        repo: fixture.repo,
        limit: 1,
      });
      expect(result.records).toHaveLength(1);
      expect(result.records[0]).toMatchObject({
        recordId: fixture.draft.record.id,
        workspaceId: wsId,
        repo: fixture.repo,
        requestedWork: {
          kind: "confirmed",
          originalRequest: "Add saved filters",
          acceptanceContract: {
            id: fixture.draft.contract.id,
            version: 1,
          },
        },
        suppliedContext: {
          kind: "compiled",
          sourceSnapshot: {
            headSha: "1".repeat(40),
            headCycleId: fixture.advanced.jobId,
          },
          compiledPack: { id: fixture.pack.id, sha256: fixture.pack.packSha256 },
        },
        pullRequest: {
          kind: "attached",
          prNumber: 611,
          head: {
            kind: "current",
            sha: "1".repeat(40),
            headCycleId: fixture.advanced.jobId,
          },
        },
        proof: {
          kind: "recorded",
          reviewJobId: fixture.advanced.jobId,
          verdict: "failed",
          postedReviewUrl: posted.postedReviewUrl,
          postedAttestationEventId: posted.event.id,
        },
        neededDecision: {
          kind: "required",
          choices: ["changes_requested", "rejected", "approved_with_exception"],
        },
        outcome: { kind: "not_recorded" },
      });
      expect(result.records[0]!.unknownReasons).toEqual([
        "decision_not_recorded",
        "outcome_not_recorded",
      ]);

      const actor = await addAcceptanceDecisionActor(wsId, "admin");
      const currentDecision = await readCurrentAcceptancePrDecision({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
      });
      if (currentDecision.kind !== "current") throw new Error("expected current summary decision binding");
      const recordedDecision = await recordAcceptancePrDecision({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        bindingId: currentDecision.binding.bindingId,
        decision: "changes_requested",
        rationale: "Repair the failed criterion before approval.",
        decidedBy: actor,
      });
      if (recordedDecision.kind !== "recorded") throw new Error("expected recorded summary decision");
      const decided = (await readAcceptanceRecordSummaries({ workspaceId: wsId, limit: 1 })).records[0]!;
      expect(decided.neededDecision).toMatchObject({
        kind: "recorded",
        eventId: recordedDecision.decision.eventId,
        decision: "changes_requested",
      });
      expect(decided.unknownReasons).not.toContain("decision_not_recorded");

      const otherWorkspace = (await db.insert(workspaces).values({
        name: "acceptance summary tenant boundary",
        slug: `acceptance-summary-tenant-${randomUUID()}`,
      }).returning({ id: workspaces.id }))[0]!;
      try {
        await expect(readAcceptanceRecordSummaries({
          workspaceId: otherWorkspace.id,
          repo: fixture.repo,
        })).resolves.toEqual({ kind: "records", records: [] });
      } finally {
        await db.delete(workspaces).where(eq(workspaces.id, otherWorkspace.id));
      }
    });

    it("keeps queued proof and each Context Pack custody state explicit", async () => {
      const admitted = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "acceptance-summary-context-admitted",
        prNumber: 616,
        headSha: "9".repeat(40),
      });
      let summary = (await readAcceptanceRecordSummaries({ workspaceId: wsId }))
        .records.find((record) => record.recordId === admitted.draft.record.id)!;
      expect(summary.proof).toEqual({ kind: "unknown" });
      expect(summary.unknownReasons).toContain("proof_not_recorded");

      await db.delete(acceptanceCompiledContextPacks)
        .where(eq(acceptanceCompiledContextPacks.id, admitted.pack.id));
      summary = (await readAcceptanceRecordSummaries({ workspaceId: wsId }))
        .records.find((record) => record.recordId === admitted.draft.record.id)!;
      expect(summary.suppliedContext).toMatchObject({
        kind: "admitted",
        sourceSnapshot: { id: admitted.pack.sourceSnapshotId },
      });

      await recordExactPostedReview({
        workspaceId: wsId,
        recordId: admitted.draft.record.id,
        jobId: admitted.advanced.jobId,
        repo: admitted.repo,
        prNumber: 616,
        headSha: "9".repeat(40),
        acceptanceContractId: admitted.draft.contract.id,
        verdict: "not_proven",
      });
      summary = (await readAcceptanceRecordSummaries({ workspaceId: wsId }))
        .records.find((record) => record.recordId === admitted.draft.record.id)!;
      expect(summary.proof).toMatchObject({
        kind: "recorded",
        reviewJobId: admitted.advanced.jobId,
        verdict: "not_proven",
      });

      const unavailable = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "acceptance-summary-context-not-proven",
        prNumber: 617,
        headSha: "a".repeat(40),
      });
      await db.delete(acceptanceCompiledContextPacks)
        .where(eq(acceptanceCompiledContextPacks.id, unavailable.pack.id));
      const unavailableReason = "github exact-head source unavailable";
      await db.update(acceptanceContextPackSnapshots).set({
        status: "not_proven",
        baseSha: null,
        mergeBaseSha: null,
        headTreeSha: null,
        baseIndex: null,
        overlay: null,
        provenance: {
          schemaVersion: 1,
          included: [],
          excluded: [{ path: null, source: "overlay", reason: unavailableReason }],
        },
        reason: unavailableReason,
      }).where(eq(acceptanceContextPackSnapshots.id, unavailable.pack.sourceSnapshotId));
      summary = (await readAcceptanceRecordSummaries({ workspaceId: wsId }))
        .records.find((record) => record.recordId === unavailable.draft.record.id)!;
      expect(summary.suppliedContext).toMatchObject({
        kind: "not_proven",
        sourceSnapshot: { id: unavailable.pack.sourceSnapshotId },
      });

      const tampered = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "acceptance-summary-context-tampered",
        prNumber: 618,
        headSha: "b".repeat(40),
      });
      await db.update(acceptanceContextPackSnapshots).set({
        correctionPacketPayloadSetSha256: "0".repeat(64),
      }).where(eq(acceptanceContextPackSnapshots.id, tampered.pack.sourceSnapshotId));
      summary = (await readAcceptanceRecordSummaries({ workspaceId: wsId }))
        .records.find((record) => record.recordId === tampered.draft.record.id)!;
      expect(summary.suppliedContext).toEqual({ kind: "unknown" });
      expect(summary.unknownReasons).toContain("invalid_context_custody");

      const ambiguous = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "acceptance-summary-context-ambiguous",
        prNumber: 619,
        headSha: "c".repeat(40),
      });
      await db.delete(acceptanceCompiledContextPacks)
        .where(eq(acceptanceCompiledContextPacks.id, ambiguous.pack.id));
      const source = (await db.select().from(acceptanceContextPackSnapshots).where(
        eq(acceptanceContextPackSnapshots.id, ambiguous.pack.sourceSnapshotId)
      ).limit(1))[0]!;
      await recordAcceptanceContextPackSnapshot({
        workspaceId: source.workspaceId,
        recordId: source.recordId,
        reviewJobId: source.reviewJobId,
        acceptanceContractId: source.acceptanceContractId,
        acceptanceContractVersion: source.acceptanceContractVersion,
        acceptanceContractSha256: source.acceptanceContractSha256!,
        repo: source.repo,
        prNumber: source.prNumber,
        expectedHeadSha: source.expectedHeadSha,
        baseSha: source.baseSha,
        mergeBaseSha: source.mergeBaseSha,
        headTreeSha: source.headTreeSha,
        packetIds: source.packetIds,
        packetSetSha256: source.packetSetSha256,
        correctionPacketPayloadSetSha256: source.correctionPacketPayloadSetSha256!,
        compilerVersion: "acceptance-summary-second-source-v1",
        baseIndex: source.baseIndex as never,
        overlay: source.overlay as never,
        provenance: source.provenance as never,
        status: source.status as "admitted",
        reason: source.reason,
      });
      summary = (await readAcceptanceRecordSummaries({ workspaceId: wsId }))
        .records.find((record) => record.recordId === ambiguous.draft.record.id)!;
      expect(summary.suppliedContext).toEqual({ kind: "unknown" });
      expect(summary.unknownReasons).toContain("ambiguous_context_custody");
    });

    it("projects signed merge and post-merge evidence without inventing negative outcomes", async () => {
      const owner = await addAcceptanceDecisionActor(wsId, "owner");
      const ready = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId,
        workKey: "acceptance-summary-merged",
        prNumber: 612,
        headSha: "2".repeat(40),
        verdict: "proven",
      });
      await recordAcceptancePrDecision({
        workspaceId: wsId,
        recordId: ready.draft.record.id,
        bindingId: ready.binding.bindingId,
        decision: "approved",
        decidedBy: owner,
      });
      const mergeSha = "3".repeat(40);
      const merge = await recordSignedAcceptanceRecordMerge(signedMergeInput({
        workspaceId: wsId,
        recordId: ready.draft.record.id,
        repo: ready.repo,
        prNumber: 612,
        headSha: "2".repeat(40),
        deliveryId: "acceptance-summary-merged:delivery",
        mergeSha,
      }));
      if (merge.kind !== "recorded") throw new Error("expected signed merge summary fixture");
      await recordAcceptancePostMergeOutcome({
        workspaceId: wsId,
        recordId: ready.draft.record.id,
        recordedBy: owner,
        occurredAt: new Date("2026-08-11T10:05:00.000Z"),
        outcome: {
          kind: "deployed",
          revisionSha: mergeSha,
          environment: "production",
          deploymentReference: "deploy:acceptance-summary-merged",
        },
      });

      const result = await readAcceptanceRecordSummaries({ workspaceId: wsId, limit: 1 });
      const summary = result.records.find((record) => record.recordId === ready.draft.record.id);
      expect(summary).toMatchObject({
        pullRequest: {
          kind: "attached",
          prNumber: 612,
          head: {
            kind: "merged",
            sha: "2".repeat(40),
            headCycleId: ready.advanced.jobId,
          },
        },
        proof: { kind: "recorded", reviewJobId: ready.advanced.jobId, verdict: "proven" },
        neededDecision: { kind: "not_required", reason: "merged" },
        outcome: {
          kind: "signed_merge",
          mergeEventId: merge.mergeEventId,
          mergeSha,
          decisionAlignment: "aligned",
          postMerge: {
            deployment: "recorded",
            incident: "not_recorded",
            revert: "not_recorded",
          },
        },
      });
      expect(summary?.unknownReasons).toContain("context_not_recorded");
      expect(summary?.unknownReasons).not.toContain("outcome_not_recorded");
    });

    it("keeps same-SHA head occurrences distinct across A-to-B-to-A", async () => {
      const headA = "4".repeat(40);
      const headB = "5".repeat(40);
      const ready = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId,
        workKey: "acceptance-summary-a-b-a",
        prNumber: 613,
        headSha: headA,
        verdict: "proven",
      });
      const advancedB = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId,
        recordId: ready.draft.record.id,
        repo: ready.repo,
        prNumber: 613,
        headSha: headB,
        event: "synchronize",
        deliveryId: "acceptance-summary-a-b-a:b",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: headA, afterHeadSha: headB },
        source: "github_webhook",
      });
      if (advancedB.kind !== "advanced") throw new Error("expected B summary cycle");
      const advancedA2 = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId,
        recordId: ready.draft.record.id,
        repo: ready.repo,
        prNumber: 613,
        headSha: headA,
        event: "synchronize",
        deliveryId: "acceptance-summary-a-b-a:a2",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: headB, afterHeadSha: headA },
        source: "github_webhook",
      });
      if (advancedA2.kind !== "advanced") throw new Error("expected A2 summary cycle");
      await recordExactPostedReview({
        workspaceId: wsId,
        recordId: ready.draft.record.id,
        jobId: advancedA2.jobId,
        repo: ready.repo,
        prNumber: 613,
        headSha: headA,
        acceptanceContractId: ready.draft.contract.id,
        verdict: "failed",
      });

      const result = await readAcceptanceRecordSummaries({ workspaceId: wsId, limit: 1 });
      expect(result.records[0]).toMatchObject({
        recordId: ready.draft.record.id,
        pullRequest: {
          kind: "attached",
          head: {
            kind: "current",
            sha: headA,
            headCycleId: advancedA2.jobId,
          },
        },
        proof: { kind: "recorded", reviewJobId: advancedA2.jobId, verdict: "failed" },
      });
      expect(advancedA2.jobId).not.toBe(ready.advanced.jobId);
    });

    it("serializes a summary read with head advance without mixing cycle custody", async () => {
      const headA = "6".repeat(40);
      const headB = "7".repeat(40);
      const ready = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId,
        workKey: "acceptance-summary-head-race",
        prNumber: 614,
        headSha: headA,
        verdict: "proven",
      });
      const [readResult, advanced] = await Promise.all([
        readAcceptanceRecordSummaries({ workspaceId: wsId, limit: 1 }),
        advanceConfirmedAcceptanceRecordPullRequestHead({
          workspaceId: wsId,
          recordId: ready.draft.record.id,
          repo: ready.repo,
          prNumber: 614,
          headSha: headB,
          event: "synchronize",
          deliveryId: "acceptance-summary-head-race:b",
          admitReviewJob: true,
          headTransition: { beforeHeadSha: headA, afterHeadSha: headB },
          source: "github_webhook",
        }),
      ]);
      if (advanced.kind !== "advanced") throw new Error("expected raced B summary cycle");
      const summary = readResult.records[0]!;
      expect(summary.recordId).toBe(ready.draft.record.id);
      if (summary.pullRequest.kind !== "attached" || summary.pullRequest.head.kind === "unknown") {
        throw new Error("summary race must resolve one exact authoritative occurrence");
      }
      if (summary.pullRequest.head.headCycleId === ready.advanced.jobId) {
        expect(summary.pullRequest.head.sha).toBe(headA);
        expect(summary.proof).toMatchObject({
          kind: "recorded",
          reviewJobId: ready.advanced.jobId,
        });
      } else {
        expect(summary.pullRequest.head).toMatchObject({
          sha: headB,
          headCycleId: advanced.jobId,
        });
        expect(summary.proof).toEqual({ kind: "unknown" });
      }
    });

    it("detects a 257th relevant event instead of returning a truncated custody projection", async () => {
      const fixture = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "acceptance-summary-event-bound",
        prNumber: 615,
        headSha: "8".repeat(40),
      });
      await recordExactPostedReview({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        jobId: fixture.advanced.jobId,
        repo: fixture.repo,
        prNumber: 615,
        headSha: "8".repeat(40),
        acceptanceContractId: fixture.draft.contract.id,
        verdict: "proven",
      });
      await db.insert(changeRecordEvents).values(Array.from({ length: 254 }, (_, index) => ({
        id: randomUUID(),
        recordId: fixture.draft.record.id,
        eventKey: `review:correction:${fixture.advanced.jobId}:noise-${index}`,
        stage: "review",
        actor: "reviewer-of-record",
        payloadRef: { kind: "malformed_summary_noise", index },
      })));

      const atBound = (await readAcceptanceRecordSummaries({ workspaceId: wsId, limit: 1 })).records[0]!;
      expect(atBound.unknownReasons).not.toContain("summary_custody_limit");
      expect(atBound.proof).toMatchObject({
        kind: "recorded",
        reviewJobId: fixture.advanced.jobId,
      });
      expect(atBound.suppliedContext).toEqual({ kind: "unknown" });
      expect(atBound.unknownReasons).toContain("invalid_context_custody");

      await db.insert(changeRecordEvents).values({
        id: randomUUID(),
        recordId: fixture.draft.record.id,
        eventKey: `review:correction:${fixture.advanced.jobId}:noise-254`,
        stage: "review",
        actor: "reviewer-of-record",
        payloadRef: { kind: "malformed_summary_noise", index: 254 },
      });
      const overflow = (await readAcceptanceRecordSummaries({ workspaceId: wsId, limit: 1 })).records[0]!;
      expect(overflow.unknownReasons).toContain("summary_custody_limit");
      expect(overflow.proof).toEqual({ kind: "unknown" });
      expect(overflow.suppliedContext).toEqual({ kind: "unknown" });
      expect(overflow.neededDecision).toEqual({ kind: "unknown" });
      expect(overflow.outcome).toEqual({ kind: "unknown" });
    });

    it("reads full current Contract, Context Pack metadata, and exact correction proof without crossing tenants", async () => {
      const fixture = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "acceptance-record-detail-complete",
        prNumber: 621,
        headSha: "1".repeat(40),
      });
      const posted = await recordExactPostedReview({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        jobId: fixture.advanced.jobId,
        repo: fixture.repo,
        prNumber: 621,
        headSha: "1".repeat(40),
        acceptanceContractId: fixture.draft.contract.id,
        verdict: "failed",
      });

      const result = await readAcceptanceRecordDetail({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
      });
      if (result.kind !== "record") throw new Error(`expected detail record, got ${result.kind}`);
      expect(result.detail.contract).toMatchObject({
        identity: { id: fixture.draft.contract.id, version: 1 },
        confirmedBy: "console_user:user-1",
        contract: {
          originalRequest: "Add saved filters",
          acceptanceCriteria: [{ id: "AC-1", text: "A user can save a filter" }],
          unresolvedQuestions: [],
        },
      });
      expect(result.detail.pullRequest).toMatchObject({
        kind: "attached",
        current: {
          kind: "current",
          headSha: "1".repeat(40),
          headCycleId: fixture.advanced.jobId,
          reviewJob: { kind: "recorded", state: "posted" },
        },
        merged: null,
      });
      expect(result.detail.contextPacks).toHaveLength(1);
      const context = result.detail.contextPacks[0]!;
      expect(context).toMatchObject({
        occurrence: { kind: "current", headCycleId: fixture.advanced.jobId },
        sourceSnapshot: {
          status: "admitted",
          binding: {
            workspaceId: wsId,
            recordId: fixture.draft.record.id,
            acceptanceContract: { id: fixture.draft.contract.id, version: 1 },
          },
        },
      });
      expect(context.compiledPacks).toHaveLength(1);
      expect(context.compiledPacks[0]).toMatchObject({
        id: fixture.pack.id,
        manifest: {
          acceptanceCriterionIds: ["AC-1"],
          sourceCount: 2,
          custody: {
            fullSourceUploadAllowed: false,
            rawSourcePersisted: false,
            snippetsPersisted: false,
          },
        },
        sourceCustody: {
          kind: "exact_head_source_custody",
          schemaVersion: 2,
          headSha: "1".repeat(40),
          changedFileCount: 2,
          recordCount: 2,
          selectedExactRangeCount: 2,
        },
      });
      expect(context.compiledPacks[0]!.manifest.sources.every((source) =>
        !("content" in source) && !("body" in source)
      )).toBe(true);
      expect(context.compiledPacks[0]!.sourceCustody.records.every((record) =>
        !("content" in record)
      )).toBe(true);
      expect(result.detail.proofMatrix).toEqual([expect.objectContaining({
        occurrence: expect.objectContaining({ kind: "current", headCycleId: fixture.advanced.jobId }),
        review: expect.objectContaining({
          kind: "posted",
          verdict: "failed",
          postedAttestationEventId: posted.event.id,
        }),
        criteria: [expect.objectContaining({
          criterion: expect.objectContaining({ id: "AC-1" }),
          proof: expect.objectContaining({
            kind: "correction_packet",
            state: "failed",
            packet: expect.objectContaining({ jobId: fixture.advanced.jobId }),
          }),
        })],
      })]);
      expect(result.detail.artifactCustody).toEqual({
        kind: "unknown",
        reason: "artifact_custody_not_available",
      });
      expect(result.detail.gatedIssue).toEqual({
        kind: "unknown",
        reason: "gated_issue_custody_not_available",
      });

      const otherWorkspace = (await db.insert(workspaces).values({
        name: "acceptance detail tenant boundary",
        slug: `acceptance-detail-tenant-${randomUUID()}`,
      }).returning({ id: workspaces.id }))[0]!;
      try {
        await expect(readAcceptanceRecordDetail({
          workspaceId: otherWorkspace.id,
          recordId: fixture.draft.record.id,
        })).resolves.toEqual({ kind: "not_found" });
      } finally {
        await db.delete(workspaces).where(eq(workspaces.id, otherWorkspace.id));
      }
    });

    it("keeps all deterministic A-to-B-to-A occurrences distinct and occurrence-binds historical context", async () => {
      const headA = "2".repeat(40);
      const headB = "3".repeat(40);
      const fixture = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "acceptance-record-detail-a-b-a",
        prNumber: 622,
        headSha: headA,
      });
      await recordExactPostedReview({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        jobId: fixture.advanced.jobId,
        repo: fixture.repo,
        prNumber: 622,
        headSha: headA,
        acceptanceContractId: fixture.draft.contract.id,
        verdict: "failed",
      });
      const cycleB = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        repo: fixture.repo,
        prNumber: 622,
        headSha: headB,
        event: "synchronize",
        deliveryId: "acceptance-record-detail-a-b-a:b",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: headA, afterHeadSha: headB },
        source: "github_webhook",
      });
      if (cycleB.kind !== "advanced") throw new Error("expected B detail cycle");
      const cycleA2 = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        repo: fixture.repo,
        prNumber: 622,
        headSha: headA,
        event: "synchronize",
        deliveryId: "acceptance-record-detail-a-b-a:a2",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: headB, afterHeadSha: headA },
        source: "github_webhook",
      });
      if (cycleA2.kind !== "advanced") throw new Error("expected A2 detail cycle");

      const result = await readAcceptanceRecordDetail({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
      });
      if (result.kind !== "record" || result.detail.pullRequest.kind !== "attached") {
        throw new Error("expected attached A-B-A detail");
      }
      expect(result.detail.pullRequest.occurrences.map((occurrence) => ({
        kind: occurrence.kind,
        headSha: occurrence.headSha,
        headCycleId: occurrence.headCycleId,
      }))).toEqual([
        { kind: "current", headSha: headA, headCycleId: cycleA2.jobId },
        { kind: "historical", headSha: headB, headCycleId: cycleB.jobId },
        { kind: "historical", headSha: headA, headCycleId: fixture.advanced.jobId },
      ]);
      expect(cycleA2.jobId).not.toBe(fixture.advanced.jobId);
      expect(result.detail.contextPacks).toHaveLength(1);
      expect(result.detail.contextPacks[0]!.occurrence).toMatchObject({
        kind: "historical",
        headSha: headA,
        headCycleId: fixture.advanced.jobId,
      });
      expect(result.detail.proofMatrix.map((cycle) => cycle.occurrence.headCycleId))
        .toEqual([cycleA2.jobId, cycleB.jobId, fixture.advanced.jobId]);
    });

    it("projects an exact merged occurrence and fails closed on historical snapshot Contract drift", async () => {
      const owner = await addAcceptanceDecisionActor(wsId, "owner");
      const ready = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId,
        workKey: "acceptance-record-detail-merged",
        prNumber: 630,
        headSha: "c".repeat(40),
        verdict: "proven",
      });
      await recordAcceptancePrDecision({
        workspaceId: wsId,
        recordId: ready.draft.record.id,
        bindingId: ready.binding.bindingId,
        decision: "approved",
        decidedBy: owner,
      });
      const merge = await recordSignedAcceptanceRecordMerge(signedMergeInput({
        workspaceId: wsId,
        recordId: ready.draft.record.id,
        repo: ready.repo,
        prNumber: 630,
        headSha: "c".repeat(40),
        deliveryId: "acceptance-record-detail-merged:delivery",
        mergeSha: "d".repeat(40),
      }));
      if (merge.kind !== "recorded") throw new Error("expected detail merge fixture");
      const merged = await readAcceptanceRecordDetail({
        workspaceId: wsId,
        recordId: ready.draft.record.id,
      });
      if (merged.kind !== "record" || merged.detail.pullRequest.kind !== "attached") {
        throw new Error("expected merged detail record");
      }
      expect(merged.detail.pullRequest.current).toBeNull();
      expect(merged.detail.pullRequest.merged).toMatchObject({
        kind: "merged",
        headSha: "c".repeat(40),
        headCycleId: ready.advanced.jobId,
        mergeEventId: merge.mergeEventId,
        mergeSha: "d".repeat(40),
      });
      expect(merged.detail.pullRequest.occurrences[0]).toMatchObject({
        kind: "merged",
        headCycleId: ready.advanced.jobId,
      });

      const historical = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "acceptance-record-detail-historical-contract-drift",
        prNumber: 631,
        headSha: "e".repeat(40),
      });
      const advanced = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId,
        recordId: historical.draft.record.id,
        repo: historical.repo,
        prNumber: 631,
        headSha: "f".repeat(40),
        event: "synchronize",
        deliveryId: "acceptance-record-detail-historical-contract-drift:f",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: "e".repeat(40), afterHeadSha: "f".repeat(40) },
        source: "github_webhook",
      });
      if (advanced.kind !== "advanced") throw new Error("expected historical drift successor");
      await db.update(acceptanceContextPackSnapshots).set({
        acceptanceContractSha256: "0".repeat(64),
      }).where(eq(acceptanceContextPackSnapshots.id, historical.pack.sourceSnapshotId));
      await expect(readAcceptanceRecordDetail({
        workspaceId: wsId,
        recordId: historical.draft.record.id,
      })).resolves.toEqual({ kind: "unavailable", reason: "invalid_context_custody" });
    });

    it("fails closed for missing failed-review packets, forged packet event identity, and cross-workspace Pack custody", async () => {
      const missingPacket = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId,
        workKey: "acceptance-record-detail-missing-packet",
        prNumber: 623,
        headSha: "4".repeat(40),
        verdict: "failed",
      });
      await expect(readAcceptanceRecordDetail({
        workspaceId: wsId,
        recordId: missingPacket.draft.record.id,
      })).resolves.toEqual({ kind: "unavailable", reason: "invalid_review_custody" });

      const missingNotProvenPacket = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId,
        workKey: "acceptance-record-detail-missing-not-proven-packet",
        prNumber: 629,
        headSha: "b".repeat(40),
        verdict: "not_proven",
      });
      await expect(readAcceptanceRecordDetail({
        workspaceId: wsId,
        recordId: missingNotProvenPacket.draft.record.id,
      })).resolves.toEqual({ kind: "unavailable", reason: "invalid_review_custody" });

      const forgedEvent = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "acceptance-record-detail-forged-packet-event",
        prNumber: 624,
        headSha: "5".repeat(40),
      });
      await db.update(changeRecordEvents).set({ id: randomUUID() }).where(and(
        eq(changeRecordEvents.recordId, forgedEvent.draft.record.id),
        eq(changeRecordEvents.eventKey, `review:correction:${forgedEvent.advanced.jobId}:AC-1`),
      ));
      await expect(readAcceptanceRecordDetail({
        workspaceId: wsId,
        recordId: forgedEvent.draft.record.id,
      })).resolves.toEqual({ kind: "unavailable", reason: "invalid_review_custody" });

      const mismatchedPack = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "acceptance-record-detail-cross-workspace-pack",
        prNumber: 625,
        headSha: "6".repeat(40),
      });
      const otherWorkspace = (await db.insert(workspaces).values({
        name: "acceptance detail Pack tenant mismatch",
        slug: `acceptance-detail-pack-tenant-${randomUUID()}`,
      }).returning({ id: workspaces.id }))[0]!;
      await db.update(acceptanceCompiledContextPacks).set({
        workspaceId: otherWorkspace.id,
      }).where(eq(acceptanceCompiledContextPacks.id, mismatchedPack.pack.id));
      await expect(readAcceptanceRecordDetail({
        workspaceId: wsId,
        recordId: mismatchedPack.draft.record.id,
      })).resolves.toEqual({ kind: "unavailable", reason: "invalid_compiled_pack_custody" });
      await db.delete(workspaces).where(eq(workspaces.id, otherWorkspace.id));
    });

    it("bounds aggregate Pack metadata and serializes a detail read with head advance", async () => {
      const oversized = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "acceptance-record-detail-pack-bound",
        prNumber: 626,
        headSha: "7".repeat(40),
      });
      const storedPack = (await db.select().from(acceptanceCompiledContextPacks).where(
        eq(acceptanceCompiledContextPacks.id, oversized.pack.id)
      ).limit(1))[0]!;
      await db.insert(acceptanceCompiledContextPacks).values(Array.from({ length: 64 }, (_, index) => ({
        ...storedPack,
        id: randomUUID(),
        compilerVersion: `detail-bound-compiler-${index}`,
        policyVersion: `detail-bound-policy-${index}`,
        createdAt: new Date(Date.now() + index + 1),
      })));
      await expect(readAcceptanceRecordDetail({
        workspaceId: wsId,
        recordId: oversized.draft.record.id,
      })).resolves.toEqual({ kind: "unavailable", reason: "detail_output_limit" });

      const largeBoundaries = Array.from({ length: 45 }, (_, index) =>
        `${String(index).padStart(2, "0")}:${"bounded-context-metadata-".repeat(40)}`
      );
      const byteLimited = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "acceptance-record-detail-byte-bound",
        prNumber: 632,
        headSha: "0".repeat(40),
        contractOverrides: { nonGoals: largeBoundaries },
      });
      const sourceSnapshot = (await db.select().from(acceptanceContextPackSnapshots).where(
        eq(acceptanceContextPackSnapshots.id, byteLimited.pack.sourceSnapshotId)
      ).limit(1))[0]!;
      const sourcePack = (await db.select().from(acceptanceCompiledContextPacks).where(
        eq(acceptanceCompiledContextPacks.id, byteLimited.pack.id)
      ).limit(1))[0]!;
      const variantSnapshots = [sourceSnapshot];
      for (let snapshotIndex = 1; snapshotIndex < 7; snapshotIndex += 1) {
        const recorded = await recordAcceptanceContextPackSnapshot({
          workspaceId: sourceSnapshot.workspaceId,
          recordId: sourceSnapshot.recordId,
          reviewJobId: sourceSnapshot.reviewJobId,
          acceptanceContractId: sourceSnapshot.acceptanceContractId,
          acceptanceContractVersion: sourceSnapshot.acceptanceContractVersion,
          acceptanceContractSha256: sourceSnapshot.acceptanceContractSha256!,
          repo: sourceSnapshot.repo,
          prNumber: sourceSnapshot.prNumber,
          expectedHeadSha: sourceSnapshot.expectedHeadSha,
          baseSha: sourceSnapshot.baseSha,
          mergeBaseSha: sourceSnapshot.mergeBaseSha,
          headTreeSha: sourceSnapshot.headTreeSha,
          packetIds: sourceSnapshot.packetIds,
          packetSetSha256: sourceSnapshot.packetSetSha256,
          correctionPacketPayloadSetSha256: sourceSnapshot.correctionPacketPayloadSetSha256!,
          compilerVersion: `detail-byte-snapshot-${snapshotIndex}`,
          baseIndex: sourceSnapshot.baseIndex as never,
          overlay: sourceSnapshot.overlay as never,
          provenance: sourceSnapshot.provenance as never,
          status: "admitted",
          reason: null,
        });
        variantSnapshots.push(recorded.snapshot);
      }
      const variantRows = variantSnapshots.flatMap((snapshot, snapshotIndex) =>
        Array.from({ length: 8 }, (_, variantIndex) => {
          if (snapshotIndex === 0 && variantIndex === 0) return null;
          const compilerVersion = `detail-byte-compiler-${snapshotIndex}-${variantIndex}`;
          const policyVersion = `detail-byte-policy-${snapshotIndex}-${variantIndex}`;
          const binding = {
            ...sourcePack.binding,
            sourceSnapshotId: snapshot.id,
            sourceSnapshotCompilerVersion: snapshot.compilerVersion,
          };
          const compiler = {
            version: compilerVersion,
            policyVersion,
            byteCounter: "utf8_byte_upper_bound_v1",
            byteBudget: 65_536,
          };
          const core = {
            kind: "compiled_acceptance_context_pack",
            version: 1,
            binding,
            compiler,
            manifest: sourcePack.manifest,
            sourceCustodyReceipt: {
              kind: sourcePack.sourceCustodyReceipt["kind"],
              schemaVersion: sourcePack.sourceCustodyReceipt["schemaVersion"],
              identitySha256: sourcePack.sourceCustodyReceipt["identitySha256"],
            },
            exactHeadDependencyTreeProofs: sourcePack.exactHeadDependencyTreeProofs,
            representations: {
              jsonSha256: sourcePack.jsonSha256,
              markdownSha256: sourcePack.markdownSha256,
            },
            renderedByteCount: sourcePack.renderedByteCount,
          };
          return {
            id: acceptanceCompiledContextPackId({
              sourceSnapshotId: snapshot.id,
              compilerVersion,
              policyVersion,
            }),
            workspaceId: sourcePack.workspaceId,
            sourceSnapshotId: snapshot.id,
            compilerVersion,
            policyVersion,
            packSha256: acceptanceContextPackCanonicalSha256(core),
            sourceCustodyIdentitySha256: sourcePack.sourceCustodyIdentitySha256,
            jsonSha256: sourcePack.jsonSha256,
            markdownSha256: sourcePack.markdownSha256,
            renderedByteCount: sourcePack.renderedByteCount,
            binding,
            manifest: sourcePack.manifest,
            sourceCustodyReceipt: sourcePack.sourceCustodyReceipt,
            exactHeadDependencyTreeProofs: sourcePack.exactHeadDependencyTreeProofs,
            createdAt: new Date(Date.now() + snapshotIndex * 10 + variantIndex),
          };
        }).filter((row): row is NonNullable<typeof row> => row !== null)
      );
      expect(variantRows).toHaveLength(55);
      await db.insert(acceptanceCompiledContextPacks).values(variantRows);
      const persistedVariantCount = await db.select({ id: acceptanceCompiledContextPacks.id })
        .from(acceptanceCompiledContextPacks).where(inArray(
          acceptanceCompiledContextPacks.sourceSnapshotId,
          variantSnapshots.map((snapshot) => snapshot.id),
        ));
      expect(persistedVariantCount).toHaveLength(56);
      await expect(readAcceptanceRecordDetail({
        workspaceId: wsId,
        recordId: byteLimited.draft.record.id,
      })).resolves.toEqual({ kind: "unavailable", reason: "detail_output_limit" });

      const headA = "8".repeat(40);
      const headB = "9".repeat(40);
      const raced = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "acceptance-record-detail-head-race",
        prNumber: 627,
        headSha: headA,
      });
      const [readResult, advanced] = await Promise.all([
        readAcceptanceRecordDetail({ workspaceId: wsId, recordId: raced.draft.record.id }),
        advanceConfirmedAcceptanceRecordPullRequestHead({
          workspaceId: wsId,
          recordId: raced.draft.record.id,
          repo: raced.repo,
          prNumber: 627,
          headSha: headB,
          event: "synchronize",
          deliveryId: "acceptance-record-detail-head-race:b",
          admitReviewJob: true,
          headTransition: { beforeHeadSha: headA, afterHeadSha: headB },
          source: "github_webhook",
        }),
      ]);
      if (advanced.kind !== "advanced" || readResult.kind !== "record"
        || readResult.detail.pullRequest.kind !== "attached") {
        throw new Error("expected coherent detail/head-advance race");
      }
      const current = readResult.detail.pullRequest.current;
      if (!current) throw new Error("detail race must expose one current cycle");
      if (current.headCycleId === raced.advanced.jobId) {
        expect(current.headSha).toBe(headA);
        expect(readResult.detail.contextPacks[0]!.occurrence.kind).toBe("current");
        expect(readResult.detail.summary.pullRequest).toMatchObject({
          head: { kind: "current", sha: headA, headCycleId: raced.advanced.jobId },
        });
      } else {
        expect(current).toMatchObject({ headSha: headB, headCycleId: advanced.jobId });
        expect(readResult.detail.contextPacks[0]!.occurrence).toMatchObject({
          kind: "historical",
          headSha: headA,
          headCycleId: raced.advanced.jobId,
        });
        expect(readResult.detail.summary.pullRequest).toMatchObject({
          head: { kind: "current", sha: headB, headCycleId: advanced.jobId },
        });
      }
    });

    it("ignores a generic legacy criterion timeline payload as proof authority", async () => {
      const ready = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId,
        workKey: "acceptance-record-detail-legacy-proof",
        prNumber: 628,
        headSha: "a".repeat(40),
        verdict: "proven",
      });
      await appendChangeRecordEvent({
        recordId: ready.draft.record.id,
        eventKey: `review:posted:${ready.advanced.jobId}`,
        stage: "review",
        actor: "reviewer-of-record",
        payloadRef: {
          kind: "legacy_review_posted",
          criterionResults: [{ criterionId: "AC-1", state: "proven" }],
        },
      });
      const result = await readAcceptanceRecordDetail({
        workspaceId: wsId,
        recordId: ready.draft.record.id,
      });
      if (result.kind !== "record") throw new Error("expected legacy-proof detail");
      expect(result.detail.proofMatrix[0]!.criteria).toEqual([
        expect.objectContaining({
          criterion: expect.objectContaining({ id: "AC-1" }),
          proof: {
            kind: "unknown",
            reason: "criterion_result_not_durably_rederivable",
          },
        }),
      ]);
    });

    it("executes the exact 0088 legacy-preview teardown statement against Postgres", async () => {
      const migration = await readFile(new URL(
        "../../drizzle/migrations/0088_change_records_current_pr_head.sql",
        import.meta.url
      ), "utf8");
      const start = migration.indexOf('UPDATE "preview_boots"');
      const end = migration.indexOf(";", start);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      const teardownStatement = migration.slice(start, end + 1);

      await db.transaction(async (tx) => {
        await tx.execute(sql`
          CREATE TEMP TABLE "preview_boots" (
            id text PRIMARY KEY,
            status text NOT NULL,
            reason text,
            updated_at timestamptz NOT NULL DEFAULT now()
          ) ON COMMIT DROP
        `);
        await tx.execute(sql`
          INSERT INTO "preview_boots" (id, status) VALUES
            ('pending', 'pending'),
            ('claimed', 'claimed'),
            ('booting', 'booting'),
            ('ready', 'ready'),
            ('failed', 'failed')
        `);
        await tx.execute(sql.raw(teardownStatement));
        const rows = Array.from(await tx.execute(sql`
          SELECT id, status, reason FROM "preview_boots" ORDER BY id
        `)) as Array<{ id: string; status: string; reason: string | null }>;
        const activeBeforeMigration = rows.filter((row) => row.id !== "failed");
        expect(activeBeforeMigration).toHaveLength(4);
        expect(activeBeforeMigration.every((row) =>
          row.status === "torn_down"
          && row.reason === "current Acceptance Record cycle unavailable after migration"
        )).toBe(true);
        expect(rows.find((row) => row.id === "failed")).toMatchObject({
          status: "failed", reason: null,
        });
      });
    });

    it("find-or-create is deterministic and idempotent for an issue anchor", async () => {
      const first = await findOrCreateChangeRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        issueNumber: 123,
        headShas: ["sha-b", "sha-a", "sha-a"],
      });
      expect(first.id).toBe(
        changeRecordId({
          workspaceId: wsId,
          repo: "acme/widgets",
          issueNumber: 123,
        })
      );
      expect(first.issueNumber).toBe(123);
      expect(first.prNumber).toBeNull();
      expect(first.headShas).toEqual(["sha-a", "sha-b"]);

      const second = await findOrCreateChangeRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        issueNumber: 123,
        headShas: ["sha-c"],
      });
      expect(second.id).toBe(first.id);
      expect(second.headShas).toEqual(["sha-a", "sha-b", "sha-c"]);
    });

    it("attaches only a confirmed Acceptance Record to one exact external PR head", async () => {
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        workKey: "external-pr-attachment",
        originChannel: "codex_mcp",
        contract: completeContract(),
        createdBy: "user:lead",
      });
      const input = {
        workspaceId: wsId,
        recordId: draft.record.id,
        repo: "acme/widgets",
        prNumber: 42,
        headSha: "abc123def4567890",
        source: "github_webhook" as const,
        prUrl: "https://github.com/acme/widgets/pull/42",
      };
      await expect(attachConfirmedAcceptanceRecordToExternalPullRequest(input)).resolves.toEqual({
        kind: "not_confirmed",
      });

      await db
        .update(acceptanceContracts)
        .set({ status: "confirmed", confirmedBy: "console_user:user-1", confirmedAt: new Date() })
        .where(eq(acceptanceContracts.id, draft.contract.id));

      const attached = await attachConfirmedAcceptanceRecordToExternalPullRequest(input);
      expect(attached).toMatchObject({
        kind: "attached",
        inserted: true,
        record: {
          id: draft.record.id,
          prNumber: 42,
          currentPrHeadSha: null,
          currentPrHeadAuthoritative: false,
          headShas: ["abc123def4567890"],
        },
      });
      await expect(attachConfirmedAcceptanceRecordToExternalPullRequest(input)).resolves.toMatchObject({
        kind: "attached",
        inserted: false,
      });
      await expect(readChangeRecordByPr({
        workspaceId: wsId, repo: "acme/widgets", prNumber: 42,
      })).resolves.toMatchObject({ id: draft.record.id, prNumber: 42 });
      await expect(readChangeRecordByPr({
        workspaceId: randomUUID(), repo: "acme/widgets", prNumber: 42,
      })).resolves.toBeNull();
      await expect(attachConfirmedAcceptanceRecordToExternalPullRequest({
        ...input,
        headSha: "def456abc1237890",
      })).resolves.toEqual({ kind: "head_advance_required" });

      const other = await createDraftAcceptanceRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        workKey: "other-external-pr-attachment",
        originChannel: "codex_mcp",
        contract: completeContract(),
        createdBy: "user:lead",
      });
      await db
        .update(acceptanceContracts)
        .set({ status: "confirmed", confirmedBy: "console_user:user-1", confirmedAt: new Date() })
        .where(eq(acceptanceContracts.id, other.contract.id));
      await expect(
        attachConfirmedAcceptanceRecordToExternalPullRequest({ ...input, recordId: other.record.id })
      ).resolves.toEqual({ kind: "already_attached" });
    });

    it("advances one confirmed PR head atomically and invalidates queued and running older heads", async () => {
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        workKey: "atomic-pr-head-advance",
        originChannel: "codex_mcp",
        contract: completeContract(),
        createdBy: "user:lead",
      });
      await db.update(acceptanceContracts).set({
        status: "confirmed", confirmedBy: "console_user:user-1", confirmedAt: new Date(),
      }).where(eq(acceptanceContracts.id, draft.contract.id));

      const firstHead = "a".repeat(40);
      const secondHead = "b".repeat(40);
      const first = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 44,
        headSha: firstHead, event: "opened", deliveryId: "delivery-head-a",
        admitReviewJob: true,
        headTransition: null,
        source: "github_webhook", prUrl: "https://github.com/acme/widgets/pull/44",
      });
      expect(first).toMatchObject({
        kind: "advanced", jobAdmitted: true, deduped: false, superseded: 0,
        previousHeadSha: null, headChanged: true,
        record: {
          currentPrHeadSha: firstHead,
          currentPrHeadAuthoritative: true,
          headShas: [firstHead],
        },
      });
      if (first.kind !== "advanced") throw new Error("expected first head advance");
      await db.update(reviewJobs).set({ state: "running", claimedBy: "worker:one", claimedAt: new Date() })
        .where(eq(reviewJobs.id, first.jobId));

      const secondInput = {
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 44,
        headSha: secondHead, event: "synchronize" as const, deliveryId: "delivery-head-b",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: firstHead, afterHeadSha: secondHead },
        source: "github_webhook" as const, prUrl: "https://github.com/acme/widgets/pull/44",
      };
      const second = await advanceConfirmedAcceptanceRecordPullRequestHead(secondInput);
      expect(second).toMatchObject({
        kind: "advanced", jobAdmitted: true, deduped: false, superseded: 1,
        previousHeadSha: firstHead, headChanged: true,
        record: { currentPrHeadSha: secondHead, headShas: [firstHead, secondHead] },
      });
      expect((await db.select().from(reviewJobs).where(eq(reviewJobs.id, first.jobId)))[0]?.state)
        .toBe("superseded");

      const replay = await advanceConfirmedAcceptanceRecordPullRequestHead(secondInput);
      expect(replay).toMatchObject({
        kind: "delivery_replayed", currentHeadSha: secondHead,
        currentHeadCycleId: second.kind === "advanced" ? second.jobId : "missing",
        currentAuthoritative: true, authorityGeneration: 2,
      });
      const provenance = await db.select().from(changeRecordEvents)
        .where(eq(changeRecordEvents.recordId, draft.record.id));
      expect(provenance).toEqual(expect.arrayContaining([
        expect.objectContaining({
          eventKey: `external-pr:attached:44:${first.jobId}`,
          payloadRef: expect.objectContaining({
            kind: "external_pr_attachment", previousHeadSha: null,
            event: "opened", deliveryId: "delivery-head-a",
          }),
        }),
        expect.objectContaining({
          eventKey: `external-pr:head-advanced:44:${second.kind === "advanced" ? second.jobId : "missing"}`,
          payloadRef: expect.objectContaining({
            kind: "external_pr_head_advanced", previousHeadSha: firstHead,
            event: "synchronize", deliveryId: "delivery-head-b",
          }),
        }),
      ]));
      expect(provenance.filter((event) =>
        event.eventKey === `external-pr:head-advanced:44:${second.kind === "advanced" ? second.jobId : "missing"}`
      )).toHaveLength(1);

      const delayedOldHead = await advanceConfirmedAcceptanceRecordPullRequestHead({
        ...secondInput,
        headSha: firstHead,
        deliveryId: "delivery-delayed-old-head",
        headTransition: { beforeHeadSha: "9".repeat(40), afterHeadSha: firstHead },
      });
      expect(delayedOldHead).toMatchObject({
        kind: "stale_delivery", superseded: 1, previewBootsTornDown: 0,
      });
      expect((await db.select().from(changeRecords).where(eq(changeRecords.id, draft.record.id)))[0])
        .toMatchObject({
          currentPrHeadSha: secondHead,
          currentPrHeadAuthoritative: false,
          headShas: [firstHead, secondHead],
        });
      if (second.kind !== "advanced") throw new Error("expected second head advance");
      expect((await db.select().from(reviewJobs).where(eq(reviewJobs.id, second.jobId)))[0]?.state)
        .toBe("superseded");
      const heldEvents = await db.select().from(changeRecordEvents).where(
        eq(changeRecordEvents.recordId, draft.record.id)
      );
      expect(heldEvents).toEqual(expect.arrayContaining([expect.objectContaining({
        eventKey: "external-pr:head-transition-held:44:delivery-delayed-old-head",
        payloadRef: {
          kind: "external_pr_head_transition_held",
          currentHeadSha: secondHead,
          currentHeadCycleId: second.jobId,
          authorityGenerationBefore: 2,
          authorityGenerationAfter: 3,
          observedHeadSha: firstHead,
          event: "synchronize",
          deliveryId: "delivery-delayed-old-head",
          headTransition: { beforeHeadSha: "9".repeat(40), afterHeadSha: firstHead },
          acceptanceContractVersion: 1,
        },
      })]));
      await expect(advanceConfirmedAcceptanceRecordPullRequestHead({
        ...secondInput,
        event: "ready_for_review",
        deliveryId: "delivery-blocked-same-head-ready",
        headTransition: null,
      })).resolves.toMatchObject({
        kind: "stale_delivery", superseded: 0, previewBootsTornDown: 0,
      });
      expect((await db.select().from(changeRecords).where(eq(changeRecords.id, draft.record.id)))[0])
        .toMatchObject({ currentPrHeadSha: secondHead, currentPrHeadAuthoritative: false });
    });

    it("reconciles only its blocked authority generation and never replays an old delivery over the new head", async () => {
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId, repo: "acme/widgets", workKey: "reconcile-authority-generation",
        originChannel: "codex_mcp", contract: completeContract(), createdBy: "user:lead",
      });
      await db.update(acceptanceContracts).set({
        status: "confirmed", confirmedBy: "console_user:user-1", confirmedAt: new Date(),
      }).where(eq(acceptanceContracts.id, draft.contract.id));
      const headA = "a".repeat(40);
      const headB = "b".repeat(40);
      const headC = "c".repeat(40);
      const initial = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 145,
        headSha: headA, event: "opened", deliveryId: "reconcile-open-a", admitReviewJob: true,
        headTransition: null, source: "github_webhook",
      });
      if (initial.kind !== "advanced") throw new Error("expected initial head");
      const heldInput = {
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 145,
        headSha: headB, event: "synchronize" as const, deliveryId: "reconcile-held-b", admitReviewJob: true,
        headTransition: { beforeHeadSha: "d".repeat(40), afterHeadSha: headB }, source: "github_webhook" as const,
      };
      const held = await advanceConfirmedAcceptanceRecordPullRequestHead(heldInput);
      expect(held).toMatchObject({
        kind: "stale_delivery", blockedHeadSha: headA, blockedCycleId: initial.jobId,
        authorityGeneration: 2, replayed: false,
      });
      if (held.kind !== "stale_delivery") throw new Error("expected held delivery");
      await expect(advanceConfirmedAcceptanceRecordPullRequestHead(heldInput)).resolves.toMatchObject({
        kind: "stale_delivery", replayed: true, blockedHeadSha: headA,
        authorityGeneration: 2, superseded: 0, previewBootsTornDown: 0,
      });
      await db.update(changeRecordEvents).set({ actor: "corrupt:out-of-band" }).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey, "external-pr:head-transition-held:145:reconcile-held-b"),
      ));
      await expect(advanceConfirmedAcceptanceRecordPullRequestHead(heldInput)).resolves.toMatchObject({
        kind: "delivery_replayed", currentHeadSha: headA,
        currentHeadCycleId: initial.jobId, currentAuthoritative: false, authorityGeneration: 2,
      });
      await db.update(changeRecordEvents).set({ actor: "github_webhook" }).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey, "external-pr:head-transition-held:145:reconcile-held-b"),
      ));

      const reconciled = await reconcileConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 145,
        expectedBlockedHeadSha: held.blockedHeadSha,
        expectedBlockedCycleId: held.blockedCycleId!,
        expectedBlockedAuthorityGeneration: held.authorityGeneration,
        observedHeadSha: headC, observedBaseSha: "e".repeat(40), observedState: "open",
        observedDraft: false, observedMerged: false, source: "github_app_api",
      });
      expect(reconciled).toMatchObject({
        kind: "reconciled", observedHeadSha: headC, jobAdmitted: true,
        authorityGeneration: 3, record: { currentPrHeadSha: headC, currentPrHeadAuthoritative: true },
      });
      await expect(reconcileConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 145,
        expectedBlockedHeadSha: held.blockedHeadSha,
        expectedBlockedCycleId: held.blockedCycleId!,
        expectedBlockedAuthorityGeneration: held.authorityGeneration,
        observedHeadSha: headC, observedBaseSha: "e".repeat(40), observedState: "open",
        observedDraft: false, observedMerged: false, source: "github_app_api",
      })).resolves.toMatchObject({ kind: "already_current", jobAdmitted: true, authorityGeneration: 3 });
      const replay = await advanceConfirmedAcceptanceRecordPullRequestHead(heldInput);
      expect(replay).toMatchObject({
        kind: "delivery_replayed", currentHeadSha: headC, currentAuthoritative: true, authorityGeneration: 3,
      });
    });

    it("does not let a replayed terminal delivery revoke a later reconciled head", async () => {
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId, repo: "acme/widgets", workKey: "terminal-delivery-replay",
        originChannel: "codex_mcp", contract: completeContract(), createdBy: "user:lead",
      });
      await db.update(acceptanceContracts).set({
        status: "confirmed", confirmedBy: "console_user:user-1", confirmedAt: new Date(),
      }).where(eq(acceptanceContracts.id, draft.contract.id));
      const headA = "1".repeat(40);
      const headC = "3".repeat(40);
      const initial = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 146,
        headSha: headA, event: "opened", deliveryId: "terminal-open-a", admitReviewJob: true,
        headTransition: null, source: "github_webhook",
      });
      if (initial.kind !== "advanced") throw new Error("expected initial head");
      const terminalInput = {
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 146,
        headSha: headA, event: "closed" as const, deliveryId: "terminal-close-a", source: "github_webhook" as const,
      };
      const terminal = await invalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEvent(terminalInput);
      expect(terminal).toMatchObject({ kind: "invalidated", inserted: true, authorityGeneration: 2 });
      const reconciled = await reconcileConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 146,
        expectedBlockedHeadSha: headA, expectedBlockedCycleId: initial.jobId,
        expectedBlockedAuthorityGeneration: 2,
        observedHeadSha: headC, observedBaseSha: "4".repeat(40), observedState: "open",
        observedDraft: false, observedMerged: false, source: "github_app_api",
      });
      expect(reconciled).toMatchObject({ kind: "reconciled", authorityGeneration: 3 });
      await expect(invalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEvent(terminalInput))
        .resolves.toMatchObject({
          kind: "invalidated", inserted: false, currentHeadSha: headC,
          currentAuthoritative: true, authorityGeneration: 3,
        });
    });

    it("accepts a draft reconciliation retry after a signed ready event admits its same cycle", async () => {
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId, repo: "acme/widgets", workKey: "reconcile-draft-ready-retry",
        originChannel: "codex_mcp", contract: completeContract(), createdBy: "user:lead",
      });
      await db.update(acceptanceContracts).set({
        status: "confirmed", confirmedBy: "console_user:user-1", confirmedAt: new Date(),
      }).where(eq(acceptanceContracts.id, draft.contract.id));
      const headA = "a".repeat(40);
      const headC = "c".repeat(40);
      const initial = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 149,
        headSha: headA, event: "opened", deliveryId: "draft-reconcile-open", admitReviewJob: true,
        headTransition: null, source: "github_webhook",
      });
      if (initial.kind !== "advanced") throw new Error("expected initial head");
      const held = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 149,
        headSha: "b".repeat(40), event: "synchronize", deliveryId: "draft-reconcile-held", admitReviewJob: false,
        headTransition: { beforeHeadSha: "d".repeat(40), afterHeadSha: "b".repeat(40) }, source: "github_webhook",
      });
      if (held.kind !== "stale_delivery") throw new Error("expected held delivery");
      const reconcileInput = {
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 149,
        expectedBlockedHeadSha: held.blockedHeadSha,
        expectedBlockedCycleId: held.blockedCycleId!,
        expectedBlockedAuthorityGeneration: held.authorityGeneration,
        observedHeadSha: headC, observedBaseSha: "e".repeat(40), observedState: "open" as const,
        observedDraft: true, observedMerged: false, source: "github_app_api" as const,
      };
      const reconciled = await reconcileConfirmedAcceptanceRecordPullRequestHead(reconcileInput);
      expect(reconciled).toMatchObject({ kind: "reconciled", jobAdmitted: false });
      const ready = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 149,
        headSha: headC, event: "ready_for_review", deliveryId: "draft-reconcile-ready", admitReviewJob: true,
        headTransition: null, source: "github_webhook",
      });
      expect(ready).toMatchObject({ kind: "advanced", jobAdmitted: true, headChanged: false });
      await expect(reconcileConfirmedAcceptanceRecordPullRequestHead(reconcileInput)).resolves.toMatchObject({
        kind: "already_current", jobAdmitted: true, authorityGeneration: 3,
      });
    });

    it("rejects an API reconciliation when a later signed delivery advanced the blocked generation", async () => {
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId, repo: "acme/widgets", workKey: "reconcile-generation-race",
        originChannel: "codex_mcp", contract: completeContract(), createdBy: "user:lead",
      });
      await db.update(acceptanceContracts).set({
        status: "confirmed", confirmedBy: "console_user:user-1", confirmedAt: new Date(),
      }).where(eq(acceptanceContracts.id, draft.contract.id));
      const headA = "5".repeat(40);
      const initial = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 147,
        headSha: headA, event: "opened", deliveryId: "race-open-a", admitReviewJob: true,
        headTransition: null, source: "github_webhook",
      });
      if (initial.kind !== "advanced") throw new Error("expected initial head");
      const firstHeld = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 147,
        headSha: "6".repeat(40), event: "synchronize", deliveryId: "race-held-b", admitReviewJob: true,
        headTransition: { beforeHeadSha: "7".repeat(40), afterHeadSha: "6".repeat(40) }, source: "github_webhook",
      });
      if (firstHeld.kind !== "stale_delivery") throw new Error("expected first held delivery");
      await expect(advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 147,
        headSha: "8".repeat(40), event: "synchronize", deliveryId: "race-later-held-c", admitReviewJob: true,
        headTransition: { beforeHeadSha: "9".repeat(40), afterHeadSha: "8".repeat(40) }, source: "github_webhook",
      })).resolves.toMatchObject({ kind: "stale_delivery", authorityGeneration: 3 });
      await expect(reconcileConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 147,
        expectedBlockedHeadSha: firstHeld.blockedHeadSha,
        expectedBlockedCycleId: firstHeld.blockedCycleId!,
        expectedBlockedAuthorityGeneration: firstHeld.authorityGeneration,
        observedHeadSha: "a".repeat(40), observedBaseSha: "b".repeat(40), observedState: "open",
        observedDraft: false, observedMerged: false, source: "github_app_api",
      })).resolves.toMatchObject({
        kind: "blocked_precondition_changed", currentHeadSha: headA,
        currentAuthoritative: false, authorityGeneration: 3,
      });
      expect((await db.select().from(changeRecords).where(eq(changeRecords.id, draft.record.id)))[0])
        .toMatchObject({ currentPrHeadSha: headA, currentPrHeadAuthoritative: false, currentPrHeadAuthorityGeneration: 3 });
    });

    it("persists a closed GitHub reconciliation once and keeps its authority revoked on replay", async () => {
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId, repo: "acme/widgets", workKey: "reconcile-closed-replay",
        originChannel: "codex_mcp", contract: completeContract(), createdBy: "user:lead",
      });
      await db.update(acceptanceContracts).set({
        status: "confirmed", confirmedBy: "console_user:user-1", confirmedAt: new Date(),
      }).where(eq(acceptanceContracts.id, draft.contract.id));
      const headA = "a".repeat(40);
      const initial = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 148,
        headSha: headA, event: "opened", deliveryId: "closed-reconcile-open", admitReviewJob: true,
        headTransition: null, source: "github_webhook",
      });
      if (initial.kind !== "advanced") throw new Error("expected initial head");
      const held = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 148,
        headSha: "b".repeat(40), event: "synchronize", deliveryId: "closed-reconcile-held", admitReviewJob: true,
        headTransition: { beforeHeadSha: "c".repeat(40), afterHeadSha: "b".repeat(40) }, source: "github_webhook",
      });
      if (held.kind !== "stale_delivery") throw new Error("expected held delivery");
      const closedInput = {
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 148,
        expectedBlockedHeadSha: held.blockedHeadSha,
        expectedBlockedCycleId: held.blockedCycleId!,
        expectedBlockedAuthorityGeneration: held.authorityGeneration,
        observedHeadSha: "d".repeat(40), observedBaseSha: "e".repeat(40), observedState: "closed" as const,
        observedDraft: false, observedMerged: true, source: "github_app_api" as const,
      };
      await expect(reconcileConfirmedAcceptanceRecordPullRequestHead(closedInput)).resolves.toMatchObject({
        kind: "closed", currentHeadSha: headA, currentAuthoritative: false, authorityGeneration: 3,
      });
      await expect(reconcileConfirmedAcceptanceRecordPullRequestHead(closedInput)).resolves.toMatchObject({
        kind: "closed", currentHeadSha: headA, currentAuthoritative: false,
        authorityGeneration: 3, superseded: 0, previewBootsTornDown: 0,
      });
      const events = await db.select().from(changeRecordEvents).where(eq(changeRecordEvents.recordId, draft.record.id));
      expect(events.filter((event) => event.payloadRef.kind === "external_pr_head_reconciliation_closed")).toHaveLength(1);
    });

    it("invalidates a draft synchronize without admitting work, then admits the same head when ready", async () => {
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId, repo: "acme/widgets", workKey: "draft-head-invalidation",
        originChannel: "codex_mcp", contract: completeContract(), createdBy: "user:lead",
      });
      await db.update(acceptanceContracts).set({
        status: "confirmed", confirmedBy: "console_user:user-1", confirmedAt: new Date(),
      }).where(eq(acceptanceContracts.id, draft.contract.id));
      const firstHead = "1".repeat(40);
      const draftHead = "2".repeat(40);
      const first = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 46,
        headSha: firstHead, event: "opened", deliveryId: "delivery-before-draft",
        admitReviewJob: true, headTransition: null, source: "github_webhook",
      });
      if (first.kind !== "advanced") throw new Error("expected initial review admission");
      await db.update(reviewJobs).set({ state: "running", claimedBy: "worker:draft", claimedAt: new Date() })
        .where(eq(reviewJobs.id, first.jobId));

      const draftInput = {
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 46,
        headSha: draftHead, event: "synchronize" as const, deliveryId: "delivery-draft-head",
        admitReviewJob: false,
        headTransition: { beforeHeadSha: firstHead, afterHeadSha: draftHead },
        source: "github_webhook" as const,
      };
      const advancedDraft = await advanceConfirmedAcceptanceRecordPullRequestHead(draftInput);
      expect(advancedDraft).toMatchObject({
        kind: "advanced", jobAdmitted: false, deduped: false, superseded: 1,
        previousHeadSha: firstHead, headChanged: true,
        record: { currentPrHeadSha: draftHead, currentPrHeadAuthoritative: true },
      });
      if (advancedDraft.kind !== "advanced") throw new Error("expected draft head advance");
      expect(await db.select().from(reviewJobs).where(eq(reviewJobs.id, advancedDraft.jobId)))
        .toHaveLength(0);
      await expect(advanceConfirmedAcceptanceRecordPullRequestHead(draftInput)).resolves.toMatchObject({
        kind: "delivery_replayed", currentHeadSha: draftHead,
        currentHeadCycleId: advancedDraft.jobId,
        currentAuthoritative: true, authorityGeneration: 2,
      });

      const readyInput = {
        ...draftInput,
        event: "ready_for_review" as const,
        deliveryId: "delivery-ready-head",
        admitReviewJob: true,
        headTransition: null,
      };
      const ready = await advanceConfirmedAcceptanceRecordPullRequestHead(readyInput);
      expect(ready).toMatchObject({
        kind: "advanced", jobAdmitted: true, deduped: false, superseded: 0,
        previousHeadSha: draftHead, headChanged: false,
      });
      if (ready.kind !== "advanced") throw new Error("expected ready review admission");
      expect((await db.select().from(reviewJobs).where(eq(reviewJobs.id, ready.jobId)))[0])
        .toMatchObject({ headSha: draftHead, event: "ready_for_review", state: "queued" });
      await expect(advanceConfirmedAcceptanceRecordPullRequestHead(readyInput)).resolves.toMatchObject({
        kind: "delivery_replayed", currentHeadSha: draftHead,
        currentHeadCycleId: advancedDraft.jobId,
        currentAuthoritative: true, authorityGeneration: 2,
      });
    });

    it("atomically revokes exact-head authority and active work on a signed merged delivery", async () => {
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId, repo: "acme/widgets", workKey: "terminal-head-invalidation",
        originChannel: "codex_mcp", contract: completeContract(), createdBy: "user:lead",
      });
      await db.update(acceptanceContracts).set({
        status: "confirmed", confirmedBy: "console_user:user-1", confirmedAt: new Date(),
      }).where(eq(acceptanceContracts.id, draft.contract.id));
      const currentHead = "d".repeat(40);
      const observedMergeHead = "e".repeat(40);
      const advanced = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 43,
        headSha: currentHead, event: "opened", deliveryId: "terminal-before-merge",
        admitReviewJob: true, headTransition: null, source: "github_webhook",
      });
      if (advanced.kind !== "advanced") throw new Error("expected terminal test head admission");
      await db.update(reviewJobs).set({ state: "running" }).where(eq(reviewJobs.id, advanced.jobId));
      const boot = await enqueueCurrentReviewJobPreviewBoot({
        workspaceId: wsId, recordId: draft.record.id, jobId: advanced.jobId,
        repo: "acme/widgets", prNumber: 43, headSha: currentHead, ref: "refs/pull/43/head",
      });
      await db.update(previewBoots).set({
        status: "ready", url: "http://terminal-preview.test", port: 3100,
      }).where(eq(previewBoots.id, boot.id));

      const input = {
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 43,
        headSha: observedMergeHead, event: "merged" as const,
        deliveryId: "terminal-merged-delivery", source: "github_webhook" as const,
      };
      const invalidated = await invalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEvent(input);
      expect(invalidated).toMatchObject({
        kind: "invalidated", inserted: true, superseded: 1, previewBootsTornDown: 1,
        currentHeadSha: currentHead, currentHeadCycleId: advanced.jobId,
      });
      expect((await db.select().from(changeRecords).where(eq(changeRecords.id, draft.record.id)))[0])
        .toMatchObject({
          currentPrHeadSha: currentHead,
          currentPrHeadCycleId: advanced.jobId,
          currentPrHeadAuthoritative: false,
          headShas: [currentHead],
        });
      expect((await db.select().from(reviewJobs).where(eq(reviewJobs.id, advanced.jobId)))[0]?.state)
        .toBe("superseded");
      expect((await db.select().from(previewBoots).where(eq(previewBoots.id, boot.id)))[0])
        .toMatchObject({ status: "torn_down", reason: "acceptance record PR closed or merged" });
      expect((await db.select().from(changeRecordEvents).where(
        eq(changeRecordEvents.id, invalidated.kind === "invalidated" ? invalidated.provenanceEventId : randomUUID())
      ))[0]).toMatchObject({
        eventKey: "external-pr:head-invalidated:43:terminal-merged-delivery",
        payloadRef: {
          kind: "external_pr_head_invalidated_terminal",
          repo: "acme/widgets",
          prNumber: 43,
          currentHeadSha: currentHead,
          currentHeadCycleId: advanced.jobId,
          observedHeadSha: observedMergeHead,
          event: "merged",
          deliveryId: "terminal-merged-delivery",
          acceptanceContractVersion: 1,
        },
      });
      await expect(invalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEvent(input))
        .resolves.toMatchObject({
          kind: "invalidated", inserted: false, superseded: 0, previewBootsTornDown: 0,
          currentHeadSha: currentHead, currentHeadCycleId: advanced.jobId,
        });
    });

    it("creates a fresh cycle, event, and job for every repeated-SHA transition", async () => {
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId, repo: "acme/widgets", workKey: "repeated-sha-cycles",
        originChannel: "codex_mcp", contract: completeContract(), createdBy: "user:lead",
      });
      await db.update(acceptanceContracts).set({
        status: "confirmed", confirmedBy: "console_user:user-1", confirmedAt: new Date(),
      }).where(eq(acceptanceContracts.id, draft.contract.id));
      const headA = "a".repeat(40);
      const headB = "b".repeat(40);
      const headC = "c".repeat(40);
      const advance = async (input: {
        headSha: string;
        event: "opened" | "synchronize";
        deliveryId: string;
        beforeHeadSha: string | null;
      }) => {
        const headTransition = input.beforeHeadSha === null ? null : {
          beforeHeadSha: input.beforeHeadSha,
          afterHeadSha: input.headSha,
        };
        const result = await advanceConfirmedAcceptanceRecordPullRequestHead({
          workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 48,
          headSha: input.headSha, event: input.event, deliveryId: input.deliveryId,
          admitReviewJob: true, headTransition, source: "github_webhook",
        });
        if (result.kind !== "advanced") throw new Error(`expected ${input.deliveryId} advance`);
        expect(result.jobId).toBe(acceptanceRecordPullRequestHeadCycleId({
          workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 48,
          headSha: input.headSha, event: input.event, deliveryId: input.deliveryId, headTransition,
        }));
        return result;
      };

      const a1 = await advance({ headSha: headA, event: "opened", deliveryId: "cycle-a-1", beforeHeadSha: null });
      const b = await advance({ headSha: headB, event: "synchronize", deliveryId: "cycle-b", beforeHeadSha: headA });
      const a2 = await advance({ headSha: headA, event: "synchronize", deliveryId: "cycle-a-2", beforeHeadSha: headB });
      const c = await advance({ headSha: headC, event: "synchronize", deliveryId: "cycle-c", beforeHeadSha: headA });
      const a3 = await advance({ headSha: headA, event: "synchronize", deliveryId: "cycle-a-3", beforeHeadSha: headC });

      expect(new Set([a1.jobId, a2.jobId, a3.jobId]).size).toBe(3);
      const aJobs = await db.select().from(reviewJobs).where(eq(reviewJobs.headSha, headA));
      expect(aJobs).toHaveLength(3);
      expect(aJobs.map((job) => job.id).sort()).toEqual([a1.jobId, a2.jobId, a3.jobId].sort());
      expect((await db.select().from(changeRecords).where(eq(changeRecords.id, draft.record.id)))[0])
        .toMatchObject({
          currentPrHeadSha: headA,
          currentPrHeadCycleId: a3.jobId,
          currentPrHeadAuthoritative: true,
          headShas: [headA, headB, headC],
        });
      const events = await db.select().from(changeRecordEvents).where(
        eq(changeRecordEvents.recordId, draft.record.id)
      );
      expect(events.filter((event) =>
        event.eventKey.startsWith("external-pr:head-advanced:48:")
        || event.eventKey.startsWith("external-pr:attached:48:")
      )).toHaveLength(5);
      expect([a1, b, a2, c].every((cycle) => cycle.jobId !== a3.jobId)).toBe(true);

      await db.update(reviewJobs).set({ state: "running" }).where(eq(reviewJobs.id, a1.jobId));
      await expect(appendCurrentReviewJobEventsAtomically({
        workspaceId: wsId, recordId: draft.record.id, jobId: a1.jobId,
        repo: "acme/widgets", prNumber: 48, headSha: headA,
        events: [{ eventKey: "cycle:stale-a1", stage: "review", actor: "reviewer-of-record", payloadRef: { cycle: a1.jobId } }],
      })).rejects.toMatchObject({
        code: "CURRENT_REVIEW_JOB_NOT_CURRENT", reason: "record_not_current",
      });
    });

    it("cycle-binds preview boots and tears them down across draft, revisit, and route races", async () => {
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId, repo: "acme/widgets", workKey: "cycle-preview-boots",
        originChannel: "codex_mcp", contract: completeContract(), createdBy: "user:lead",
      });
      await db.update(acceptanceContracts).set({
        status: "confirmed", confirmedBy: "console_user:user-1", confirmedAt: new Date(),
      }).where(eq(acceptanceContracts.id, draft.contract.id));
      const headA = "5".repeat(40);
      const headB = "6".repeat(40);
      const headC = "7".repeat(40);
      const a1 = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 49,
        headSha: headA, event: "opened", deliveryId: "preview-cycle-a1",
        admitReviewJob: true, headTransition: null, source: "github_webhook",
      });
      if (a1.kind !== "advanced") throw new Error("expected preview A1 cycle");
      await db.update(reviewJobs).set({ state: "running" }).where(eq(reviewJobs.id, a1.jobId));
      const bootInput = (jobId: string, headSha: string) => ({
        workspaceId: wsId, recordId: draft.record.id, jobId,
        repo: "acme/widgets", prNumber: 49, headSha, ref: `refs/pull/49/head`,
      });
      const bootA1 = await enqueueCurrentReviewJobPreviewBoot(bootInput(a1.jobId, headA));
      expect(bootA1).toEqual({
        id: previewBootId({ workspaceId: wsId, repo: "acme/widgets", prNumber: 49, headSha: headA, cycleId: a1.jobId }),
        deduped: false,
        superseded: 0,
      });
      await expect(enqueueCurrentReviewJobPreviewBoot(bootInput(a1.jobId, headA)))
        .resolves.toMatchObject({ id: bootA1.id, deduped: true, superseded: 0 });
      await db.update(previewBoots).set({ status: "ready", url: "http://preview-a1.test", port: 3100 })
        .where(eq(previewBoots.id, bootA1.id));

      const bDraft = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 49,
        headSha: headB, event: "synchronize", deliveryId: "preview-cycle-b-draft",
        admitReviewJob: false,
        headTransition: { beforeHeadSha: headA, afterHeadSha: headB },
        source: "github_webhook",
      });
      expect(bDraft).toMatchObject({
        kind: "advanced", jobAdmitted: false, previewBootsTornDown: 1,
      });
      if (bDraft.kind !== "advanced") throw new Error("expected draft B cycle");
      expect((await db.select().from(previewBoots).where(eq(previewBoots.id, bootA1.id)))[0])
        .toMatchObject({ status: "torn_down", reason: "acceptance record head advanced" });

      const bReady = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 49,
        headSha: headB, event: "ready_for_review", deliveryId: "preview-cycle-b-ready",
        admitReviewJob: true, headTransition: null, source: "github_webhook",
      });
      if (bReady.kind !== "advanced") throw new Error("expected ready B cycle");
      expect(bReady.jobId).toBe(bDraft.jobId);
      await db.update(reviewJobs).set({ state: "running" }).where(eq(reviewJobs.id, bReady.jobId));
      const bootB = await enqueueCurrentReviewJobPreviewBoot(bootInput(bReady.jobId, headB));

      const a2 = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 49,
        headSha: headA, event: "synchronize", deliveryId: "preview-cycle-a2",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: headB, afterHeadSha: headA },
        source: "github_webhook",
      });
      expect(a2).toMatchObject({ kind: "advanced", previewBootsTornDown: 1 });
      if (a2.kind !== "advanced") throw new Error("expected preview A2 cycle");
      expect(a2.jobId).not.toBe(a1.jobId);
      expect((await db.select().from(previewBoots).where(eq(previewBoots.id, bootB.id)))[0]?.status)
        .toBe("torn_down");
      await db.update(reviewJobs).set({ state: "running" }).where(eq(reviewJobs.id, a2.jobId));
      const bootA2 = await enqueueCurrentReviewJobPreviewBoot(bootInput(a2.jobId, headA));
      expect(bootA2.id).not.toBe(bootA1.id);
      await expect(enqueueCurrentReviewJobPreviewBoot(bootInput(a1.jobId, headA)))
        .rejects.toMatchObject({
          code: "CURRENT_REVIEW_JOB_NOT_CURRENT", reason: "record_not_current",
        });

      const [racingBoot, racingHead] = await Promise.allSettled([
        enqueueCurrentReviewJobPreviewBoot(bootInput(a2.jobId, headA)),
        advanceConfirmedAcceptanceRecordPullRequestHead({
          workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 49,
          headSha: headC, event: "synchronize", deliveryId: "preview-cycle-c-draft",
          admitReviewJob: false,
          headTransition: { beforeHeadSha: headA, afterHeadSha: headC },
          source: "github_webhook",
        }),
      ]);
      expect(racingHead.status).toBe("fulfilled");
      if (racingBoot.status === "rejected") {
        expect(racingBoot.reason).toMatchObject({ code: "CURRENT_REVIEW_JOB_NOT_CURRENT" });
      }
      expect((await db.select().from(previewBoots).where(eq(previewBoots.id, bootA2.id)))[0]?.status)
        .toBe("torn_down");
      const activeBoots = await db.select().from(previewBoots).where(sql`
        ${previewBoots.workspaceId} = ${wsId}
        AND ${previewBoots.repo} = 'acme/widgets'
        AND ${previewBoots.prNumber} = 49
        AND ${previewBoots.status} IN ('pending', 'claimed', 'booting', 'ready')
      `);
      expect(activeBoots).toHaveLength(0);
    });

    it("appends post-review events only for the locked current running head", async () => {
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId, repo: "acme/widgets", workKey: "guarded-current-head-events",
        originChannel: "codex_mcp", contract: completeContract(), createdBy: "user:lead",
      });
      await db.update(acceptanceContracts).set({
        status: "confirmed", confirmedBy: "console_user:user-1", confirmedAt: new Date(),
      }).where(eq(acceptanceContracts.id, draft.contract.id));
      const headSha = "c".repeat(40);
      const advance = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 45,
        headSha, event: "opened", deliveryId: "delivery-current-head",
        admitReviewJob: true,
        headTransition: null,
        source: "github_webhook",
      });
      if (advance.kind !== "advanced") throw new Error("expected head advance");
      const guardedInput = {
        workspaceId: wsId, recordId: draft.record.id, jobId: advance.jobId,
        repo: "acme/widgets", prNumber: 45, headSha,
        events: [{
          eventKey: `review:reservation:${advance.jobId}`,
          stage: "review", actor: "reviewer-of-record",
          payloadRef: { kind: "correction_reservation", headSha },
        }],
      };
      await expect(appendCurrentReviewJobEventsAtomically(guardedInput))
        .rejects.toThrow("running review job");
      await db.update(reviewJobs).set({ state: "running", claimedBy: "worker:two", claimedAt: new Date() })
        .where(eq(reviewJobs.id, advance.jobId));
      const first = await appendCurrentReviewJobEventsAtomically(guardedInput);
      const replay = await appendCurrentReviewJobEventsAtomically(guardedInput);
      expect(first.events).toEqual([expect.objectContaining({ inserted: true })]);
      expect(replay.events).toEqual([expect.objectContaining({ inserted: false })]);

      const nextHead = "d".repeat(40);
      await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 45,
        headSha: nextHead, event: "synchronize", deliveryId: "delivery-next-head",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: headSha, afterHeadSha: nextHead },
        source: "github_webhook",
      });
      await expect(appendCurrentReviewJobEventsAtomically(guardedInput))
        .rejects.toThrow("current PR head");
      expect((await db.select().from(changeRecords).where(eq(changeRecords.id, draft.record.id)))[0])
        .toMatchObject({ currentPrHeadSha: nextHead, headShas: [headSha, nextHead] });
    });

    it("reads only the complete current correction packet custody and fails closed for foreign or malformed rows", async () => {
      const repo = "acme/widgets";
      const prNumber = 145;
      const headSha = "1".repeat(40);
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId, repo, workKey: "current-correction-packet-read",
        originChannel: "codex_mcp", contract: completeContract(), createdBy: "user:lead",
      });
      await db.update(acceptanceContracts).set({
        status: "confirmed", confirmedBy: "console_user:user-1", confirmedAt: new Date(),
      }).where(eq(acceptanceContracts.id, draft.contract.id));
      const current = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo, prNumber, headSha,
        event: "opened", deliveryId: "current-correction-packet-open", admitReviewJob: true,
        headTransition: null, source: "github_webhook",
      });
      if (current.kind !== "advanced") throw new Error("expected current correction packet head");

      await expect(readCurrentAcceptanceCorrectionPackets({
        workspaceId: wsId, recordId: draft.record.id,
      })).resolves.toEqual({ kind: "not_ready", reason: "no_correction_packets" });

      const packet = await appendExactCurrentCorrectionPacket({
        workspaceId: wsId, recordId: draft.record.id, jobId: current.jobId,
        repo, prNumber, headSha, acceptanceContractId: draft.contract.id,
      });
      const expectedContractSha256 = acceptanceContractSha256({
        acceptanceContractId: draft.contract.id,
        acceptanceContractVersion: draft.contract.version,
        contract: draft.contract.contract,
      });
      const result = await readCurrentAcceptanceCorrectionPackets({
        workspaceId: wsId, recordId: draft.record.id,
      });
      expect(result).toEqual({
        kind: "current",
        binding: {
          workspaceId: wsId,
          recordId: draft.record.id,
          reviewJobId: current.jobId,
          repo,
          prNumber,
          headSha,
          headCycleId: current.jobId,
          authorityGeneration: 1,
          acceptanceContract: {
            id: draft.contract.id,
            version: draft.contract.version,
            sha256: expectedContractSha256,
          },
        },
        packetIds: [packet.packetId],
        packetSetSha256: acceptanceContextPacketSetSha256({ packetIds: [packet.packetId] }),
        correctionPacketPayloadSetSha256: acceptanceCorrectionPacketPayloadSetSha256({ packets: [packet] }),
        packets: [packet],
      });

      const foreignWorkspace = (await db.insert(workspaces).values({
        name: "foreign current packet workspace",
        slug: `foreign-current-packets-${randomUUID()}`,
      }).returning({ id: workspaces.id }))[0]!;
      try {
        await expect(readCurrentAcceptanceCorrectionPackets({
          workspaceId: foreignWorkspace.id,
          recordId: draft.record.id,
        })).resolves.toEqual({ kind: "not_found" });
      } finally {
        await db.delete(workspaces).where(eq(workspaces.id, foreignWorkspace.id));
      }

      await db.update(acceptanceContracts).set({ status: "draft" })
        .where(eq(acceptanceContracts.id, draft.contract.id));
      await expect(readCurrentAcceptanceCorrectionPackets({
        workspaceId: wsId, recordId: draft.record.id,
      })).resolves.toEqual({ kind: "not_ready", reason: "confirmed_contract_unavailable" });
      await db.update(acceptanceContracts).set({ status: "confirmed" })
        .where(eq(acceptanceContracts.id, draft.contract.id));

      const packetEventWhere = and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey, `review:correction:${current.jobId}:AC-1`),
      );
      await db.update(changeRecordEvents).set({ actor: "server:forged-packet" }).where(packetEventWhere);
      await expect(readCurrentAcceptanceCorrectionPackets({
        workspaceId: wsId, recordId: draft.record.id,
      })).resolves.toEqual({ kind: "not_ready", reason: "invalid_packet_custody" });
      await db.update(changeRecordEvents).set({ actor: "reviewer-of-record", stage: "builder_handoff" })
        .where(packetEventWhere);
      await expect(readCurrentAcceptanceCorrectionPackets({
        workspaceId: wsId, recordId: draft.record.id,
      })).resolves.toEqual({ kind: "not_ready", reason: "invalid_packet_custody" });
      await db.update(changeRecordEvents).set({
        stage: "review",
        payloadRef: {
          ...packet,
          criterion: { id: "AC-1", snapshot: "A drifted criterion snapshot" },
          expected: "A drifted criterion snapshot",
        },
      }).where(packetEventWhere);
      await expect(readCurrentAcceptanceCorrectionPackets({
        workspaceId: wsId, recordId: draft.record.id,
      })).resolves.toEqual({ kind: "not_ready", reason: "invalid_packet_custody" });
      await db.update(changeRecordEvents).set({ payloadRef: packet }).where(packetEventWhere);

      await appendChangeRecordEvent({
        recordId: draft.record.id,
        eventKey: `review:correction:${current.jobId}:AC-FORGED`,
        stage: "review",
        actor: "reviewer-of-record",
        payloadRef: { ...packet, packetId: `correction-${"f".repeat(48)}` },
      });
      const partial = await readCurrentAcceptanceCorrectionPackets({
        workspaceId: wsId, recordId: draft.record.id,
      });
      expect(partial).toEqual({ kind: "not_ready", reason: "invalid_packet_custody" });
      expect(partial).not.toMatchObject({ kind: "current", packetIds: [packet.packetId] });
    });

    it("does not inherit or revive historical correction packets across A-to-B-to-A head cycles", async () => {
      const repo = "acme/widgets";
      const prNumber = 146;
      const headA = "a".repeat(40);
      const headB = "b".repeat(40);
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId, repo, workKey: "correction-packet-cycle-revisit",
        originChannel: "codex_mcp", contract: completeContract(), createdBy: "user:lead",
      });
      await db.update(acceptanceContracts).set({
        status: "confirmed", confirmedBy: "console_user:user-1", confirmedAt: new Date(),
      }).where(eq(acceptanceContracts.id, draft.contract.id));
      const a1 = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo, prNumber, headSha: headA,
        event: "opened", deliveryId: "correction-packet-cycle-a1", admitReviewJob: true,
        headTransition: null, source: "github_webhook",
      });
      if (a1.kind !== "advanced") throw new Error("expected A1 correction packet cycle");
      const packetA1 = await appendExactCurrentCorrectionPacket({
        workspaceId: wsId, recordId: draft.record.id, jobId: a1.jobId,
        repo, prNumber, headSha: headA, acceptanceContractId: draft.contract.id,
        observed: "A1 did not retain the filter.",
      });
      await expect(readCurrentAcceptanceCorrectionPackets({
        workspaceId: wsId, recordId: draft.record.id,
      })).resolves.toMatchObject({
        kind: "current", binding: { headSha: headA, headCycleId: a1.jobId },
        packetIds: [packetA1.packetId],
      });

      const [racingRead, b] = await Promise.all([
        readCurrentAcceptanceCorrectionPackets({ workspaceId: wsId, recordId: draft.record.id }),
        advanceConfirmedAcceptanceRecordPullRequestHead({
          workspaceId: wsId, recordId: draft.record.id, repo, prNumber, headSha: headB,
          event: "synchronize", deliveryId: "correction-packet-cycle-b", admitReviewJob: true,
          headTransition: { beforeHeadSha: headA, afterHeadSha: headB }, source: "github_webhook",
        }),
      ]);
      if (b.kind !== "advanced") throw new Error("expected B correction packet cycle");
      if (racingRead.kind === "current") {
        expect(racingRead).toMatchObject({
          binding: { headSha: headA, headCycleId: a1.jobId },
          packetIds: [packetA1.packetId],
        });
      } else {
        expect(racingRead).toEqual({ kind: "not_ready", reason: "no_correction_packets" });
      }
      await expect(readCurrentAcceptanceCorrectionPackets({
        workspaceId: wsId, recordId: draft.record.id,
      })).resolves.toEqual({ kind: "not_ready", reason: "no_correction_packets" });

      const a2 = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo, prNumber, headSha: headA,
        event: "synchronize", deliveryId: "correction-packet-cycle-a2", admitReviewJob: true,
        headTransition: { beforeHeadSha: headB, afterHeadSha: headA }, source: "github_webhook",
      });
      if (a2.kind !== "advanced") throw new Error("expected A2 correction packet cycle");
      expect(a2.jobId).not.toBe(a1.jobId);
      await expect(readCurrentAcceptanceCorrectionPackets({
        workspaceId: wsId, recordId: draft.record.id,
      })).resolves.toEqual({ kind: "not_ready", reason: "no_correction_packets" });

      const packetA2 = await appendExactCurrentCorrectionPacket({
        workspaceId: wsId, recordId: draft.record.id, jobId: a2.jobId,
        repo, prNumber, headSha: headA, acceptanceContractId: draft.contract.id,
        observed: "A2 still did not retain the filter.",
      });
      expect(packetA2.packetId).not.toBe(packetA1.packetId);
      await expect(readCurrentAcceptanceCorrectionPackets({
        workspaceId: wsId, recordId: draft.record.id,
      })).resolves.toMatchObject({
        kind: "current",
        binding: { headSha: headA, headCycleId: a2.jobId, reviewJobId: a2.jobId },
        packetIds: [packetA2.packetId],
        packets: [expect.objectContaining({ jobId: a2.jobId, observed: "A2 still did not retain the filter." })],
      });

      await invalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEvent({
        workspaceId: wsId, recordId: draft.record.id, repo, prNumber,
        headSha: headA, event: "closed", deliveryId: "correction-packet-cycle-closed",
        source: "github_webhook",
      });
      await expect(readCurrentAcceptanceCorrectionPackets({
        workspaceId: wsId, recordId: draft.record.id,
      })).resolves.toEqual({ kind: "not_current" });
    });

    it("records and replays one immutable approved decision for the exact current proven review", async () => {
      const actor = await addAcceptanceDecisionActor(wsId, "owner");
      const ready = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId,
        workKey: "current-pr-decision-approved",
        prNumber: 147,
        headSha: "7".repeat(40),
        verdict: "proven",
      });
      const expectedContractSha256 = acceptanceContractSha256({
        acceptanceContractId: ready.draft.contract.id,
        acceptanceContractVersion: ready.draft.contract.version,
        contract: ready.draft.contract.contract,
      });
      const before = await readCurrentAcceptancePrDecision({
        workspaceId: wsId,
        recordId: ready.draft.record.id,
      });
      expect(before).toEqual({
        kind: "current",
        binding: {
          bindingId: ready.binding.bindingId,
          workspaceId: wsId,
          recordId: ready.draft.record.id,
          repo: ready.repo,
          prNumber: 147,
          headSha: "7".repeat(40),
          headCycleId: ready.advanced.jobId,
          authorityGeneration: 1,
          reviewJobId: ready.advanced.jobId,
          reviewVerdict: "proven",
          postedReviewUrl: ready.posted.postedReviewUrl,
          postedAttestationEventId: ready.posted.event.id,
          acceptanceContract: {
            id: ready.draft.contract.id,
            version: ready.draft.contract.version,
            sha256: expectedContractSha256,
          },
        },
        decision: null,
      });

      const input = {
        workspaceId: wsId,
        recordId: ready.draft.record.id,
        bindingId: ready.binding.bindingId,
        decision: "approved" as const,
        decidedBy: actor,
      };
      const first = await recordAcceptancePrDecision(input);
      const replay = await recordAcceptancePrDecision(input);
      expect(first).toMatchObject({
        kind: "recorded",
        binding: { headCycleId: ready.advanced.jobId, reviewVerdict: "proven" },
        decision: {
          eventKey: `acceptance-pr-decision:${ready.advanced.jobId}`,
          decision: "approved",
          rationale: null,
          decidedBy: actor,
          decidedRole: "owner",
        },
      });
      expect(replay).toMatchObject({
        kind: "replayed",
        decision: {
          eventId: first.kind === "recorded" ? first.decision.eventId : "missing",
          decidedRole: "owner",
        },
      });
      await expect(recordAcceptancePrDecision({
        ...input,
        decision: "rejected",
      })).rejects.toBeInstanceOf(AcceptancePrDecisionConflictError);

      const userId = actor.slice("user:".length);
      await db.update(workspaceMemberships).set({ role: "admin" }).where(and(
        eq(workspaceMemberships.workspaceId, wsId),
        eq(workspaceMemberships.userId, userId),
      ));
      await expect(recordAcceptancePrDecision(input)).resolves.toMatchObject({
        kind: "replayed",
        decision: { decidedRole: "owner" },
      });
      await db.update(workspaceMemberships).set({ role: "member" }).where(and(
        eq(workspaceMemberships.workspaceId, wsId),
        eq(workspaceMemberships.userId, userId),
      ));
      await expect(recordAcceptancePrDecision(input)).resolves.toEqual({ kind: "not_authorized" });

      await expect(readCurrentAcceptancePrDecision({
        workspaceId: wsId,
        recordId: ready.draft.record.id,
      })).resolves.toMatchObject({
        kind: "current",
        decision: { decision: "approved", decidedBy: actor, decidedRole: "owner" },
      });
      await expect(readCurrentAcceptancePrDecision({
        workspaceId: randomUUID(),
        recordId: ready.draft.record.id,
      })).resolves.toEqual({ kind: "not_found" });
      expect((await db.select().from(reviewJobs).where(eq(reviewJobs.id, ready.advanced.jobId)))[0])
        .toMatchObject({ state: "posted", verdict: "proven" });
      expect((await db.select().from(changeRecords).where(eq(changeRecords.id, ready.draft.record.id)))[0])
        .toMatchObject({ state: "open", mergedSha: null, currentPrHeadSha: "7".repeat(40) });
    });

    it("records a signed merge fact while keeping approval alignment explicit", async () => {
      const owner = await addAcceptanceDecisionActor(wsId, "owner");
      const exception = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId,
        workKey: "signed-merge-aligned-exception",
        prNumber: 160,
        headSha: "5".repeat(40),
        verdict: "not_proven",
      });
      await recordAcceptancePrDecision({
        workspaceId: wsId,
        recordId: exception.draft.record.id,
        bindingId: exception.binding.bindingId,
        decision: "approved_with_exception",
        rationale: "The owner accepts the documented unproven criterion for this exact head.",
        decidedBy: owner,
      });
      await expect(recordSignedAcceptanceRecordMerge(signedMergeInput({
        workspaceId: wsId,
        recordId: exception.draft.record.id,
        repo: exception.repo,
        prNumber: 160,
        headSha: "5".repeat(40),
        deliveryId: "signed-merge-aligned-exception:merged",
        mergeSha: "6".repeat(40),
      }))).resolves.toMatchObject({
        kind: "recorded",
        decisionAlignment: {
          kind: "aligned",
          decision: "approved_with_exception",
          binding: { headCycleId: exception.advanced.jobId },
        },
      });

      const conflicting = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId,
        workKey: "signed-merge-conflicting-decision",
        prNumber: 161,
        headSha: "7".repeat(40),
        verdict: "failed",
      });
      await recordAcceptancePrDecision({
        workspaceId: wsId,
        recordId: conflicting.draft.record.id,
        bindingId: conflicting.binding.bindingId,
        decision: "changes_requested",
        rationale: "Repair AC-1 before merge.",
        decidedBy: owner,
      });
      await expect(recordSignedAcceptanceRecordMerge(signedMergeInput({
        workspaceId: wsId,
        recordId: conflicting.draft.record.id,
        repo: conflicting.repo,
        prNumber: 161,
        headSha: "7".repeat(40),
        deliveryId: "signed-merge-conflicting-decision:merged",
        mergeSha: "8".repeat(40),
      }))).resolves.toMatchObject({
        kind: "recorded",
        decisionAlignment: {
          kind: "decision_conflicts_merge",
          decision: "changes_requested",
          binding: { headCycleId: conflicting.advanced.jobId },
        },
      });

      const undecided = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId,
        workKey: "signed-merge-without-decision",
        prNumber: 162,
        headSha: "9".repeat(40),
        verdict: "proven",
      });
      await expect(recordSignedAcceptanceRecordMerge(signedMergeInput({
        workspaceId: wsId,
        recordId: undecided.draft.record.id,
        repo: undecided.repo,
        prNumber: 162,
        headSha: "9".repeat(40),
        deliveryId: "signed-merge-without-decision:merged",
        mergeSha: "a".repeat(40),
      }))).resolves.toMatchObject({
        kind: "recorded",
        decisionAlignment: {
          kind: "not_recorded",
          binding: { headCycleId: undecided.advanced.jobId },
        },
      });

      for (const ready of [exception, conflicting, undecided]) {
        expect((await db.select().from(changeRecords).where(
          eq(changeRecords.id, ready.draft.record.id)
        ))[0]).toMatchObject({ state: "merged", currentPrHeadAuthoritative: false });
        expect((await db.select().from(reviewJobs).where(
          eq(reviewJobs.id, ready.advanced.jobId)
        ))[0]).toMatchObject({ state: "posted", verdict: ready.binding.reviewVerdict });
      }
    });

    it("projects immutable exact-review outcomes without consulting the current head", async () => {
      const owner = await addAcceptanceDecisionActor(wsId, "owner");
      const approved = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId, workKey: "outcome-history-approved", prNumber: 170,
        headSha: "a".repeat(40), verdict: "proven",
      });
      await recordAcceptancePrDecision({
        workspaceId: wsId, recordId: approved.draft.record.id, bindingId: approved.binding.bindingId,
        decision: "approved", decidedBy: owner,
      });
      const mergeAt = new Date();
      await recordSignedAcceptanceRecordMerge({
        ...signedMergeInput({
          workspaceId: wsId, recordId: approved.draft.record.id, repo: approved.repo,
          prNumber: 170, headSha: "a".repeat(40), deliveryId: "outcome-history-approved:merge",
          mergeSha: "b".repeat(40),
        }),
        mergedAt: mergeAt,
      });
      await recordAcceptancePostMergeOutcome({
        workspaceId: wsId, recordId: approved.draft.record.id, recordedBy: owner,
        occurredAt: mergeAt,
        outcome: {
          kind: "deployed", revisionSha: "b".repeat(40), environment: "production",
          deploymentReference: "deploy:outcome-history-approved",
        },
      });
      const notRecorded = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId, workKey: "outcome-history-not-recorded", prNumber: 171,
        headSha: "c".repeat(40), verdict: "proven",
      });
      const invalid = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId, workKey: "outcome-history-invalid", prNumber: 172,
        headSha: "d".repeat(40), verdict: "proven",
      });
      await db.update(changeRecordEvents).set({ stage: "forged_review" }).where(and(
        eq(changeRecordEvents.recordId, invalid.draft.record.id),
        eq(changeRecordEvents.eventKey, `review:github-posted:${invalid.advanced.jobId}`),
      ));

      const observedUntil = new Date(Date.now() + 60_000);
      const report = await readAcceptanceOutcomeHistory({
        workspaceId: wsId, from: new Date(Date.now() - 60_000), to: observedUntil,
        observedUntil,
      });
      expect(report.counts).toMatchObject({
        eligible: 2, approved: 1, approvedWithException: 0, changesRequested: 0,
        rejected: 0, notRecorded: 1, excludedUnknown: 1, signedMerged: 1,
        deploymentObserved: 1, incidentObserved: 0, reverted: 0,
      });
      expect(report.counts.eligible).toBe(
        report.counts.approved + report.counts.approvedWithException
          + report.counts.changesRequested + report.counts.rejected + report.counts.notRecorded
      );
      expect(report.samples).toEqual(expect.arrayContaining([
        expect.objectContaining({
          recordId: approved.draft.record.id, classification: "approved",
          lineage: { signedMerged: true, deploymentObserved: true, incidentObserved: false, reverted: false },
        }),
        expect.objectContaining({ recordId: notRecorded.draft.record.id, classification: "not_recorded" }),
        expect.objectContaining({
          recordId: invalid.draft.record.id, classification: "excluded_unknown",
          exclusionReason: "invalid_posted_review_custody",
        }),
      ]));
      await expect(readAcceptanceOutcomeHistory({
        workspaceId: wsId, from: observedUntil, to: observedUntil, observedUntil,
      })).rejects.toThrow("Acceptance outcome history requires a workspace and bounded UTC Date window");
    });

    it("excludes cross-workspace, cross-Contract, duplicate, and late-confirmed review custody", async () => {
      const foreignWorkspace = (await db.insert(workspaces).values({
        name: "foreign outcome-history workspace",
        slug: `foreign-outcome-history-${randomUUID()}`,
      }).returning({ id: workspaces.id }))[0]!.id;
      let crossWorkspaceJobId: string | null = null;
      try {
        const crossWorkspaceJob = await createReadyAcceptanceDecisionRecord({
          workspaceId: wsId, workKey: "outcome-history-cross-workspace-job", prNumber: 173,
          headSha: "1".repeat(40), verdict: "proven",
        });
        crossWorkspaceJobId = crossWorkspaceJob.advanced.jobId;
        await db.update(reviewJobs).set({ workspaceId: foreignWorkspace })
          .where(eq(reviewJobs.id, crossWorkspaceJob.advanced.jobId));

        const foreignDraft = await createDraftAcceptanceRecord({
          workspaceId: foreignWorkspace, repo: "acme/widgets",
          workKey: "outcome-history-foreign-contract", originChannel: "codex_mcp",
          contract: completeContract(), createdBy: "user:foreign",
        });
        await db.update(acceptanceContracts).set({
          status: "confirmed", confirmedBy: "console_user:foreign", confirmedAt: new Date(),
        }).where(eq(acceptanceContracts.id, foreignDraft.contract.id));
        const crossContract = await createReadyAcceptanceDecisionRecord({
          workspaceId: wsId, workKey: "outcome-history-cross-contract", prNumber: 174,
          headSha: "2".repeat(40), verdict: "proven",
        });
        await db.update(changeRecordEvents).set({
          payloadRef: {
            ...crossContract.posted.event.payloadRef,
            acceptanceContractId: foreignDraft.contract.id,
          },
        }).where(eq(changeRecordEvents.id, crossContract.posted.event.id));

        const lateContract = await createReadyAcceptanceDecisionRecord({
          workspaceId: wsId, workKey: "outcome-history-late-contract", prNumber: 175,
          headSha: "3".repeat(40), verdict: "proven",
        });
        await db.update(acceptanceContracts).set({
          confirmedAt: new Date(lateContract.posted.event.at.valueOf() + 1_000),
        }).where(eq(acceptanceContracts.id, lateContract.draft.contract.id));

        const duplicateSource = await createReadyAcceptanceDecisionRecord({
          workspaceId: wsId, workKey: "outcome-history-duplicate-source", prNumber: 176,
          headSha: "4".repeat(40), verdict: "proven",
        });
        const duplicateRecord = await createDraftAcceptanceRecord({
          workspaceId: wsId, repo: duplicateSource.repo,
          workKey: "outcome-history-duplicate-target", originChannel: "codex_mcp",
          contract: completeContract(), createdBy: "user:lead",
        });
        await appendChangeRecordEvent({
          recordId: duplicateRecord.record.id,
          eventKey: `review:github-posted:${duplicateSource.advanced.jobId}`,
          stage: "review",
          actor: "reviewer-of-record",
          payloadRef: {
            ...duplicateSource.posted.event.payloadRef,
            recordId: duplicateRecord.record.id,
          },
        });

        const observedUntil = new Date(Date.now() + 60_000);
        const report = await readAcceptanceOutcomeHistory({
          workspaceId: wsId,
          from: new Date(Date.now() - 60_000),
          to: observedUntil,
          observedUntil,
        });
        const sampleFor = (recordId: string) => report.samples.find((sample) => sample.recordId === recordId);
        expect(sampleFor(crossWorkspaceJob.draft.record.id)).toMatchObject({
          classification: "excluded_unknown", exclusionReason: "invalid_posted_review_custody",
        });
        expect(sampleFor(crossContract.draft.record.id)).toMatchObject({
          classification: "excluded_unknown", exclusionReason: "invalid_posted_review_custody",
        });
        expect(sampleFor(lateContract.draft.record.id)).toMatchObject({
          classification: "excluded_unknown", exclusionReason: "invalid_posted_review_custody",
        });
        expect(sampleFor(duplicateSource.draft.record.id)).toMatchObject({
          classification: "excluded_unknown", exclusionReason: "ambiguous_review_custody",
        });
        expect(sampleFor(duplicateRecord.record.id)).toMatchObject({
          classification: "excluded_unknown", exclusionReason: "ambiguous_review_custody",
        });
      } finally {
        if (crossWorkspaceJobId) {
          await db.update(reviewJobs).set({ workspaceId: wsId })
            .where(eq(reviewJobs.id, crossWorkspaceJobId));
        }
        await db.delete(workspaces).where(eq(workspaces.id, foreignWorkspace));
      }
    });

    it("excludes malformed and out-of-order decision, merge, and post-merge custody", async () => {
      const owner = await addAcceptanceDecisionActor(wsId, "owner");
      const malformedDecision = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId, workKey: "outcome-history-malformed-decision", prNumber: 177,
        headSha: "5".repeat(40), verdict: "proven",
      });
      await recordAcceptancePrDecision({
        workspaceId: wsId, recordId: malformedDecision.draft.record.id,
        bindingId: malformedDecision.binding.bindingId, decision: "approved", decidedBy: owner,
      });
      await db.update(changeRecordEvents).set({ stage: "forged_decision" }).where(and(
        eq(changeRecordEvents.recordId, malformedDecision.draft.record.id),
        eq(changeRecordEvents.eventKey, `acceptance-pr-decision:${malformedDecision.advanced.jobId}`),
      ));

      const malformedMerge = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId, workKey: "outcome-history-malformed-merge", prNumber: 178,
        headSha: "6".repeat(40), verdict: "proven",
      });
      await recordAcceptancePrDecision({
        workspaceId: wsId, recordId: malformedMerge.draft.record.id,
        bindingId: malformedMerge.binding.bindingId, decision: "approved", decidedBy: owner,
      });
      const malformedMergeSha = "7".repeat(40);
      await recordSignedAcceptanceRecordMerge({
        ...signedMergeInput({
          workspaceId: wsId, recordId: malformedMerge.draft.record.id, repo: malformedMerge.repo,
          prNumber: 178, headSha: "6".repeat(40), deliveryId: "outcome-history-malformed-merge:merge",
          mergeSha: malformedMergeSha,
        }),
        mergedAt: new Date(),
      });
      await db.update(changeRecordEvents).set({ stage: "forged_merge" }).where(and(
        eq(changeRecordEvents.recordId, malformedMerge.draft.record.id),
        eq(changeRecordEvents.eventKey, `acceptance-pr:signed-merge:${malformedMergeSha}`),
      ));

      const malformedPostMerge = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId, workKey: "outcome-history-malformed-postmerge", prNumber: 179,
        headSha: "8".repeat(40), verdict: "proven",
      });
      await recordAcceptancePrDecision({
        workspaceId: wsId, recordId: malformedPostMerge.draft.record.id,
        bindingId: malformedPostMerge.binding.bindingId, decision: "approved", decidedBy: owner,
      });
      const malformedPostMergeSha = "9".repeat(40);
      const malformedPostMergeAt = new Date();
      await recordSignedAcceptanceRecordMerge({
        ...signedMergeInput({
          workspaceId: wsId, recordId: malformedPostMerge.draft.record.id, repo: malformedPostMerge.repo,
          prNumber: 179, headSha: "8".repeat(40), deliveryId: "outcome-history-malformed-postmerge:merge",
          mergeSha: malformedPostMergeSha,
        }),
        mergedAt: malformedPostMergeAt,
      });
      const malformedPostMergeEvent = await recordAcceptancePostMergeOutcome({
        workspaceId: wsId, recordId: malformedPostMerge.draft.record.id, recordedBy: owner,
        occurredAt: new Date(),
        outcome: {
          kind: "deployed", revisionSha: malformedPostMergeSha, environment: "production",
          deploymentReference: "deploy:outcome-history-malformed-postmerge",
        },
      });
      await db.update(changeRecordEvents).set({ stage: "forged_postmerge" })
        .where(eq(changeRecordEvents.id, malformedPostMergeEvent.event.id));

      const earlyDecision = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId, workKey: "outcome-history-early-decision", prNumber: 180,
        headSha: "a".repeat(40), verdict: "proven",
      });
      await recordAcceptancePrDecision({
        workspaceId: wsId, recordId: earlyDecision.draft.record.id,
        bindingId: earlyDecision.binding.bindingId, decision: "approved", decidedBy: owner,
      });
      await db.update(changeRecordEvents).set({
        at: new Date(earlyDecision.posted.event.at.valueOf() - 1_000),
      }).where(and(
        eq(changeRecordEvents.recordId, earlyDecision.draft.record.id),
        eq(changeRecordEvents.eventKey, `acceptance-pr-decision:${earlyDecision.advanced.jobId}`),
      ));

      const earlyMerge = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId, workKey: "outcome-history-early-merge", prNumber: 181,
        headSha: "b".repeat(40), verdict: "proven",
      });
      await recordAcceptancePrDecision({
        workspaceId: wsId, recordId: earlyMerge.draft.record.id,
        bindingId: earlyMerge.binding.bindingId, decision: "approved", decidedBy: owner,
      });
      await recordSignedAcceptanceRecordMerge({
        ...signedMergeInput({
          workspaceId: wsId, recordId: earlyMerge.draft.record.id, repo: earlyMerge.repo,
          prNumber: 181, headSha: "b".repeat(40), deliveryId: "outcome-history-early-merge:merge",
          mergeSha: "c".repeat(40),
        }),
        mergedAt: new Date(earlyMerge.posted.event.at.valueOf() - 1_000),
      });

      const earlyPostMerge = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId, workKey: "outcome-history-early-postmerge", prNumber: 182,
        headSha: "d".repeat(40), verdict: "proven",
      });
      await recordAcceptancePrDecision({
        workspaceId: wsId, recordId: earlyPostMerge.draft.record.id,
        bindingId: earlyPostMerge.binding.bindingId, decision: "approved", decidedBy: owner,
      });
      const earlyPostMergeSha = "e".repeat(40);
      const earlyPostMergeAt = new Date();
      await recordSignedAcceptanceRecordMerge({
        ...signedMergeInput({
          workspaceId: wsId, recordId: earlyPostMerge.draft.record.id, repo: earlyPostMerge.repo,
          prNumber: 182, headSha: "d".repeat(40), deliveryId: "outcome-history-early-postmerge:merge",
          mergeSha: earlyPostMergeSha,
        }),
        mergedAt: earlyPostMergeAt,
      });
      await recordAcceptancePostMergeOutcome({
        workspaceId: wsId, recordId: earlyPostMerge.draft.record.id, recordedBy: owner,
        occurredAt: new Date(earlyPostMergeAt.valueOf() - 1_000),
        outcome: {
          kind: "deployed", revisionSha: earlyPostMergeSha, environment: "production",
          deploymentReference: "deploy:outcome-history-early-postmerge",
        },
      });

      const wrongKeyAttestation = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId, workKey: "outcome-history-wrong-attestation-key", prNumber: 183,
        headSha: "f".repeat(40), verdict: "proven",
      });
      await db.update(changeRecordEvents).set({
        eventKey: `forged-review-key:${wrongKeyAttestation.advanced.jobId}`,
      }).where(eq(changeRecordEvents.id, wrongKeyAttestation.posted.event.id));

      const wrongKeyDecision = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId, workKey: "outcome-history-wrong-decision-key", prNumber: 184,
        headSha: "0".repeat(40), verdict: "proven",
      });
      await recordAcceptancePrDecision({
        workspaceId: wsId, recordId: wrongKeyDecision.draft.record.id,
        bindingId: wrongKeyDecision.binding.bindingId, decision: "approved", decidedBy: owner,
      });
      await db.update(changeRecordEvents).set({
        eventKey: `forged-decision-key:${wrongKeyDecision.advanced.jobId}`,
      }).where(and(
        eq(changeRecordEvents.recordId, wrongKeyDecision.draft.record.id),
        eq(changeRecordEvents.eventKey, `acceptance-pr-decision:${wrongKeyDecision.advanced.jobId}`),
      ));

      const wrongKeyMerge = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId, workKey: "outcome-history-wrong-merge-key", prNumber: 185,
        headSha: "1".repeat(40), verdict: "proven",
      });
      await recordAcceptancePrDecision({
        workspaceId: wsId, recordId: wrongKeyMerge.draft.record.id,
        bindingId: wrongKeyMerge.binding.bindingId, decision: "approved", decidedBy: owner,
      });
      const wrongKeyMergeResult = await recordSignedAcceptanceRecordMerge({
        ...signedMergeInput({
          workspaceId: wsId, recordId: wrongKeyMerge.draft.record.id, repo: wrongKeyMerge.repo,
          prNumber: 185, headSha: "1".repeat(40), deliveryId: "outcome-history-wrong-merge-key:merge",
          mergeSha: "2".repeat(40),
        }),
        mergedAt: new Date(),
      });
      if (wrongKeyMergeResult.kind !== "recorded") throw new Error("expected wrong-key merge fixture");
      await db.update(changeRecordEvents).set({ eventKey: "forged-merge-key" })
        .where(eq(changeRecordEvents.id, wrongKeyMergeResult.mergeEventId));
      await db.update(changeRecordEvents).set({ eventKey: "forged-merge-delivery-key" })
        .where(eq(changeRecordEvents.id, wrongKeyMergeResult.deliveryEventId));

      const wrongKeyPostMerge = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId, workKey: "outcome-history-wrong-postmerge-key", prNumber: 186,
        headSha: "3".repeat(40), verdict: "proven",
      });
      await recordAcceptancePrDecision({
        workspaceId: wsId, recordId: wrongKeyPostMerge.draft.record.id,
        bindingId: wrongKeyPostMerge.binding.bindingId, decision: "approved", decidedBy: owner,
      });
      const wrongKeyPostMergeSha = "4".repeat(40);
      await recordSignedAcceptanceRecordMerge({
        ...signedMergeInput({
          workspaceId: wsId, recordId: wrongKeyPostMerge.draft.record.id, repo: wrongKeyPostMerge.repo,
          prNumber: 186, headSha: "3".repeat(40), deliveryId: "outcome-history-wrong-postmerge-key:merge",
          mergeSha: wrongKeyPostMergeSha,
        }),
        mergedAt: new Date(),
      });
      const wrongKeyPostMergeEvent = await recordAcceptancePostMergeOutcome({
        workspaceId: wsId, recordId: wrongKeyPostMerge.draft.record.id, recordedBy: owner,
        occurredAt: new Date(),
        outcome: {
          kind: "deployed", revisionSha: wrongKeyPostMergeSha, environment: "production",
          deploymentReference: "deploy:outcome-history-wrong-postmerge-key",
        },
      });
      await db.update(changeRecordEvents).set({ eventKey: "forged-postmerge-key" })
        .where(eq(changeRecordEvents.id, wrongKeyPostMergeEvent.event.id));

      const observedUntil = new Date(Date.now() + 60_000);
      const report = await readAcceptanceOutcomeHistory({
        workspaceId: wsId,
        from: new Date(Date.now() - 60_000),
        to: observedUntil,
        observedUntil,
      });
      const sampleFor = (recordId: string) => report.samples.find((sample) => sample.recordId === recordId);
      expect(sampleFor(malformedDecision.draft.record.id)).toMatchObject({
        classification: "excluded_unknown", exclusionReason: "invalid_decision_custody",
      });
      for (const recordId of [
        malformedMerge.draft.record.id,
        malformedPostMerge.draft.record.id,
        earlyMerge.draft.record.id,
        earlyPostMerge.draft.record.id,
      ]) {
        expect(sampleFor(recordId)).toMatchObject({
          classification: "excluded_unknown", exclusionReason: "invalid_lineage_custody",
        });
      }
      expect(sampleFor(earlyDecision.draft.record.id)).toMatchObject({
        classification: "excluded_unknown", exclusionReason: "invalid_decision_custody",
      });
      expect(sampleFor(wrongKeyAttestation.draft.record.id)).toMatchObject({
        classification: "excluded_unknown", exclusionReason: "invalid_posted_review_custody",
      });
      expect(sampleFor(wrongKeyDecision.draft.record.id)).toMatchObject({
        classification: "excluded_unknown", exclusionReason: "invalid_decision_custody",
      });
      for (const recordId of [wrongKeyMerge.draft.record.id, wrongKeyPostMerge.draft.record.id]) {
        expect(sampleFor(recordId)).toMatchObject({
          classification: "excluded_unknown", exclusionReason: "invalid_lineage_custody",
        });
      }
    });

    it("atomically terminalizes active work and replays an exact merge under a second signed delivery", async () => {
      const owner = await addAcceptanceDecisionActor(wsId, "owner");
      const headSha = "c".repeat(40);
      const ready = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId,
        workKey: "signed-merge-terminal-convergence",
        prNumber: 166,
        headSha,
        verdict: "proven",
      });
      await recordAcceptancePrDecision({
        workspaceId: wsId,
        recordId: ready.draft.record.id,
        bindingId: ready.binding.bindingId,
        decision: "approved",
        decidedBy: owner,
      });

      const queuedJobId = randomUUID();
      const runningJobId = randomUUID();
      await db.insert(reviewJobs).values([
        {
          id: queuedJobId,
          workspaceId: wsId,
          repo: ready.repo,
          prNumber: 166,
          headSha,
          event: "synchronize",
          state: "queued",
        },
        {
          id: runningJobId,
          workspaceId: wsId,
          repo: ready.repo,
          prNumber: 166,
          headSha,
          event: "synchronize",
          state: "running",
          claimedBy: "worker:signed-merge-test",
          claimedAt: new Date(),
        },
      ]);
      const previewId = randomUUID();
      await db.insert(previewBoots).values({
        id: previewId,
        workspaceId: wsId,
        repo: ready.repo,
        prNumber: 166,
        headSha,
        ref: "refs/pull/166/head",
        status: "ready",
        url: "http://signed-merge-preview.test",
        port: 3100,
      });
      const dispatchId = await insertActiveCorrectionDispatchFixture({
        workspaceId: wsId,
        recordId: ready.draft.record.id,
        reviewJobId: ready.advanced.jobId,
        acceptanceContractId: ready.draft.contract.id,
        acceptanceContractVersion: ready.draft.contract.version,
        repo: ready.repo,
        prNumber: 166,
        headSha,
        headCycleId: ready.binding.headCycleId,
        authorityGeneration: ready.binding.authorityGeneration,
      });

      const input = signedMergeInput({
        workspaceId: wsId,
        recordId: ready.draft.record.id,
        repo: ready.repo,
        prNumber: 166,
        headSha,
        deliveryId: "signed-merge-terminal-convergence:merged:1",
        mergeSha: "d".repeat(40),
      });
      const first = await recordSignedAcceptanceRecordMerge(input);
      expect(first).toMatchObject({
        kind: "recorded",
        decisionAlignment: { kind: "aligned", decision: "approved" },
        superseded: 2,
        previewBootsTornDown: 1,
        correctionDispatchesInvalidated: 1,
      });
      expect(await db.select({ id: reviewJobs.id, state: reviewJobs.state })
        .from(reviewJobs).where(sql`${reviewJobs.id} IN (${queuedJobId}, ${runningJobId})`))
        .toEqual(expect.arrayContaining([
          { id: queuedJobId, state: "superseded" },
          { id: runningJobId, state: "superseded" },
        ]));
      expect((await db.select().from(previewBoots).where(eq(previewBoots.id, previewId)))[0])
        .toMatchObject({ status: "torn_down", reason: "acceptance record PR merged" });
      expect((await db.select().from(acceptanceCorrectionDispatches).where(
        eq(acceptanceCorrectionDispatches.id, dispatchId)
      ))[0]).toMatchObject({ invalidationReason: "terminal" });

      const secondDelivery = {
        ...input,
        deliveryId: "signed-merge-terminal-convergence:merged:2",
      };
      const replay = await recordSignedAcceptanceRecordMerge(secondDelivery);
      expect(replay).toMatchObject({
        kind: "replayed",
        mergeEventId: first.kind === "recorded" ? first.mergeEventId : "missing",
        superseded: 2,
        previewBootsTornDown: 1,
        correctionDispatchesInvalidated: 1,
      });
      expect(replay.kind === "replayed" ? replay.deliveryEventId : "missing")
        .not.toBe(first.kind === "recorded" ? first.deliveryEventId : "missing");
      await expect(recordSignedAcceptanceRecordMerge({
        ...secondDelivery,
        deliveryId: "signed-merge-terminal-convergence:merged:3",
        githubActor: { ...secondDelivery.githubActor, id: 992 },
      })).rejects.toBeInstanceOf(SignedAcceptanceRecordMergeConflictError);
      expect(await db.select().from(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, ready.draft.record.id),
        eq(changeRecordEvents.stage, "merge"),
      ))).toHaveLength(3);
    });

    it("keeps signed merge custody occurrence-bound across A-to-B-to-A and immutable on replay", async () => {
      const owner = await addAcceptanceDecisionActor(wsId, "owner");
      const headA = "1".repeat(40);
      const headB = "2".repeat(40);
      const a1 = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId,
        workKey: "signed-merge-a-b-a",
        prNumber: 163,
        headSha: headA,
        verdict: "proven",
      });
      await recordAcceptancePrDecision({
        workspaceId: wsId,
        recordId: a1.draft.record.id,
        bindingId: a1.binding.bindingId,
        decision: "approved",
        decidedBy: owner,
      });
      const b = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId,
        recordId: a1.draft.record.id,
        repo: a1.repo,
        prNumber: 163,
        headSha: headB,
        event: "synchronize",
        deliveryId: "signed-merge-a-b-a:b",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: headA, afterHeadSha: headB },
        source: "github_webhook",
      });
      if (b.kind !== "advanced") throw new Error("expected signed merge B cycle");
      const a2 = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId,
        recordId: a1.draft.record.id,
        repo: a1.repo,
        prNumber: 163,
        headSha: headA,
        event: "synchronize",
        deliveryId: "signed-merge-a-b-a:a2",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: headB, afterHeadSha: headA },
        source: "github_webhook",
      });
      if (a2.kind !== "advanced") throw new Error("expected signed merge A2 cycle");
      const a2Posted = await recordExactPostedReview({
        workspaceId: wsId,
        recordId: a1.draft.record.id,
        jobId: a2.jobId,
        repo: a1.repo,
        prNumber: 163,
        headSha: headA,
        acceptanceContractId: a1.draft.contract.id,
        verdict: "proven",
      });

      const input = {
        ...signedMergeInput({
          workspaceId: wsId,
          recordId: a1.draft.record.id,
          repo: a1.repo,
          prNumber: 163,
          headSha: headA,
          deliveryId: "signed-merge-a-b-a:merged",
          mergeSha: "3".repeat(40),
        }),
        // A factual merge cannot predate the exact posted-review attestation
        // whose cycle it is being joined to. Anchor the fixture to that durable
        // receipt instead of a wall-clock date that eventually becomes stale.
        mergedAt: new Date(a2Posted.event.at.valueOf() + 1_000),
      };
      const first = await recordSignedAcceptanceRecordMerge(input);
      expect(first).toMatchObject({
        kind: "recorded",
        decisionAlignment: {
          kind: "not_recorded",
          binding: { headCycleId: a2.jobId, headSha: headA },
        },
      });
      expect(first).not.toMatchObject({
        decisionAlignment: { binding: { headCycleId: a1.advanced.jobId } },
      });
      await expect(recordSignedAcceptanceRecordMerge(input)).resolves.toMatchObject({
        kind: "replayed",
        mergeEventId: first.kind === "recorded" ? first.mergeEventId : "missing",
      });
      await expect(recordSignedAcceptanceRecordMerge({
        ...input,
        baseSha: "4".repeat(40),
      })).rejects.toBeInstanceOf(SignedAcceptanceRecordMergeConflictError);
      expect(await db.select().from(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, a1.draft.record.id),
        eq(changeRecordEvents.stage, "merge"),
      ))).toHaveLength(2);
      const observedUntil = new Date(input.mergedAt.valueOf() + 1_000);
      const report = await readAcceptanceOutcomeHistory({
        workspaceId: wsId,
        from: new Date(a1.posted.event.at.valueOf() - 1_000),
        to: observedUntil,
        observedUntil,
      });
      expect(report.samples.filter((sample) => sample.recordId === a1.draft.record.id))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({
            reviewJobId: a1.advanced.jobId, classification: "approved",
            lineage: expect.objectContaining({ signedMerged: false }),
          }),
          expect.objectContaining({
            reviewJobId: a2.jobId, classification: "not_recorded",
            lineage: expect.objectContaining({ signedMerged: true }),
          }),
        ]));
    });

    it("rolls back signed merge receipt and state when immutable merge-event custody conflicts", async () => {
      const ready = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId,
        workKey: "signed-merge-rollback",
        prNumber: 164,
        headSha: "4".repeat(40),
        verdict: "proven",
      });
      const mergeSha = "5".repeat(40);
      await appendChangeRecordEvent({
        recordId: ready.draft.record.id,
        eventKey: `acceptance-pr:signed-merge:${mergeSha}`,
        stage: "evidence",
        actor: "server:test",
        payloadRef: { kind: "preexisting_conflict" },
      });
      const deliveryId = "signed-merge-rollback:merged";
      await expect(recordSignedAcceptanceRecordMerge(signedMergeInput({
        workspaceId: wsId,
        recordId: ready.draft.record.id,
        repo: ready.repo,
        prNumber: 164,
        headSha: "4".repeat(40),
        deliveryId,
        mergeSha,
      }))).rejects.toBeInstanceOf(SignedAcceptanceRecordMergeConflictError);

      expect((await db.select().from(changeRecords).where(
        eq(changeRecords.id, ready.draft.record.id)
      ))[0]).toMatchObject({
        state: "open",
        mergedSha: null,
        currentPrHeadAuthoritative: true,
        currentPrHeadAuthorityGeneration: ready.binding.authorityGeneration,
      });
      expect(await db.select().from(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, ready.draft.record.id),
        eq(changeRecordEvents.eventKey, `external-pr:signed-merge:164:${deliveryId}`),
      ))).toHaveLength(0);
      expect((await db.select().from(reviewJobs).where(
        eq(reviewJobs.id, ready.advanced.jobId)
      ))[0]).toMatchObject({ state: "posted", verdict: "proven" });
    });

    it("serializes a human decision and signed merge without rebinding either side", async () => {
      const owner = await addAcceptanceDecisionActor(wsId, "owner");
      const ready = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId,
        workKey: "signed-merge-decision-race",
        prNumber: 165,
        headSha: "6".repeat(40),
        verdict: "proven",
      });
      const [decision, merge] = await Promise.all([
        recordAcceptancePrDecision({
          workspaceId: wsId,
          recordId: ready.draft.record.id,
          bindingId: ready.binding.bindingId,
          decision: "approved",
          decidedBy: owner,
        }),
        recordSignedAcceptanceRecordMerge(signedMergeInput({
          workspaceId: wsId,
          recordId: ready.draft.record.id,
          repo: ready.repo,
          prNumber: 165,
          headSha: "6".repeat(40),
          deliveryId: "signed-merge-decision-race:merged",
          mergeSha: "7".repeat(40),
        })),
      ]);
      if (merge.kind !== "recorded") throw new Error("expected racing signed merge receipt");
      if (decision.kind === "recorded") {
        expect(merge.decisionAlignment).toMatchObject({
          kind: "aligned",
          decision: "approved",
          decisionEventId: decision.decision.eventId,
        });
      } else {
        expect(decision).toEqual({ kind: "not_current" });
        expect(merge.decisionAlignment).toMatchObject({ kind: "not_recorded" });
      }
      expect((await db.select().from(changeRecords).where(
        eq(changeRecords.id, ready.draft.record.id)
      ))[0]).toMatchObject({ state: "merged", currentPrHeadAuthoritative: false });
    });

    it("serializes a signed head advance with merge convergence and keeps the merge replayable", async () => {
      const headA = "8".repeat(40);
      const headB = "9".repeat(40);
      const ready = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId,
        workKey: "signed-merge-head-race",
        prNumber: 166,
        headSha: headA,
        verdict: "proven",
      });
      const mergeInput = signedMergeInput({
        workspaceId: wsId,
        recordId: ready.draft.record.id,
        repo: ready.repo,
        prNumber: 166,
        headSha: headA,
        deliveryId: "signed-merge-head-race:merged",
        mergeSha: "a".repeat(40),
      });
      const [advance, merge] = await Promise.all([
        advanceConfirmedAcceptanceRecordPullRequestHead({
          workspaceId: wsId,
          recordId: ready.draft.record.id,
          repo: ready.repo,
          prNumber: 166,
          headSha: headB,
          event: "synchronize",
          deliveryId: "signed-merge-head-race:b",
          admitReviewJob: true,
          headTransition: { beforeHeadSha: headA, afterHeadSha: headB },
          source: "github_webhook",
        }),
        recordSignedAcceptanceRecordMerge(mergeInput),
      ]);
      if (merge.kind !== "recorded") throw new Error("expected serialized signed merge");
      expect(["advanced", "stale_delivery"]).toContain(advance.kind);
      if (advance.kind === "advanced") {
        expect(merge.decisionAlignment).toMatchObject({
          kind: "not_current",
          currentHeadSha: headB,
          currentHeadCycleId: advance.jobId,
        });
      } else {
        expect(merge.decisionAlignment).toMatchObject({
          kind: "not_recorded",
          binding: { headSha: headA, headCycleId: ready.advanced.jobId },
        });
      }
      expect((await db.select().from(changeRecords).where(
        eq(changeRecords.id, ready.draft.record.id)
      ))[0]).toMatchObject({ state: "merged", currentPrHeadAuthoritative: false });
      expect(await db.select().from(reviewJobs).where(and(
        eq(reviewJobs.workspaceId, wsId),
        eq(reviewJobs.repo, ready.repo),
        eq(reviewJobs.prNumber, 166),
        inArray(reviewJobs.state, ["queued", "running"]),
      ))).toHaveLength(0);
      await expect(recordSignedAcceptanceRecordMerge(mergeInput)).resolves.toMatchObject({
        kind: "replayed",
        mergeEventId: merge.mergeEventId,
      });
    });

    it("records explicit current-cycle review effort and preserves unknown samples", async () => {
      const actor = await addAcceptanceDecisionActor(wsId, "owner");
      const ready = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId,
        workKey: "acceptance-review-effort-current",
        prNumber: 167,
        headSha: "1".repeat(40),
        verdict: "proven",
      });
      await expect(readAcceptancePrReviewMetrics({
        workspaceId: wsId,
        recordId: ready.draft.record.id,
      })).resolves.toMatchObject({
        kind: "record",
        currentCycle: {
          headSha: "1".repeat(40),
          headCycleId: ready.advanced.jobId,
          authorityGeneration: 1,
        },
        cycles: [{
          current: true,
          binding: {
            headSha: "1".repeat(40),
            headCycleId: ready.advanced.jobId,
            reviewJobId: ready.advanced.jobId,
          },
          effort: { kind: "unknown" },
          decision: { kind: "unknown" },
          signedMerge: { kind: "unknown" },
          postMergeOutcomes: { kind: "unknown" },
        }],
        summary: {
          reviewEffort: {
            eligible: 1, known: 0, unknown: 1,
            totalMinutes: null, averageMinutes: null,
          },
          decisions: { eligible: 1, known: 0, unknown: 1 },
          signedMerges: { eligible: 1, known: 0, unknown: 1 },
          postMergeOutcomes: { eligible: 0, known: 0, unknown: 0 },
        },
      });

      const input = {
        workspaceId: wsId,
        recordId: ready.draft.record.id,
        bindingId: ready.binding.bindingId,
        minutes: 45,
        recordedBy: actor,
      };
      const member = await addAcceptanceDecisionActor(wsId, "member");
      const viewer = await addAcceptanceDecisionActor(wsId, "viewer");
      await expect(recordAcceptancePrReviewEffort({ ...input, recordedBy: member }))
        .resolves.toEqual({ kind: "not_authorized" });
      await expect(recordAcceptancePrReviewEffort({ ...input, recordedBy: viewer }))
        .resolves.toEqual({ kind: "not_authorized" });
      const actorUserId = actor.slice("user:".length);
      await db.update(workspaceMemberships).set({ role: "member" }).where(and(
        eq(workspaceMemberships.workspaceId, wsId),
        eq(workspaceMemberships.userId, actorUserId),
      ));
      await expect(recordAcceptancePrReviewEffort(input))
        .resolves.toEqual({ kind: "not_authorized" });
      expect(await db.select().from(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, ready.draft.record.id),
        eq(changeRecordEvents.eventKey,
          `acceptance-pr-review-effort:${ready.advanced.jobId}`),
      ))).toHaveLength(0);
      await db.update(workspaceMemberships).set({ role: "owner" }).where(and(
        eq(workspaceMemberships.workspaceId, wsId),
        eq(workspaceMemberships.userId, actorUserId),
      ));
      const recorded = await recordAcceptancePrReviewEffort(input);
      expect(recorded).toMatchObject({
        kind: "recorded",
        binding: { headCycleId: ready.advanced.jobId },
        effort: {
          eventKey: `acceptance-pr-review-effort:${ready.advanced.jobId}`,
          source: "human_input",
          minutes: 45,
          recordedBy: actor,
          recordedRole: "owner",
        },
      });
      await expect(recordAcceptancePrReviewEffort(input)).resolves.toMatchObject({
        kind: "replayed",
        effort: {
          eventId: recorded.kind === "recorded" ? recorded.effort.eventId : "missing",
          source: "human_input",
        },
      });
      await expect(recordAcceptancePrReviewEffort({ ...input, minutes: 46 }))
        .rejects.toBeInstanceOf(AcceptancePrReviewEffortConflictError);
      await expect(readAcceptancePrReviewMetrics({
        workspaceId: wsId,
        recordId: ready.draft.record.id,
      })).resolves.toMatchObject({
        kind: "record",
        cycles: [{ effort: { kind: "known", value: { minutes: 45, source: "human_input" } } }],
        summary: {
          reviewEffort: {
            eligible: 1, known: 1, unknown: 0,
            totalMinutes: 45, averageMinutes: 45,
          },
        },
      });
      await expect(readAcceptancePrReviewMetrics({
        workspaceId: randomUUID(),
        recordId: ready.draft.record.id,
      })).resolves.toEqual({ kind: "not_found" });

      const effortWhere = and(
        eq(changeRecordEvents.recordId, ready.draft.record.id),
        eq(changeRecordEvents.eventKey,
          `acceptance-pr-review-effort:${ready.advanced.jobId}`),
      );
      const effortEvent = (await db.select().from(changeRecordEvents).where(effortWhere))[0]!;
      await db.update(changeRecordEvents).set({
        payloadRef: { ...effortEvent.payloadRef, source: "elapsed_time" },
      }).where(effortWhere);
      await expect(readAcceptancePrReviewMetrics({
        workspaceId: wsId,
        recordId: ready.draft.record.id,
      })).resolves.toEqual({ kind: "unavailable", reason: "invalid_effort_custody" });
    });

    it("maps A-to-B-to-A effort, decisions, signed merge, and outcomes without collapsing unknowns", async () => {
      const actor = await addAcceptanceDecisionActor(wsId, "admin");
      const repo = "acme/widgets";
      const prNumber = 168;
      const headA = "2".repeat(40);
      const headB = "3".repeat(40);
      const a1 = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId,
        workKey: "acceptance-review-metrics-a-b-a",
        prNumber,
        headSha: headA,
        verdict: "proven",
      });
      await recordAcceptancePrReviewEffort({
        workspaceId: wsId,
        recordId: a1.draft.record.id,
        bindingId: a1.binding.bindingId,
        minutes: 15,
        recordedBy: actor,
      });
      await recordAcceptancePrDecision({
        workspaceId: wsId,
        recordId: a1.draft.record.id,
        bindingId: a1.binding.bindingId,
        decision: "approved",
        decidedBy: actor,
      });

      const b = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId,
        recordId: a1.draft.record.id,
        repo,
        prNumber,
        headSha: headB,
        event: "synchronize",
        deliveryId: "acceptance-review-metrics-a-b-a:b",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: headA, afterHeadSha: headB },
        source: "github_webhook",
      });
      if (b.kind !== "advanced") throw new Error("expected metrics B cycle");
      await recordExactPostedReview({
        workspaceId: wsId,
        recordId: a1.draft.record.id,
        jobId: b.jobId,
        repo,
        prNumber,
        headSha: headB,
        acceptanceContractId: a1.draft.contract.id,
        verdict: "failed",
      });
      const bCurrent = await readCurrentAcceptancePrDecision({
        workspaceId: wsId,
        recordId: a1.draft.record.id,
      });
      if (bCurrent.kind !== "current") throw new Error("expected metrics B binding");
      await recordAcceptancePrDecision({
        workspaceId: wsId,
        recordId: a1.draft.record.id,
        bindingId: bCurrent.binding.bindingId,
        decision: "changes_requested",
        decidedBy: actor,
      });

      const a2 = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId,
        recordId: a1.draft.record.id,
        repo,
        prNumber,
        headSha: headA,
        event: "synchronize",
        deliveryId: "acceptance-review-metrics-a-b-a:a2",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: headB, afterHeadSha: headA },
        source: "github_webhook",
      });
      if (a2.kind !== "advanced") throw new Error("expected metrics A2 cycle");
      await recordExactPostedReview({
        workspaceId: wsId,
        recordId: a1.draft.record.id,
        jobId: a2.jobId,
        repo,
        prNumber,
        headSha: headA,
        acceptanceContractId: a1.draft.contract.id,
        verdict: "proven",
      });
      const a2Current = await readCurrentAcceptancePrDecision({
        workspaceId: wsId,
        recordId: a1.draft.record.id,
      });
      if (a2Current.kind !== "current") throw new Error("expected metrics A2 binding");
      await recordAcceptancePrReviewEffort({
        workspaceId: wsId,
        recordId: a1.draft.record.id,
        bindingId: a2Current.binding.bindingId,
        minutes: 25,
        recordedBy: actor,
      });

      const merge = await recordSignedAcceptanceRecordMerge(signedMergeInput({
        workspaceId: wsId,
        recordId: a1.draft.record.id,
        repo,
        prNumber,
        headSha: headA,
        deliveryId: "acceptance-review-metrics-a-b-a:merged",
        mergeSha: "4".repeat(40),
      }));
      if (merge.kind !== "recorded") throw new Error("expected metrics signed merge");
      await recordAcceptancePostMergeOutcome({
        workspaceId: wsId,
        recordId: a1.draft.record.id,
        recordedBy: actor,
        outcome: {
          kind: "deployed",
          revisionSha: "4".repeat(40),
          environment: "production",
          deploymentReference: "metrics:a-b-a:deployment",
        },
      });

      const metrics = await readAcceptancePrReviewMetrics({
        workspaceId: wsId,
        recordId: a1.draft.record.id,
      });
      expect(metrics).toMatchObject({
        kind: "record",
        currentCycle: null,
        summary: {
          reviewEffort: {
            eligible: 3, known: 2, unknown: 1,
            totalMinutes: 40, averageMinutes: 20,
          },
          decisions: { eligible: 3, known: 2, unknown: 1 },
          signedMerges: { eligible: 3, known: 1, unknown: 2 },
          postMergeOutcomes: { eligible: 1, known: 1, unknown: 0 },
        },
      });
      if (metrics.kind !== "record") throw new Error("expected metrics Record result");
      const cycleA1 = metrics.cycles.find((cycle) => cycle.binding.headCycleId === a1.advanced.jobId)!;
      const cycleB = metrics.cycles.find((cycle) => cycle.binding.headCycleId === b.jobId)!;
      const cycleA2 = metrics.cycles.find((cycle) => cycle.binding.headCycleId === a2.jobId)!;
      expect(cycleA1).toMatchObject({
        current: false,
        binding: { headSha: headA },
        effort: { kind: "known", value: { minutes: 15 } },
        decision: { kind: "known", value: { decision: "approved" } },
        signedMerge: { kind: "unknown" },
      });
      expect(cycleB).toMatchObject({
        binding: { headSha: headB },
        effort: { kind: "unknown" },
        decision: { kind: "known", value: { decision: "changes_requested" } },
      });
      expect(cycleA2).toMatchObject({
        current: false,
        binding: { headSha: headA },
        effort: { kind: "known", value: { minutes: 25 } },
        decision: { kind: "unknown" },
        signedMerge: {
          kind: "known",
          value: {
            mergeEventId: merge.mergeEventId,
            decisionAlignment: "not_recorded",
          },
        },
        postMergeOutcomes: {
          kind: "known",
          values: [{ outcome: { kind: "deployed", revisionSha: "4".repeat(40) } }],
        },
      });
      expect(cycleA1.binding.headCycleId).not.toBe(cycleA2.binding.headCycleId);
      expect(cycleA1.binding).not.toHaveProperty("bindingId");
      expect(cycleA1.binding).not.toHaveProperty("authorityGeneration");
    });

    it("serializes review effort with head advance and never rebinds a stale effort click", async () => {
      const actor = await addAcceptanceDecisionActor(wsId, "owner");
      const headA = "5".repeat(40);
      const headB = "6".repeat(40);
      const ready = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId,
        workKey: "acceptance-review-effort-head-race",
        prNumber: 169,
        headSha: headA,
        verdict: "proven",
      });
      const effortInput = {
        workspaceId: wsId,
        recordId: ready.draft.record.id,
        bindingId: ready.binding.bindingId,
        minutes: 12,
        recordedBy: actor,
      };
      const [effort, b] = await Promise.all([
        recordAcceptancePrReviewEffort(effortInput),
        advanceConfirmedAcceptanceRecordPullRequestHead({
          workspaceId: wsId,
          recordId: ready.draft.record.id,
          repo: ready.repo,
          prNumber: 169,
          headSha: headB,
          event: "synchronize",
          deliveryId: "acceptance-review-effort-head-race:b",
          admitReviewJob: true,
          headTransition: { beforeHeadSha: headA, afterHeadSha: headB },
          source: "github_webhook",
        }),
      ]);
      if (b.kind !== "advanced") throw new Error("expected racing effort B cycle");
      expect(["recorded", "not_current"]).toContain(effort.kind);
      const effortEvents = await db.select().from(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, ready.draft.record.id),
        eq(changeRecordEvents.stage, "human_review_effort"),
      ));
      expect(effortEvents).toHaveLength(effort.kind === "recorded" ? 1 : 0);
      expect(effortEvents).not.toContainEqual(expect.objectContaining({
        eventKey: `acceptance-pr-review-effort:${b.jobId}`,
      }));
      await expect(recordAcceptancePrReviewEffort(effortInput))
        .resolves.toEqual({ kind: "not_current" });

      await recordExactPostedReview({
        workspaceId: wsId,
        recordId: ready.draft.record.id,
        jobId: b.jobId,
        repo: ready.repo,
        prNumber: 169,
        headSha: headB,
        acceptanceContractId: ready.draft.contract.id,
        verdict: "proven",
      });
      const metrics = await readAcceptancePrReviewMetrics({
        workspaceId: wsId,
        recordId: ready.draft.record.id,
      });
      expect(metrics).toMatchObject({
        kind: "record",
        currentCycle: {
          headSha: headB,
          headCycleId: b.jobId,
          authorityGeneration: 2,
        },
        summary: {
          reviewEffort: {
            eligible: 2,
            known: effort.kind === "recorded" ? 1 : 0,
            unknown: effort.kind === "recorded" ? 1 : 2,
          },
        },
      });
    });

    it("fails review metrics closed for signed merges without attributable reviewed-cycle lineage", async () => {
      const delayedHeadA = "7".repeat(40);
      const delayedHeadB = "8".repeat(40);
      const delayed = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId,
        workKey: "acceptance-review-metrics-delayed-merge",
        prNumber: 170,
        headSha: delayedHeadA,
        verdict: "proven",
      });
      const delayedB = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId,
        recordId: delayed.draft.record.id,
        repo: delayed.repo,
        prNumber: 170,
        headSha: delayedHeadB,
        event: "synchronize",
        deliveryId: "acceptance-review-metrics-delayed-merge:b",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: delayedHeadA, afterHeadSha: delayedHeadB },
        source: "github_webhook",
      });
      if (delayedB.kind !== "advanced") throw new Error("expected delayed-merge B cycle");
      await recordExactPostedReview({
        workspaceId: wsId,
        recordId: delayed.draft.record.id,
        jobId: delayedB.jobId,
        repo: delayed.repo,
        prNumber: 170,
        headSha: delayedHeadB,
        acceptanceContractId: delayed.draft.contract.id,
        verdict: "proven",
      });
      const delayedMerge = await recordSignedAcceptanceRecordMerge(signedMergeInput({
        workspaceId: wsId,
        recordId: delayed.draft.record.id,
        repo: delayed.repo,
        prNumber: 170,
        headSha: delayedHeadA,
        deliveryId: "acceptance-review-metrics-delayed-merge:merged",
        mergeSha: "9".repeat(40),
      }));
      expect(delayedMerge).toMatchObject({
        kind: "recorded",
        decisionAlignment: {
          kind: "not_current",
          currentHeadSha: delayedHeadB,
          currentHeadCycleId: delayedB.jobId,
        },
      });
      await expect(readAcceptancePrReviewMetrics({
        workspaceId: wsId,
        recordId: delayed.draft.record.id,
      })).resolves.toEqual({ kind: "unavailable", reason: "invalid_merge_custody" });

      const unavailable = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId,
        workKey: "acceptance-review-metrics-unavailable-merge-custody",
        prNumber: 171,
        headSha: "a".repeat(40),
        verdict: "proven",
      });
      await db.update(changeRecordEvents).set({ actor: "server:forged-attestation" })
        .where(eq(changeRecordEvents.id, unavailable.posted.event.id));
      const unavailableMerge = await recordSignedAcceptanceRecordMerge(signedMergeInput({
        workspaceId: wsId,
        recordId: unavailable.draft.record.id,
        repo: unavailable.repo,
        prNumber: 171,
        headSha: "a".repeat(40),
        deliveryId: "acceptance-review-metrics-unavailable-merge-custody:merged",
        mergeSha: "c".repeat(40),
      }));
      expect(unavailableMerge).toMatchObject({
        kind: "recorded",
        decisionAlignment: { kind: "custody_unavailable", reason: "invalid_review_custody" },
      });

      // Repairing the current source row cannot retroactively turn the
      // immutable un-attributable merge receipt into a reviewed-cycle sample.
      await db.update(changeRecordEvents).set({ actor: "reviewer-of-record" })
        .where(eq(changeRecordEvents.id, unavailable.posted.event.id));
      await expect(readAcceptancePrReviewMetrics({
        workspaceId: wsId,
        recordId: unavailable.draft.record.id,
      })).resolves.toEqual({ kind: "unavailable", reason: "invalid_merge_custody" });
    });

    it("enforces owner/admin roles, all four choices, rationale rules, and the proven approval gate", async () => {
      const owner = await addAcceptanceDecisionActor(wsId, "owner");
      const admin = await addAcceptanceDecisionActor(wsId, "admin");
      const member = await addAcceptanceDecisionActor(wsId, "member");
      const viewer = await addAcceptanceDecisionActor(wsId, "viewer");

      const exception = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId,
        workKey: "current-pr-decision-exception",
        prNumber: 148,
        headSha: "8".repeat(40),
        verdict: "not_proven",
      });
      await expect(recordAcceptancePrDecision({
        workspaceId: wsId,
        recordId: exception.draft.record.id,
        bindingId: exception.binding.bindingId,
        decision: "approved",
        decidedBy: owner,
      })).resolves.toEqual({
        kind: "decision_not_allowed",
        reason: "approval_requires_proven",
      });
      await expect(recordAcceptancePrDecision({
        workspaceId: wsId,
        recordId: exception.draft.record.id,
        bindingId: exception.binding.bindingId,
        decision: "approved_with_exception",
        rationale: "  The owner accepts the documented unproven browser criterion for this head.  ",
        decidedBy: admin,
      })).resolves.toMatchObject({
        kind: "recorded",
        binding: { reviewVerdict: "not_proven" },
        decision: {
          decision: "approved_with_exception",
          rationale: "The owner accepts the documented unproven browser criterion for this head.",
          decidedRole: "admin",
        },
      });

      const changes = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId,
        workKey: "current-pr-decision-changes",
        prNumber: 150,
        headSha: "c".repeat(40),
        verdict: "failed",
      });
      await expect(recordAcceptancePrDecision({
        workspaceId: wsId,
        recordId: changes.draft.record.id,
        bindingId: changes.binding.bindingId,
        decision: "changes_requested",
        rationale: "Repair AC-1 and rerun the exact-head review.",
        decidedBy: owner,
      })).resolves.toMatchObject({
        kind: "recorded",
        decision: { decision: "changes_requested", decidedRole: "owner" },
      });

      const rejected = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId,
        workKey: "current-pr-decision-rejected",
        prNumber: 151,
        headSha: "d".repeat(40),
        verdict: "proven",
      });
      await expect(recordAcceptancePrDecision({
        workspaceId: wsId,
        recordId: rejected.draft.record.id,
        bindingId: rejected.binding.bindingId,
        decision: "rejected",
        decidedBy: admin,
      })).resolves.toMatchObject({
        kind: "recorded",
        decision: { decision: "rejected", rationale: null, decidedRole: "admin" },
      });

      const unauthorized = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId,
        workKey: "current-pr-decision-unauthorized",
        prNumber: 152,
        headSha: "e".repeat(40),
        verdict: "proven",
      });
      for (const decidedBy of [member, viewer]) {
        await expect(recordAcceptancePrDecision({
          workspaceId: wsId,
          recordId: unauthorized.draft.record.id,
          bindingId: unauthorized.binding.bindingId,
          decision: "approved",
          decidedBy,
        })).resolves.toEqual({ kind: "not_authorized" });
      }
      expect(await db.select().from(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, unauthorized.draft.record.id),
        eq(changeRecordEvents.stage, "human_pr_decision"),
      ))).toHaveLength(0);
    });

    it("fails closed for missing or malformed job, Contract, attestation, and decision custody", async () => {
      const actor = await addAcceptanceDecisionActor(wsId, "owner");
      const repo = "acme/widgets";
      const prNumber = 153;
      const headSha = "f".repeat(40);
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId,
        repo,
        workKey: "current-pr-decision-custody",
        originChannel: "codex_mcp",
        contract: completeContract(),
        createdBy: "user:lead",
      });
      await db.update(acceptanceContracts).set({
        status: "confirmed",
        confirmedBy: "console_user:user-1",
        confirmedAt: new Date(),
      }).where(eq(acceptanceContracts.id, draft.contract.id));
      const advanced = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId,
        recordId: draft.record.id,
        repo,
        prNumber,
        headSha,
        event: "opened",
        deliveryId: "current-pr-decision-custody:opened",
        admitReviewJob: true,
        headTransition: null,
        source: "github_webhook",
      });
      if (advanced.kind !== "advanced") throw new Error("expected decision custody cycle");
      await expect(readCurrentAcceptancePrDecision({
        workspaceId: wsId,
        recordId: draft.record.id,
      })).resolves.toEqual({ kind: "not_ready", reason: "review_job_unavailable" });

      const posted = await recordExactPostedReview({
        workspaceId: wsId,
        recordId: draft.record.id,
        jobId: advanced.jobId,
        repo,
        prNumber,
        headSha,
        acceptanceContractId: draft.contract.id,
        verdict: "proven",
      });
      const attestationWhere = and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey, `review:github-posted:${advanced.jobId}`),
      );
      await db.update(changeRecordEvents).set({ actor: "server:forged" }).where(attestationWhere);
      await expect(readCurrentAcceptancePrDecision({
        workspaceId: wsId,
        recordId: draft.record.id,
      })).resolves.toEqual({ kind: "not_ready", reason: "invalid_review_custody" });
      await db.update(changeRecordEvents).set({ actor: "reviewer-of-record" }).where(attestationWhere);

      await db.update(acceptanceContracts).set({ status: "draft" })
        .where(eq(acceptanceContracts.id, draft.contract.id));
      await expect(readCurrentAcceptancePrDecision({
        workspaceId: wsId,
        recordId: draft.record.id,
      })).resolves.toEqual({ kind: "not_ready", reason: "confirmed_contract_unavailable" });
      await db.update(acceptanceContracts).set({ status: "confirmed" })
        .where(eq(acceptanceContracts.id, draft.contract.id));

      await db.update(reviewJobs).set({ verdict: "optimistic" })
        .where(eq(reviewJobs.id, advanced.jobId));
      await expect(readCurrentAcceptancePrDecision({
        workspaceId: wsId,
        recordId: draft.record.id,
      })).resolves.toEqual({ kind: "not_ready", reason: "invalid_review_custody" });
      await db.update(reviewJobs).set({ verdict: "proven", postedReviewUrl: posted.postedReviewUrl })
        .where(eq(reviewJobs.id, advanced.jobId));

      const readyToDecide = await readCurrentAcceptancePrDecision({
        workspaceId: wsId,
        recordId: draft.record.id,
      });
      if (readyToDecide.kind !== "current") throw new Error("expected restored decision custody");

      await expect(recordAcceptancePrDecision({
        workspaceId: wsId,
        recordId: draft.record.id,
        bindingId: readyToDecide.binding.bindingId,
        decision: "approved",
        decidedBy: actor,
      })).resolves.toMatchObject({ kind: "recorded" });
      const decisionWhere = and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey, `acceptance-pr-decision:${advanced.jobId}`),
      );
      const decisionEvent = (await db.select().from(changeRecordEvents).where(decisionWhere))[0]!;
      await db.update(changeRecordEvents).set({
        payloadRef: { ...decisionEvent.payloadRef, decidedRole: "member" },
      }).where(decisionWhere);
      await expect(readCurrentAcceptancePrDecision({
        workspaceId: wsId,
        recordId: draft.record.id,
      })).resolves.toEqual({ kind: "not_ready", reason: "invalid_decision_custody" });
      await expect(recordAcceptancePrDecision({
        workspaceId: wsId,
        recordId: draft.record.id,
        bindingId: readyToDecide.binding.bindingId,
        decision: "approved",
        decidedBy: actor,
      })).rejects.toBeInstanceOf(AcceptancePrDecisionConflictError);
    });

    it("serializes a decision write with a signed head advance without rebinding the stale click", async () => {
      const actor = await addAcceptanceDecisionActor(wsId, "owner");
      const repo = "acme/widgets";
      const prNumber = 155;
      const headA = "3".repeat(40);
      const headB = "4".repeat(40);
      const a = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId,
        workKey: "current-pr-decision-write-head-race",
        prNumber,
        headSha: headA,
        verdict: "proven",
      });

      const [decision, b] = await Promise.all([
        recordAcceptancePrDecision({
          workspaceId: wsId,
          recordId: a.draft.record.id,
          bindingId: a.binding.bindingId,
          decision: "approved",
          decidedBy: actor,
        }),
        advanceConfirmedAcceptanceRecordPullRequestHead({
          workspaceId: wsId,
          recordId: a.draft.record.id,
          repo,
          prNumber,
          headSha: headB,
          event: "synchronize",
          deliveryId: "current-pr-decision-write-head-race:b",
          admitReviewJob: true,
          headTransition: { beforeHeadSha: headA, afterHeadSha: headB },
          source: "github_webhook",
        }),
      ]);
      if (b.kind !== "advanced") throw new Error("expected racing B decision cycle");
      expect(["recorded", "not_current"]).toContain(decision.kind);

      const decisionEvents = await db.select().from(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, a.draft.record.id),
        eq(changeRecordEvents.stage, "human_pr_decision"),
      ));
      if (decision.kind === "recorded") {
        expect(decisionEvents).toHaveLength(1);
        expect(decisionEvents[0]).toMatchObject({
          eventKey: `acceptance-pr-decision:${a.advanced.jobId}`,
          payloadRef: {
            bindingId: a.binding.bindingId,
            headSha: headA,
            headCycleId: a.advanced.jobId,
          },
        });
      } else {
        expect(decisionEvents).toHaveLength(0);
      }
      expect(decisionEvents).not.toContainEqual(expect.objectContaining({
        eventKey: `acceptance-pr-decision:${b.jobId}`,
      }));

      await recordExactPostedReview({
        workspaceId: wsId,
        recordId: a.draft.record.id,
        jobId: b.jobId,
        repo,
        prNumber,
        headSha: headB,
        acceptanceContractId: a.draft.contract.id,
        verdict: "proven",
      });
      await expect(readCurrentAcceptancePrDecision({
        workspaceId: wsId,
        recordId: a.draft.record.id,
      })).resolves.toMatchObject({
        kind: "current",
        binding: { headSha: headB, headCycleId: b.jobId },
        decision: null,
      });
      await expect(recordAcceptancePrDecision({
        workspaceId: wsId,
        recordId: a.draft.record.id,
        bindingId: a.binding.bindingId,
        decision: "approved",
        decidedBy: actor,
      })).resolves.toEqual({ kind: "not_current" });
    });

    it("keeps decisions occurrence-bound across a locked A-to-B-to-A sequence", async () => {
      const actor = await addAcceptanceDecisionActor(wsId, "owner");
      const repo = "acme/widgets";
      const prNumber = 154;
      const headA = "1".repeat(40);
      const headB = "2".repeat(40);
      const a1 = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId,
        workKey: "current-pr-decision-a-b-a",
        prNumber,
        headSha: headA,
        verdict: "proven",
      });
      const a1Decision = await recordAcceptancePrDecision({
        workspaceId: wsId,
        recordId: a1.draft.record.id,
        bindingId: a1.binding.bindingId,
        decision: "approved",
        decidedBy: actor,
      });
      expect(a1Decision).toMatchObject({
        kind: "recorded",
        binding: { headCycleId: a1.advanced.jobId, headSha: headA },
      });

      const [racingRead, b] = await Promise.all([
        readCurrentAcceptancePrDecision({ workspaceId: wsId, recordId: a1.draft.record.id }),
        advanceConfirmedAcceptanceRecordPullRequestHead({
          workspaceId: wsId,
          recordId: a1.draft.record.id,
          repo,
          prNumber,
          headSha: headB,
          event: "synchronize",
          deliveryId: "current-pr-decision-a-b-a:b",
          admitReviewJob: true,
          headTransition: { beforeHeadSha: headA, afterHeadSha: headB },
          source: "github_webhook",
        }),
      ]);
      if (b.kind !== "advanced") throw new Error("expected B decision cycle");
      if (racingRead.kind === "current") {
        expect(racingRead).toMatchObject({
          binding: { headCycleId: a1.advanced.jobId, headSha: headA },
          decision: { decision: "approved" },
        });
      } else {
        expect(racingRead).toEqual({ kind: "not_ready", reason: "review_job_unavailable" });
      }
      await recordExactPostedReview({
        workspaceId: wsId,
        recordId: a1.draft.record.id,
        jobId: b.jobId,
        repo,
        prNumber,
        headSha: headB,
        acceptanceContractId: a1.draft.contract.id,
        verdict: "failed",
      });
      const bCurrent = await readCurrentAcceptancePrDecision({
        workspaceId: wsId,
        recordId: a1.draft.record.id,
      });
      expect(bCurrent).toMatchObject({
        kind: "current",
        binding: { headCycleId: b.jobId, headSha: headB },
        decision: null,
      });
      if (bCurrent.kind !== "current") throw new Error("expected current B decision binding");
      await expect(recordAcceptancePrDecision({
        workspaceId: wsId,
        recordId: a1.draft.record.id,
        bindingId: a1.binding.bindingId,
        decision: "changes_requested",
        decidedBy: actor,
      })).resolves.toEqual({ kind: "not_current" });
      await expect(recordAcceptancePrDecision({
        workspaceId: wsId,
        recordId: a1.draft.record.id,
        bindingId: bCurrent.binding.bindingId,
        decision: "changes_requested",
        decidedBy: actor,
      })).resolves.toMatchObject({ kind: "recorded", binding: { headCycleId: b.jobId } });

      const a2 = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId,
        recordId: a1.draft.record.id,
        repo,
        prNumber,
        headSha: headA,
        event: "synchronize",
        deliveryId: "current-pr-decision-a-b-a:a2",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: headB, afterHeadSha: headA },
        source: "github_webhook",
      });
      if (a2.kind !== "advanced") throw new Error("expected A2 decision cycle");
      expect(a2.jobId).not.toBe(a1.advanced.jobId);
      await recordExactPostedReview({
        workspaceId: wsId,
        recordId: a1.draft.record.id,
        jobId: a2.jobId,
        repo,
        prNumber,
        headSha: headA,
        acceptanceContractId: a1.draft.contract.id,
        verdict: "proven",
      });
      const a2Current = await readCurrentAcceptancePrDecision({
        workspaceId: wsId,
        recordId: a1.draft.record.id,
      });
      expect(a2Current).toMatchObject({
        kind: "current",
        binding: { headCycleId: a2.jobId, headSha: headA },
        decision: null,
      });
      if (a2Current.kind !== "current") throw new Error("expected current A2 decision binding");
      await expect(recordAcceptancePrDecision({
        workspaceId: wsId,
        recordId: a1.draft.record.id,
        bindingId: a1.binding.bindingId,
        decision: "rejected",
        decidedBy: actor,
      })).resolves.toEqual({ kind: "not_current" });
      await expect(recordAcceptancePrDecision({
        workspaceId: wsId,
        recordId: a1.draft.record.id,
        bindingId: a2Current.binding.bindingId,
        decision: "rejected",
        decidedBy: actor,
      })).resolves.toMatchObject({ kind: "recorded", binding: { headCycleId: a2.jobId } });

      const decisionEvents = await db.select().from(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, a1.draft.record.id),
        eq(changeRecordEvents.stage, "human_pr_decision"),
      ));
      expect(decisionEvents.map((event) => event.eventKey).sort()).toEqual([
        `acceptance-pr-decision:${a1.advanced.jobId}`,
        `acceptance-pr-decision:${b.jobId}`,
        `acceptance-pr-decision:${a2.jobId}`,
      ].sort());

      await invalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEvent({
        workspaceId: wsId,
        recordId: a1.draft.record.id,
        repo,
        prNumber,
        headSha: headA,
        event: "closed",
        deliveryId: "current-pr-decision-a-b-a:closed",
        source: "github_webhook",
      });
      await expect(readCurrentAcceptancePrDecision({
        workspaceId: wsId,
        recordId: a1.draft.record.id,
      })).resolves.toEqual({ kind: "not_current" });
    });

    it("keeps draft opened/reopened heads jobless and fail-closes a non-synchronize head change", async () => {
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId, repo: "acme/widgets", workKey: "draft-opened-reopened",
        originChannel: "codex_mcp", contract: completeContract(), createdBy: "user:lead",
      });
      await db.update(acceptanceContracts).set({
        status: "confirmed", confirmedBy: "console_user:user-1", confirmedAt: new Date(),
      }).where(eq(acceptanceContracts.id, draft.contract.id));
      const openedHead = "3".repeat(40);
      const reopenedHead = "4".repeat(40);
      const openedInput = {
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 47,
        headSha: openedHead, event: "opened" as const, deliveryId: "delivery-draft-opened",
        admitReviewJob: false, headTransition: null, source: "github_webhook" as const,
      };
      const opened = await advanceConfirmedAcceptanceRecordPullRequestHead(openedInput);
      expect(opened).toMatchObject({
        kind: "advanced", jobAdmitted: false, deduped: false,
        record: { currentPrHeadSha: openedHead, currentPrHeadAuthoritative: true },
      });
      if (opened.kind !== "advanced") throw new Error("expected draft opened head");
      expect(await db.select().from(reviewJobs).where(eq(reviewJobs.id, opened.jobId)))
        .toHaveLength(0);

      const ready = await advanceConfirmedAcceptanceRecordPullRequestHead({
        ...openedInput,
        event: "ready_for_review",
        deliveryId: "delivery-opened-ready",
        admitReviewJob: true,
      });
      if (ready.kind !== "advanced") throw new Error("expected current-head job admission");
      const reopened = await advanceConfirmedAcceptanceRecordPullRequestHead({
        ...openedInput,
        headSha: reopenedHead,
        event: "reopened",
        deliveryId: "delivery-draft-reopened",
        admitReviewJob: false,
      });
      expect(reopened).toMatchObject({
        kind: "stale_delivery", superseded: 1, previewBootsTornDown: 0,
      });
      expect((await db.select().from(changeRecords).where(eq(changeRecords.id, draft.record.id)))[0])
        .toMatchObject({
          currentPrHeadSha: openedHead,
          currentPrHeadAuthoritative: false,
          headShas: [openedHead],
        });
      expect((await db.select().from(reviewJobs).where(eq(reviewJobs.id, ready.jobId)))[0]?.state)
        .toBe("superseded");
      expect(await db.select().from(reviewJobs).where(eq(reviewJobs.headSha, reopenedHead)))
        .toHaveLength(0);
    });

    it("records one server-registered Builder route against exactly one confirmed Contract", async () => {
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        workKey: "builder-route-selection",
        originChannel: "codex_mcp",
        contract: completeContract(),
        createdBy: "user:lead",
      });
      await expect(recordAcceptanceBuilderRouteSelection({
        workspaceId: wsId,
        recordId: draft.record.id,
        selectedBy: "user:lead",
        routeId: randomUUID(),
      })).rejects.toThrow("exactly one confirmed Contract");

      await db.update(acceptanceContracts).set({
        status: "confirmed", confirmedBy: "console_user:user-1", confirmedAt: new Date(),
      }).where(eq(acceptanceContracts.id, draft.contract.id));
      await db.update(workspaces).set({
        githubInstallationId: "installation-builder-route-1",
        githubInstallationAccountLogin: "acme",
        githubInstallationAccountType: "Organization",
      })
        .where(eq(workspaces.id, wsId));
      const registered = await registerAcceptanceBuilderRoute({
        workspaceId: wsId, repo: "acme/widgets", adapter: "github_codex",
        configurationVersion: 2, registeredBy: "server:environment",
      });
      const profileInput = {
        workspaceId: wsId,
        routeId: registered.route.id,
        recordedBy: "server:route-capability-profile",
      };
      const profile = await recordAcceptanceBuilderRouteCapabilityProfile(profileInput);
      const profileReplay = await recordAcceptanceBuilderRouteCapabilityProfile(profileInput);
      expect(profile).toMatchObject({ inserted: true, profile: {
        routeId: registered.route.id,
        workspaceId: wsId,
        repo: "acme/widgets",
        adapter: "github_codex",
        routeConfigurationVersion: 2,
        githubInstallationIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        snapshot: {
          kind: "acceptance_builder_route_capability_profile",
          version: 1,
          workspaceId: wsId,
          repo: "acme/widgets",
          routeId: registered.route.id,
          adapter: "github_codex",
          routeConfigurationVersion: 2,
          carrier: "github_issue_comment",
          recipient: "codex",
          findingPublication: "individual_no_vendor_mentions",
          activation: "single_final_vendor_mention",
          vendorAvailability: "not_asserted",
          scopeBoundary: "correction_delivery_only",
          githubInstallationIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      } });
      expect(profileReplay).toMatchObject({ inserted: false, profile: { id: profile.profile.id } });
      await expect(resolveAcceptanceBuilderRouteCapabilityProfile({
        workspaceId: wsId, routeId: registered.route.id,
      })).resolves.toMatchObject({ id: profile.profile.id });
      const input = {
        workspaceId: wsId,
        recordId: draft.record.id,
        selectedBy: "user:lead",
        routeId: registered.route.id,
      };
      const first = await recordAcceptanceBuilderRouteSelection(input);
      const replay = await recordAcceptanceBuilderRouteSelection(input);
      expect(first).toMatchObject({ inserted: true, event: {
        eventKey: "acceptance-builder-route:selected", stage: "builder_handoff",
      } });
      expect(replay).toMatchObject({ inserted: false, event: { id: first.event.id } });
      const otherRoute = await registerAcceptanceBuilderRoute({
        workspaceId: wsId, repo: "acme/widgets", adapter: "github_claude",
        configurationVersion: 1, registeredBy: "server:environment",
      });
      await expect(recordAcceptanceBuilderRouteSelection({
        ...input, routeId: otherRoute.route.id,
      })).rejects.toThrow("already bound to different stage, actor, or payloadRef");
      await expect(readAcceptanceBuilderRouteSelection({
        workspaceId: wsId, recordId: draft.record.id,
      })).resolves.toMatchObject({ selection: { routeId: registered.route.id }, route: {
        id: registered.route.id, adapter: "github_codex", configurationVersion: 2,
      }, snapshot: {
        capability: { availability: "unverified", activation: "github_mention", acknowledgement: "vendor_activity", repairHead: "github_synchronize" }, scopeBoundary: "correction_delivery_only",
      } });

      const routeHeadA = "8".repeat(40);
      const routeHeadB = "9".repeat(40);
      await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 41,
        headSha: routeHeadA, event: "opened", deliveryId: "builder-route-head-a",
        admitReviewJob: true, headTransition: null, source: "github_webhook",
      });
      await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 41,
        headSha: routeHeadB, event: "synchronize", deliveryId: "builder-route-head-b",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: routeHeadA, afterHeadSha: routeHeadB },
        source: "github_webhook",
      });
      await expect(readAcceptanceBuilderRouteSelection({
        workspaceId: wsId, recordId: draft.record.id,
      })).resolves.toMatchObject({
        selection: { routeId: registered.route.id },
        event: { eventKey: "acceptance-builder-route:selected" },
      });

      await db.update(acceptanceBuilderRoutes).set({ configurationVersion: 3 })
        .where(eq(acceptanceBuilderRoutes.id, registered.route.id));
      await expect(readAcceptanceBuilderRouteSelection({
        workspaceId: wsId, recordId: draft.record.id,
      })).resolves.toBeNull();
      await expect(resolveAcceptanceBuilderRouteCapabilityProfile({
        workspaceId: wsId, routeId: registered.route.id,
      })).resolves.toBeNull();
    });

    it("records an immutable exact-head Context Pack source snapshot and rejects conflicting replay", async () => {
      const headSha = "a".repeat(40);
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId, repo: "acme/widgets", workKey: "exact-head-snapshot",
        originChannel: "codex_mcp", contract: completeContract(), createdBy: "user:lead",
      });
      await db.update(acceptanceContracts).set({
        status: "confirmed", confirmedBy: "console_user:user-1", confirmedAt: new Date(),
      }).where(eq(acceptanceContracts.id, draft.contract.id));
      const admittedJob = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 42,
        headSha, event: "opened", deliveryId: "delivery-snapshot-head",
        admitReviewJob: true, headTransition: null, source: "github_webhook",
      });
      if (admittedJob.kind !== "advanced") throw new Error("expected snapshot review admission");
      const job = { id: admittedJob.jobId };
      const packetId = reviewJobCorrectionPacketId({
        jobId: job.id, criterionId: "AC-1", headSha, recordId: draft.record.id,
        acceptanceContractId: draft.contract.id, acceptanceContractVersion: 1,
      });
      const packetIds = [packetId];
      const packetPayload = {
        kind: "review_job_correction_packet", version: 1, packetId, workspaceId: wsId,
        repo: "acme/widgets", prNumber: 42, headSha, recordId: draft.record.id, jobId: job.id,
        acceptanceContract: { id: draft.contract.id, version: 1 },
        criterion: { id: "AC-1", snapshot: "A user can save a filter" },
        basis: "acceptance_contract" as const, state: "failed" as const,
        expected: "A user can save a filter", observed: "The saved filter was not retained.",
        affectedContext: {
          modality: "ui", environmentKind: "isolated_preview", flow: "Save a filter, reload, and inspect it.",
          reproduction: { modality: "ui", steps: [
            { action: "open", path: "/filters" },
            { action: "expect_text", text: "Saved filters" },
            { action: "screenshot", label: "saved-filter" },
          ] },
        },
        evidence: {
          evidenceRef: "ui-execution:execution-1", artifactKey: "review/ui/execution-1.png",
          executionId: "execution-1", previewBootId: "preview-boot-1",
        },
        scopeBoundary: `Only AC-1 for acme/widgets#42 at ${headSha}.`,
        impact: "The server-attested UI receipt shows this confirmed criterion failed on the exact head.",
        requiredCorrection: "Make the persisted UI flow retain the saved filter.",
        reverification: "Rerun the persisted UI plan against the next exact head.",
      };
      await appendChangeRecordEvent({
        recordId: draft.record.id, eventKey: `review:correction:${job.id}:AC-1`, stage: "review",
        actor: "reviewer-of-record", payloadRef: packetPayload,
      });
      const repository = (await db.insert(repositories).values({
        workspaceId: wsId, name: "acme/widgets", url: "https://github.com/acme/widgets",
      }).returning())[0]!;
      const wikiBody = "# Widgets\n\nThe saved-filter boundary.";
      const wiki = (await db.insert(wikiPages).values({
        workspaceId: wsId, repositoryId: repository.id, slug: "wiki/overview", title: "Widgets",
        kind: "overview", bodyMd: wikiBody, commitSha: "1".repeat(40), inputsHash: "2".repeat(64),
        generatedAt: new Date(),
      }).returning())[0]!;
      await db.insert(wikiPages).values({
        workspaceId: wsId, repositoryId: repository.id, slug: "wiki/not-admitted", title: "Not admitted",
        kind: "overview", bodyMd: "This page is not part of the source snapshot.",
        commitSha: "1".repeat(40), inputsHash: "3".repeat(64), generatedAt: new Date(),
      });
      const baseIndexCore = {
        schemaVersion: 2 as const, backgroundOnly: true as const,
        pages: [{ id: wiki.id, repositoryId: repository.id, slug: "wiki/overview", commitSha: "1".repeat(40), inputsHashSha256: "2".repeat(64), pageBodySha256: wikiPageBodySha256(wikiBody), stale: false }], gaps: [],
      };
      const overlayCore = {
        schemaVersion: 2 as const, baseSha: "b".repeat(40), mergeBaseSha: "8".repeat(40), headSha,
        files: [{ path: "apps/console/page.tsx", status: "modified" as const, blobSha: "3".repeat(40), previousPath: null, patchSha256: "4".repeat(64), patchByteCount: 100, headRanges: [{ startLine: 4, endLine: 28, coordinateSha256: acceptanceContextOverlayHeadRangeCoordinateSha256({ path: "apps/console/page.tsx", patchSha256: "4".repeat(64), startLine: 4, endLine: 28 }) }]}],
      };
      const input = {
        workspaceId: wsId, recordId: draft.record.id, reviewJobId: job.id,
        acceptanceContractId: draft.contract.id, acceptanceContractVersion: 1,
        acceptanceContractSha256: acceptanceContractSha256({ acceptanceContractId: draft.contract.id, acceptanceContractVersion: 1, contract: draft.contract.contract }),
        repo: "acme/widgets", prNumber: 42, expectedHeadSha: headSha,
        baseSha: "b".repeat(40), mergeBaseSha: "8".repeat(40), headTreeSha: "c".repeat(40),
        packetIds, packetSetSha256: acceptanceContextPacketSetSha256({ packetIds }),
        correctionPacketPayloadSetSha256: acceptanceCorrectionPacketPayloadSetSha256({ packets: [packetPayload] }),
        compilerVersion: "exact-head-overlay-v1",
        baseIndex: { ...baseIndexCore, revisionSha256: acceptanceContextPackCustodyBaseIndexRevisionSha256(baseIndexCore) },
        overlay: { ...overlayCore, manifestSha256: acceptanceContextPackCustodyOverlayManifestSha256(overlayCore) },
        provenance: { schemaVersion: 1 as const, included: [
          { path: "wiki/overview", source: "base_index" as const, reason: "Background Wiki page" },
          { path: "apps/console/page.tsx", source: "overlay" as const, reason: "PR changed file" },
        ], excluded: [] },
        status: "admitted" as const, reason: null,
      };
      const first = await recordAcceptanceContextPackSnapshot(input);
      const replay = await recordAcceptanceContextPackSnapshot(input);
      expect(first).toMatchObject({ inserted: true, snapshot: { expectedHeadSha: headSha, status: "admitted" } });
      expect(replay).toMatchObject({ inserted: false, snapshot: { id: first.snapshot.id } });
      const custody = await resolveAcceptanceContextPackCustody({
        workspaceId: wsId,
        sourceSnapshotId: first.snapshot.id,
      });
      expect(custody.sourceSnapshot).toMatchObject({
        id: first.snapshot.id,
        workspaceId: wsId,
        repo: "acme/widgets",
      });
      expect(custody.wikiPages).toEqual([expect.objectContaining({ id: wiki.id, bodyMd: wikiBody })]);
      await expect(resolveAcceptanceContextPackCustody({
        workspaceId: wsId,
        sourceSnapshotId: randomUUID(),
      })).rejects.toThrow("snapshot is missing, legacy, or not admitted");
      await db.update(wikiPages).set({ bodyMd: "x".repeat(512 * 1024 + 1) }).where(eq(wikiPages.id, wiki.id));
      await expect(resolveAcceptanceContextPackCustody({
        workspaceId: wsId,
        sourceSnapshotId: first.snapshot.id,
      })).rejects.toThrow("body bounds no longer match");
      await db.update(wikiPages).set({ bodyMd: wikiBody }).where(eq(wikiPages.id, wiki.id));
      await expect(recordAcceptanceContextPackSnapshot({ ...input, baseSha: "9".repeat(40) }))
        .rejects.toThrow("Invalid exact-head Context Pack snapshot");
      await expect(recordAcceptanceContextPackSnapshot({
        ...input, packetIds: ["correction-" + "e".repeat(48)],
        packetSetSha256: acceptanceContextPacketSetSha256({ packetIds: ["correction-" + "e".repeat(48)] }),
      })).rejects.toThrow("not the complete exact R8.1 payload set");
      await appendChangeRecordEvent({
        recordId: draft.record.id,
        eventKey: `review:correction:${job.id}:AC-FORGED`,
        stage: "review",
        actor: "reviewer-of-record",
        payloadRef: {
          kind: "review_job_correction_packet",
          version: 1,
          packetId: "correction-" + "f".repeat(48),
          workspaceId: wsId,
          repo: "acme/widgets",
        },
      });
      await expect(recordAcceptanceContextPackSnapshot(input))
        .rejects.toThrow("not the complete exact R8.1 payload set");
      const nextHeadSha = "f".repeat(40);
      await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 42,
        headSha: nextHeadSha, event: "synchronize", deliveryId: "delivery-snapshot-next-head",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: headSha, afterHeadSha: nextHeadSha },
        source: "github_webhook",
      });
      const revisitedHead = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 42,
        headSha, event: "synchronize", deliveryId: "delivery-snapshot-revisited-head",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: nextHeadSha, afterHeadSha: headSha },
        source: "github_webhook",
      });
      expect(revisitedHead).toMatchObject({
        kind: "advanced", record: { currentPrHeadSha: headSha },
      });
      if (revisitedHead.kind !== "advanced") throw new Error("expected snapshot head revisit");
      expect(revisitedHead.jobId).not.toBe(job.id);
      await expect(recordAcceptanceContextPackSnapshot(input))
        .rejects.toThrow("Record head is not current");
      await expect(resolveAcceptanceContextPackCustody({
        workspaceId: wsId,
        sourceSnapshotId: first.snapshot.id,
      })).rejects.toThrow("Record head is no longer current");
      const rows = await db.select().from(acceptanceContextPackSnapshots)
        .where(eq(acceptanceContextPackSnapshots.id, first.snapshot.id));
      expect(rows).toHaveLength(1);
    });

    it("records one exact-head dependency observation and replays only exact normalized evidence", async () => {
      const fixture = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "dependency-observation-exact-replay",
        prNumber: 180,
        headSha: "1".repeat(40),
      });
      const input = acceptanceDependencyObservationInput({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        compiledPackId: fixture.pack.id,
        headSha: "1".repeat(40),
        manifestBlobSha: fixture.manifestBlobSha,
        lockfileBlobSha: fixture.lockfileBlobSha,
      });

      const recorded = await recordAcceptanceDependencyObservation(input);
      expect(recorded).toMatchObject({
        kind: "recorded",
        binding: {
          workspaceId: wsId,
          recordId: fixture.draft.record.id,
          repo: fixture.repo,
          prNumber: 180,
          headSha: "1".repeat(40),
          headCycleId: fixture.advanced.jobId,
          reviewJobId: fixture.advanced.jobId,
          acceptanceContract: {
            id: fixture.draft.contract.id,
            version: fixture.draft.contract.version,
          },
          compiledPack: { id: fixture.pack.id, sha256: fixture.pack.packSha256 },
        },
        observation: {
          eventKey: expect.stringMatching(
            new RegExp(`^acceptance-dependency-observation:v2:${fixture.advanced.jobId}:[a-f0-9]{64}$`),
          ),
          status: "observed",
          reasons: [],
          candidateFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          candidate: input.candidate,
          manifest: input.manifest,
          lockfile: input.lockfile,
          observedAt: expect.any(Date),
        },
      });
      if (recorded.kind !== "recorded") throw new Error("expected dependency observation record");
      const event = (await db.select().from(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, fixture.draft.record.id),
        eq(changeRecordEvents.eventKey, recorded.observation.eventKey),
      )))[0];
      expect(event).toMatchObject({
        id: recorded.observation.eventId,
        stage: "dependency_observation",
        actor: "server:dependency-observation",
        payloadRef: {
          kind: "acceptance_dependency_observation",
          version: 2,
          status: "observed",
          reasons: [],
        },
      });

      const replay = await recordAcceptanceDependencyObservation({
        ...input,
        workspaceId: input.workspaceId.toUpperCase(),
        recordId: input.recordId.toUpperCase(),
        compiledPackId: input.compiledPackId.toUpperCase(),
        runtime: { ...input.runtime, evidenceSha256: input.runtime.evidenceSha256.toUpperCase() },
        packageManager: {
          ...input.packageManager,
          evidenceSha256: input.packageManager.evidenceSha256.toUpperCase(),
        },
        manifest: { ...input.manifest, blobSha: input.manifest.blobSha.toUpperCase() },
        lockfile: {
          ...input.lockfile,
          blobSha: input.lockfile.blobSha?.toUpperCase() ?? null,
          evidenceSha256: input.lockfile.evidenceSha256.toUpperCase(),
        },
        baseline: { headSha: input.baseline.headSha.toUpperCase() },
        security: { ...input.security, reportSha256: input.security.reportSha256.toUpperCase() },
      });
      expect(replay).toMatchObject({
        kind: "replayed",
        binding: recorded.binding,
        observation: { eventId: recorded.observation.eventId },
      });

      await expect(recordAcceptanceDependencyObservation({
        ...input,
        security: { ...input.security, reportSha256: "5".repeat(64) },
      })).rejects.toBeInstanceOf(AcceptanceDependencyObservationConflictError);
      const foreignWorkspace = (await db.insert(workspaces).values({
        name: "foreign dependency observation workspace",
        slug: `foreign-dependency-observation-${randomUUID()}`,
      }).returning({ id: workspaces.id }))[0]!;
      await expect(recordAcceptanceDependencyObservation({
        ...input,
        workspaceId: foreignWorkspace.id,
      })).resolves.toEqual({ kind: "not_found" });
      await db.delete(workspaces).where(eq(workspaces.id, foreignWorkspace.id));

      await db.update(changeRecordEvents).set({ stage: "review" }).where(
        eq(changeRecordEvents.id, recorded.observation.eventId),
      );
      await expect(readCurrentAcceptanceDependencyObservations({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
      })).resolves.toEqual({
        kind: "not_ready",
        reason: "invalid_observation_custody",
      });
    });

    it("records the root npm profile, preserves exact argv policy, and mints the same identity into R10.2", async () => {
      const headSha = "a".repeat(40);
      const fixture = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "dependency-observation-npm-profile",
        prNumber: 281,
        headSha,
        manifestContent: JSON.stringify({
          engines: { node: "22.17.0" },
          dependencies: { lodash: "^4.17.20" },
        }),
        lockfilePath: "package-lock.json",
        lockfileContent: JSON.stringify({ name: "widgets", lockfileVersion: 3, packages: {} }),
      });
      if (fixture.lockfileBlobSha === null) throw new Error("expected npm package-lock custody");

      const cases = [
        ["dependencies", "4.17.21", "--save-prod"],
        ["devDependencies", "4.17.22", "--save-dev"],
        ["optionalDependencies", "4.17.23", "--save-optional"],
        ["peerDependencies", "4.17.24", "--save-peer"],
      ] as const;
      const recorded = [];
      for (const [dependencyKind, targetVersion, saveFlag] of cases) {
        const evidence = npmAcceptanceDependencyObservationInput({
          workspaceId: wsId,
          recordId: fixture.draft.record.id,
          compiledPackId: fixture.pack.id,
          headSha,
          manifestBlobSha: fixture.manifestBlobSha,
          lockfileBlobSha: fixture.lockfileBlobSha,
          dependencyKind,
          targetVersion,
        });
        const result = await recordAcceptanceDependencyObservation(evidence);
        expect(result).toMatchObject({
          kind: "recorded",
          observation: {
            status: "observed",
            reasons: [],
            candidate: { identity: evidence.candidate.identity, dependencyKind, targetVersion },
            packageManager: {
              name: "npm",
              profile: "npm_package_lock_only_v1",
              updateArgv: [
                "npm", "install", `lodash@${targetVersion}`, "--package-lock-only",
                "--ignore-scripts", "--no-audit", saveFlag,
              ],
            },
            manifest: { path: "package.json" },
            lockfile: { path: "package-lock.json", disposition: "present" },
            security: {
              provider: "osv",
              reference: `osv:npm:lodash@${targetVersion}`,
            },
          },
        });
        if (result.kind !== "recorded") throw new Error("expected npm observation");
        recorded.push({ result, evidence });
      }

      await expect(recordAcceptanceDependencyObservation(recorded[0]!.evidence)).resolves.toMatchObject({
        kind: "replayed",
        observation: { eventId: recorded[0]!.result.observation.eventId },
      });
      await expect(recordAcceptanceDependencyObservation({
        ...recorded[0]!.evidence,
        security: { ...recorded[0]!.evidence.security, reportSha256: "5".repeat(64) },
      })).rejects.toBeInstanceOf(AcceptanceDependencyObservationConflictError);

      const selected = await selectDependencyExternalBuilderRoute({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        repo: fixture.repo,
        adapter: "github_codex",
        configurationVersion: 4,
      });
      const ownerId = "12121212-1212-4121-8121-121212121212";
      await db.insert(workspaceMemberships).values({ workspaceId: wsId, userId: ownerId, role: "owner" });
      const approved = await approveAcceptanceDependencyObservationAndMintExternalBuilderPack({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        observationEventId: recorded[0]!.result.observation.eventId,
        approvedBy: `user:${ownerId}`,
      });
      expect(approved).toMatchObject({
        kind: "approved",
        observation: { candidate: { identity: recorded[0]!.evidence.candidate.identity } },
        externalBuilderPack: {
          candidate: { identity: recorded[0]!.evidence.candidate.identity },
          runtime: { identity: recorded[0]!.evidence.runtime.identity },
          packageManager: recorded[0]!.evidence.packageManager,
          manifest: { path: "package.json" },
          lockfile: { path: "package-lock.json" },
          security: { identity: recorded[0]!.evidence.security.identity, provider: "osv" },
          route: { id: selected.route.id, adapter: "github_codex", configurationVersion: 4 },
          deliveryAuthority: "not_granted",
          reviewRequirement: "exact_head_r7_reentry",
        },
      });
      const current = await readCurrentAcceptanceDependencyObservations({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
      });
      expect(current).toMatchObject({ kind: "current" });
      if (current.kind !== "current") throw new Error("expected current npm observations");
      expect(current.observations).toHaveLength(4);
      expect(current.observations.find(
        (item) => item.observation.eventId === recorded[0]!.result.observation.eventId,
      )).toMatchObject({
          payloadVersion: 2,
          observation: { eventId: recorded[0]!.result.observation.eventId, status: "observed" },
          approval: { approvedBy: `user:${ownerId}` },
          externalBuilderPack: {
            candidate: { identity: recorded[0]!.evidence.candidate.identity },
            packageManager: recorded[0]!.evidence.packageManager,
          },
      });
    });

    it("records the root Yarn 4 profile and preserves its exact identity through R10.2", async () => {
      const headSha = "d".repeat(40);
      const fixture = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "dependency-observation-yarn-profile",
        prNumber: 284,
        headSha,
        manifestContent: JSON.stringify({
          packageManager: "yarn@4.18.0",
          engines: { node: ">=18.12.0" },
          dependencies: { lodash: "^4.17.20" },
        }),
        lockfilePath: "yarn.lock",
        lockfileContent: "__metadata:\n  version: 8\n",
        yarnConfigurationRead: "path_not_found",
        compiledPackCompilerVersion: "exact-head-correction-pack-v5",
        compiledPackPolicyVersion: "bounded-exact-ranges-v3",
      });
      if (fixture.lockfileBlobSha === null) throw new Error("expected Yarn lockfile custody");

      const cases = [
        ["dependencies", "4.17.21", null],
        ["devDependencies", "4.17.22", "--dev"],
        ["optionalDependencies", "4.17.23", "--optional"],
        ["peerDependencies", "4.17.24", "--peer"],
      ] as const;
      const recorded = [];
      for (const [dependencyKind, targetVersion, kindFlag] of cases) {
        const evidence = yarnAcceptanceDependencyObservationInput({
          workspaceId: wsId,
          recordId: fixture.draft.record.id,
          compiledPackId: fixture.pack.id,
          headSha,
          manifestBlobSha: fixture.manifestBlobSha,
          lockfileBlobSha: fixture.lockfileBlobSha,
          dependencyKind,
          targetVersion,
        });
        const result = await recordAcceptanceDependencyObservation(evidence);
        expect(result).toMatchObject({
          kind: "recorded",
          observation: {
            status: "observed",
            reasons: [],
            candidate: { identity: evidence.candidate.identity, dependencyKind, targetVersion },
            runtime: { version: "22.17.0" },
            packageManager: {
              name: "yarn",
              version: "4.18.0",
              profile: "yarn_berry_v4_root_lockfile_only_v1",
              updateArgv: [
                "yarn", "add", `lodash@${targetVersion}`, "--mode=update-lockfile",
                ...(kindFlag ? [kindFlag] : []),
              ],
            },
            manifest: { path: "package.json" },
            lockfile: { path: "yarn.lock", disposition: "present" },
            security: { provider: "osv", reference: `osv:npm:lodash@${targetVersion}` },
          },
        });
        if (result.kind !== "recorded") throw new Error("expected Yarn observation");
        recorded.push({ result, evidence });
      }

      await expect(recordAcceptanceDependencyObservation(recorded[0]!.evidence)).resolves.toMatchObject({
        kind: "replayed",
        observation: { eventId: recorded[0]!.result.observation.eventId, status: "observed" },
      });
      await expect(recordAcceptanceDependencyObservation({
        ...recorded[0]!.evidence,
        security: { ...recorded[0]!.evidence.security, reportSha256: "5".repeat(64) },
      })).rejects.toBeInstanceOf(AcceptanceDependencyObservationConflictError);

      const selected = await selectDependencyExternalBuilderRoute({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        repo: fixture.repo,
        adapter: "github_codex",
        configurationVersion: 5,
      });
      const ownerId = "14141414-1414-4141-8141-141414141414";
      await db.insert(workspaceMemberships).values({ workspaceId: wsId, userId: ownerId, role: "owner" });
      const approved = await approveAcceptanceDependencyObservationAndMintExternalBuilderPack({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        observationEventId: recorded[0]!.result.observation.eventId,
        approvedBy: `user:${ownerId}`,
      });
      expect(approved).toMatchObject({
        kind: "approved",
        observation: { candidate: { identity: recorded[0]!.evidence.candidate.identity } },
        externalBuilderPack: {
          candidate: { identity: recorded[0]!.evidence.candidate.identity },
          runtime: { identity: recorded[0]!.evidence.runtime.identity },
          packageManager: recorded[0]!.evidence.packageManager,
          manifest: { path: "package.json" },
          lockfile: { path: "yarn.lock" },
          security: { identity: recorded[0]!.evidence.security.identity, provider: "osv" },
          route: { id: selected.route.id, adapter: "github_codex", configurationVersion: 5 },
          deliveryAuthority: "not_granted",
          reviewRequirement: "exact_head_r7_reentry",
        },
      });
      const current = await readCurrentAcceptanceDependencyObservations({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
      });
      expect(current).toMatchObject({ kind: "current" });
      if (current.kind !== "current") throw new Error("expected current Yarn observations");
      expect(current.observations.find(
        (item) => item.observation.eventId === recorded[0]!.result.observation.eventId,
      )).toMatchObject({
          payloadVersion: 2,
          observation: { eventId: recorded[0]!.result.observation.eventId, status: "observed" },
          approval: { approvedBy: `user:${ownerId}` },
          externalBuilderPack: {
            candidate: { identity: recorded[0]!.evidence.candidate.identity },
            packageManager: recorded[0]!.evidence.packageManager,
          },
      });
    });

    it("derives Yarn configuration safety from exact compiled-Pack read custody and rejects profile drift", async () => {
      const custodyCases = [
        ["record", "refused_unsafe_runtime", "unsafe_yarn_configuration_present"],
        ["unsafe_content", "refused_unsafe_runtime", "unsafe_yarn_configuration_present"],
        ["github_unavailable", "not_proven", "yarn_configuration_absence_not_proven"],
        [undefined, "not_proven", "yarn_configuration_absence_not_proven"],
      ] as const;
      for (const [ordinal, [configurationRead, status, reason]] of custodyCases.entries()) {
        const headSha = String(ordinal + 1).repeat(40);
        const fixture = await createAcceptanceDependencyObservationFixture({
          workspaceId: wsId,
          workKey: `dependency-observation-yarn-config-${configurationRead ?? "missing"}`,
          prNumber: 285 + ordinal,
          headSha,
          lockfilePath: "yarn.lock",
          lockfileContent: "__metadata:\n  version: 8\n",
          yarnConfigurationRead: configurationRead,
          ...(configurationRead === undefined ? {
            compiledPackCompilerVersion: "exact-head-correction-pack-v4",
            compiledPackPolicyVersion: "bounded-exact-ranges-v2",
          } : {}),
        });
        if (fixture.lockfileBlobSha === null) throw new Error("expected Yarn lockfile custody");
        const evidence = yarnAcceptanceDependencyObservationInput({
          workspaceId: wsId,
          recordId: fixture.draft.record.id,
          compiledPackId: fixture.pack.id,
          headSha,
          manifestBlobSha: fixture.manifestBlobSha,
          lockfileBlobSha: fixture.lockfileBlobSha,
        });
        const result = await recordAcceptanceDependencyObservation(evidence);
        expect(result).toMatchObject({
          kind: "recorded",
          observation: { status, reasons: [reason] },
        });
        if (configurationRead === undefined) {
          expect(result).toMatchObject({
            kind: "recorded",
            binding: {
              compiledPack: {
                compilerVersion: "exact-head-correction-pack-v4",
                policyVersion: "bounded-exact-ranges-v2",
              },
            },
            observation: {
              status: "not_proven",
              reasons: ["yarn_configuration_absence_not_proven"],
            },
          });
          if (result.kind !== "recorded") throw new Error("expected legacy Pack Yarn refusal");
          const ownerId = "16161616-1616-4161-8161-161616161616";
          await db.insert(workspaceMemberships).values({
            workspaceId: wsId,
            userId: ownerId,
            role: "owner",
          });
          await expect(approveAcceptanceDependencyObservationAndMintExternalBuilderPack({
            workspaceId: wsId,
            recordId: fixture.draft.record.id,
            observationEventId: result.observation.eventId,
            approvedBy: `user:${ownerId}`,
          })).resolves.toEqual({
            kind: "observation_not_eligible",
            reason: "observation_not_observed",
          });
          const projected = await readCurrentAcceptanceDependencyObservations({
            workspaceId: wsId,
            recordId: fixture.draft.record.id,
          });
          expect(projected).toMatchObject({
            kind: "current",
            observations: [{
              observation: {
                eventId: result.observation.eventId,
                status: "not_proven",
                reasons: ["yarn_configuration_absence_not_proven"],
              },
              approval: null,
              externalBuilderPack: null,
            }],
          });
        }
      }

      const changedHeadSha = "e".repeat(40);
      const changed = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "dependency-observation-yarn-config-changed-overlay",
        prNumber: 295,
        headSha: changedHeadSha,
        lockfilePath: "yarn.lock",
        lockfileContent: "__metadata:\n  version: 8\n",
        yarnConfigurationChangedContent: "enableScripts: false\n",
        compiledPackCompilerVersion: "exact-head-correction-pack-v5",
        compiledPackPolicyVersion: "bounded-exact-ranges-v3",
      });
      if (changed.lockfileBlobSha === null) throw new Error("expected changed-config Yarn lockfile");
      await expect(recordAcceptanceDependencyObservation(
        yarnAcceptanceDependencyObservationInput({
          workspaceId: wsId,
          recordId: changed.draft.record.id,
          compiledPackId: changed.pack.id,
          headSha: changedHeadSha,
          manifestBlobSha: changed.manifestBlobSha,
          lockfileBlobSha: changed.lockfileBlobSha,
        }),
      )).resolves.toMatchObject({
        kind: "recorded",
        observation: {
          status: "refused_unsafe_runtime",
          reasons: ["unsafe_yarn_configuration_present"],
        },
      });

      const headSha = "6".repeat(40);
      const strict = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "dependency-observation-yarn-strict-profile",
        prNumber: 289,
        headSha,
        lockfilePath: "yarn.lock",
        lockfileContent: "__metadata:\n  version: 8\n",
        yarnConfigurationRead: "path_not_found",
      });
      if (strict.lockfileBlobSha === null) throw new Error("expected strict Yarn lockfile custody");
      const base = yarnAcceptanceDependencyObservationInput({
        workspaceId: wsId,
        recordId: strict.draft.record.id,
        compiledPackId: strict.pack.id,
        headSha,
        manifestBlobSha: strict.manifestBlobSha,
        lockfileBlobSha: strict.lockfileBlobSha,
      });
      const argvDrift = { ...base, candidate: { ...base.candidate, targetVersion: "4.18.0" } };
      await expect(recordAcceptanceDependencyObservation({
        ...argvDrift,
        packageManager: {
          ...argvDrift.packageManager,
          updateArgv: ["yarn", "up", "lodash@4.18.0", "-R"],
        },
        security: { ...argvDrift.security, reference: "osv:npm:lodash@4.18.0" },
      })).resolves.toMatchObject({
        kind: "recorded",
        observation: { status: "refused_unsafe_runtime", reasons: ["unsafe_package_manager_argv"] },
      });

      for (const malformed of [
        { ...base, packageManager: { ...base.packageManager, version: "3.8.7" } },
        { ...base, packageManager: { ...base.packageManager, version: "5.0.0" } },
        { ...base, packageManager: { ...base.packageManager, version: "4.18.0-rc.1" } },
        { ...base, runtime: { ...base.runtime, version: "18.11.0" } },
        { ...base, runtime: { ...base.runtime, version: "18.12.0-rc.1" } },
        { ...base, candidate: { ...base.candidate, specifier: "npm:underscore@1.13.6" } },
        { ...base, candidate: { ...base.candidate, specifier: "workspace:^" } },
        { ...base, candidate: { ...base.candidate, specifier: ">=4.17.0 <5" } },
        { ...base, candidate: { ...base.candidate, specifier: "latest" } },
        { ...base, candidate: { ...base.candidate, specifier: "*" } },
        {
          ...base,
          manifest: { ...base.manifest, path: "services/api/package.json" },
          lockfile: { ...base.lockfile, path: "services/api/yarn.lock" },
        },
        { ...base, security: { ...base.security, reference: "osv:npm:lodash@4.17.20" } },
      ]) {
        await expect(recordAcceptanceDependencyObservation(malformed))
          .rejects.toBeInstanceOf(AcceptanceDependencyObservationInvalidEvidenceError);
      }
      const events = await db.select().from(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, strict.draft.record.id),
        eq(changeRecordEvents.stage, "dependency_observation"),
      ));
      expect(events).toHaveLength(1);
    }, 15_000);

    it("replays frozen pre-support Yarn v2 refusals without reinterpreting valid or broad evidence", async () => {
      const broadHeadSha = "7".repeat(40);
      const broadFixture = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "dependency-observation-historical-unsupported-yarn-broad",
        prNumber: 290,
        headSha: broadHeadSha,
        manifestPath: "services/api/package.json",
        manifestContent: JSON.stringify({ dependencies: { lodash: "release-channel" } }),
        lockfilePath: "services/api/yarn.lock",
        lockfileContent: "__metadata:\n  version: broad\n",
      });
      if (broadFixture.lockfileBlobSha === null) throw new Error("expected historical Yarn lockfile");
      const identity = {
        ecosystem: "node",
        manager: "yarn",
        profile: "yarn_berry_v4_root_lockfile_only_v1",
      };
      const broadEvidence: RecordAcceptanceDependencyObservationInput = {
        workspaceId: wsId,
        recordId: broadFixture.draft.record.id,
        compiledPackId: broadFixture.pack.id,
        candidate: {
          identity,
          package: "lodash",
          dependencyKind: "runtime",
          specifier: "release-channel",
          currentVersion: "release-1",
          targetVersion: "release-2",
        },
        runtime: {
          identity,
          disposition: "safe",
          version: "node-release-22",
          evidenceSha256: "1".repeat(64),
        },
        packageManager: {
          disposition: "safe",
          name: "yarn",
          version: "yarn-release-berry",
          profile: "yarn_berry_v4_root_lockfile_only_v1",
          updateArgv: ["yarn", "up", "lodash@release-2"],
          evidenceSha256: "2".repeat(64),
        },
        manifest: { path: "services/api/package.json", blobSha: broadFixture.manifestBlobSha },
        lockfile: {
          disposition: "present",
          path: "services/api/yarn.lock",
          blobSha: broadFixture.lockfileBlobSha,
          evidenceSha256: "3".repeat(64),
        },
        baseline: { headSha: broadHeadSha },
        security: {
          identity,
          disposition: "clear",
          provider: "opaque",
          reference: "opaque:pre-support-yarn",
          reportSha256: "4".repeat(64),
        },
      };
      const broadHistorical = await appendHistoricalUnsupportedDependencyObservationV2(broadEvidence);
      await expect(recordAcceptanceDependencyObservation(broadEvidence)).resolves.toMatchObject({
        kind: "replayed",
        observation: {
          eventId: broadHistorical.event.id,
          status: "refused_unsupported_profile",
          reasons: ["unsupported_manager_profile"],
          candidate: broadEvidence.candidate,
        },
      });
      await expect(recordAcceptanceDependencyObservation({
        ...broadEvidence,
        security: { ...broadEvidence.security, reportSha256: "5".repeat(64) },
      })).rejects.toBeInstanceOf(AcceptanceDependencyObservationConflictError);
      await expect(recordAcceptanceDependencyObservation({
        ...broadEvidence,
        candidate: { ...broadEvidence.candidate, targetVersion: "release-3" },
      })).rejects.toBeInstanceOf(AcceptanceDependencyObservationInvalidEvidenceError);

      const validHeadSha = "8".repeat(40);
      const validFixture = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "dependency-observation-historical-unsupported-yarn-valid",
        prNumber: 291,
        headSha: validHeadSha,
        lockfilePath: "yarn.lock",
        lockfileContent: "__metadata:\n  version: 8\n",
        yarnConfigurationRead: "path_not_found",
      });
      if (validFixture.lockfileBlobSha === null) throw new Error("expected valid historical Yarn lockfile");
      const validEvidence = yarnAcceptanceDependencyObservationInput({
        workspaceId: wsId,
        recordId: validFixture.draft.record.id,
        compiledPackId: validFixture.pack.id,
        headSha: validHeadSha,
        manifestBlobSha: validFixture.manifestBlobSha,
        lockfileBlobSha: validFixture.lockfileBlobSha,
      });
      const validHistorical = await appendHistoricalUnsupportedDependencyObservationV2(validEvidence);
      await expect(recordAcceptanceDependencyObservation(validEvidence)).resolves.toMatchObject({
        kind: "replayed",
        observation: {
          eventId: validHistorical.event.id,
          status: "refused_unsupported_profile",
          reasons: ["unsupported_manager_profile"],
        },
      });
      const ownerId = "15151515-1515-4151-8151-151515151515";
      await db.insert(workspaceMemberships).values({ workspaceId: wsId, userId: ownerId, role: "owner" });
      await selectDependencyExternalBuilderRoute({
        workspaceId: wsId,
        recordId: validFixture.draft.record.id,
        repo: validFixture.repo,
        adapter: "github_codex",
      });
      await expect(approveAcceptanceDependencyObservationAndMintExternalBuilderPack({
        workspaceId: wsId,
        recordId: validFixture.draft.record.id,
        observationEventId: validHistorical.event.id,
        approvedBy: `user:${ownerId}`,
      })).resolves.toEqual({
        kind: "observation_not_eligible",
        reason: "observation_not_observed",
      });
      const events = await db.select().from(changeRecordEvents).where(and(
        inArray(changeRecordEvents.recordId, [broadFixture.draft.record.id, validFixture.draft.record.id]),
        eq(changeRecordEvents.stage, "dependency_observation"),
      ));
      expect(events).toHaveLength(2);
    });

    it("projects Yarn-specific baseline, runtime, manager, lockfile, and OSV refusals", async () => {
      const headSha = "9".repeat(40);
      const fixture = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "dependency-observation-yarn-refusal-matrix",
        prNumber: 292,
        headSha,
        lockfilePath: "yarn.lock",
        lockfileContent: "__metadata:\n  version: 8\n",
        yarnConfigurationRead: "path_not_found",
      });
      if (fixture.lockfileBlobSha === null) throw new Error("expected Yarn refusal lockfile");
      const base = (targetVersion: string) => yarnAcceptanceDependencyObservationInput({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        compiledPackId: fixture.pack.id,
        headSha,
        manifestBlobSha: fixture.manifestBlobSha,
        lockfileBlobSha: fixture.lockfileBlobSha,
        targetVersion,
      });

      const baseline = base("4.18.1");
      await expect(recordAcceptanceDependencyObservation({
        ...baseline,
        baseline: { headSha: "f".repeat(40) },
      })).resolves.toMatchObject({
        kind: "recorded",
        observation: { status: "refused_baseline", reasons: ["baseline_head_mismatch"] },
      });
      const unsafeRuntime = base("4.18.2");
      await expect(recordAcceptanceDependencyObservation({
        ...unsafeRuntime,
        runtime: { ...unsafeRuntime.runtime, disposition: "unsafe" as const, version: "0.1.0" },
      })).resolves.toMatchObject({
        kind: "recorded",
        observation: { status: "refused_unsafe_runtime", reasons: ["unsafe_runtime"] },
      });
      const unavailableRuntime = base("4.18.3");
      await expect(recordAcceptanceDependencyObservation({
        ...unavailableRuntime,
        runtime: { ...unavailableRuntime.runtime, disposition: "unavailable" as const, version: null },
      })).resolves.toMatchObject({
        kind: "recorded",
        observation: { status: "not_proven", reasons: ["runtime_evidence_unavailable"] },
      });
      const unsafeManager = base("4.18.4");
      await expect(recordAcceptanceDependencyObservation({
        ...unsafeManager,
        packageManager: {
          ...unsafeManager.packageManager,
          disposition: "unsafe" as const,
          version: "4.18.0",
        },
      })).resolves.toMatchObject({
        kind: "recorded",
        observation: { status: "refused_unsafe_runtime", reasons: ["unsafe_package_manager"] },
      });
      const unavailableManager = base("4.18.5");
      await expect(recordAcceptanceDependencyObservation({
        ...unavailableManager,
        packageManager: {
          ...unavailableManager.packageManager,
          disposition: "unavailable" as const,
          version: null,
        },
      })).resolves.toMatchObject({
        kind: "recorded",
        observation: { status: "not_proven", reasons: ["package_manager_evidence_unavailable"] },
      });
      for (const [targetVersion, disposition, reason] of [
        ["4.18.6", "affected", "security_affected"],
        ["4.18.7", "unavailable", "security_evidence_unavailable"],
      ] as const) {
        const evidence = base(targetVersion);
        await expect(recordAcceptanceDependencyObservation({
          ...evidence,
          security: { ...evidence.security, disposition },
        })).resolves.toMatchObject({
          kind: "recorded",
          observation: { status: "refused_security", reasons: [reason] },
        });
      }

      const missingHeadSha = "a".repeat(40);
      const missing = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "dependency-observation-yarn-lockfile-missing",
        prNumber: 293,
        headSha: missingHeadSha,
        lockfilePath: "yarn.lock",
        lockfileReadReason: "path_not_found",
        yarnConfigurationRead: "path_not_found",
      });
      await expect(recordAcceptanceDependencyObservation({
        ...yarnAcceptanceDependencyObservationInput({
          workspaceId: wsId,
          recordId: missing.draft.record.id,
          compiledPackId: missing.pack.id,
          headSha: missingHeadSha,
          manifestBlobSha: missing.manifestBlobSha,
          lockfileBlobSha: "0".repeat(40),
        }),
        lockfile: {
          disposition: "missing" as const,
          path: "yarn.lock",
          blobSha: null,
          evidenceSha256: "3".repeat(64),
        },
      })).resolves.toMatchObject({
        kind: "recorded",
        observation: { status: "refused_lockfile", reasons: ["lockfile_missing"] },
      });

      const unavailableHeadSha = "b".repeat(40);
      const unavailable = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "dependency-observation-yarn-lockfile-unavailable",
        prNumber: 294,
        headSha: unavailableHeadSha,
        lockfilePath: "yarn.lock",
        lockfileReadReason: "github_unavailable",
        yarnConfigurationRead: "path_not_found",
      });
      await expect(recordAcceptanceDependencyObservation({
        ...yarnAcceptanceDependencyObservationInput({
          workspaceId: wsId,
          recordId: unavailable.draft.record.id,
          compiledPackId: unavailable.pack.id,
          headSha: unavailableHeadSha,
          manifestBlobSha: unavailable.manifestBlobSha,
          lockfileBlobSha: "0".repeat(40),
        }),
        lockfile: {
          disposition: "unavailable" as const,
          path: "yarn.lock",
          blobSha: null,
          evidenceSha256: "3".repeat(64),
        },
      })).resolves.toMatchObject({
        kind: "recorded",
        observation: { status: "refused_lockfile", reasons: ["lockfile_evidence_unavailable"] },
      });
    });

    it("records the exact root uv profile and preserves its evidence through R10.2", async () => {
      const headSha = "2".repeat(40);
      const fixture = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "dependency-observation-uv-profile",
        prNumber: 340,
        headSha,
        manifestPath: "pyproject.toml",
        manifestContent: [
          "[project]",
          'requires-python = ">=3.12"',
          'dependencies = ["httpx>=0.27.0"]',
          "",
        ].join("\n"),
        lockfilePath: "uv.lock",
        lockfileContent: 'version = 1\nrequires-python = ">=3.12"\n',
        compiledPackCompilerVersion: "exact-head-correction-pack-v5",
        compiledPackPolicyVersion: "bounded-exact-ranges-v3",
      });
      if (fixture.lockfileBlobSha === null) throw new Error("expected uv lock custody");
      const evidence = uvAcceptanceDependencyObservationInput({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        compiledPackId: fixture.pack.id,
        headSha,
        manifestBlobSha: fixture.manifestBlobSha,
        lockfileBlobSha: fixture.lockfileBlobSha,
      });

      const recorded = await recordAcceptanceDependencyObservation(evidence);
      expect(recorded).toMatchObject({
        kind: "recorded",
        binding: {
          compiledPack: {
            id: fixture.pack.id,
            compilerVersion: "exact-head-correction-pack-v5",
            policyVersion: "bounded-exact-ranges-v3",
          },
        },
        observation: {
          status: "observed",
          reasons: [],
          candidate: {
            identity: evidence.candidate.identity,
            package: "httpx",
            dependencyKind: "dependencies",
            specifier: ">=0.27.0",
            currentVersion: "0.27.0",
            targetVersion: "0.28.1",
          },
          runtime: { identity: evidence.runtime.identity, version: "3.12.8" },
          packageManager: {
            name: "uv",
            version: "0.12.0",
            profile: "uv_project_lockfile_only_v1",
            updateArgv: [
              "uv", "lock", "--no-cache", "--no-config", "--no-python-downloads",
              "--no-sources", "--no-build", "--upgrade-package", "httpx==0.28.1",
            ],
          },
          manifest: { path: "pyproject.toml" },
          lockfile: { path: "uv.lock", disposition: "present" },
          security: { provider: "osv", reference: "osv:PyPI:httpx@0.28.1" },
        },
      });
      if (recorded.kind !== "recorded") throw new Error("expected uv observation");
      await expect(recordAcceptanceDependencyObservation(evidence)).resolves.toMatchObject({
        kind: "replayed",
        observation: { eventId: recorded.observation.eventId, status: "observed" },
      });
      await expect(recordAcceptanceDependencyObservation({
        ...evidence,
        security: { ...evidence.security, reportSha256: "5".repeat(64) },
      })).rejects.toBeInstanceOf(AcceptanceDependencyObservationConflictError);

      const selected = await selectDependencyExternalBuilderRoute({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        repo: fixture.repo,
        adapter: "github_codex",
        configurationVersion: 6,
      });
      const ownerId = "17171717-1717-4171-8171-171717171717";
      await db.insert(workspaceMemberships).values({ workspaceId: wsId, userId: ownerId, role: "owner" });
      const approved = await approveAcceptanceDependencyObservationAndMintExternalBuilderPack({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        observationEventId: recorded.observation.eventId,
        approvedBy: `user:${ownerId}`,
      });
      expect(approved).toMatchObject({
        kind: "approved",
        observation: { eventId: recorded.observation.eventId, candidate: evidence.candidate },
        externalBuilderPack: {
          candidate: evidence.candidate,
          runtime: evidence.runtime,
          packageManager: evidence.packageManager,
          manifest: evidence.manifest,
          lockfile: evidence.lockfile,
          security: evidence.security,
          route: { id: selected.route.id, adapter: "github_codex", configurationVersion: 6 },
          deliveryAuthority: "not_granted",
          reviewRequirement: "exact_head_r7_reentry",
        },
      });
      await expect(readCurrentAcceptanceDependencyObservations({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
      })).resolves.toMatchObject({
        kind: "current",
        observations: [{
          payloadVersion: 2,
          observation: { eventId: recorded.observation.eventId, status: "observed" },
          approval: { approvedBy: `user:${ownerId}` },
          externalBuilderPack: {
            candidate: evidence.candidate,
            packageManager: evidence.packageManager,
          },
        }],
      });
    }, 15_000);

    it("fails closed for uv runner drift, refusals, and missing exact Pack source custody", async () => {
      const headSha = "3".repeat(40);
      const fixture = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "dependency-observation-uv-refusals",
        prNumber: 341,
        headSha,
        manifestPath: "pyproject.toml",
        manifestContent: '[project]\ndependencies = ["httpx>=0.27.0"]\n',
        lockfilePath: "uv.lock",
        lockfileContent: "version = 1\n",
      });
      if (fixture.lockfileBlobSha === null) throw new Error("expected uv refusal lock custody");
      const base = (targetVersion: string) => uvAcceptanceDependencyObservationInput({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        compiledPackId: fixture.pack.id,
        headSha,
        manifestBlobSha: fixture.manifestBlobSha,
        lockfileBlobSha: fixture.lockfileBlobSha,
        targetVersion,
      });

      const argvDrift = base("0.28.2");
      await expect(recordAcceptanceDependencyObservation({
        ...argvDrift,
        packageManager: {
          ...argvDrift.packageManager,
          updateArgv: argvDrift.packageManager.updateArgv.filter((token) => token !== "--no-config"),
        },
      })).resolves.toMatchObject({
        kind: "recorded",
        observation: { status: "refused_unsafe_runtime", reasons: ["unsafe_package_manager_argv"] },
      });
      const baseline = base("0.28.3");
      await expect(recordAcceptanceDependencyObservation({
        ...baseline,
        baseline: { headSha: "f".repeat(40) },
      })).resolves.toMatchObject({
        kind: "recorded",
        observation: { status: "refused_baseline", reasons: ["baseline_head_mismatch"] },
      });
      const unsafeRuntime = base("0.28.4");
      await expect(recordAcceptanceDependencyObservation({
        ...unsafeRuntime,
        runtime: { ...unsafeRuntime.runtime, disposition: "unsafe" as const, version: "3.8.0" },
      })).resolves.toMatchObject({
        kind: "recorded",
        observation: { status: "refused_unsafe_runtime", reasons: ["unsafe_runtime"] },
      });
      const unavailableManager = base("0.28.5");
      await expect(recordAcceptanceDependencyObservation({
        ...unavailableManager,
        packageManager: {
          ...unavailableManager.packageManager,
          disposition: "unavailable" as const,
          version: null,
        },
      })).resolves.toMatchObject({
        kind: "recorded",
        observation: { status: "not_proven", reasons: ["package_manager_evidence_unavailable"] },
      });
      const affected = base("0.28.6");
      await expect(recordAcceptanceDependencyObservation({
        ...affected,
        security: { ...affected.security, disposition: "affected" as const },
      })).resolves.toMatchObject({
        kind: "recorded",
        observation: { status: "refused_security", reasons: ["security_affected"] },
      });

      const missingHeadSha = "4".repeat(40);
      const missing = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "dependency-observation-uv-lockfile-missing",
        prNumber: 342,
        headSha: missingHeadSha,
        manifestPath: "pyproject.toml",
        manifestContent: '[project]\ndependencies = ["httpx>=0.27.0"]\n',
        lockfilePath: "uv.lock",
        lockfileReadReason: "path_not_found",
      });
      await expect(recordAcceptanceDependencyObservation({
        ...uvAcceptanceDependencyObservationInput({
          workspaceId: wsId,
          recordId: missing.draft.record.id,
          compiledPackId: missing.pack.id,
          headSha: missingHeadSha,
          manifestBlobSha: missing.manifestBlobSha,
          lockfileBlobSha: "0".repeat(40),
        }),
        lockfile: {
          disposition: "missing" as const,
          path: "uv.lock",
          blobSha: null,
          evidenceSha256: "3".repeat(64),
        },
      })).resolves.toMatchObject({
        kind: "recorded",
        observation: { status: "refused_lockfile", reasons: ["lockfile_missing"] },
      });

      const noSourceHeadSha = "5".repeat(40);
      const noSource = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "dependency-observation-uv-source-not-proven",
        prNumber: 343,
        headSha: noSourceHeadSha,
        manifestPath: "package.json",
        lockfilePath: "uv.lock",
        lockfileContent: "version = 1\n",
      });
      if (noSource.lockfileBlobSha === null) throw new Error("expected uv source lock custody");
      await expect(recordAcceptanceDependencyObservation(uvAcceptanceDependencyObservationInput({
        workspaceId: wsId,
        recordId: noSource.draft.record.id,
        compiledPackId: noSource.pack.id,
        headSha: noSourceHeadSha,
        manifestBlobSha: noSource.manifestBlobSha,
        lockfileBlobSha: noSource.lockfileBlobSha,
      }))).resolves.toMatchObject({
        kind: "recorded",
        observation: { status: "not_proven", reasons: ["manifest_source_not_proven"] },
      });

      const strictCases = [
        (() => {
          const value = base("0.29.0");
          return { ...value, candidate: { ...value.candidate, package: "HTTPX" } };
        })(),
        (() => {
          const value = base("0.29.1");
          return { ...value, candidate: { ...value.candidate, dependencyKind: "devDependencies" } };
        })(),
        (() => {
          const value = base("0.29.2");
          return { ...value, candidate: { ...value.candidate, specifier: "^0.27.0" } };
        })(),
        (() => {
          const value = base("0.29.3");
          return { ...value, runtime: { ...value.runtime, version: "3.13.0rc1" } };
        })(),
        (() => {
          const value = base("0.29.4");
          return { ...value, packageManager: { ...value.packageManager, version: "0.13.0" } };
        })(),
        (() => {
          const value = base("0.29.5");
          return { ...value, manifest: { ...value.manifest, path: "services/api/pyproject.toml" } };
        })(),
        (() => {
          const value = base("0.29.6");
          return { ...value, security: { ...value.security, reference: "osv:pypi:httpx@0.29.6" } };
        })(),
      ];
      for (const malformed of strictCases) {
        await expect(recordAcceptanceDependencyObservation(malformed))
          .rejects.toBeInstanceOf(AcceptanceDependencyObservationInvalidEvidenceError);
      }
      const strictEvents = await db.select().from(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, fixture.draft.record.id),
        eq(changeRecordEvents.stage, "dependency_observation"),
      ));
      expect(strictEvents).toHaveLength(5);
    });

    it("replays frozen pre-support uv v2 refusals without admitting a new broad body", async () => {
      const validHeadSha = "6".repeat(40);
      const validFixture = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "dependency-observation-historical-unsupported-uv-valid",
        prNumber: 344,
        headSha: validHeadSha,
        manifestPath: "pyproject.toml",
        manifestContent: '[project]\ndependencies = ["httpx>=0.27.0"]\n',
        lockfilePath: "uv.lock",
        lockfileContent: "version = 1\n",
      });
      if (validFixture.lockfileBlobSha === null) throw new Error("expected valid historical uv lockfile");
      const validEvidence = uvAcceptanceDependencyObservationInput({
        workspaceId: wsId,
        recordId: validFixture.draft.record.id,
        compiledPackId: validFixture.pack.id,
        headSha: validHeadSha,
        manifestBlobSha: validFixture.manifestBlobSha,
        lockfileBlobSha: validFixture.lockfileBlobSha,
      });
      const validHistorical = await appendHistoricalUnsupportedDependencyObservationV2(validEvidence);
      await expect(recordAcceptanceDependencyObservation(validEvidence)).resolves.toMatchObject({
        kind: "replayed",
        observation: {
          eventId: validHistorical.event.id,
          status: "refused_unsupported_profile",
          reasons: ["unsupported_manager_profile"],
        },
      });

      const broadHeadSha = "7".repeat(40);
      const broadFixture = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "dependency-observation-historical-unsupported-uv-broad",
        prNumber: 345,
        headSha: broadHeadSha,
        manifestPath: "services/api/pyproject.toml",
        manifestContent: '[project]\ndependencies = ["httpx @ https://example.invalid/httpx.whl"]\n',
        lockfilePath: "services/api/uv.lock",
        lockfileContent: "version = 'preview'\n",
      });
      if (broadFixture.lockfileBlobSha === null) throw new Error("expected broad historical uv lockfile");
      const identity = {
        ecosystem: "python",
        manager: "uv",
        profile: "uv_project_lockfile_only_v1",
      };
      const broadEvidence: RecordAcceptanceDependencyObservationInput = {
        workspaceId: wsId,
        recordId: broadFixture.draft.record.id,
        compiledPackId: broadFixture.pack.id,
        candidate: {
          identity,
          package: "HTTP_X",
          dependencyKind: "optional:extra",
          specifier: "https://example.invalid/httpx.whl",
          currentVersion: "release-1",
          targetVersion: "release-2",
        },
        runtime: {
          identity,
          disposition: "safe",
          version: "python-release-3",
          evidenceSha256: "1".repeat(64),
        },
        packageManager: {
          disposition: "safe",
          name: "uv",
          version: "uv-release-preview",
          profile: "uv_project_lockfile_only_v1",
          updateArgv: ["uv", "lock", "--upgrade-package", "HTTP_X@release-2"],
          evidenceSha256: "2".repeat(64),
        },
        manifest: { path: "services/api/pyproject.toml", blobSha: broadFixture.manifestBlobSha },
        lockfile: {
          disposition: "present",
          path: "services/api/uv.lock",
          blobSha: broadFixture.lockfileBlobSha,
          evidenceSha256: "3".repeat(64),
        },
        baseline: { headSha: broadHeadSha },
        security: {
          identity,
          disposition: "clear",
          provider: "opaque",
          reference: "opaque:pre-support-uv",
          reportSha256: "4".repeat(64),
        },
      };
      const broadHistorical = await appendHistoricalUnsupportedDependencyObservationV2(broadEvidence);
      await expect(recordAcceptanceDependencyObservation(broadEvidence)).resolves.toMatchObject({
        kind: "replayed",
        observation: {
          eventId: broadHistorical.event.id,
          status: "refused_unsupported_profile",
          candidate: broadEvidence.candidate,
        },
      });
      await expect(recordAcceptanceDependencyObservation({
        ...broadEvidence,
        security: { ...broadEvidence.security, reportSha256: "5".repeat(64) },
      })).rejects.toBeInstanceOf(AcceptanceDependencyObservationConflictError);
      await expect(recordAcceptanceDependencyObservation({
        ...broadEvidence,
        candidate: { ...broadEvidence.candidate, targetVersion: "release-3" },
      })).rejects.toBeInstanceOf(AcceptanceDependencyObservationInvalidEvidenceError);
      const events = await db.select().from(changeRecordEvents).where(and(
        inArray(changeRecordEvents.recordId, [validFixture.draft.record.id, broadFixture.draft.record.id]),
        eq(changeRecordEvents.stage, "dependency_observation"),
      ));
      expect(events).toHaveLength(2);
    });

    it("fails closed for npm command drift and rejects noncanonical new npm bodies without an event", async () => {
      const headSha = "b".repeat(40);
      const fixture = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "dependency-observation-npm-refusals",
        prNumber: 282,
        headSha,
        lockfilePath: "package-lock.json",
        lockfileContent: JSON.stringify({ name: "widgets", lockfileVersion: 3, packages: {} }),
      });
      if (fixture.lockfileBlobSha === null) throw new Error("expected npm package-lock custody");
      const base = (targetVersion: string) => npmAcceptanceDependencyObservationInput({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        compiledPackId: fixture.pack.id,
        headSha,
        manifestBlobSha: fixture.manifestBlobSha,
        lockfileBlobSha: fixture.lockfileBlobSha,
        targetVersion,
      });

      const argvDrift = base("4.18.0");
      await expect(recordAcceptanceDependencyObservation({
        ...argvDrift,
        packageManager: {
          ...argvDrift.packageManager,
          updateArgv: argvDrift.packageManager.updateArgv.filter((token) => token !== "--no-audit"),
        },
      })).resolves.toMatchObject({
        kind: "recorded",
        observation: { status: "refused_unsafe_runtime", reasons: ["unsafe_package_manager_argv"] },
      });

      const unsafeRuntime = base("4.18.1");
      await expect(recordAcceptanceDependencyObservation({
        ...unsafeRuntime,
        runtime: { ...unsafeRuntime.runtime, disposition: "unsafe" as const, version: "0.1.0" },
      })).resolves.toMatchObject({
        kind: "recorded",
        observation: { status: "refused_unsafe_runtime", reasons: ["unsafe_runtime"] },
      });

      const affected = base("4.18.2");
      await expect(recordAcceptanceDependencyObservation({
        ...affected,
        security: { ...affected.security, disposition: "affected" as const },
      })).resolves.toMatchObject({
        kind: "recorded",
        observation: { status: "refused_security", reasons: ["security_affected"] },
      });

      for (const malformed of [
        { ...base("4.18.3"), candidate: { ...base("4.18.3").candidate, specifier: "npm:underscore@1.13.6" } },
        {
          ...base("4.18.4"),
          manifest: { ...base("4.18.4").manifest, path: "services/api/package.json" },
          lockfile: { ...base("4.18.4").lockfile, path: "services/api/package-lock.json" },
        },
        {
          ...base("4.18.5"),
          security: { ...base("4.18.5").security, provider: "opaque", reference: "opaque:npm" },
        },
      ]) {
        await expect(recordAcceptanceDependencyObservation(malformed))
          .rejects.toBeInstanceOf(AcceptanceDependencyObservationInvalidEvidenceError);
      }
      const events = await db.select().from(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, fixture.draft.record.id),
        eq(changeRecordEvents.stage, "dependency_observation"),
      ));
      expect(events).toHaveLength(3);
    });

    it("replays one authentic legacy pnpm observation instead of appending a v2 duplicate", async () => {
      const headSha = "5".repeat(40);
      const fixture = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "dependency-observation-legacy-replay",
        prNumber: 279,
        headSha,
      });
      const input = acceptanceDependencyObservationInput({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        compiledPackId: fixture.pack.id,
        headSha,
        manifestBlobSha: fixture.manifestBlobSha,
        lockfileBlobSha: fixture.lockfileBlobSha,
      });
      const record = (await db.select().from(changeRecords).where(
        eq(changeRecords.id, fixture.draft.record.id),
      ))[0]!;
      const contractSha256 = acceptanceContractSha256({
        acceptanceContractId: fixture.draft.contract.id,
        acceptanceContractVersion: fixture.draft.contract.version,
        contract: fixture.draft.contract.contract,
      });
      const candidateFingerprint = `sha256:${acceptanceContextPackCanonicalSha256({
        ecosystem: "node",
        manifestPath: input.manifest.path,
        package: input.candidate.package,
        dependencyKind: input.candidate.dependencyKind,
        specifier: input.candidate.specifier,
        currentVersion: input.candidate.currentVersion,
        targetVersion: input.candidate.targetVersion,
      })}`;
      const eventKey = `acceptance-dependency-observation:${fixture.advanced.jobId}:${candidateFingerprint.slice("sha256:".length)}`;
      const { identity: _candidateIdentity, ...legacyCandidate } = input.candidate;
      const { identity: _runtimeIdentity, version, ...legacyRuntime } = input.runtime;
      const { identity: _securityIdentity, ...legacySecurity } = input.security;
      await appendChangeRecordEvent({
        recordId: fixture.draft.record.id,
        eventKey,
        stage: "dependency_observation",
        actor: "server:dependency-observation",
        payloadRef: {
          kind: "acceptance_dependency_observation",
          version: 1,
          binding: {
            workspaceId: wsId,
            recordId: fixture.draft.record.id,
            repo: fixture.repo,
            prNumber: 279,
            headSha,
            headCycleId: fixture.advanced.jobId,
            authorityGeneration: record.currentPrHeadAuthorityGeneration,
            reviewJobId: fixture.advanced.jobId,
            acceptanceContract: {
              id: fixture.draft.contract.id,
              version: fixture.draft.contract.version,
              sha256: contractSha256,
            },
            compiledPack: {
              id: fixture.pack.id,
              sha256: fixture.pack.packSha256,
              sourceSnapshotId: fixture.pack.sourceSnapshotId,
              sourceCustodyIdentitySha256: fixture.pack.sourceCustodyIdentitySha256,
              compilerVersion: fixture.pack.compilerVersion,
              policyVersion: fixture.pack.policyVersion,
              exactHeadDependencyTreeProofsSha256: acceptanceContextPackCanonicalSha256({
                kind: "acceptance_dependency_tree_proof_set",
                version: 1,
                proofs: fixture.pack.exactHeadDependencyTreeProofs,
              }),
            },
          },
          candidateFingerprint,
          candidate: legacyCandidate,
          runtime: { ...legacyRuntime, nodeVersion: version },
          packageManager: input.packageManager,
          manifest: input.manifest,
          lockfile: input.lockfile,
          baseline: input.baseline,
          security: legacySecurity,
          status: "observed",
          reasons: [],
        },
      });

      await expect(recordAcceptanceDependencyObservation(input)).resolves.toMatchObject({
        kind: "replayed",
        observation: { eventKey, candidateFingerprint, status: "observed" },
      });
      await expect(readCurrentAcceptanceDependencyObservations({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
      })).resolves.toMatchObject({
        kind: "current",
        observations: [{
          payloadVersion: 1,
          observation: {
            eventKey,
            candidateFingerprint,
            candidate: { identity: input.candidate.identity },
            runtime: { identity: input.runtime.identity, version: input.runtime.version },
            security: { identity: input.security.identity },
          },
        }],
      });
      const observationEvents = (await db.select().from(changeRecordEvents).where(
        eq(changeRecordEvents.recordId, fixture.draft.record.id),
      )).filter((event) => event.eventKey.startsWith("acceptance-dependency-observation:"));
      expect(observationEvents).toHaveLength(1);
    });

    it("replays a pre-support npm v2 refusal without reinterpreting or admitting broad evidence", async () => {
      const headSha = "c".repeat(40);
      const fixture = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "dependency-observation-historical-unsupported-npm",
        prNumber: 283,
        headSha,
        manifestPath: "services/api/package.json",
        manifestContent: JSON.stringify({ dependencies: { lodash: "release-channel" } }),
        lockfilePath: "services/api/package-lock.json",
        lockfileContent: JSON.stringify({ name: "api", lockfileVersion: 3, packages: {} }),
      });
      if (fixture.lockfileBlobSha === null) throw new Error("expected historical npm lockfile custody");
      const record = (await db.select().from(changeRecords).where(
        eq(changeRecords.id, fixture.draft.record.id),
      ))[0]!;
      const identity = {
        ecosystem: "node",
        manager: "npm",
        profile: "npm_package_lock_only_v1",
      };
      const broadEvidence = {
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        compiledPackId: fixture.pack.id,
        candidate: {
          identity,
          package: "lodash",
          dependencyKind: "runtime",
          specifier: "release-channel",
          currentVersion: "release-1",
          targetVersion: "release-2",
        },
        runtime: {
          identity,
          disposition: "safe" as const,
          version: "node-release-22",
          evidenceSha256: "1".repeat(64),
        },
        packageManager: {
          disposition: "safe" as const,
          name: "npm",
          version: "npm-release-10",
          profile: "npm_package_lock_only_v1",
          updateArgv: ["npm", "install", "lodash@release-2"],
          evidenceSha256: "2".repeat(64),
        },
        manifest: { path: "services/api/package.json", blobSha: fixture.manifestBlobSha },
        lockfile: {
          disposition: "present" as const,
          path: "services/api/package-lock.json",
          blobSha: fixture.lockfileBlobSha,
          evidenceSha256: "3".repeat(64),
        },
        baseline: { headSha },
        security: {
          identity,
          disposition: "clear" as const,
          provider: "opaque",
          reference: "opaque:pre-support-npm",
          reportSha256: "4".repeat(64),
        },
      };
      const contractSha256 = acceptanceContractSha256({
        acceptanceContractId: fixture.draft.contract.id,
        acceptanceContractVersion: fixture.draft.contract.version,
        contract: fixture.draft.contract.contract,
      });
      const candidateFingerprint = `sha256:${acceptanceContextPackCanonicalSha256({
        identity,
        manifestPath: broadEvidence.manifest.path,
        package: broadEvidence.candidate.package,
        dependencyKind: broadEvidence.candidate.dependencyKind,
        specifier: broadEvidence.candidate.specifier,
        currentVersion: broadEvidence.candidate.currentVersion,
        targetVersion: broadEvidence.candidate.targetVersion,
      })}`;
      const eventKey = `acceptance-dependency-observation:v2:${fixture.advanced.jobId}:${candidateFingerprint.slice("sha256:".length)}`;
      const binding = {
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        repo: fixture.repo,
        prNumber: 283,
        headSha,
        headCycleId: fixture.advanced.jobId,
        authorityGeneration: record.currentPrHeadAuthorityGeneration,
        reviewJobId: fixture.advanced.jobId,
        acceptanceContract: {
          id: fixture.draft.contract.id,
          version: fixture.draft.contract.version,
          sha256: contractSha256,
        },
        compiledPack: {
          id: fixture.pack.id,
          sha256: fixture.pack.packSha256,
          sourceSnapshotId: fixture.pack.sourceSnapshotId,
          sourceCustodyIdentitySha256: fixture.pack.sourceCustodyIdentitySha256,
          compilerVersion: fixture.pack.compilerVersion,
          policyVersion: fixture.pack.policyVersion,
          exactHeadDependencyTreeProofsSha256: acceptanceContextPackCanonicalSha256({
            kind: "acceptance_dependency_tree_proof_set",
            version: 1,
            proofs: fixture.pack.exactHeadDependencyTreeProofs,
          }),
        },
      };
      const historical = await appendChangeRecordEvent({
        recordId: fixture.draft.record.id,
        eventKey,
        stage: "dependency_observation",
        actor: "server:dependency-observation",
        payloadRef: {
          kind: "acceptance_dependency_observation",
          version: 2,
          binding,
          candidateFingerprint,
          candidate: broadEvidence.candidate,
          runtime: broadEvidence.runtime,
          packageManager: broadEvidence.packageManager,
          manifest: broadEvidence.manifest,
          lockfile: broadEvidence.lockfile,
          baseline: broadEvidence.baseline,
          security: broadEvidence.security,
          status: "refused_unsupported_profile",
          reasons: ["unsupported_manager_profile"],
        },
      });

      await expect(recordAcceptanceDependencyObservation(broadEvidence)).resolves.toMatchObject({
        kind: "replayed",
        observation: {
          eventId: historical.event.id,
          eventKey,
          status: "refused_unsupported_profile",
          reasons: ["unsupported_manager_profile"],
          candidate: broadEvidence.candidate,
        },
      });
      await expect(readCurrentAcceptanceDependencyObservations({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
      })).resolves.toMatchObject({
        kind: "current",
        observations: [{
          payloadVersion: 2,
          observation: { eventId: historical.event.id, status: "refused_unsupported_profile" },
          approval: null,
          externalBuilderPack: null,
        }],
      });
      await expect(recordAcceptanceDependencyObservation({
        ...broadEvidence,
        security: { ...broadEvidence.security, reportSha256: "5".repeat(64) },
      })).rejects.toBeInstanceOf(AcceptanceDependencyObservationConflictError);
      await expect(recordAcceptanceDependencyObservation({
        ...broadEvidence,
        candidate: { ...broadEvidence.candidate, targetVersion: "release-3" },
      })).rejects.toBeInstanceOf(AcceptanceDependencyObservationInvalidEvidenceError);

      const ownerId = "13131313-1313-4131-8131-131313131313";
      await db.insert(workspaceMemberships).values({ workspaceId: wsId, userId: ownerId, role: "owner" });
      await selectDependencyExternalBuilderRoute({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        repo: fixture.repo,
        adapter: "github_codex",
      });
      await expect(approveAcceptanceDependencyObservationAndMintExternalBuilderPack({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        observationEventId: historical.event.id,
        approvedBy: `user:${ownerId}`,
      })).resolves.toEqual({
        kind: "observation_not_eligible",
        reason: "observation_not_observed",
      });
      expect(await db.select().from(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, fixture.draft.record.id),
        eq(changeRecordEvents.stage, "dependency_observation"),
      ))).toHaveLength(1);
    });

    it("records and replays a bounded unsupported Poetry identity without pnpm coercion", async () => {
      const fixture = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "dependency-observation-poetry-refusal",
        prNumber: 280,
        headSha: "6".repeat(40),
        manifestPath: "pyproject.toml",
        manifestContent: "[tool.poetry.dependencies]\nrequests = '^2.31'\n",
        lockfilePath: "poetry.lock",
        lockfileContent: "[[package]]\nname = 'requests'\nversion = '2.32.0'\n",
      });
      const input = acceptanceDependencyObservationInput({
        workspaceId: wsId, recordId: fixture.draft.record.id, compiledPackId: fixture.pack.id,
        headSha: "6".repeat(40), manifestBlobSha: fixture.manifestBlobSha, lockfileBlobSha: fixture.lockfileBlobSha,
      });
      const identity = { ecosystem: "python", manager: "poetry", profile: "poetry_lock_v1" };
      const poetry = {
        ...input,
        candidate: {
          ...input.candidate,
          identity,
          package: "requests",
          specifier: "^2.31",
          currentVersion: "2.31.0rc1",
          targetVersion: "2.32.0rc1",
        },
        runtime: { ...input.runtime, identity, version: "cpython-3.13" },
        packageManager: {
          ...input.packageManager,
          name: "poetry",
          version: "2.1.4",
          profile: "poetry_lock_v1",
          updateArgv: ["poetry", "update", "requests", "--lock"],
        },
        manifest: { path: "pyproject.toml", blobSha: fixture.manifestBlobSha },
        lockfile: { ...input.lockfile, path: "poetry.lock" },
        security: { ...input.security, identity, provider: "opaque", reference: "opaque:poetry-observation" },
      };
      const recorded = await recordAcceptanceDependencyObservation(poetry);
      expect(recorded).toMatchObject({
        kind: "recorded",
        observation: { status: "refused_unsupported_profile", reasons: ["unsupported_manager_profile"], candidate: poetry.candidate },
      });
      const replay = await recordAcceptanceDependencyObservation(poetry);
      expect(replay).toMatchObject({ kind: "replayed", observation: { status: "refused_unsupported_profile" } });

      const missingSource = {
        ...poetry,
        manifest: { ...poetry.manifest, path: "services/api/pyproject.toml" },
        lockfile: { ...poetry.lockfile, path: "services/api/poetry.lock" },
      };
      await expect(recordAcceptanceDependencyObservation(missingSource)).resolves.toMatchObject({
        kind: "recorded",
        observation: {
          status: "refused_unsupported_profile",
          reasons: [
            "unsupported_manager_profile",
            "manifest_source_not_proven",
            "lockfile_source_not_proven",
          ],
        },
      });
    });

    it("records fail-closed dependency refusals only when their exact source custody is proven", async () => {
      const headSha = "2".repeat(40);
      const fixture = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "dependency-observation-refusals",
        prNumber: 181,
        headSha,
      });
      const base = (targetVersion: string) => acceptanceDependencyObservationInput({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        compiledPackId: fixture.pack.id,
        headSha,
        manifestBlobSha: fixture.manifestBlobSha,
        lockfileBlobSha: fixture.lockfileBlobSha,
        targetVersion,
      });

      const unsafeRuntime = base("4.17.22");
      await expect(recordAcceptanceDependencyObservation({
        ...unsafeRuntime,
        runtime: {
          ...unsafeRuntime.runtime,
          disposition: "unsafe",
          version: "0.1.0",
        },
      })).resolves.toMatchObject({
        kind: "recorded",
        observation: { status: "refused_unsafe_runtime", reasons: ["unsafe_runtime"] },
      });

      const unsafeProfile = base("4.17.23");
      await expect(recordAcceptanceDependencyObservation({
        ...unsafeProfile,
        packageManager: {
          ...unsafeProfile.packageManager,
          profile: "pnpm_lockfile_only_v2",
        },
      })).resolves.toMatchObject({
        kind: "recorded",
        observation: {
          status: "refused_unsafe_runtime",
          reasons: ["unsafe_package_manager_profile"],
        },
      });

      const unsafeArgv = base("4.17.231");
      await expect(recordAcceptanceDependencyObservation({
        ...unsafeArgv,
        packageManager: {
          ...unsafeArgv.packageManager,
          updateArgv: ["pnpm", "exec", "postinstall"],
        },
      })).resolves.toMatchObject({
        kind: "recorded",
        observation: {
          status: "refused_unsafe_runtime",
          reasons: ["unsafe_package_manager_argv"],
        },
      });

      const unsafeManagerVersion = base("4.17.233");
      await expect(recordAcceptanceDependencyObservation({
        ...unsafeManagerVersion,
        packageManager: {
          ...unsafeManagerVersion.packageManager,
          version: "pnpm-ten",
        },
      })).resolves.toMatchObject({
        kind: "recorded",
        observation: {
          status: "refused_unsafe_runtime",
          reasons: ["unsafe_package_manager_profile"],
        },
      });

      const unsafeSecurityIdentity = base("4.17.232");
      await expect(recordAcceptanceDependencyObservation({
        ...unsafeSecurityIdentity,
        security: {
          ...unsafeSecurityIdentity.security,
          provider: "github",
          reference: "opaque:untrusted-security-result",
        },
      })).resolves.toMatchObject({
        kind: "recorded",
        observation: {
          status: "refused_unsafe_runtime",
          reasons: ["unsafe_package_manager_profile"],
        },
      });

      const wrongBaseline = base("4.17.24");
      await expect(recordAcceptanceDependencyObservation({
        ...wrongBaseline,
        baseline: { headSha: "f".repeat(40) },
      })).resolves.toMatchObject({
        kind: "recorded",
        observation: { status: "refused_baseline", reasons: ["baseline_head_mismatch"] },
      });

      for (const [targetVersion, disposition, reason] of [
        ["4.17.25", "affected", "security_affected"],
        ["4.17.26", "unavailable", "security_evidence_unavailable"],
        ["4.17.27", "ambiguous", "security_evidence_ambiguous"],
      ] as const) {
        const evidence = base(targetVersion);
        await expect(recordAcceptanceDependencyObservation({
          ...evidence,
          security: { ...evidence.security, disposition },
        })).resolves.toMatchObject({
          kind: "recorded",
          observation: { status: "refused_security", reasons: [reason] },
        });
      }

      const unknownRuntime = base("4.17.28");
      await expect(recordAcceptanceDependencyObservation({
        ...unknownRuntime,
        runtime: {
          ...unknownRuntime.runtime,
          disposition: "unavailable",
          version: null,
        },
      })).resolves.toMatchObject({
        kind: "recorded",
        observation: { status: "not_proven", reasons: ["runtime_evidence_unavailable"] },
      });

      const uncommittedLockfile = acceptanceDependencyObservationInput({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        compiledPackId: fixture.pack.id,
        headSha,
        manifestBlobSha: fixture.manifestBlobSha,
        lockfileBlobSha: fixture.lockfileBlobSha,
        targetVersion: "4.17.29",
        lockfileDisposition: "uncommitted",
      });
      await expect(recordAcceptanceDependencyObservation(uncommittedLockfile)).resolves.toMatchObject({
        kind: "recorded",
        observation: { status: "refused_lockfile", reasons: ["lockfile_uncommitted"] },
      });

      const falseMissing = acceptanceDependencyObservationInput({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        compiledPackId: fixture.pack.id,
        headSha,
        manifestBlobSha: fixture.manifestBlobSha,
        lockfileBlobSha: fixture.lockfileBlobSha,
        targetVersion: "4.17.30",
        lockfileDisposition: "missing",
      });
      await expect(recordAcceptanceDependencyObservation(falseMissing)).resolves.toMatchObject({
        kind: "recorded",
        observation: {
          status: "not_proven",
          reasons: ["lockfile_source_not_proven", "lockfile_missing"],
        },
      });

      const missing = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "dependency-observation-lockfile-missing",
        prNumber: 182,
        headSha: "3".repeat(40),
        lockfileReadReason: "path_not_found",
      });
      await expect(recordAcceptanceDependencyObservation(
        acceptanceDependencyObservationInput({
          workspaceId: wsId,
          recordId: missing.draft.record.id,
          compiledPackId: missing.pack.id,
          headSha: "3".repeat(40),
          manifestBlobSha: missing.manifestBlobSha,
          lockfileBlobSha: null,
          lockfileDisposition: "missing",
        }),
      )).resolves.toMatchObject({
        kind: "recorded",
        observation: { status: "refused_lockfile", reasons: ["lockfile_missing"] },
      });

      const unavailable = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "dependency-observation-lockfile-unavailable",
        prNumber: 183,
        headSha: "4".repeat(40),
        lockfileReadReason: "github_unavailable",
      });
      for (const [targetVersion, disposition, reason] of [
        ["4.17.21", "unavailable", "lockfile_evidence_unavailable"],
        ["4.17.22", "ambiguous", "lockfile_evidence_ambiguous"],
      ] as const) {
        await expect(recordAcceptanceDependencyObservation(
          acceptanceDependencyObservationInput({
            workspaceId: wsId,
            recordId: unavailable.draft.record.id,
            compiledPackId: unavailable.pack.id,
            headSha: "4".repeat(40),
            manifestBlobSha: unavailable.manifestBlobSha,
            lockfileBlobSha: null,
            targetVersion,
            lockfileDisposition: disposition,
          }),
        )).resolves.toMatchObject({
          kind: "recorded",
          observation: { status: "refused_lockfile", reasons: [reason] },
        });
      }

      const dispatches = await db.select().from(acceptanceCorrectionDispatches).where(inArray(
        acceptanceCorrectionDispatches.recordId,
        [fixture.draft.record.id, missing.draft.record.id, unavailable.draft.record.id],
      ));
      expect(dispatches).toHaveLength(0);
    });

    it("fails closed when dependency evidence is not tied to the compiled Pack custody", async () => {
      const fixture = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "dependency-observation-source-custody",
        prNumber: 184,
        headSha: "5".repeat(40),
      });
      const input = acceptanceDependencyObservationInput({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        compiledPackId: fixture.pack.id,
        headSha: "5".repeat(40),
        manifestBlobSha: "a".repeat(40),
        lockfileBlobSha: fixture.lockfileBlobSha,
      });
      await expect(recordAcceptanceDependencyObservation(input)).resolves.toMatchObject({
        kind: "recorded",
        observation: { status: "not_proven", reasons: ["manifest_source_not_proven"] },
      });

      await db.update(acceptanceCompiledContextPacks).set({ manifest: {} }).where(
        eq(acceptanceCompiledContextPacks.id, fixture.pack.id),
      );
      const nextCandidate = acceptanceDependencyObservationInput({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        compiledPackId: fixture.pack.id,
        headSha: "5".repeat(40),
        manifestBlobSha: fixture.manifestBlobSha,
        lockfileBlobSha: fixture.lockfileBlobSha,
        targetVersion: "4.17.22",
      });
      await expect(recordAcceptanceDependencyObservation(nextCandidate)).resolves.toEqual({
        kind: "not_ready",
        reason: "invalid_compiled_pack_custody",
      });
    });

    it("never revives a dependency observation Pack across A-B-A head occurrences or reconciliation", async () => {
      const headA = "6".repeat(40);
      const headB = "7".repeat(40);
      const fixture = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "dependency-observation-a-b-a",
        prNumber: 185,
        headSha: headA,
      });
      const oldInput = acceptanceDependencyObservationInput({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        compiledPackId: fixture.pack.id,
        headSha: headA,
        manifestBlobSha: fixture.manifestBlobSha,
        lockfileBlobSha: fixture.lockfileBlobSha,
      });
      const advancedB = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        repo: fixture.repo,
        prNumber: 185,
        headSha: headB,
        event: "synchronize",
        deliveryId: "dependency-observation-a-b-a:b",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: headA, afterHeadSha: headB },
        source: "github_webhook",
      });
      expect(advancedB).toMatchObject({ kind: "advanced", previousHeadSha: headA });
      await expect(recordAcceptanceDependencyObservation(oldInput)).resolves.toEqual({
        kind: "not_current",
      });

      const revisitedA = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        repo: fixture.repo,
        prNumber: 185,
        headSha: headA,
        event: "synchronize",
        deliveryId: "dependency-observation-a-b-a:a2",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: headB, afterHeadSha: headA },
        source: "github_webhook",
      });
      expect(revisitedA).toMatchObject({ kind: "advanced", previousHeadSha: headB });
      if (revisitedA.kind !== "advanced") throw new Error("expected revisited A occurrence");
      expect(revisitedA.jobId).not.toBe(fixture.advanced.jobId);
      await expect(recordAcceptanceDependencyObservation(oldInput)).resolves.toEqual({
        kind: "not_current",
      });

      const heldFixture = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "dependency-observation-reconcile",
        prNumber: 186,
        headSha: "8".repeat(40),
      });
      const held = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId,
        recordId: heldFixture.draft.record.id,
        repo: heldFixture.repo,
        prNumber: 186,
        headSha: "9".repeat(40),
        event: "synchronize",
        deliveryId: "dependency-observation-reconcile:held",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: "f".repeat(40), afterHeadSha: "9".repeat(40) },
        source: "github_webhook",
      });
      expect(held).toMatchObject({ kind: "stale_delivery", currentAuthoritative: false });
      if (held.kind !== "stale_delivery" || held.blockedCycleId === null) {
        throw new Error("expected held dependency observation delivery");
      }
      const heldInput = acceptanceDependencyObservationInput({
        workspaceId: wsId,
        recordId: heldFixture.draft.record.id,
        compiledPackId: heldFixture.pack.id,
        headSha: "8".repeat(40),
        manifestBlobSha: heldFixture.manifestBlobSha,
        lockfileBlobSha: heldFixture.lockfileBlobSha,
      });
      await expect(recordAcceptanceDependencyObservation(heldInput)).resolves.toEqual({
        kind: "not_current",
      });
      const reconciled = await reconcileConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId,
        recordId: heldFixture.draft.record.id,
        repo: heldFixture.repo,
        prNumber: 186,
        expectedBlockedHeadSha: held.blockedHeadSha,
        expectedBlockedCycleId: held.blockedCycleId,
        expectedBlockedAuthorityGeneration: held.authorityGeneration,
        observedHeadSha: "a".repeat(40),
        observedBaseSha: "b".repeat(40),
        observedState: "open",
        observedDraft: false,
        observedMerged: false,
        source: "github_app_api",
      });
      expect(reconciled).toMatchObject({ kind: "reconciled", observedHeadSha: "a".repeat(40) });
      await expect(recordAcceptanceDependencyObservation(heldInput)).resolves.toEqual({
        kind: "not_current",
      });
    });

    it("serializes dependency observation writes with signed head advance", async () => {
      const headA = "c".repeat(40);
      const headB = "d".repeat(40);
      const fixture = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "dependency-observation-head-race",
        prNumber: 187,
        headSha: headA,
      });
      const observationInput = acceptanceDependencyObservationInput({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        compiledPackId: fixture.pack.id,
        headSha: headA,
        manifestBlobSha: fixture.manifestBlobSha,
        lockfileBlobSha: fixture.lockfileBlobSha,
      });
      const [observation, headAdvance] = await Promise.all([
        recordAcceptanceDependencyObservation(observationInput),
        advanceConfirmedAcceptanceRecordPullRequestHead({
          workspaceId: wsId,
          recordId: fixture.draft.record.id,
          repo: fixture.repo,
          prNumber: 187,
          headSha: headB,
          event: "synchronize",
          deliveryId: "dependency-observation-head-race:b",
          admitReviewJob: true,
          headTransition: { beforeHeadSha: headA, afterHeadSha: headB },
          source: "github_webhook",
        }),
      ]);
      expect(headAdvance).toMatchObject({ kind: "advanced", previousHeadSha: headA });
      expect(["recorded", "not_current"]).toContain(observation.kind);
      const events = await db.select().from(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, fixture.draft.record.id),
        eq(changeRecordEvents.stage, "dependency_observation"),
      ));
      expect(events).toHaveLength(observation.kind === "recorded" ? 1 : 0);
      for (const event of events) {
        expect(event.payloadRef).toMatchObject({
          binding: {
            headSha: headA,
            headCycleId: fixture.advanced.jobId,
            reviewJobId: fixture.advanced.jobId,
          },
        });
      }
      await expect(recordAcceptanceDependencyObservation(observationInput)).resolves.toEqual({
        kind: "not_current",
      });
    });

    it("approves one observed dependency candidate and mints one immutable external Builder Pack", async () => {
      const headSha = "e".repeat(40);
      const fixture = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "dependency-external-builder-pack",
        prNumber: 188,
        headSha,
      });
      const selected = await selectDependencyExternalBuilderRoute({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        repo: fixture.repo,
        adapter: "github_codex",
        configurationVersion: 3,
      });
      const observed = await recordAcceptanceDependencyObservation(
        acceptanceDependencyObservationInput({
          workspaceId: wsId,
          recordId: fixture.draft.record.id,
          compiledPackId: fixture.pack.id,
          headSha,
          manifestBlobSha: fixture.manifestBlobSha,
          lockfileBlobSha: fixture.lockfileBlobSha,
        }),
      );
      if (observed.kind !== "recorded") throw new Error("expected observed dependency candidate");
      const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const otherOwnerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      await db.insert(workspaceMemberships).values([
        { workspaceId: wsId, userId: ownerId, role: "owner" },
        { workspaceId: wsId, userId: otherOwnerId, role: "owner" },
      ]);

      await expect(readCurrentAcceptanceDependencyObservations({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
      })).resolves.toMatchObject({
        kind: "current",
        binding: {
          headSha,
          headCycleId: fixture.advanced.jobId,
          authorityGeneration: 1,
          acceptanceContract: { id: fixture.draft.contract.id },
        },
        observations: [{
          payloadVersion: 2,
          observation: { eventId: observed.observation.eventId, status: "observed" },
          approval: null,
          externalBuilderPack: null,
        }],
      });

      const command = {
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        observationEventId: observed.observation.eventId,
        approvedBy: `user:${ownerId}`,
      };
      const approved = await approveAcceptanceDependencyObservationAndMintExternalBuilderPack(command);
      expect(approved).toMatchObject({
        kind: "approved",
        binding: observed.binding,
        observation: { eventId: observed.observation.eventId, status: "observed" },
        approval: {
          eventKey: `acceptance-dependency-approval:${fixture.advanced.jobId}:${observed.observation.candidateFingerprint.slice("sha256:".length)}`,
          observationEventId: observed.observation.eventId,
          candidateFingerprint: observed.observation.candidateFingerprint,
          approvedBy: `user:${ownerId}`,
          approvedRole: "owner",
          approvedAt: expect.any(Date),
        },
        externalBuilderPack: {
          packId: expect.stringMatching(/^[a-f0-9-]{36}$/),
          eventKey: `acceptance-dependency-external-builder-pack:${fixture.advanced.jobId}:${observed.observation.candidateFingerprint.slice("sha256:".length)}`,
          observationEventId: observed.observation.eventId,
          candidateFingerprint: observed.observation.candidateFingerprint,
          binding: observed.binding,
          candidate: observed.observation.candidate,
          route: {
            selectionEventId: selected.selection.id,
            id: selected.route.id,
            adapter: "github_codex",
            configurationVersion: 3,
            snapshot: { scopeBoundary: "correction_delivery_only" },
            snapshotSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
          deliveryAuthority: "not_granted",
          scopeBoundary: "dependency_external_builder_pack_only",
          reviewRequirement: "exact_head_r7_reentry",
          mintedAt: expect.any(Date),
        },
      });
      if (approved.kind !== "approved") throw new Error("expected dependency approval and Pack");
      expect(approved.externalBuilderPack.approvalEventId).toBe(approved.approval.eventId);

      await expect(readCurrentAcceptanceDependencyObservations({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
      })).resolves.toMatchObject({
        kind: "current",
        observations: [{
          approval: { eventId: approved.approval.eventId },
          externalBuilderPack: { eventId: approved.externalBuilderPack.eventId },
        }],
      });
      await db.update(workspaceMemberships).set({ role: "admin" }).where(and(
        eq(workspaceMemberships.workspaceId, wsId),
        eq(workspaceMemberships.userId, ownerId),
      ));
      await db.update(acceptanceBuilderRoutes).set({ status: "disabled" }).where(
        eq(acceptanceBuilderRoutes.id, selected.route.id),
      );
      await expect(approveAcceptanceDependencyObservationAndMintExternalBuilderPack(command))
        .resolves.toMatchObject({
          kind: "replayed",
          approval: { eventId: approved.approval.eventId, approvedRole: "owner" },
          externalBuilderPack: { eventId: approved.externalBuilderPack.eventId },
        });
      await expect(approveAcceptanceDependencyObservationAndMintExternalBuilderPack({
        ...command,
        approvedBy: `user:${otherOwnerId}`,
      })).rejects.toBeInstanceOf(AcceptanceDependencyExternalBuilderPackConflictError);
      await db.delete(workspaceMemberships).where(and(
        eq(workspaceMemberships.workspaceId, wsId),
        eq(workspaceMemberships.userId, ownerId),
      ));
      await expect(approveAcceptanceDependencyObservationAndMintExternalBuilderPack(command))
        .resolves.toEqual({ kind: "not_authorized" });

      const foreign = (await db.insert(workspaces).values({
        name: "foreign dependency Pack workspace",
        slug: `foreign-dependency-pack-${randomUUID()}`,
      }).returning({ id: workspaces.id }))[0]!;
      await expect(readCurrentAcceptanceDependencyObservations({
        workspaceId: foreign.id,
        recordId: fixture.draft.record.id,
      })).resolves.toEqual({ kind: "not_found" });
      await expect(approveAcceptanceDependencyObservationAndMintExternalBuilderPack({
        ...command,
        workspaceId: foreign.id,
        approvedBy: `user:${otherOwnerId}`,
      })).resolves.toEqual({ kind: "not_found" });
      await db.delete(workspaces).where(eq(workspaces.id, foreign.id));

      expect(await db.select().from(acceptanceCorrectionDispatches).where(
        eq(acceptanceCorrectionDispatches.recordId, fixture.draft.record.id),
      )).toHaveLength(0);
      expect((await db.select().from(changeRecords).where(
        eq(changeRecords.id, fixture.draft.record.id),
      ))[0]).toMatchObject({ issueNumber: null, mergedSha: null, state: "open" });
    });

    it("refuses dependency Pack approval for unauthorized and non-observed evidence", async () => {
      const headSha = "f".repeat(40);
      const fixture = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "dependency-pack-refusal",
        prNumber: 189,
        headSha,
      });
      await selectDependencyExternalBuilderRoute({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        repo: fixture.repo,
        adapter: "github_claude",
      });
      const evidence = acceptanceDependencyObservationInput({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        compiledPackId: fixture.pack.id,
        headSha,
        manifestBlobSha: fixture.manifestBlobSha,
        lockfileBlobSha: fixture.lockfileBlobSha,
      });
      const refused = await recordAcceptanceDependencyObservation({
        ...evidence,
        security: { ...evidence.security, disposition: "affected" },
      });
      if (refused.kind !== "recorded") throw new Error("expected refused dependency observation");
      const memberId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      const adminId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
      await db.insert(workspaceMemberships).values([
        { workspaceId: wsId, userId: memberId, role: "member" },
        { workspaceId: wsId, userId: adminId, role: "admin" },
      ]);
      const base = {
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        observationEventId: refused.observation.eventId,
      };
      await expect(approveAcceptanceDependencyObservationAndMintExternalBuilderPack({
        ...base,
        approvedBy: `user:${memberId}`,
      })).resolves.toEqual({ kind: "not_authorized" });
      await expect(approveAcceptanceDependencyObservationAndMintExternalBuilderPack({
        ...base,
        approvedBy: `user:${adminId}`,
      })).resolves.toEqual({
        kind: "observation_not_eligible",
        reason: "observation_not_observed",
      });
      await expect(approveAcceptanceDependencyObservationAndMintExternalBuilderPack({
        ...base,
        observationEventId: randomUUID(),
        approvedBy: `user:${adminId}`,
      })).resolves.toEqual({ kind: "observation_not_found" });
      await expect(readCurrentAcceptanceDependencyObservations({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
      })).resolves.toMatchObject({
        kind: "current",
        observations: [{
          observation: { status: "refused_security", reasons: ["security_affected"] },
          approval: null,
          externalBuilderPack: null,
        }],
      });
      expect(await db.select().from(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, fixture.draft.record.id),
        inArray(changeRecordEvents.stage, ["human_dependency_approval", "external_builder_pack"]),
      ))).toHaveLength(0);
    });

    it("fails closed on unavailable, unsupported, drifted route or compiled Pack custody", async () => {
      const ownerId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
      await db.insert(workspaceMemberships).values({ workspaceId: wsId, userId: ownerId, role: "owner" });
      const approveFixture = async (input: {
        workKey: string;
        prNumber: number;
        headSha: string;
        adapter?: "github_codex" | "durable_jace_fallback";
      }) => {
        const fixture = await createAcceptanceDependencyObservationFixture({
          workspaceId: wsId,
          workKey: input.workKey,
          prNumber: input.prNumber,
          headSha: input.headSha,
        });
        const observed = await recordAcceptanceDependencyObservation(
          acceptanceDependencyObservationInput({
            workspaceId: wsId,
            recordId: fixture.draft.record.id,
            compiledPackId: fixture.pack.id,
            headSha: input.headSha,
            manifestBlobSha: fixture.manifestBlobSha,
            lockfileBlobSha: fixture.lockfileBlobSha,
          }),
        );
        if (observed.kind !== "recorded") throw new Error("expected route test observation");
        const selected = input.adapter ? await selectDependencyExternalBuilderRoute({
          workspaceId: wsId,
          recordId: fixture.draft.record.id,
          repo: fixture.repo,
          adapter: input.adapter,
        }) : null;
        return { fixture, observed, selected, command: {
          workspaceId: wsId,
          recordId: fixture.draft.record.id,
          observationEventId: observed.observation.eventId,
          approvedBy: `user:${ownerId}`,
        } };
      };

      const unavailable = await approveFixture({
        workKey: "dependency-pack-route-unavailable",
        prNumber: 190,
        headSha: "1".repeat(40),
      });
      await expect(approveAcceptanceDependencyObservationAndMintExternalBuilderPack(unavailable.command))
        .resolves.toEqual({ kind: "not_ready", reason: "selected_route_unavailable" });

      const unsupported = await approveFixture({
        workKey: "dependency-pack-route-unsupported",
        prNumber: 191,
        headSha: "2".repeat(40),
        adapter: "durable_jace_fallback",
      });
      await expect(approveAcceptanceDependencyObservationAndMintExternalBuilderPack(unsupported.command))
        .resolves.toEqual({ kind: "not_ready", reason: "selected_route_not_external_builder" });

      const drifted = await approveFixture({
        workKey: "dependency-pack-route-drift",
        prNumber: 192,
        headSha: "3".repeat(40),
        adapter: "github_codex",
      });
      await db.update(acceptanceBuilderRoutes).set({ configurationVersion: 2 }).where(
        eq(acceptanceBuilderRoutes.id, drifted.selected!.route.id),
      );
      await expect(approveAcceptanceDependencyObservationAndMintExternalBuilderPack(drifted.command))
        .resolves.toEqual({ kind: "not_ready", reason: "selected_route_unavailable" });

      const packDrift = await approveFixture({
        workKey: "dependency-pack-source-drift",
        prNumber: 193,
        headSha: "4".repeat(40),
        adapter: "github_codex",
      });
      await db.update(acceptanceCompiledContextPacks).set({ manifest: {} }).where(
        eq(acceptanceCompiledContextPacks.id, packDrift.fixture.pack.id),
      );
      await expect(approveAcceptanceDependencyObservationAndMintExternalBuilderPack(packDrift.command))
        .resolves.toEqual({ kind: "not_ready", reason: "invalid_compiled_pack_custody" });
      await expect(readCurrentAcceptanceDependencyObservations({
        workspaceId: wsId,
        recordId: packDrift.fixture.draft.record.id,
      })).resolves.toEqual({ kind: "not_ready", reason: "invalid_compiled_pack_custody" });

      await db.update(acceptanceCompiledContextPacks).set({
        manifest: packDrift.fixture.pack.manifest,
      }).where(eq(acceptanceCompiledContextPacks.id, packDrift.fixture.pack.id));
      await db.update(wikiPages).set({ bodyMd: "tampered dependency source custody" }).where(and(
        eq(wikiPages.workspaceId, wsId),
        eq(wikiPages.slug, "wiki/dependency-pack-source-drift"),
      ));
      await expect(approveAcceptanceDependencyObservationAndMintExternalBuilderPack(packDrift.command))
        .resolves.toEqual({ kind: "not_ready", reason: "invalid_compiled_pack_custody" });

      const contractDrift = await approveFixture({
        workKey: "dependency-pack-contract-drift",
        prNumber: 197,
        headSha: "a".repeat(40),
        adapter: "github_codex",
      });
      await db.update(acceptanceContracts).set({ status: "draft" }).where(
        eq(acceptanceContracts.id, contractDrift.fixture.draft.contract.id),
      );
      await expect(approveAcceptanceDependencyObservationAndMintExternalBuilderPack(contractDrift.command))
        .resolves.toEqual({ kind: "not_ready", reason: "confirmed_contract_unavailable" });
      expect(await db.select().from(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, contractDrift.fixture.draft.record.id),
        inArray(changeRecordEvents.stage, ["human_dependency_approval", "external_builder_pack"]),
      ))).toHaveLength(0);
    });

    it("keeps dependency approval occurrence-safe across A-B-A and serializes with head advance", async () => {
      const ownerId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
      await db.insert(workspaceMemberships).values({ workspaceId: wsId, userId: ownerId, role: "owner" });
      const headA = "5".repeat(40);
      const headB = "6".repeat(40);
      const fixture = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "dependency-pack-a-b-a",
        prNumber: 194,
        headSha: headA,
      });
      await selectDependencyExternalBuilderRoute({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        repo: fixture.repo,
        adapter: "github_codex",
      });
      const observed = await recordAcceptanceDependencyObservation(
        acceptanceDependencyObservationInput({
          workspaceId: wsId,
          recordId: fixture.draft.record.id,
          compiledPackId: fixture.pack.id,
          headSha: headA,
          manifestBlobSha: fixture.manifestBlobSha,
          lockfileBlobSha: fixture.lockfileBlobSha,
        }),
      );
      if (observed.kind !== "recorded") throw new Error("expected A1 observation");
      const command = {
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        observationEventId: observed.observation.eventId,
        approvedBy: `user:${ownerId}`,
      };
      await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        repo: fixture.repo,
        prNumber: 194,
        headSha: headB,
        event: "synchronize",
        deliveryId: "dependency-pack-a-b-a:b",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: headA, afterHeadSha: headB },
        source: "github_webhook",
      });
      await expect(approveAcceptanceDependencyObservationAndMintExternalBuilderPack(command))
        .resolves.toEqual({ kind: "not_current" });
      const a2 = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        repo: fixture.repo,
        prNumber: 194,
        headSha: headA,
        event: "synchronize",
        deliveryId: "dependency-pack-a-b-a:a2",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: headB, afterHeadSha: headA },
        source: "github_webhook",
      });
      if (a2.kind !== "advanced") throw new Error("expected A2 occurrence");
      expect(a2.jobId).not.toBe(fixture.advanced.jobId);
      await expect(approveAcceptanceDependencyObservationAndMintExternalBuilderPack(command))
        .resolves.toEqual({ kind: "not_current" });
      await expect(readCurrentAcceptanceDependencyObservations({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
      })).resolves.toMatchObject({ kind: "current", binding: { headCycleId: a2.jobId }, observations: [] });

      const raceHeadA = "7".repeat(40);
      const raceHeadB = "8".repeat(40);
      const race = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "dependency-pack-head-race",
        prNumber: 195,
        headSha: raceHeadA,
      });
      await selectDependencyExternalBuilderRoute({
        workspaceId: wsId,
        recordId: race.draft.record.id,
        repo: race.repo,
        adapter: "github_claude",
      });
      const raceObservation = await recordAcceptanceDependencyObservation(
        acceptanceDependencyObservationInput({
          workspaceId: wsId,
          recordId: race.draft.record.id,
          compiledPackId: race.pack.id,
          headSha: raceHeadA,
          manifestBlobSha: race.manifestBlobSha,
          lockfileBlobSha: race.lockfileBlobSha,
        }),
      );
      if (raceObservation.kind !== "recorded") throw new Error("expected race observation");
      const [approval, advance] = await Promise.all([
        approveAcceptanceDependencyObservationAndMintExternalBuilderPack({
          workspaceId: wsId,
          recordId: race.draft.record.id,
          observationEventId: raceObservation.observation.eventId,
          approvedBy: `user:${ownerId}`,
        }),
        advanceConfirmedAcceptanceRecordPullRequestHead({
          workspaceId: wsId,
          recordId: race.draft.record.id,
          repo: race.repo,
          prNumber: 195,
          headSha: raceHeadB,
          event: "synchronize",
          deliveryId: "dependency-pack-head-race:b",
          admitReviewJob: true,
          headTransition: { beforeHeadSha: raceHeadA, afterHeadSha: raceHeadB },
          source: "github_webhook",
        }),
      ]);
      expect(advance).toMatchObject({ kind: "advanced", previousHeadSha: raceHeadA });
      expect(["approved", "not_current"]).toContain(approval.kind);
      const pairEvents = await db.select().from(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, race.draft.record.id),
        inArray(changeRecordEvents.stage, ["human_dependency_approval", "external_builder_pack"]),
      ));
      expect(pairEvents).toHaveLength(approval.kind === "approved" ? 2 : 0);
      for (const event of pairEvents) {
        expect(event.payloadRef).toMatchObject({
          binding: { headSha: raceHeadA, headCycleId: race.advanced.jobId },
        });
      }
    });

    it("fails closed when an external Builder Pack event pair becomes partial", async () => {
      const ownerId = "99999999-9999-4999-8999-999999999999";
      await db.insert(workspaceMemberships).values({ workspaceId: wsId, userId: ownerId, role: "owner" });
      const fixture = await createAcceptanceDependencyObservationFixture({
        workspaceId: wsId,
        workKey: "dependency-pack-partial-pair",
        prNumber: 196,
        headSha: "9".repeat(40),
      });
      await selectDependencyExternalBuilderRoute({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        repo: fixture.repo,
        adapter: "github_codex",
      });
      const observed = await recordAcceptanceDependencyObservation(
        acceptanceDependencyObservationInput({
          workspaceId: wsId,
          recordId: fixture.draft.record.id,
          compiledPackId: fixture.pack.id,
          headSha: "9".repeat(40),
          manifestBlobSha: fixture.manifestBlobSha,
          lockfileBlobSha: fixture.lockfileBlobSha,
        }),
      );
      if (observed.kind !== "recorded") throw new Error("expected partial pair observation");
      const command = {
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
        observationEventId: observed.observation.eventId,
        approvedBy: `user:${ownerId}`,
      };
      const approved = await approveAcceptanceDependencyObservationAndMintExternalBuilderPack(command);
      if (approved.kind !== "approved") throw new Error("expected complete event pair");
      await db.delete(changeRecordEvents).where(eq(
        changeRecordEvents.id,
        approved.externalBuilderPack.eventId,
      ));
      await expect(readCurrentAcceptanceDependencyObservations({
        workspaceId: wsId,
        recordId: fixture.draft.record.id,
      })).resolves.toEqual({ kind: "not_ready", reason: "invalid_approval_pack_custody" });
      await expect(approveAcceptanceDependencyObservationAndMintExternalBuilderPack(command))
        .rejects.toBeInstanceOf(AcceptanceDependencyExternalBuilderPackConflictError);
    });

    it("persists only a revalidated metadata-only compiled Pack and rejects divergent replay", async () => {
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId, repo: "acme/widgets", workKey: "compiled-pack-custody", originChannel: "codex_mcp",
        contract: completeContract(), createdBy: "user:lead",
      });
      await db.update(acceptanceContracts).set({
        status: "confirmed", confirmedBy: "console_user:user-1", confirmedAt: new Date(),
      }).where(eq(acceptanceContracts.id, draft.contract.id));
      await db.update(workspaces).set({
        githubInstallationId: "installation-dispatch-profile",
        githubInstallationAccountLogin: "acme",
        githubInstallationAccountType: "Organization",
      })
        .where(eq(workspaces.id, wsId));
      const selectedRoute = await registerAcceptanceBuilderRoute({
        workspaceId: wsId, repo: "acme/widgets", adapter: "github_claude",
        configurationVersion: 1, registeredBy: "server:environment",
      });
      const routeSelection = await recordAcceptanceBuilderRouteSelection({
        workspaceId: wsId, recordId: draft.record.id, selectedBy: "user:lead", routeId: selectedRoute.route.id,
      });
      const headSha = "a".repeat(40);
      const admittedJob = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 43,
        headSha, event: "opened", deliveryId: "delivery-compiled-head",
        admitReviewJob: true, headTransition: null, source: "github_webhook",
      });
      if (admittedJob.kind !== "advanced") throw new Error("expected compiled Pack review admission");
      const job = { id: admittedJob.jobId };
      const packetId = reviewJobCorrectionPacketId({
        jobId: job.id, criterionId: "AC-1", headSha, recordId: draft.record.id,
        acceptanceContractId: draft.contract.id, acceptanceContractVersion: 1,
      });
      const packet = {
        kind: "review_job_correction_packet", version: 1, packetId, workspaceId: wsId, repo: "acme/widgets", prNumber: 43,
        headSha, recordId: draft.record.id, jobId: job.id, acceptanceContract: { id: draft.contract.id, version: 1 },
        criterion: { id: "AC-1", snapshot: "A user can save a filter" }, basis: "acceptance_contract", state: "failed",
        expected: "A user can save a filter", observed: "Not implemented", affectedContext: {
          modality: "ui", environmentKind: null, flow: "Save a filter", reproduction: { modality: "ui", steps: [{ action: "open", path: "/filters" }] },
        }, evidence: { evidenceRef: "review:AC-1", previewBootId: "boot-1" }, scopeBoundary: "Filter save flow", impact: "Users cannot save", requiredCorrection: "Implement save", reverification: "Repeat flow",
      };
      await appendChangeRecordEvent({ recordId: draft.record.id, eventKey: `review:correction:${job.id}:AC-1`, stage: "review", actor: "reviewer-of-record", payloadRef: packet });
      const repo = await db.insert(repositories).values({
        workspaceId: wsId, name: "acme/widgets", url: "https://github.com/acme/widgets",
      }).returning();
      const wiki = await db.insert(wikiPages).values({
        workspaceId: wsId, repositoryId: repo[0]!.id, slug: "wiki/overview", title: "Widgets",
        kind: "overview", commitSha: "d".repeat(40), inputsHash: "e".repeat(64),
        bodyMd: "Background", generatedAt: new Date(),
      }).returning();
      const baseIndexCore = { schemaVersion: 2 as const, backgroundOnly: true as const, pages: [{
        id: wiki[0]!.id, repositoryId: repo[0]!.id, slug: "wiki/overview", commitSha: "d".repeat(40), inputsHashSha256: "e".repeat(64), pageBodySha256: wikiPageBodySha256("Background"), stale: false,
      }], gaps: [] };
      const patchSha256 = "4".repeat(64);
      const dependencyContent = "export const helper = true;";
      const dependencyBytes = Buffer.from(dependencyContent, "utf8");
      const dependencyBlobSha = createHash("sha1")
        .update(`blob ${dependencyBytes.length}\0`, "utf8").update(dependencyBytes).digest("hex");
      const treeBody = Buffer.concat([Buffer.from("100644 helper.ts\0", "utf8"), Buffer.from(dependencyBlobSha, "hex")]);
      const headTreeSha = createHash("sha1").update(`tree ${treeBody.length}\0`, "utf8").update(treeBody).digest("hex");
      const dependencyTreeProof: ExactGitTreeInclusionProof = {
        kind: "exact_git_tree_inclusion_batch", version: 1, headTreeSha,
        trees: [{ sha1: headTreeSha, bodyBase64: treeBody.toString("base64") }],
        paths: [{ path: "helper.ts", blobSha: dependencyBlobSha }],
      };
      const exactSourceContent = Array.from({ length: 28 }, (_, index) => `line-${index + 1}`).join("\n");
      const exactSourceBytes = Buffer.from(exactSourceContent, "utf8");
      const exactBlobSha = createHash("sha1")
        .update(`blob ${exactSourceBytes.length}\0`, "utf8").update(exactSourceBytes).digest("hex");
      const exactFullContentSha256 = createHash("sha256").update(exactSourceBytes).digest("hex");
      const exactRangeContent = exactSourceContent.split("\n").slice(3, 28).join("\n");
      const exactRangeSha256 = createHash("sha256").update(exactRangeContent, "utf8").digest("hex");
      const exactRangeByteCount = Buffer.byteLength(exactRangeContent, "utf8");
      const range = { startLine: 4, endLine: 28, coordinateSha256: acceptanceContextOverlayHeadRangeCoordinateSha256({ path: "apps/filter.ts", patchSha256, startLine: 4, endLine: 28 }) };
      const overlayCore = { schemaVersion: 2 as const, baseSha: "b".repeat(40), mergeBaseSha: "8".repeat(40), headSha, files: [{
        path: "apps/filter.ts", status: "modified" as const, blobSha: exactBlobSha, previousPath: null, patchSha256, patchByteCount: 100, headRanges: [range],
      }] };
      const snapshot = await recordAcceptanceContextPackSnapshot({
        workspaceId: wsId, recordId: draft.record.id, reviewJobId: job.id, acceptanceContractId: draft.contract.id, acceptanceContractVersion: 1,
        acceptanceContractSha256: acceptanceContractSha256({ acceptanceContractId: draft.contract.id, acceptanceContractVersion: 1, contract: draft.contract.contract }),
        repo: "acme/widgets", prNumber: 43, expectedHeadSha: headSha, baseSha: "b".repeat(40), mergeBaseSha: "8".repeat(40), headTreeSha,
        packetIds: [packetId], packetSetSha256: acceptanceContextPacketSetSha256({ packetIds: [packetId] }), correctionPacketPayloadSetSha256: acceptanceCorrectionPacketPayloadSetSha256({ packets: [packet] }),
        compilerVersion: "exact-head-overlay-v1", baseIndex: { ...baseIndexCore, revisionSha256: acceptanceContextPackCustodyBaseIndexRevisionSha256(baseIndexCore) },
        overlay: { ...overlayCore, manifestSha256: acceptanceContextPackCustodyOverlayManifestSha256(overlayCore) },
        provenance: { schemaVersion: 1, included: [{ path: "wiki/overview", source: "base_index", reason: "Background" }, { path: "apps/filter.ts", source: "overlay", reason: "Changed" }], excluded: [] }, status: "admitted", reason: null,
      });
      const source = { kind: "exact_head_overlay" as const, path: "apps/filter.ts", blobSha: exactBlobSha, fullContentSha256: exactFullContentSha256, startLine: 4, endLine: 28, rangeSha256: exactRangeSha256, byteCount: exactRangeByteCount, reason: "exact_patch_head_range", citation: `apps/filter.ts@${exactBlobSha}#L4-L28` };
      const dependencySource = {
        kind: "exact_head_dependency" as const, path: "helper.ts", blobSha: dependencyBlobSha,
        fullContentSha256: createHash("sha256").update(dependencyBytes).digest("hex"), startLine: 1, endLine: 1,
        rangeSha256: createHash("sha256").update(dependencyBytes).digest("hex"), byteCount: dependencyBytes.length,
        reason: "static_relative_import", citation: `helper.ts@${dependencyBlobSha}#L1-L1`,
      };
      const receiptCore = {
        kind: "exact_head_source_custody" as const, schemaVersion: 2 as const, repo: "acme/widgets", prNumber: 43, baseSha: "b".repeat(40), mergeBaseSha: "8".repeat(40), headSha, headTreeSha,
        manifestSha256: acceptanceContextOverlayManifestSha256({ schemaVersion: 1, baseSha: "b".repeat(40), mergeBaseSha: "8".repeat(40), headSha, files: [{ path: "apps/filter.ts", status: "modified" as const, blobSha: exactBlobSha, previousPath: null }] }),
        changedManifest: [{ path: "apps/filter.ts", status: "modified", blobSha: exactBlobSha, previousPath: null, headRanges: [{ startLine: 4, endLine: 28 }], patchSha256, patchByteCount: 100 }],
        records: [{ path: "apps/filter.ts", blobSha: exactBlobSha, previousPath: null, contentSha256: exactFullContentSha256, byteCount: exactSourceBytes.length, lineCount: 28, source: "exact_head_overlay", reason: "exact_base_to_head_compare" }],
        exclusions: [],
        directReadReceipts: [{
          requestedPath: dependencySource.path, headSha, headTreeSha, outcome: "record" as const,
          record: { path: dependencySource.path, blobSha: dependencyBlobSha, previousPath: null, contentSha256: dependencySource.fullContentSha256, byteCount: dependencyBytes.length, lineCount: 1, source: "exact_head_tree_fallback", reason: "exact_head_tree_path" },
        }],
        selectedExactRanges: [
          (({ reason: _reason, citation: _citation, ...rangeIdentity }) => rangeIdentity)(dependencySource),
          (({ reason: _reason, citation: _citation, ...rangeIdentity }) => rangeIdentity)(source),
        ],
      };
      const receipt = { ...receiptCore, identitySha256: acceptanceContextPackCanonicalSha256(receiptCore) };
      const binding = {
        sourceSnapshotId: snapshot.snapshot.id, workspaceId: wsId, recordId: draft.record.id, reviewJobId: job.id, acceptanceContractId: draft.contract.id, acceptanceContractVersion: 1,
        acceptanceContractSha256: acceptanceContractSha256({ acceptanceContractId: draft.contract.id, acceptanceContractVersion: 1, contract: draft.contract.contract }), repo: "acme/widgets", prNumber: 43,
        baseSha: "b".repeat(40), mergeBaseSha: "8".repeat(40), headSha, headTreeSha, packetSetSha256: acceptanceContextPacketSetSha256({ packetIds: [packetId] }),
        correctionPacketPayloadSetSha256: acceptanceCorrectionPacketPayloadSetSha256({ packets: [packet] }), sourceSnapshotCompilerVersion: "exact-head-overlay-v1",
        baseIndexRevisionSha256: acceptanceContextPackCustodyBaseIndexRevisionSha256(baseIndexCore), overlayManifestSha256: acceptanceContextPackCustodyOverlayManifestSha256(overlayCore),
      };
      const compiler = { version: "exact-head-correction-pack-v4", policyVersion: "bounded-exact-ranges-v2", byteCounter: "utf8_byte_upper_bound_v1", byteBudget: 65536 };
      const manifest = { version: 1, acceptanceCriterionIds: ["AC-1"], unresolvedQuestionIds: [], packetIds: [packetId], sources: [dependencySource, source], architectureBoundaries: [], tests: [], decisions: [], exclusions: [], sourceCustody: { kind: "exact_head_source_custody", schemaVersion: 2, identitySha256: receipt.identitySha256 }, budget: { counter: "utf8_byte_upper_bound_v1", limitBytes: 65536 }, custody: { fullSourceUploadAllowed: false, rawSourcePersisted: false, snippetsPersisted: false } };
      const representations = { jsonSha256: "7".repeat(64), markdownSha256: "9".repeat(64) };
      const core = { kind: "compiled_acceptance_context_pack" as const, version: 1 as const, binding, compiler, manifest, sourceCustodyReceipt: { kind: receipt.kind, schemaVersion: receipt.schemaVersion, identitySha256: receipt.identitySha256 }, exactHeadDependencyTreeProofs: [{ path: dependencySource.path, blobSha: dependencyBlobSha, proofIdentitySha256: exactGitTreeInclusionProofIdentity(dependencyTreeProof) }], representations, renderedByteCount: 100 };
      const compiled = { ...core, sourceCustodyReceipt: receipt, packSha256: acceptanceContextPackCanonicalSha256(core) };
      const exactSourceProofs = [{ kind: "exact_head_overlay" as const, path: "apps/filter.ts", content: exactSourceContent }, { kind: "exact_head_dependency" as const, path: dependencySource.path, content: dependencyContent }];
      const persist = (value: typeof compiled) => recordAcceptanceCompiledContextPack({
        workspaceId: wsId, sourceSnapshotId: snapshot.snapshot.id, compiled: value, exactSourceProofs, exactGitTreeInclusionProofs: [dependencyTreeProof],
      });
      const first = await persist(compiled);
      const replay = await persist(compiled);
      expect(first).toMatchObject({ inserted: true, pack: { packSha256: compiled.packSha256 } });
      expect(replay).toMatchObject({ inserted: false, pack: { id: first.pack.id } });
      expect(first.pack.exactHeadDependencyTreeProofs).toEqual(core.exactHeadDependencyTreeProofs);
      expect(JSON.stringify(first.pack)).not.toContain("bodyBase64");
      await expect(queueSelectedCorrectionDispatch({ workspaceId: wsId, compiledPackId: first.pack.id }))
        .rejects.toThrow("capability profile");
      const capability = await recordAcceptanceBuilderRouteCapabilityProfile({
        workspaceId: wsId,
        routeId: selectedRoute.route.id,
        recordedBy: "server:route-capability-profile",
      });
      const acknowledgementProfile = await recordAcceptanceBuilderRouteGithubClaudeAckProfile({
        workspaceId: wsId,
        routeId: selectedRoute.route.id,
        githubRepositoryId: "1001",
        githubRepositoryOwnerId: "1002",
        githubAppBotUserId: "1003",
        githubAppBotLogin: "jace[bot]",
        callerWorkflowRef:
          "acme/widgets/.github/workflows/agentrail-claude-correction.yml@refs/heads/main",
        jobWorkflowRef: `agentrail/jace/.github/workflows/github-claude-correction-ack.yml@${"1".repeat(40)}`,
        jobWorkflowSha: "1".repeat(40),
        claudeActionSha: "6b082c41935b4c8a3b8b0ef85ba4ba4d9eeb8975",
        recordedBy: "server:github-claude-ack-profile",
      });
      expect(acknowledgementProfile).toMatchObject({
        inserted: true,
        profile: {
          routeId: selectedRoute.route.id,
          capabilityProfileId: capability.profile.id,
          oidcAudienceContract: "activation_comment_run_attempt_sha256_v1",
          oidcSubjectContract: "default_repo_ref_legacy_or_immutable_v1",
        },
      });
      const githubQueued = await queueSelectedCorrectionDispatch({ workspaceId: wsId, compiledPackId: first.pack.id });
      const githubQueuedReplay = await queueSelectedCorrectionDispatch({ workspaceId: wsId, compiledPackId: first.pack.id });
      expect(githubQueued).toMatchObject({
        inserted: true,
        dispatch: {
          recordId: draft.record.id, headSha, headCycleId: job.id,
          authorityGeneration: 1, sourceSnapshotId: snapshot.snapshot.id,
          acceptanceContractId: draft.contract.id, acceptanceContractVersion: 1,
          compiledPackId: first.pack.id, compiledPackSha256: compiled.packSha256,
          jsonSha256: representations.jsonSha256, markdownSha256: representations.markdownSha256,
          routeId: selectedRoute.route.id, routeConfigurationVersion: 1,
          capabilityProfileId: capability.profile.id,
          capabilityProfileSnapshot: capability.profile.snapshot,
          capabilityProfileSnapshotSha256: capability.profile.snapshotSha256,
          activationState: "not_started", deliveryState: "queued",
        },
      });
      expect(githubQueuedReplay).toMatchObject({ inserted: false, dispatch: { id: githubQueued.dispatch.id } });
      // The DB custody lane reserves/reports only a carrier-inert
      // authentication/read preflight. It must not project carrier acceptance
      // or agent activity.
      const parallelPreflights = await Promise.all([
        reserveGithubCorrectionCarrierPreflight({ workspaceId: wsId, dispatchId: githubQueued.dispatch.id }),
        reserveGithubCorrectionCarrierPreflight({ workspaceId: wsId, dispatchId: githubQueued.dispatch.id }),
      ]);
      expect(parallelPreflights.map((result) => result.kind).sort()).toEqual(["held", "reserved"]);
      const preflight = parallelPreflights.find((result) => result.kind === "reserved");
      expect(preflight).toMatchObject({
        kind: "reserved", inserted: true,
        preflight: {
          dispatchId: githubQueued.dispatch.id, recordId: draft.record.id,
          headSha, baseSha: "b".repeat(40), headCycleId: job.id, authorityGeneration: 1,
          capabilityProfileId: capability.profile.id,
          githubInstallationIdentitySha256: capability.profile.githubInstallationIdentitySha256,
          permissionContract: "issues_write_and_pull_requests_write_v1",
          attempt: 1, status: "reserved", result: null,
        },
      });
      if (!preflight || preflight.kind !== "reserved") throw new Error("expected preflight reservation");
      // A retargeted base with the identical PR head invalidates this Context
      // Pack binding before a carrier result can be accepted.
      await db.update(acceptanceContextPackSnapshots).set({ baseSha: "e".repeat(40) })
        .where(eq(acceptanceContextPackSnapshots.id, snapshot.snapshot.id));
      await expect(reportGithubCorrectionCarrierPreflight({
        workspaceId: wsId, preflightId: preflight.preflight.id,
        outcome: { kind: "ready", headSha, baseSha: "b".repeat(40) },
      })).resolves.toEqual({ kind: "not_current" });
      await db.update(acceptanceContextPackSnapshots).set({ baseSha: "b".repeat(40) })
        .where(eq(acceptanceContextPackSnapshots.id, snapshot.snapshot.id));
      await expect(reserveGithubCorrectionCarrierPreflight({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toMatchObject({ kind: "held", reason: "reserved", preflight: { id: preflight.preflight.id } });
      const preflightResult = await reportGithubCorrectionCarrierPreflight({
        workspaceId: wsId, preflightId: preflight.preflight.id,
        outcome: { kind: "storage_unavailable" },
      });
      expect(preflightResult).toMatchObject({
        kind: "reported", preflight: { id: preflight.preflight.id, status: "indeterminate", result: { kind: "storage_unavailable" } },
      });
      await expect(recordDurableCorrectionDispatchFallback({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toEqual({ kind: "not_eligible" });
      const unavailableAttempt = await reserveGithubCorrectionCarrierPreflight({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      });
      expect(unavailableAttempt).toMatchObject({ kind: "reserved", preflight: { attempt: 2 } });
      if (unavailableAttempt.kind !== "reserved") throw new Error("expected unavailable preflight attempt");
      await expect(reportGithubCorrectionCarrierPreflight({
        workspaceId: wsId, preflightId: unavailableAttempt.preflight.id,
        outcome: { kind: "github_unavailable" },
      })).resolves.toMatchObject({ kind: "reported", preflight: { status: "indeterminate" } });
      await expect(readDurableCorrectionDispatchFallback({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toEqual({ kind: "absent" });
      const preflightFallback = await recordDurableCorrectionDispatchFallback({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      });
      expect(preflightFallback).toMatchObject({ kind: "recorded", fallback: {
        dispatch: { id: githubQueued.dispatch.id }, headSha, headCycleId: job.id,
        lane: "jace_only", trigger: { stage: "github_preflight", attempt: 2,
          reason: "github_unavailable" }, publishedFindings: [],
        truthBoundary: { vendorActivation: "not_proven", agentStarted: "not_proven",
          agentAcknowledged: "not_proven", repairHead: "not_proven" },
      } });
      if (preflightFallback.kind !== "recorded") throw new Error("expected preflight fallback");
      expect(preflightFallback.fallback.notice.body).not.toContain("@");
      await expect(recordDurableCorrectionDispatchFallback({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toMatchObject({ kind: "replayed", fallback: { id: preflightFallback.fallback.id } });
      await db.update(workspaces).set({
        githubInstallationId: "installation-fallback-replay-drift",
        githubInstallationAccountLogin: "different-owner",
        githubInstallationAccountType: "Organization",
      }).where(eq(workspaces.id, wsId));
      await db.update(acceptanceBuilderRoutes).set({ status: "disabled" })
        .where(eq(acceptanceBuilderRoutes.id, selectedRoute.route.id));
      await expect(readDurableCorrectionDispatchFallback({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toMatchObject({ kind: "found", fallback: { id: preflightFallback.fallback.id,
        lane: "jace_only" } });
      await db.update(workspaces).set({
        githubInstallationId: "installation-dispatch-profile",
        githubInstallationAccountLogin: "acme",
        githubInstallationAccountType: "Organization",
      }).where(eq(workspaces.id, wsId));
      await db.update(acceptanceBuilderRoutes).set({ status: "active" })
        .where(eq(acceptanceBuilderRoutes.id, selectedRoute.route.id));
      const fallbackStaleHeadSha = "0".repeat(40);
      const fallbackAdvance = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 43,
        headSha: fallbackStaleHeadSha, event: "synchronize",
        deliveryId: "delivery-fallback-stale-head", admitReviewJob: true,
        headTransition: { beforeHeadSha: headSha, afterHeadSha: fallbackStaleHeadSha },
        source: "github_webhook",
      });
      if (fallbackAdvance.kind !== "advanced") throw new Error("expected fallback head advance");
      await expect(readDurableCorrectionDispatchFallback({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toEqual({ kind: "not_current" });
      const fallbackRevisit = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 43,
        headSha, event: "synchronize", deliveryId: "delivery-fallback-revisited-head",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: fallbackStaleHeadSha, afterHeadSha: headSha },
        source: "github_webhook",
      });
      if (fallbackRevisit.kind !== "advanced") throw new Error("expected fallback head revisit");
      expect(fallbackRevisit.jobId).not.toBe(job.id);
      await expect(readDurableCorrectionDispatchFallback({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toEqual({ kind: "not_current" });
      await expect(recordDurableCorrectionDispatchFallback({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toEqual({ kind: "not_current" });
      // Test-only restore: production keeps the A2 cycle authoritative. This
      // broad fixture restores A1 only to continue unrelated carrier proofs.
      await db.delete(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey,
          `acceptance-correction-dispatch:invalidated:${job.id}`),
      ));
      await db.update(acceptanceCorrectionDispatches).set({
        invalidatedAt: null, invalidationReason: null,
        successorHeadSha: null, successorHeadCycleId: null,
      }).where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id));
      await db.update(changeRecords).set({
        currentPrHeadSha: headSha, currentPrHeadCycleId: job.id,
        currentPrHeadAuthoritative: true, currentPrHeadAuthorityGeneration: 1,
      })
        .where(eq(changeRecords.id, draft.record.id));
      // Test-only rewind: fallback itself has no retry API; this broad fixture
      // removes both exact events and its projection to continue the carrier path.
      await db.delete(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        sql`${changeRecordEvents.eventKey} IN (
          ${`acceptance-correction-dispatch:durable-fallback:reserved:${job.id}`},
          ${`acceptance-correction-dispatch:durable-fallback:recorded:${job.id}`}
        )`,
      ));
      await expect(readDurableCorrectionDispatchFallback({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).rejects.toThrow("projection has no event custody");
      await db.update(acceptanceCorrectionDispatches).set({
        deliveryState: "queued", activationState: "not_started",
      }).where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id));
      const retry = await reserveGithubCorrectionCarrierPreflight({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      });
      expect(retry).toMatchObject({ kind: "reserved", inserted: true, preflight: { attempt: 3, status: "reserved" } });
      if (retry.kind !== "reserved") throw new Error("expected bounded preflight retry");
      await expect(reportGithubCorrectionCarrierPreflight({
        workspaceId: wsId, preflightId: retry.preflight.id,
        outcome: { kind: "ready", headSha, baseSha: "b".repeat(40) },
      })).resolves.toMatchObject({ kind: "reported", preflight: { status: "ready" } });
      await expect(reportGithubCorrectionCarrierPreflight({
        workspaceId: wsId, preflightId: retry.preflight.id,
        outcome: { kind: "ready", headSha, baseSha: "b".repeat(40) },
      })).resolves.toMatchObject({ kind: "replayed", preflight: { id: retry.preflight.id, status: "ready" } });
      await expect(reportGithubCorrectionCarrierPreflight({
        workspaceId: wsId, preflightId: retry.preflight.id,
        outcome: { kind: "remote_head_mismatch", expectedHeadSha: "c".repeat(40), observedHeadSha: "d".repeat(40) },
      })).resolves.toEqual({ kind: "not_current" });
      await expect(reportGithubCorrectionCarrierPreflight({
        workspaceId: wsId, preflightId: retry.preflight.id,
        outcome: { kind: "installation_or_permission_denied" },
      })).rejects.toThrow("already terminal");
      await expect(reserveGithubCorrectionCarrierPreflight({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toMatchObject({ kind: "terminal", preflight: { id: retry.preflight.id, status: "ready" } });
      expect((await db.select().from(acceptanceCorrectionDispatches)
        .where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id)))[0]).toMatchObject({
        deliveryState: "queued", agentState: "not_observed",
        findingsState: "not_started", activationState: "not_started",
      });
      expect(await db.select().from(acceptanceCorrectionDispatchGithubPreflights).where(and(
        eq(acceptanceCorrectionDispatchGithubPreflights.dispatchId, githubQueued.dispatch.id),
        eq(acceptanceCorrectionDispatchGithubPreflights.workspaceId, wsId),
      ))).toHaveLength(3);
      await db.update(workspaces).set({
        githubInstallationId: "installation-preflight-drift",
        githubInstallationAccountLogin: "acme",
        githubInstallationAccountType: "Organization",
      }).where(eq(workspaces.id, wsId));
      await expect(reserveGithubCorrectionCarrierPreflight({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toEqual({ kind: "not_current" });
      await db.update(workspaces).set({
        githubInstallationId: "installation-dispatch-profile",
        githubInstallationAccountLogin: "acme",
        githubInstallationAccountType: "Organization",
      }).where(eq(workspaces.id, wsId));
      const originalDispatchIdentity = githubQueued.dispatch.dispatchIdentitySha256;
      await db.update(acceptanceCorrectionDispatches).set({
        dispatchIdentitySha256: "f".repeat(64),
      }).where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id));
      await expect(reserveGithubCorrectionCarrierPreflight({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toEqual({ kind: "not_current" });
      await db.update(acceptanceCorrectionDispatches).set({
        dispatchIdentitySha256: originalDispatchIdentity,
      }).where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id));
      const preflightResultEvent = (await db.select().from(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey,
          `acceptance-correction-dispatch:github-preflight:result:${job.id}:${retry.preflight.attempt}`),
      )).limit(1))[0]!;
      await db.update(changeRecordEvents).set({ payloadRef: { forged: true } }).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey,
          `acceptance-correction-dispatch:github-preflight:result:${job.id}:${retry.preflight.attempt}`),
      ));
      await expect(reserveGithubCorrectionCarrierPreflight({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).rejects.toThrow("event custody");
      // Migration 0091 deliberately leaves pre-profile rows nullable. A retry
      // must hold that historical aggregate; it may not silently bless or
      // rewrite it with today's capability configuration.
      await db.update(acceptanceCorrectionDispatches).set({
        capabilityProfileId: null,
        capabilityProfileSnapshot: null,
        capabilityProfileSnapshotSha256: null,
      }).where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id));
      await expect(queueSelectedCorrectionDispatch({ workspaceId: wsId, compiledPackId: first.pack.id }))
        .rejects.toThrow("unprofiled selected correction dispatch");
      await db.update(acceptanceCorrectionDispatches).set({
        capabilityProfileId: githubQueued.dispatch.capabilityProfileId,
        capabilityProfileSnapshot: githubQueued.dispatch.capabilityProfileSnapshot,
        capabilityProfileSnapshotSha256: githubQueued.dispatch.capabilityProfileSnapshotSha256,
      }).where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id));
      await db.update(changeRecordEvents).set({ payloadRef: preflightResultEvent.payloadRef }).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey,
          `acceptance-correction-dispatch:github-preflight:result:${job.id}:${retry.preflight.attempt}`),
      ));

      // Two-stage publication: one ordinary finding reservation wins, all
      // findings reach a durable terminal result, then exactly one activation
      // reservation contains the complete immutable packet bundle.
      const findingReservations = await Promise.all([
        reserveNextGithubCorrectionFindingPublication({ workspaceId: wsId, dispatchId: githubQueued.dispatch.id }),
        reserveNextGithubCorrectionFindingPublication({ workspaceId: wsId, dispatchId: githubQueued.dispatch.id }),
      ]);
      expect(findingReservations.map((result) => result.kind).sort()).toEqual(["held", "reserved"]);
      const findingReservation = findingReservations.find((result) => result.kind === "reserved");
      if (!findingReservation || findingReservation.kind !== "reserved") throw new Error("expected finding reservation");
      expect(findingReservation.publication).toMatchObject({
        dispatchId: githubQueued.dispatch.id, packetId, criterionId: "AC-1",
        headSha, baseSha: "b".repeat(40), headCycleId: job.id,
        authorityGeneration: 1, routeId: selectedRoute.route.id,
        capabilityProfileId: capability.profile.id,
        readyPreflightId: retry.preflight.id,
        status: "reserved", githubCommentId: null,
      });
      expect(findingReservation.body).not.toContain("@codex");
      expect(findingReservation.body).not.toContain("@claude");
      await expect(reserveGithubCorrectionCarrierPreflight({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toMatchObject({
        kind: "terminal", preflight: { id: retry.preflight.id, status: "ready", attempt: 3 },
      });
      await expect(reportGithubCorrectionFindingPublication({
        workspaceId: wsId, publicationId: findingReservation.publication.id,
        outcome: { kind: "unknown_post_outcome", reason: "github_unavailable" },
      })).resolves.toMatchObject({ kind: "reported", publication: {
        status: "ambiguous_hold", resultReason: "github_unavailable",
      } });
      await expect(reserveNextGithubCorrectionFindingPublication({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toEqual({ kind: "held", reason: "ambiguous_hold" });
      // Test-only rewind: the production API deliberately provides no retry.
      // Removing the exact result event and projection lets this same fixture
      // continue through the independent accepted-receipt branch.
      await db.delete(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey,
          `acceptance-correction-dispatch:github-finding:result:${job.id}:${packetId}`),
      ));
      await db.update(acceptanceCorrectionDispatchGithubFindingPublications).set({
        status: "reserved", resultReason: null, completedAt: null,
        githubCommentId: null, githubCommentUrl: null,
      }).where(eq(acceptanceCorrectionDispatchGithubFindingPublications.id, findingReservation.publication.id));
      await db.update(acceptanceCorrectionDispatches).set({
        deliveryState: "queued", findingsState: "reserved",
      }).where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id));
      const findingUrl = "https://github.com/acme/widgets/pull/43#issuecomment-91001";
      await expect(reportGithubCorrectionFindingPublication({
        workspaceId: wsId, publicationId: findingReservation.publication.id,
        outcome: { kind: "published", githubCommentId: "91001", githubCommentUrl: findingUrl },
      })).resolves.toMatchObject({ kind: "reported", publication: {
        status: "published", githubCommentId: "91001", githubCommentUrl: findingUrl,
      } });
      await expect(reportGithubCorrectionFindingPublication({
        workspaceId: wsId, publicationId: findingReservation.publication.id,
        outcome: { kind: "published", githubCommentId: "91001", githubCommentUrl: findingUrl },
      })).resolves.toMatchObject({ kind: "replayed" });
      await expect(reserveNextGithubCorrectionFindingPublication({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toMatchObject({ kind: "complete", expected: 1, published: 1, boundedFailed: 0 });
      await expect(reserveGithubCorrectionCarrierPreflight({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toMatchObject({
        kind: "terminal", preflight: { id: retry.preflight.id, status: "ready", attempt: 3 },
      });

      const activationReservations = await Promise.all([
        reserveGithubCorrectionActivation({ workspaceId: wsId, dispatchId: githubQueued.dispatch.id }),
        reserveGithubCorrectionActivation({ workspaceId: wsId, dispatchId: githubQueued.dispatch.id }),
      ]);
      expect(activationReservations.map((result) => result.kind).sort()).toEqual(["held", "reserved"]);
      const activationReservation = activationReservations.find((result) => result.kind === "reserved");
      if (!activationReservation || activationReservation.kind !== "reserved") throw new Error("expected activation reservation");
      expect((activationReservation.body.match(/@claude/g) ?? [])).toHaveLength(1);
      expect(activationReservation.body).not.toContain("@codex");
      expect(activationReservation.body.split(activationReservation.packetBundleBase64url)).toHaveLength(2);
      expect(activationReservation.body.split(activationReservation.packetBundleSha256)).toHaveLength(2);
      const decodedBundle = JSON.parse(Buffer.from(
        activationReservation.packetBundleBase64url, "base64url"
      ).toString("utf8"));
      expect(decodedBundle).toMatchObject({ packets: [{ packetId }], binding: {
        dispatchId: githubQueued.dispatch.id, headSha, baseSha: "b".repeat(40),
        readyPreflight: { id: retry.preflight.id }, recipient: "claude",
      } });
      // Whole-worker restart after activation reservation: the finding phase
      // replays only its terminal summary and activation exposes no second body.
      await expect(reserveNextGithubCorrectionFindingPublication({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toMatchObject({ kind: "complete", expected: 1, published: 1, boundedFailed: 0 });
      await expect(reserveGithubCorrectionActivation({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toEqual({ kind: "held", reason: "reserved" });
      await expect(reportGithubCorrectionActivation({
        workspaceId: wsId, activationId: activationReservation.activation.id,
        outcome: { kind: "unknown_post_outcome", reason: "ambiguous_response" },
      })).resolves.toMatchObject({ kind: "reported", activation: {
        status: "ambiguous_hold", resultReason: "ambiguous_response",
      } });
      await expect(reserveGithubCorrectionActivation({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toEqual({ kind: "held", reason: "ambiguous_hold" });
      const activationFallback = await recordDurableCorrectionDispatchFallback({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      });
      expect(activationFallback).toMatchObject({ kind: "recorded", fallback: {
        lane: "github_findings_and_jace",
        trigger: { stage: "github_activation", activationId: activationReservation.activation.id,
          reason: "ambiguous_response" },
        publishedFindings: [{ packetId, githubCommentId: "91001", githubCommentUrl: findingUrl }],
      } });
      if (activationFallback.kind !== "recorded") throw new Error("expected activation fallback");
      expect(activationFallback.fallback.notice.body).not.toContain("@");
      await expect(readDurableCorrectionDispatchFallback({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toMatchObject({ kind: "found", fallback: {
        id: activationFallback.fallback.id, lane: "github_findings_and_jace",
      } });
      await db.update(acceptanceCorrectionDispatches).set({ findingsState: "not_started" })
        .where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id));
      await expect(readDurableCorrectionDispatchFallback({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).rejects.toThrow("source custody");
      await db.update(acceptanceCorrectionDispatches).set({ findingsState: "terminal" })
        .where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id));
      await db.delete(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        sql`${changeRecordEvents.eventKey} IN (
          ${`acceptance-correction-dispatch:durable-fallback:reserved:${job.id}`},
          ${`acceptance-correction-dispatch:durable-fallback:recorded:${job.id}`}
        )`,
      ));
      await db.update(acceptanceCorrectionDispatches).set({
        deliveryState: "ambiguous_hold", activationState: "ambiguous_hold",
      }).where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id));
      await db.delete(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey,
          `acceptance-correction-dispatch:github-activation:result:${job.id}`),
      ));
      await db.update(acceptanceCorrectionDispatchGithubActivations).set({
        status: "reserved", resultReason: null, completedAt: null,
        githubCommentId: null, githubCommentUrl: null,
      }).where(eq(acceptanceCorrectionDispatchGithubActivations.id, activationReservation.activation.id));
      await db.update(acceptanceCorrectionDispatches).set({
        deliveryState: "queued", activationState: "reserved",
      }).where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id));
      // A known GitHub rejection is terminal and replayed as a bodyless closed
      // result. The worker can restart without creating or exposing a second
      // activation reservation.
      await expect(reportGithubCorrectionActivation({
        workspaceId: wsId, activationId: activationReservation.activation.id,
        outcome: { kind: "bounded_failed", reason: "github_rejected" },
      })).resolves.toMatchObject({ kind: "reported", activation: {
        status: "bounded_failed", resultReason: "github_rejected",
      } });
      await expect(reserveNextGithubCorrectionFindingPublication({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toMatchObject({ kind: "complete", expected: 1, published: 1, boundedFailed: 0 });
      await expect(reserveGithubCorrectionActivation({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toEqual({
        kind: "bounded_failed",
        activationId: activationReservation.activation.id,
        reason: "github_rejected",
      });
      expect((await db.select().from(acceptanceCorrectionDispatches)
        .where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id)))[0]).toMatchObject({
        findingsState: "terminal", activationState: "failed",
        deliveryState: "failed", agentState: "not_observed",
      });
      // Test-only rewind so this fixture can continue through the independent
      // accepted-receipt and cross-table receipt-uniqueness branches.
      await db.delete(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey,
          `acceptance-correction-dispatch:github-activation:result:${job.id}`),
      ));
      await db.update(acceptanceCorrectionDispatchGithubActivations).set({
        status: "reserved", resultReason: null, completedAt: null,
        githubCommentId: null, githubCommentUrl: null,
      }).where(eq(acceptanceCorrectionDispatchGithubActivations.id, activationReservation.activation.id));
      await db.update(acceptanceCorrectionDispatches).set({
        deliveryState: "queued", activationState: "reserved",
      }).where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id));
      await expect(reportGithubCorrectionActivation({
        workspaceId: wsId, activationId: activationReservation.activation.id,
        outcome: { kind: "carrier_accepted", githubCommentId: "91001", githubCommentUrl: findingUrl },
      })).rejects.toThrow("already bound to another finding or activation");
      const activationUrl = "https://github.com/acme/widgets/pull/43#issuecomment-91002";
      await expect(reportGithubCorrectionActivation({
        workspaceId: wsId, activationId: activationReservation.activation.id,
        outcome: { kind: "carrier_accepted", githubCommentId: "91002", githubCommentUrl: activationUrl },
      })).resolves.toMatchObject({ kind: "reported", activation: {
        status: "carrier_accepted", githubCommentId: "91002", githubCommentUrl: activationUrl,
      } });
      await expect(reportGithubCorrectionActivation({
        workspaceId: wsId, activationId: activationReservation.activation.id,
        outcome: { kind: "carrier_accepted", githubCommentId: "91002", githubCommentUrl: activationUrl },
      })).resolves.toMatchObject({ kind: "replayed" });
      expect((await db.select().from(acceptanceCorrectionDispatches)
        .where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id)))[0]).toMatchObject({
        findingsState: "terminal", activationState: "carrier_accepted",
        deliveryState: "carrier_accepted", agentState: "not_observed",
      });
      // A terminal whole-worker retry returns the persisted receipt as truth.
      // It cannot reach a new activation POST because no body is returned.
      await expect(reserveNextGithubCorrectionFindingPublication({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toMatchObject({ kind: "complete", expected: 1, published: 1, boundedFailed: 0 });
      await expect(reserveGithubCorrectionActivation({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toMatchObject({
        kind: "carrier_accepted",
        activationId: activationReservation.activation.id,
        githubCommentId: "91002",
        githubCommentUrl: activationUrl,
      });
      expect((await db.select().from(acceptanceCorrectionDispatches)
        .where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id)))[0]).toMatchObject({
        findingsState: "terminal", activationState: "carrier_accepted",
        deliveryState: "carrier_accepted", agentState: "not_observed",
      });

      const tokenNow = Math.floor(Date.now() / 1_000);
      const oidcSubject = "repo:acme/widgets:ref:refs/heads/main";
      const oidc = {
        issuer: "https://token.actions.githubusercontent.com" as const,
        audience: githubClaudeAcknowledgementAudience({
          activationCommentId: "91002", runId: "44001", runAttempt: 1,
        })!,
        subject: oidcSubject,
        subjectSha256: createHash("sha256").update(oidcSubject).digest("hex"),
        jtiSha256: "2".repeat(64),
        issuedAt: tokenNow - 5,
        notBefore: tokenNow - 5,
        expiresAt: tokenNow + 120,
        repository: "acme/widgets",
        repositoryId: "1001",
        repositoryOwner: "acme",
        repositoryOwnerId: "1002",
        actor: "jace[bot]",
        actorId: "1003",
        eventName: "issue_comment" as const,
        ref: "refs/heads/main",
        workflowRef:
          "acme/widgets/.github/workflows/agentrail-claude-correction.yml@refs/heads/main",
        workflowSha: "3".repeat(40),
        jobWorkflowRef: `agentrail/jace/.github/workflows/github-claude-correction-ack.yml@${"1".repeat(40)}`,
        jobWorkflowSha: "1".repeat(40),
        runId: "44001",
        runAttempt: 1 as const,
        checkRunId: "55001",
      };
      const acknowledgementInput = {
        activationCommentId: "91002",
        activationBodySha256: activationReservation.activation.bodySha256!,
        conclusion: "success" as const,
        providerSessionId: "claude-session-opaque-1",
        oidc,
      };
      const makeRepairObservationInput = (input: {
        afterHeadSha: string;
        beforeHeadSha?: string;
        activationBodySha256?: string;
        providerSessionId?: string;
        oidc?: Partial<typeof oidc>;
        jtiSha256?: string;
      }) => {
        const claims = { ...oidc, ...input.oidc };
        const activationBodySha256 = input.activationBodySha256
          ?? activationReservation.activation.bodySha256!;
        const beforeHeadSha = input.beforeHeadSha ?? headSha;
        return {
          activationCommentId: "91002",
          activationBodySha256,
          beforeHeadSha,
          afterHeadSha: input.afterHeadSha,
          providerSessionId: input.providerSessionId ?? "claude-session-opaque-1",
          oidc: {
            ...claims,
            audience: githubClaudeRepairObservationAudience({
              activationCommentId: "91002",
              activationBodySha256,
              beforeHeadSha,
              afterHeadSha: input.afterHeadSha,
              runId: claims.runId,
              runAttempt: claims.runAttempt,
            })!,
            jtiSha256: input.jtiSha256 ?? "6".repeat(64),
          },
        };
      };

      // A signed synchronize may win the race after GitHub accepts the
      // activation but before the provider posts its receipt. The receipt is
      // retained as historical evidence and must not project acknowledgement
      // onto either the obsolete cycle or its successor.
      const historicalHeadSha = "5".repeat(40);
      const historicalAdvance = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId,
        recordId: draft.record.id,
        repo: "acme/widgets",
        prNumber: 43,
        headSha: historicalHeadSha,
        event: "synchronize",
        deliveryId: "delivery-ack-historical-successor",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: headSha, afterHeadSha: historicalHeadSha },
        source: "github_webhook",
      });
      if (historicalAdvance.kind !== "advanced") throw new Error("expected acknowledgement successor");
      const historicalRepairInput = makeRepairObservationInput({
        afterHeadSha: historicalHeadSha,
      });
      await expect(recordGithubClaudeRepairHeadObservation(historicalRepairInput))
        .resolves.toEqual({ kind: "not_admitted" });
      const beforeHistoricalAck = (await db.select().from(acceptanceCorrectionDispatches)
        .where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id)))[0]!;
      expect(beforeHistoricalAck).toMatchObject({
        invalidationReason: "head_advanced",
        successorHeadSha: historicalHeadSha,
        successorHeadCycleId: historicalAdvance.jobId,
        agentState: "not_observed",
      });
      const historicalAcknowledged = await recordGithubClaudeAgentAcknowledgement(acknowledgementInput);
      expect(historicalAcknowledged).toMatchObject({
        kind: "recorded",
        receipt: { dispatchId: githubQueued.dispatch.id, headSha },
      });
      const afterHistoricalAck = (await db.select().from(acceptanceCorrectionDispatches)
        .where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id)))[0]!;
      expect(afterHistoricalAck).toMatchObject({
        invalidationReason: "head_advanced",
        successorHeadSha: historicalHeadSha,
        successorHeadCycleId: historicalAdvance.jobId,
        agentState: "not_observed",
      });
      expect(await db.select().from(acceptanceCorrectionDispatches).where(and(
        eq(acceptanceCorrectionDispatches.recordId, draft.record.id),
        eq(acceptanceCorrectionDispatches.headCycleId, historicalAdvance.jobId),
      ))).toHaveLength(0);
      await expect(readGithubClaudeAgentAcknowledgement({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toMatchObject({ id: historicalAcknowledged.kind === "recorded"
        ? historicalAcknowledged.receipt.id : "unreachable" });
      await expect(recordGithubClaudeAgentAcknowledgement(acknowledgementInput))
        .resolves.toMatchObject({ kind: "replayed" });

      await expect(recordGithubClaudeRepairHeadObservation({
        ...historicalRepairInput,
        providerSessionId: "wrong-session",
      })).resolves.toEqual({ kind: "not_admitted" });
      await expect(recordGithubClaudeRepairHeadObservation(makeRepairObservationInput({
        afterHeadSha: historicalHeadSha,
        activationBodySha256: "4".repeat(64),
      }))).resolves.toEqual({ kind: "not_admitted" });
      await expect(recordGithubClaudeRepairHeadObservation(makeRepairObservationInput({
        afterHeadSha: historicalHeadSha,
        beforeHeadSha: "7".repeat(40),
      }))).resolves.toEqual({ kind: "not_admitted" });
      await expect(recordGithubClaudeRepairHeadObservation(makeRepairObservationInput({
        afterHeadSha: "8".repeat(40),
      }))).resolves.toEqual({ kind: "not_admitted" });
      await expect(recordGithubClaudeRepairHeadObservation(makeRepairObservationInput({
        afterHeadSha: historicalHeadSha,
        oidc: { runId: "44002" },
      }))).resolves.toEqual({ kind: "not_admitted" });
      await expect(recordGithubClaudeRepairHeadObservation(makeRepairObservationInput({
        afterHeadSha: historicalHeadSha,
        oidc: { checkRunId: "55002" },
      }))).resolves.toEqual({ kind: "not_admitted" });
      await expect(recordGithubClaudeRepairHeadObservation(makeRepairObservationInput({
        afterHeadSha: historicalHeadSha,
        oidc: { issuedAt: oidc.issuedAt - 1, notBefore: oidc.notBefore - 1 },
      }))).resolves.toEqual({ kind: "not_admitted" });
      await expect(recordGithubClaudeRepairHeadObservation(makeRepairObservationInput({
        afterHeadSha: historicalHeadSha,
        oidc: { repositoryId: "9999" },
      }))).resolves.toEqual({ kind: "not_admitted" });
      await expect(recordGithubClaudeRepairHeadObservation(makeRepairObservationInput({
        afterHeadSha: historicalHeadSha,
        jtiSha256: oidc.jtiSha256,
      }))).resolves.toEqual({ kind: "not_admitted" });

      const historicalRepairObserved = await recordGithubClaudeRepairHeadObservation(
        historicalRepairInput
      );
      expect(historicalRepairObserved).toMatchObject({
        kind: "recorded",
        observation: {
          dispatchId: githubQueued.dispatch.id,
          acknowledgementReceiptId: historicalAcknowledged.kind === "recorded"
            ? historicalAcknowledged.receipt.id : "unreachable",
          beforeHeadSha: headSha,
          afterHeadSha: historicalHeadSha,
          oidcRunId: oidc.runId,
          oidcCheckRunId: oidc.checkRunId,
        },
      });
      if (historicalRepairObserved.kind !== "recorded") {
        throw new Error("expected historical repair observation");
      }
      expect(JSON.stringify(historicalRepairObserved.observation))
        .not.toContain("claude-session-opaque-1");
      expect(JSON.stringify(historicalRepairObserved.observation)).not.toContain(oidcSubject);
      await expect(recordGithubClaudeAgentAcknowledgement({
        ...acknowledgementInput,
        oidc: { ...oidc, jtiSha256: historicalRepairInput.oidc.jtiSha256 },
      })).rejects.toBeInstanceOf(GithubClaudeAgentAcknowledgementConflictError);
      await expect(recordGithubClaudeRepairHeadObservation(historicalRepairInput))
        .resolves.toMatchObject({
          kind: "replayed",
          observation: { id: historicalRepairObserved.observation.id },
        });
      await expect(recordGithubClaudeRepairHeadObservation(makeRepairObservationInput({
        afterHeadSha: historicalHeadSha,
        jtiSha256: "7".repeat(64),
      }))).rejects.toBeInstanceOf(GithubClaudeRepairObservationConflictError);
      await expect(readGithubClaudeRepairHeadEvidence({
        workspaceId: randomUUID(), dispatchId: githubQueued.dispatch.id,
      })).resolves.toBeNull();
      const historicalRepairEvidence = await readGithubClaudeRepairHeadEvidence({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      });
      expect(historicalRepairEvidence).toMatchObject({
        kind: "github_claude_repair_head_evidence",
        version: 1,
        dispatchId: githubQueued.dispatch.id,
        acknowledgementReceiptId: historicalAcknowledged.kind === "recorded"
          ? historicalAcknowledged.receipt.id : "unreachable",
        observationId: historicalRepairObserved.observation.id,
        originalHeadSha: headSha,
        repairHeadSha: historicalHeadSha,
        repairHeadCycleId: historicalAdvance.jobId,
        githubDeliveryId: "delivery-ack-historical-successor",
        reviewJobId: historicalAdvance.jobId,
        attribution: "selected_run_observed_successor",
        authorship: "not_independently_proven",
        reviewRequirement: "exact_head_r7_reentry",
        evidenceIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });

      const invalidationEvent = (await db.select().from(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey,
          `acceptance-correction-dispatch:invalidated:${job.id}`),
      )).limit(1))[0]!;
      await db.update(acceptanceCorrectionDispatches).set({
        invalidationReason: "reconciled",
      }).where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id));
      await db.update(changeRecordEvents).set({
        payloadRef: { ...invalidationEvent.payloadRef, reason: "reconciled" },
      }).where(eq(changeRecordEvents.id, invalidationEvent.id));
      await expect(readGithubClaudeRepairHeadEvidence({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toBeNull();
      await db.update(acceptanceCorrectionDispatches).set({
        invalidationReason: "head_advanced",
      }).where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id));
      await db.update(changeRecordEvents).set({ payloadRef: invalidationEvent.payloadRef })
        .where(eq(changeRecordEvents.id, invalidationEvent.id));

      const signedDeliveryEvent = (await db.select().from(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey,
          "external-pr:delivery:43:delivery-ack-historical-successor"),
      )).limit(1))[0]!;
      await db.update(changeRecordEvents).set({ actor: "server:test" })
        .where(eq(changeRecordEvents.id, signedDeliveryEvent.id));
      await expect(readGithubClaudeRepairHeadEvidence({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toBeNull();
      await db.update(changeRecordEvents).set({ actor: "github_webhook" })
        .where(eq(changeRecordEvents.id, signedDeliveryEvent.id));

      const revisitedOriginal = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId,
        recordId: draft.record.id,
        repo: "acme/widgets",
        prNumber: 43,
        headSha,
        event: "synchronize",
        deliveryId: "delivery-repair-a-b-a",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: historicalHeadSha, afterHeadSha: headSha },
        source: "github_webhook",
      });
      if (revisitedOriginal.kind !== "advanced") throw new Error("expected A-B-A revisit");
      expect(revisitedOriginal.jobId).not.toBe(job.id);
      await expect(readGithubClaudeRepairHeadEvidence({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toMatchObject({
        repairHeadSha: historicalHeadSha,
        repairHeadCycleId: historicalAdvance.jobId,
        originalHeadCycleId: job.id,
      });

      const repeatedObservedHead = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId,
        recordId: draft.record.id,
        repo: "acme/widgets",
        prNumber: 43,
        headSha: historicalHeadSha,
        event: "synchronize",
        deliveryId: "delivery-repair-a-b-a-b",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: headSha, afterHeadSha: historicalHeadSha },
        source: "github_webhook",
      });
      if (repeatedObservedHead.kind !== "advanced") throw new Error("expected A-B-A-B repeat");
      expect(repeatedObservedHead.jobId).not.toBe(historicalAdvance.jobId);
      await expect(readGithubClaudeRepairHeadEvidence({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toBeNull();
      await db.delete(acceptanceCorrectionDispatchGithubClaudeRepairObservations)
        .where(eq(acceptanceCorrectionDispatchGithubClaudeRepairObservations.dispatchId,
          githubQueued.dispatch.id));
      await db.delete(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey,
          `acceptance-correction-dispatch:github-claude-repair-observation:${job.id}`),
      ));
      const repeatedOccurrenceObservation = await recordGithubClaudeRepairHeadObservation(
        makeRepairObservationInput({
          afterHeadSha: historicalHeadSha,
          jtiSha256: "7".repeat(64),
        })
      );
      expect(repeatedOccurrenceObservation).toMatchObject({ kind: "recorded" });
      await expect(readGithubClaudeRepairHeadEvidence({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toBeNull();

      // Test-only rewind preserves the existing current-cycle carrier proof in
      // this broad fixture so the same API is also exercised on its current
      // agentState CAS path below.
      await db.delete(acceptanceCorrectionDispatchGithubClaudeRepairObservations)
        .where(eq(acceptanceCorrectionDispatchGithubClaudeRepairObservations.dispatchId,
          githubQueued.dispatch.id));
      await db.delete(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey,
          `acceptance-correction-dispatch:github-claude-repair-observation:${job.id}`),
      ));
      await db.delete(acceptanceCorrectionDispatchGithubClaudeAckReceipts)
        .where(eq(acceptanceCorrectionDispatchGithubClaudeAckReceipts.dispatchId,
          githubQueued.dispatch.id));
      await db.delete(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey,
          `acceptance-correction-dispatch:github-claude-ack:${job.id}`),
      ));
      await db.delete(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey,
          `acceptance-correction-dispatch:invalidated:${job.id}`),
      ));
      await db.update(acceptanceCorrectionDispatches).set({
        invalidatedAt: null,
        invalidationReason: null,
        successorHeadSha: null,
        successorHeadCycleId: null,
      }).where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id));
      await db.update(changeRecords).set({
        currentPrHeadSha: headSha,
        currentPrHeadCycleId: job.id,
        currentPrHeadAuthoritative: true,
        currentPrHeadAuthorityGeneration: 1,
      }).where(eq(changeRecords.id, draft.record.id));

      const immutableSubject =
        "repo:acme@1002/widgets@1001:ref:refs/heads/main";
      const immutableAcknowledgementInput = {
        ...acknowledgementInput,
        oidc: {
          ...oidc,
          subject: immutableSubject,
          subjectSha256: createHash("sha256").update(immutableSubject).digest("hex"),
        },
      };
      for (const rejectedSubject of [
        "repo:acme@9999/widgets@1001:ref:refs/heads/main",
        "repo:acme@1002/widgets@9999:ref:refs/heads/main",
        "repo:acme@1002/widgets@1001:ref:refs/heads/other",
        "repo:acme/widgets:environment:production",
      ]) {
        await expect(recordGithubClaudeAgentAcknowledgement({
          ...immutableAcknowledgementInput,
          oidc: {
            ...immutableAcknowledgementInput.oidc,
            subject: rejectedSubject,
            subjectSha256: createHash("sha256").update(rejectedSubject).digest("hex"),
          },
        })).resolves.toEqual({ kind: "not_admitted" });
      }
      const wrongSignedRepositoryId = "9999";
      const wrongIdSubject =
        `repo:acme@1002/widgets@${wrongSignedRepositoryId}:ref:refs/heads/main`;
      await expect(recordGithubClaudeAgentAcknowledgement({
        ...immutableAcknowledgementInput,
        oidc: {
          ...immutableAcknowledgementInput.oidc,
          repositoryId: wrongSignedRepositoryId,
          subject: wrongIdSubject,
          subjectSha256: createHash("sha256").update(wrongIdSubject).digest("hex"),
        },
      })).resolves.toEqual({ kind: "not_admitted" });

      await expect(recordGithubClaudeAgentAcknowledgement({
        ...immutableAcknowledgementInput,
        activationBodySha256: "4".repeat(64),
      })).resolves.toEqual({ kind: "not_admitted" });
      const acknowledged = await recordGithubClaudeAgentAcknowledgement(
        immutableAcknowledgementInput
      );
      expect(acknowledged).toMatchObject({
        kind: "recorded",
        receipt: {
          dispatchId: githubQueued.dispatch.id,
          activationId: activationReservation.activation.id,
          activationGithubCommentId: "91002",
          ackProfileId: acknowledgementProfile.profile.id,
          provider: "anthropic_claude_code_action",
          providerConclusion: "success",
          oidcRunAttempt: 1,
        },
      });
      if (acknowledged.kind !== "recorded") throw new Error("expected Claude acknowledgement");
      expect(JSON.stringify(acknowledged.receipt)).not.toContain("claude-session-opaque-1");
      expect(JSON.stringify(acknowledged.receipt)).not.toContain(oidcSubject);
      expect(JSON.stringify(acknowledged.receipt)).not.toContain(immutableSubject);
      await expect(recordGithubClaudeAgentAcknowledgement(immutableAcknowledgementInput))
        .resolves.toMatchObject({ kind: "replayed", receipt: { id: acknowledged.receipt.id } });
      await expect(recordGithubClaudeAgentAcknowledgement({
        ...immutableAcknowledgementInput,
        providerSessionId: "different-session",
      })).rejects.toBeInstanceOf(GithubClaudeAgentAcknowledgementConflictError);
      await expect(readGithubClaudeAgentAcknowledgement({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toMatchObject({ id: acknowledged.receipt.id });
      expect((await db.select().from(acceptanceCorrectionDispatches)
        .where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id)))[0]).toMatchObject({
        findingsState: "terminal", activationState: "carrier_accepted",
        deliveryState: "carrier_accepted", agentState: "acknowledged",
        successorHeadSha: null, successorHeadCycleId: null,
      });

      // A second-purpose repair token may not reuse a JTI already consumed by
      // any acknowledgement, including a different dispatch. The synthetic
      // foreign row needs no trusted event because admission must stop at the
      // global cross-table anti-replay lookup.
      const crossDispatchJti = "9".repeat(64);
      const crossDispatchId = randomUUID();
      const crossPreflightId = randomUUID();
      const crossActivationId = randomUUID();
      const crossAckReceiptId = randomUUID();
      const crossDispatchIdentity = "c".repeat(64);
      const crossPreflightIdentity = "d".repeat(64);
      const crossActivationIdentity = "e".repeat(64);
      const currentDispatchRow = (await db.select().from(acceptanceCorrectionDispatches)
        .where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id)))[0]!;
      const currentPreflightRow = (await db.select()
        .from(acceptanceCorrectionDispatchGithubPreflights).where(and(
          eq(acceptanceCorrectionDispatchGithubPreflights.dispatchId, githubQueued.dispatch.id),
          eq(acceptanceCorrectionDispatchGithubPreflights.status, "ready"),
        )).limit(1))[0]!;
      const currentActivationRow = (await db.select()
        .from(acceptanceCorrectionDispatchGithubActivations).where(
          eq(acceptanceCorrectionDispatchGithubActivations.id, activationReservation.activation.id)
        ).limit(1))[0]!;
      await db.insert(acceptanceCorrectionDispatches).values({
        ...currentDispatchRow,
        id: crossDispatchId,
        headSha: historicalHeadSha,
        headCycleId: historicalAdvance.jobId,
        reviewJobId: historicalAdvance.jobId,
        dispatchIdentitySha256: crossDispatchIdentity,
        invalidatedAt: null,
        invalidationReason: null,
        successorHeadSha: null,
        successorHeadCycleId: null,
      });
      await db.insert(acceptanceCorrectionDispatchGithubPreflights).values({
        ...currentPreflightRow,
        id: crossPreflightId,
        dispatchId: crossDispatchId,
        headSha: historicalHeadSha,
        headCycleId: historicalAdvance.jobId,
        dispatchIdentitySha256: crossDispatchIdentity,
        preflightIdentitySha256: crossPreflightIdentity,
      });
      await db.insert(acceptanceCorrectionDispatchGithubActivations).values({
        ...currentActivationRow,
        id: crossActivationId,
        dispatchId: crossDispatchId,
        headSha: historicalHeadSha,
        headCycleId: historicalAdvance.jobId,
        dispatchIdentitySha256: crossDispatchIdentity,
        readyPreflightId: crossPreflightId,
        readyPreflightIdentitySha256: crossPreflightIdentity,
        activationIdentitySha256: crossActivationIdentity,
        githubCommentId: "91999",
        githubCommentUrl: "https://github.com/acme/widgets/pull/43#issuecomment-91999",
      });
      await db.insert(acceptanceCorrectionDispatchGithubClaudeAckReceipts).values({
        ...acknowledged.receipt,
        id: crossAckReceiptId,
        dispatchId: crossDispatchId,
        activationId: crossActivationId,
        headSha: historicalHeadSha,
        headCycleId: historicalAdvance.jobId,
        dispatchIdentitySha256: crossDispatchIdentity,
        activationIdentitySha256: crossActivationIdentity,
        activationGithubCommentId: "91999",
        oidcAudience: githubClaudeAcknowledgementAudience({
          activationCommentId: "91999", runId: "44999", runAttempt: 1,
        })!,
        oidcRunId: "44999",
        oidcJtiSha256: crossDispatchJti,
        receiptIdentitySha256: "f".repeat(64),
      });
      await expect(recordGithubClaudeRepairHeadObservation(makeRepairObservationInput({
        afterHeadSha: "6".repeat(40),
        oidc: immutableAcknowledgementInput.oidc,
        jtiSha256: crossDispatchJti,
      }))).resolves.toEqual({ kind: "not_admitted" });
      await db.delete(acceptanceCorrectionDispatchGithubClaudeAckReceipts)
        .where(eq(acceptanceCorrectionDispatchGithubClaudeAckReceipts.id, crossAckReceiptId));
      await db.delete(acceptanceCorrectionDispatchGithubActivations)
        .where(eq(acceptanceCorrectionDispatchGithubActivations.id, crossActivationId));
      await db.delete(acceptanceCorrectionDispatchGithubPreflights)
        .where(eq(acceptanceCorrectionDispatchGithubPreflights.id, crossPreflightId));
      await db.delete(acceptanceCorrectionDispatches)
        .where(eq(acceptanceCorrectionDispatches.id, crossDispatchId));

      // The provider observation may arrive before GitHub's independently
      // signed synchronize delivery. It is retained without projecting repair;
      // the same immutable row becomes evidence only after the exact A-to-B
      // delivery advances the PR and admits B back into R7.
      const observedBeforeWebhookHeadSha = "6".repeat(40);
      const observedBeforeWebhookInput = makeRepairObservationInput({
        afterHeadSha: observedBeforeWebhookHeadSha,
        oidc: immutableAcknowledgementInput.oidc,
        jtiSha256: "8".repeat(64),
      });
      const observedBeforeWebhook = await recordGithubClaudeRepairHeadObservation(
        observedBeforeWebhookInput
      );
      expect(observedBeforeWebhook).toMatchObject({
        kind: "recorded",
        observation: {
          dispatchId: githubQueued.dispatch.id,
          acknowledgementReceiptId: acknowledged.receipt.id,
          beforeHeadSha: headSha,
          afterHeadSha: observedBeforeWebhookHeadSha,
        },
      });
      if (observedBeforeWebhook.kind !== "recorded") {
        throw new Error("expected pre-synchronize repair observation");
      }
      await expect(readGithubClaudeRepairHeadEvidence({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toBeNull();
      const observedSuccessor = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId,
        recordId: draft.record.id,
        repo: "acme/widgets",
        prNumber: 43,
        headSha: observedBeforeWebhookHeadSha,
        event: "synchronize",
        deliveryId: "delivery-repair-observation-after-receipt",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: headSha, afterHeadSha: observedBeforeWebhookHeadSha },
        source: "github_webhook",
      });
      if (observedSuccessor.kind !== "advanced") throw new Error("expected observed successor");
      await expect(readGithubClaudeRepairHeadEvidence({
        workspaceId: wsId, dispatchId: githubQueued.dispatch.id,
      })).resolves.toMatchObject({
        observationId: observedBeforeWebhook.observation.id,
        originalHeadSha: headSha,
        repairHeadSha: observedBeforeWebhookHeadSha,
        repairHeadCycleId: observedSuccessor.jobId,
        githubDeliveryId: "delivery-repair-observation-after-receipt",
        reviewJobId: observedSuccessor.jobId,
        attribution: "selected_run_observed_successor",
        authorship: "not_independently_proven",
        reviewRequirement: "exact_head_r7_reentry",
      });
      expect((await db.select().from(acceptanceCorrectionDispatches)
        .where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id)))[0])
        .toMatchObject({ agentState: "acknowledged", successorHeadSha: observedBeforeWebhookHeadSha });
      expect(await db.select().from(acceptanceCorrectionDispatches).where(and(
        eq(acceptanceCorrectionDispatches.recordId, draft.record.id),
        eq(acceptanceCorrectionDispatches.headCycleId, observedSuccessor.jobId),
      ))).toHaveLength(0);

      // Test-only restore: the broad fixture next exercises the unrelated
      // fallback lane against the original compiled exact-head pack.
      await db.delete(acceptanceCorrectionDispatchGithubClaudeRepairObservations)
        .where(eq(acceptanceCorrectionDispatchGithubClaudeRepairObservations.dispatchId,
          githubQueued.dispatch.id));
      await db.delete(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey,
          `acceptance-correction-dispatch:github-claude-repair-observation:${job.id}`),
      ));
      await db.delete(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey,
          `acceptance-correction-dispatch:invalidated:${job.id}`),
      ));
      await db.update(acceptanceCorrectionDispatches).set({
        invalidatedAt: null,
        invalidationReason: null,
        successorHeadSha: null,
        successorHeadCycleId: null,
      }).where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id));
      await db.update(changeRecords).set({
        currentPrHeadSha: headSha,
        currentPrHeadCycleId: job.id,
        currentPrHeadAuthoritative: true,
        currentPrHeadAuthorityGeneration: 1,
      }).where(eq(changeRecords.id, draft.record.id));

      // Durable fallback remains queueable, but deliberately has no GitHub
      // vendor capability profile and still performs no carrier action.
      await db.delete(acceptanceCorrectionDispatchGithubClaudeAckReceipts)
        .where(eq(acceptanceCorrectionDispatchGithubClaudeAckReceipts.dispatchId,
          githubQueued.dispatch.id));
      await db.delete(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey,
          `acceptance-correction-dispatch:github-claude-ack:${job.id}`),
      ));
      await db.delete(acceptanceCorrectionDispatchGithubActivations)
        .where(eq(acceptanceCorrectionDispatchGithubActivations.dispatchId, githubQueued.dispatch.id));
      await db.delete(acceptanceCorrectionDispatchGithubFindingPublications)
        .where(eq(acceptanceCorrectionDispatchGithubFindingPublications.dispatchId, githubQueued.dispatch.id));
      await db.delete(acceptanceCorrectionDispatchGithubPreflights)
        .where(eq(acceptanceCorrectionDispatchGithubPreflights.dispatchId, githubQueued.dispatch.id));
      await db.delete(acceptanceCorrectionDispatches)
        .where(eq(acceptanceCorrectionDispatches.id, githubQueued.dispatch.id));
      await db.delete(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, draft.record.id),
        eq(changeRecordEvents.eventKey, `acceptance-correction-dispatch:queued:${job.id}`),
      ));
      await db.update(acceptanceBuilderRoutes).set({ adapter: "durable_jace_fallback" })
        .where(eq(acceptanceBuilderRoutes.id, selectedRoute.route.id));
      const selectionPayload = routeSelection.event.payloadRef as Record<string, unknown>;
      await db.update(changeRecordEvents).set({ payloadRef: {
        ...selectionPayload,
        route: {
          id: selectedRoute.route.id,
          adapter: "durable_jace_fallback",
          configurationVersion: 1,
          status: "active",
        },
        snapshot: {
          builder: { adapter: "durable_jace_fallback", routeId: selectedRoute.route.id },
          protocol: "durable_notice",
          capability: {
            availability: "unverified",
            activation: "none",
            acknowledgement: "human_ack",
            repairHead: "github_synchronize",
          },
          scopeBoundary: "correction_delivery_only",
        },
      } }).where(eq(changeRecordEvents.id, routeSelection.event.id));
      const queued = await queueSelectedCorrectionDispatch({ workspaceId: wsId, compiledPackId: first.pack.id });
      const queuedReplay = await queueSelectedCorrectionDispatch({ workspaceId: wsId, compiledPackId: first.pack.id });
      expect(queued).toMatchObject({ inserted: true, dispatch: {
        routeAdapter: "durable_jace_fallback",
        carrier: "durable_notice",
        capabilityProfileId: null,
        capabilityProfileSnapshot: null,
        capabilityProfileSnapshotSha256: null,
        deliveryState: "queued",
        agentState: "not_observed",
        activationState: "not_started",
      } });
      expect(queuedReplay).toMatchObject({ inserted: false, dispatch: { id: queued.dispatch.id } });
      await expect(persist({
        ...compiled, manifest: { ...compiled.manifest, exclusions: [{ source: "exact_head_overlay", path: "apps/filter.ts", reason: "Excluded", content: "raw source" }] },
      })).rejects.toThrow("Invalid compiled Context Pack");
      await expect(persist({
        ...compiled, sourceCustodyReceipt: { ...compiled.sourceCustodyReceipt, directReadReceipts: [{ requestedPath: "lib/unsafe.ts", headSha, headTreeSha: "c".repeat(40), outcome: "not_proven", reason: "secret", exclusion: { arbitrary: "untrusted" } }] },
      })).rejects.toThrow("Invalid compiled Context Pack");
      await expect(persist({
        ...compiled, manifest: { ...compiled.manifest, decisions: ["self-attested decision"] },
      })).rejects.toThrow("does not match");
      await expect(persist({ ...compiled, renderedByteCount: 101 })).rejects.toThrow("does not match");
      await expect(resolveAcceptanceCompiledContextPack({ workspaceId: randomUUID(), sourceSnapshotId: snapshot.snapshot.id, compilerVersion: compiler.version, policyVersion: compiler.policyVersion })).resolves.toBeNull();
      const nextHeadSha = "f".repeat(40);
      await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 43,
        headSha: nextHeadSha, event: "synchronize", deliveryId: "delivery-compiled-next-head",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: headSha, afterHeadSha: nextHeadSha },
        source: "github_webhook",
      });
      expect((await db.select().from(acceptanceCorrectionDispatches)
        .where(eq(acceptanceCorrectionDispatches.id, queued.dispatch.id)))[0]).toMatchObject({
        invalidationReason: "head_advanced", successorHeadSha: nextHeadSha,
      });
      const revisitedHead = await advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId: wsId, recordId: draft.record.id, repo: "acme/widgets", prNumber: 43,
        headSha, event: "synchronize", deliveryId: "delivery-compiled-revisited-head",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: nextHeadSha, afterHeadSha: headSha },
        source: "github_webhook",
      });
      if (revisitedHead.kind !== "advanced") throw new Error("expected compiled head revisit");
      expect(revisitedHead.jobId).not.toBe(job.id);
      await expect(reserveNextGithubCorrectionFindingPublication({
        workspaceId: wsId, dispatchId: queued.dispatch.id,
      })).resolves.toEqual({ kind: "not_current" });
      await expect(reserveGithubCorrectionActivation({
        workspaceId: wsId, dispatchId: queued.dispatch.id,
      })).resolves.toEqual({ kind: "not_current" });
      await expect(resolveAcceptanceCompiledContextPack({
        workspaceId: wsId, sourceSnapshotId: snapshot.snapshot.id,
        compilerVersion: compiler.version, policyVersion: compiler.policyVersion,
      })).resolves.toBeNull();
      await expect(queueSelectedCorrectionDispatch({ workspaceId: wsId, compiledPackId: first.pack.id }))
        .rejects.toThrow("current");
      await expect(persist(compiled)).rejects.toThrow("Record head is no longer current");
      expect(await db.select().from(acceptanceCompiledContextPacks).where(eq(acceptanceCompiledContextPacks.id, first.pack.id))).toHaveLength(1);
    });

    it("rejects unknown, disabled, cross-workspace, cross-repository, and unsupported Builder routes", async () => {
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId, repo: "acme/widgets", workKey: "builder-route-boundaries",
        originChannel: "codex_mcp", contract: completeContract(), createdBy: "user:lead",
      });
      await db.update(acceptanceContracts).set({
        status: "confirmed", confirmedBy: "console_user:user-1", confirmedAt: new Date(),
      }).where(eq(acceptanceContracts.id, draft.contract.id));
      const select = (routeId: string) => recordAcceptanceBuilderRouteSelection({
        workspaceId: wsId, recordId: draft.record.id, selectedBy: "user:lead", routeId,
      });

      await expect(select(randomUUID())).rejects.toThrow("unavailable for this Record");
      const disabled = await registerAcceptanceBuilderRoute({
        workspaceId: wsId, repo: "acme/widgets", adapter: "durable_jace_fallback",
        status: "disabled", configurationVersion: 1, registeredBy: "server:environment",
      });
      await expect(select(disabled.route.id)).rejects.toThrow("unavailable for this Record");
      const otherRepo = await registerAcceptanceBuilderRoute({
        workspaceId: wsId, repo: "acme/other", adapter: "durable_github_fallback",
        configurationVersion: 1, registeredBy: "server:environment",
      });
      await expect(select(otherRepo.route.id)).rejects.toThrow("unavailable for this Record");

      const otherWorkspace = (await db.insert(workspaces).values({
        name: "other builder route workspace", slug: `other-builder-route-${randomUUID()}`,
      }).returning({ id: workspaces.id }))[0]!;
      const foreign = await registerAcceptanceBuilderRoute({
        workspaceId: otherWorkspace.id, repo: "acme/widgets", adapter: "github_claude",
        configurationVersion: 1, registeredBy: "server:environment",
      });
      await expect(select(foreign.route.id)).rejects.toThrow("unavailable for this Record");
      await db.delete(workspaces).where(eq(workspaces.id, otherWorkspace.id));

      for (const adapter of ["codex_app_server", "mcp_correction_inbox"] as const) {
        await expect(registerAcceptanceBuilderRoute({
          workspaceId: wsId, repo: "acme/widgets", adapter: adapter as never,
          configurationVersion: 1, registeredBy: "server:environment",
        })).rejects.toThrow("Invalid Acceptance Builder route registration");
      }
    });

    it("fails capability profiles closed on installation, route scope, and revision drift", async () => {
      const route = await registerAcceptanceBuilderRoute({
        workspaceId: wsId, repo: "acme/widgets", adapter: "github_codex",
        configurationVersion: 1, registeredBy: "server:environment",
      });
      const input = {
        workspaceId: wsId, routeId: route.route.id,
        recordedBy: "server:route-capability-profile",
      };
      await expect(recordAcceptanceBuilderRouteCapabilityProfile(input))
        .rejects.toThrow();

      await db.update(workspaces).set({
        githubInstallationId: "installation-capability-a",
        githubInstallationAccountLogin: "acme",
        githubInstallationAccountType: "Organization",
      })
        .where(eq(workspaces.id, wsId));
      const first = await recordAcceptanceBuilderRouteCapabilityProfile(input);
      expect(first.inserted).toBe(true);

      await db.update(workspaces).set({
        githubInstallationId: "installation-capability-b",
        githubInstallationAccountLogin: "acme",
        githubInstallationAccountType: "Organization",
      })
        .where(eq(workspaces.id, wsId));
      await expect(resolveAcceptanceBuilderRouteCapabilityProfile({
        workspaceId: wsId, routeId: route.route.id,
      })).resolves.toBeNull();
      await db.update(workspaces).set({
        githubInstallationId: "installation-capability-a",
        githubInstallationAccountLogin: "acme",
        githubInstallationAccountType: "Organization",
      })
        .where(eq(workspaces.id, wsId));
      await expect(resolveAcceptanceBuilderRouteCapabilityProfile({
        workspaceId: wsId, routeId: route.route.id,
      })).resolves.toMatchObject({ id: first.profile.id });

      const fallback = await registerAcceptanceBuilderRoute({
        workspaceId: wsId, repo: "acme/widgets", adapter: "durable_github_fallback",
        configurationVersion: 1, registeredBy: "server:environment",
      });
      await expect(recordAcceptanceBuilderRouteCapabilityProfile({
        ...input, routeId: fallback.route.id,
      })).rejects.toThrow();
      const disabled = await registerAcceptanceBuilderRoute({
        workspaceId: wsId, repo: "acme/widgets", adapter: "github_claude",
        status: "disabled", configurationVersion: 1, registeredBy: "server:environment",
      });
      await expect(recordAcceptanceBuilderRouteCapabilityProfile({
        ...input, routeId: disabled.route.id,
      })).rejects.toThrow();
      const otherRepo = await registerAcceptanceBuilderRoute({
        workspaceId: wsId, repo: "acme/other", adapter: "github_claude",
        configurationVersion: 1, registeredBy: "server:environment",
      });
      const otherRepoProfile = await recordAcceptanceBuilderRouteCapabilityProfile({
        ...input, routeId: otherRepo.route.id,
      });
      expect(otherRepoProfile).toMatchObject({ profile: {
        repo: "acme/other", adapter: "github_claude",
        snapshot: expect.objectContaining({ workspaceId: wsId, repo: "acme/other", routeId: otherRepo.route.id, adapter: "github_claude", routeConfigurationVersion: 1 }),
      } });
      expect(otherRepoProfile.profile.snapshotSha256).not.toBe(first.profile.snapshotSha256);

      const sameRepoDifferentRoute = await registerAcceptanceBuilderRoute({
        workspaceId: wsId, repo: "acme/widgets", adapter: "github_codex",
        configurationVersion: 1, registeredBy: "server:environment",
      });
      const sameRepoDifferentRouteProfile = await recordAcceptanceBuilderRouteCapabilityProfile({
        ...input, routeId: sameRepoDifferentRoute.route.id,
      });
      expect(sameRepoDifferentRouteProfile.profile.snapshotSha256).not.toBe(first.profile.snapshotSha256);

      // A syntactically valid snapshot copied from another route is not an
      // authorization profile for this route: every bound identity must match.
      await db.update(acceptanceBuilderRouteCapabilityProfiles).set({
        snapshot: otherRepoProfile.profile.snapshot,
        snapshotSha256: otherRepoProfile.profile.snapshotSha256,
      }).where(eq(acceptanceBuilderRouteCapabilityProfiles.id, first.profile.id));
      await expect(resolveAcceptanceBuilderRouteCapabilityProfile({
        workspaceId: wsId, routeId: route.route.id,
      })).resolves.toBeNull();

      await db.update(acceptanceBuilderRoutes).set({ configurationVersion: 2 })
        .where(eq(acceptanceBuilderRoutes.id, route.route.id));
      await expect(resolveAcceptanceBuilderRouteCapabilityProfile({
        workspaceId: wsId, routeId: route.route.id,
      })).resolves.toBeNull();
      const versionTwo = await recordAcceptanceBuilderRouteCapabilityProfile(input);
      expect(versionTwo).toMatchObject({ profile: {
        routeConfigurationVersion: 2,
        snapshot: expect.objectContaining({ routeConfigurationVersion: 2 }),
      } });
      expect(versionTwo.profile.snapshotSha256).not.toBe(first.profile.snapshotSha256);

      const otherWorkspace = (await db.insert(workspaces).values({
        name: "builder profile foreign workspace", slug: `builder-profile-${randomUUID()}`,
        githubInstallationId: "installation-foreign",
        githubInstallationAccountLogin: "foreign",
        githubInstallationAccountType: "Organization",
      }).returning({ id: workspaces.id }))[0]!;
      const foreign = await registerAcceptanceBuilderRoute({
        workspaceId: otherWorkspace.id, repo: "acme/widgets", adapter: "github_claude",
        configurationVersion: 1, registeredBy: "server:environment",
      });
      const foreignProfile = await recordAcceptanceBuilderRouteCapabilityProfile({
        workspaceId: otherWorkspace.id,
        routeId: foreign.route.id,
        recordedBy: "server:route-capability-profile",
      });
      expect(foreignProfile.profile.snapshotSha256).not.toBe(first.profile.snapshotSha256);
      await expect(recordAcceptanceBuilderRouteCapabilityProfile({
        ...input, routeId: foreign.route.id,
      })).rejects.toThrow();
      await db.delete(workspaces).where(eq(workspaces.id, otherWorkspace.id));
    });

    it("persists one canonical Intake message idempotently and refuses source-key collisions", async () => {
      const first = await recordAcceptanceInboundIntake({
        workspaceId: wsId,
        originChannel: "Slack",
        conversationKey: "thread-7",
        sourceKey: "event-1",
        text: "Add saved filters",
        sourceReferences: [{ kind: "channel_message", id: "event-1" }],
      });
      expect(first.inserted).toBe(true);
      expect(first.intake.originChannel).toBe("slack");

      const replay = await recordAcceptanceInboundIntake({
        workspaceId: wsId,
        originChannel: "slack",
        conversationKey: "thread-7",
        sourceKey: "event-1",
        text: "Add saved filters",
      });
      expect(replay.inserted).toBe(false);
      expect(replay.intake.id).toBe(first.intake.id);
      expect(replay.message.id).toBe(first.message.id);

      await expect(
        recordAcceptanceInboundIntake({
          workspaceId: wsId,
          originChannel: "slack",
          conversationKey: "thread-7",
          sourceKey: "event-1",
          text: "Different content",
        })
      ).rejects.toThrow("source key is already bound to different content");

      expect(
        await db
          .select()
          .from(acceptanceIntakes)
          .where(eq(acceptanceIntakes.id, first.intake.id))
      ).toHaveLength(1);
      expect(
        await db
          .select()
          .from(acceptanceIntakeMessages)
          .where(eq(acceptanceIntakeMessages.intakeId, first.intake.id))
      ).toHaveLength(1);
    });

    it("binds an Intake to one provenance-preserving draft and refuses changed re-drafts", async () => {
      const intake = await recordAcceptanceInboundIntake({
        workspaceId: wsId,
        originChannel: "discord",
        conversationKey: "thread-8",
        sourceKey: "message-1",
        text: "Add saved filters",
        sourceReferences: [{ kind: "channel_message", id: "message-1" }],
      });
      const contract = completeContract();
      const drafted = await createDraftAcceptanceRecordFromIntake({
        workspaceId: wsId,
        intakeId: intake.intake.id,
        repo: "acme/widgets",
        contract,
        createdBy: "jace:acceptance-intake",
      });
      expect(drafted.created).toBe(true);
      expect(drafted.intake.status).toBe("drafted");
      expect(drafted.intake.recordId).toBe(drafted.record.id);
      expect(drafted.record.workKey).toBe(`acceptance-intake:${intake.intake.id}`);
      expect(drafted.record.originChannel).toBe("discord");
      expect(drafted.record.sourceReferences).toEqual(intake.intake.sourceReferences);
      expect(drafted.contract.contract).toEqual(contract);

      const replay = await createDraftAcceptanceRecordFromIntake({
        workspaceId: wsId,
        intakeId: intake.intake.id,
        repo: "acme/widgets",
        contract,
        createdBy: "jace:acceptance-intake",
      });
      expect(replay).toMatchObject({
        created: false,
        intake: { id: intake.intake.id, recordId: drafted.record.id },
        record: { id: drafted.record.id },
        contract: { id: drafted.contract.id },
      });

      await expect(
        createDraftAcceptanceRecordFromIntake({
          workspaceId: wsId,
          intakeId: intake.intake.id,
          repo: "acme/widgets",
          contract: completeContract({ originalRequest: "A different request" }),
          createdBy: "jace:acceptance-intake",
        })
      ).rejects.toMatchObject({ code: "conflict" });

      const timeline = await readChangeRecordTimeline({
        workspaceId: wsId,
        recordId: drafted.record.id,
      });
      expect(timeline?.events.some((event) => event.eventKey ===
        `acceptance-intake:${intake.intake.id}:drafted`)).toBe(true);
    });

    it("unifies issue-only and PR-only records, moving PR events to the issue record", async () => {
      const issueRecord = await findOrCreateChangeRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        issueNumber: 77,
      });
      const prRecord = await findOrCreateChangeRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        prNumber: 456,
      });
      expect(prRecord.id).not.toBe(issueRecord.id);
      const currentHead = "f".repeat(40);
      const currentCycleId = randomUUID();
      await db.update(changeRecords).set({
        currentPrHeadSha: currentHead,
        currentPrHeadCycleId: currentCycleId,
        currentPrHeadAuthoritative: false,
        currentPrHeadAuthorityGeneration: 7,
        headShas: [currentHead],
      }).where(eq(changeRecords.id, prRecord.id));

      await appendChangeRecordEvent({
        recordId: prRecord.id,
        eventKey: "review:456:sha-1",
        stage: "review",
        actor: "reviewer-of-record",
        payloadRef: { kind: "review", prNumber: 456, headSha: "sha-1" },
        at: new Date("2026-08-03T10:00:00.000Z"),
      });

      const unified = await findOrCreateChangeRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        issueNumber: 77,
        prNumber: 456,
        headShas: ["sha-1"],
      });
      expect(unified.id).toBe(issueRecord.id);
      expect(unified.prNumber).toBe(456);
      expect(unified.headShas).toEqual([currentHead, "sha-1"]);
      expect(unified).toMatchObject({
        currentPrHeadSha: currentHead,
        currentPrHeadCycleId: currentCycleId,
        currentPrHeadAuthoritative: false,
        currentPrHeadAuthorityGeneration: 7,
      });

      const timeline = await readChangeRecordTimeline({
        workspaceId: wsId,
        recordId: unified.id,
      });
      expect(timeline?.events.map((e) => e.eventKey)).toEqual([
        "review:456:sha-1",
      ]);

      const oldEvents = await db
        .select()
        .from(changeRecordEvents)
        .where(eq(changeRecordEvents.recordId, prRecord.id));
      expect(oldEvents).toHaveLength(0);
    });

    it("appendChangeRecordEvent is append-only and idempotent by eventKey", async () => {
      const record = await findOrCreateChangeRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        prNumber: 9,
      });
      const first = await appendChangeRecordEvent({
        recordId: record.id,
        eventKey: "ac-proof:run-1",
        stage: "verification",
        actor: "arc-c",
        payloadRef: { artifact: "ac_evidence.json", runId: "run-1" },
      });
      const second = await appendChangeRecordEvent({
        recordId: record.id,
        eventKey: "ac-proof:run-1",
        stage: "verification",
        actor: "arc-c",
        payloadRef: { artifact: "different.json", runId: "run-1" },
      });

      expect(first.inserted).toBe(true);
      expect(second.inserted).toBe(false);
      expect(second.event.id).toBe(first.event.id);
      expect(second.event.payloadRef).toEqual({
        artifact: "ac_evidence.json",
        runId: "run-1",
      });
    });

    it("atomically appends an ordered batch and allows an exact replay", async () => {
      const record = await findOrCreateChangeRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        prNumber: 10,
      });
      const events = [
        {
          recordId: record.id,
          eventKey: "batch:contract",
          stage: "contract",
          actor: "console_user:user-1",
          payloadRef: { version: 1, kind: "acceptance_contract" },
          at: new Date("2026-08-10T09:00:00.000Z"),
        },
        {
          recordId: record.id,
          eventKey: "batch:evidence",
          stage: "evidence",
          actor: "console_user:user-1",
          payloadRef: { artifactKey: "evidence/run-1.json", kind: "criterion_evidence" },
          at: new Date("2026-08-10T09:01:00.000Z"),
        },
      ];

      const first = await appendChangeRecordEventsAtomically(events);
      expect(first.events.map((result) => result.inserted)).toEqual([true, true]);
      expect(first.events.map((result) => result.event.eventKey)).toEqual([
        "batch:contract",
        "batch:evidence",
      ]);

      const replay = await appendChangeRecordEventsAtomically(events.map((event) => ({
        ...event,
        at: new Date("2026-08-10T10:00:00.000Z"),
      })));
      expect(replay.events.map((result) => result.inserted)).toEqual([false, false]);
      expect(replay.events.map((result) => result.event.id)).toEqual(
        first.events.map((result) => result.event.id)
      );
    });

    it("rolls back new batch events when a reused event key has different provenance", async () => {
      const record = await findOrCreateChangeRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        prNumber: 11,
      });
      await appendChangeRecordEvent({
        recordId: record.id,
        eventKey: "batch:already-recorded",
        stage: "contract",
        actor: "console_user:user-1",
        payloadRef: { version: 1 },
      });

      await expect(appendChangeRecordEventsAtomically([
        {
          recordId: record.id,
          eventKey: "batch:must-roll-back",
          stage: "evidence",
          actor: "console_user:user-1",
          payloadRef: { artifactKey: "evidence/new.json" },
        },
        {
          recordId: record.id,
          eventKey: "batch:already-recorded",
          stage: "evidence",
          actor: "console_user:user-1",
          payloadRef: { version: 1 },
        },
      ])).rejects.toThrow("already bound to different stage, actor, or payloadRef");

      const persisted = await db
        .select()
        .from(changeRecordEvents)
        .where(eq(changeRecordEvents.recordId, record.id));
      expect(persisted.map((event) => event.eventKey).sort()).toEqual(["batch:already-recorded"]);
    });

    it("keeps exact preexisting events and atomically appends only the new remainder", async () => {
      const record = await findOrCreateChangeRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        prNumber: 12,
      });
      const preexisting = {
        recordId: record.id,
        eventKey: "batch:preexisting",
        stage: "contract",
        actor: "console_user:user-1",
        payloadRef: { version: 1 },
      };
      await appendChangeRecordEvent(preexisting);

      const appended = await appendChangeRecordEventsAtomically([
        { ...preexisting, at: new Date("2026-08-10T10:00:00.000Z") },
        {
          recordId: record.id,
          eventKey: "batch:new",
          stage: "evidence",
          actor: "console_user:user-1",
          payloadRef: { artifactKey: "evidence/new.json" },
        },
      ]);
      expect(appended.events.map((result) => result.inserted)).toEqual([false, true]);
      expect(appended.events.map((result) => result.event.eventKey)).toEqual([
        "batch:preexisting",
        "batch:new",
      ]);
    });

    it("records signed merge custody before append-only post-merge outcomes and stays replay-safe", async () => {
      const actor = await addAcceptanceDecisionActor(wsId, "owner");
      const headSha = "a".repeat(40);
      const baseSha = "b".repeat(40);
      const mergeSha = "c".repeat(40);
      const ready = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId,
        workKey: "signed-merge-post-merge-lineage",
        prNumber: 310,
        headSha,
        verdict: "proven",
      });
      await expect(recordAcceptancePrDecision({
        workspaceId: wsId,
        recordId: ready.draft.record.id,
        bindingId: ready.binding.bindingId,
        decision: "approved",
        decidedBy: actor,
      })).resolves.toMatchObject({ kind: "recorded" });

      const mergeInput = {
        workspaceId: wsId,
        recordId: ready.draft.record.id,
        repo: ready.repo,
        prNumber: 310,
        deliveryId: "signed-merge-post-merge-lineage:merged",
        headSha,
        baseSha,
        mergeSha,
        mergedAt: new Date("2026-08-11T08:00:00.000Z"),
        prUrl: "https://github.com/acme/widgets/pull/310",
        githubActor: { id: 310, login: "octocat", type: "User" as const },
        source: "github_webhook" as const,
      };
      const merged = await recordSignedAcceptanceRecordMerge(mergeInput);
      const mergedReplay = await recordSignedAcceptanceRecordMerge(mergeInput);
      expect(merged).toMatchObject({
        kind: "recorded",
        decisionAlignment: {
          kind: "aligned",
          decision: "approved",
          binding: { headSha, headCycleId: ready.advanced.jobId },
        },
      });
      expect(mergedReplay).toMatchObject({
        kind: "replayed",
        mergeEventId: merged.kind === "recorded" ? merged.mergeEventId : "missing",
        deliveryEventId: merged.kind === "recorded" ? merged.deliveryEventId : "missing",
      });

      const deployedOutcome = {
        kind: "deployed",
        revisionSha: mergeSha,
        environment: "production",
        deploymentReference: "railway:deploy:42",
      } as const;
      const incidentOutcome = {
        kind: "incident",
        revisionSha: mergeSha,
        incidentReference: "incidents:inc-9",
      } as const;
      const revertedOutcome = {
        kind: "reverted",
        revertedSha: mergeSha,
        revertSha: "d".repeat(40),
        revertReference: "gh/revert/99",
      } as const;

      const deployed = await recordAcceptancePostMergeOutcome({
        workspaceId: wsId,
        recordId: ready.draft.record.id,
        recordedBy: "user:lead",
        outcome: deployedOutcome,
        occurredAt: new Date("2026-08-11T08:10:00.000Z"),
      });
      const incident = await recordAcceptancePostMergeOutcome({
        workspaceId: wsId,
        recordId: ready.draft.record.id,
        recordedBy: "user:lead",
        outcome: incidentOutcome,
        occurredAt: new Date("2026-08-11T08:20:00.000Z"),
      });
      const reverted = await recordAcceptancePostMergeOutcome({
        workspaceId: wsId,
        recordId: ready.draft.record.id,
        recordedBy: "user:lead",
        outcome: revertedOutcome,
        occurredAt: new Date("2026-08-11T08:30:00.000Z"),
      });

      expect(deployed.inserted).toBe(true);
      expect(incident.inserted).toBe(true);
      expect(reverted.inserted).toBe(true);

      const timeline = await readChangeRecordTimeline({
        workspaceId: wsId,
        recordId: ready.draft.record.id,
      });
      expect(timeline?.record.mergedSha).toBe(mergeSha);
      expect(timeline?.record.state).toBe("reverted");
      const outcomeEvents = timeline?.events.filter((event) =>
        event.stage === "post_merge_outcome"
      ) ?? [];
      expect(outcomeEvents.map((event) => event.eventKey)).toEqual([
        "acceptance-post-merge:deployed:railway:deploy:42",
        "acceptance-post-merge:incident:incidents:inc-9",
        `acceptance-post-merge:reverted:${"d".repeat(40)}`,
      ]);
      expect(outcomeEvents[0]?.payloadRef).toEqual({
        kind: "acceptance_post_merge_outcome",
        repository: "acme/widgets",
        signedMergeEventId: merged.kind === "recorded" ? merged.mergeEventId : "missing",
        signedMergeDeliveryEventId: merged.kind === "recorded" ? merged.deliveryEventId : "missing",
        signedMergeSha: mergeSha,
        outcome: deployedOutcome,
      });
      expect(outcomeEvents[1]?.payloadRef).toEqual({
        kind: "acceptance_post_merge_outcome",
        repository: "acme/widgets",
        signedMergeEventId: merged.kind === "recorded" ? merged.mergeEventId : "missing",
        signedMergeDeliveryEventId: merged.kind === "recorded" ? merged.deliveryEventId : "missing",
        signedMergeSha: mergeSha,
        outcome: incidentOutcome,
      });
      expect(outcomeEvents[2]?.payloadRef).toEqual({
        kind: "acceptance_post_merge_outcome",
        repository: "acme/widgets",
        signedMergeEventId: merged.kind === "recorded" ? merged.mergeEventId : "missing",
        signedMergeDeliveryEventId: merged.kind === "recorded" ? merged.deliveryEventId : "missing",
        signedMergeSha: mergeSha,
        outcome: revertedOutcome,
      });

      await expect(recordSignedAcceptanceRecordMerge(mergeInput)).resolves.toMatchObject({
        kind: "replayed",
        mergeEventId: merged.kind === "recorded" ? merged.mergeEventId : "missing",
      });
    });

    it("rejects caller-minted merges, foreign workspaces, and unmatched post-merge revisions", async () => {
      const genericRecord = await findOrCreateChangeRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        issueNumber: 410,
        prNumber: 410,
        headShas: ["e".repeat(40)],
      });
      await expect(
        recordAcceptancePostMergeOutcome({
          workspaceId: wsId,
          recordId: genericRecord.id,
          recordedBy: "user:lead",
          outcome: {
            kind: "merged",
            prNumber: 410,
            baseSha: "f".repeat(40),
            headSha: "e".repeat(40),
            mergeSha: "a".repeat(40),
            mergeReference: "gh/pr/410#merge",
          } as never,
        })
      ).rejects.toThrow("signed GitHub webhook boundary");

      const actor = await addAcceptanceDecisionActor(wsId, "admin");
      const ready = await createReadyAcceptanceDecisionRecord({
        workspaceId: wsId,
        workKey: "signed-merge-post-merge-boundaries",
        prNumber: 411,
        headSha: "1".repeat(40),
        verdict: "proven",
      });
      await recordAcceptancePrDecision({
        workspaceId: wsId,
        recordId: ready.draft.record.id,
        bindingId: ready.binding.bindingId,
        decision: "approved",
        decidedBy: actor,
      });
      const mergeSha = "2".repeat(40);
      await recordSignedAcceptanceRecordMerge({
        workspaceId: wsId,
        recordId: ready.draft.record.id,
        repo: ready.repo,
        prNumber: 411,
        deliveryId: "signed-merge-post-merge-boundaries:merged",
        headSha: "1".repeat(40),
        baseSha: "3".repeat(40),
        mergeSha,
        mergedAt: new Date("2026-08-11T09:00:00.000Z"),
        prUrl: "https://github.com/acme/widgets/pull/411",
        githubActor: { id: 411, login: "merge-bot[bot]", type: "Bot" },
        source: "github_webhook",
      });

      const otherWorkspace = await db
        .insert(workspaces)
        .values({
          name: "other workspace",
          slug: `other-change-records-${randomUUID()}`,
        })
        .returning({ id: workspaces.id });
      try {
        await expect(
          recordAcceptancePostMergeOutcome({
            workspaceId: otherWorkspace[0]!.id,
            recordId: ready.draft.record.id,
            recordedBy: "user:lead",
            outcome: {
              kind: "deployed",
              revisionSha: mergeSha,
              environment: "production",
              deploymentReference: "railway:deploy:foreign",
            },
          })
        ).rejects.toThrow("Acceptance Record is missing or outside this workspace");
      } finally {
        await db
          .delete(workspaces)
          .where(eq(workspaces.id, otherWorkspace[0]!.id));
      }

      await expect(
        recordAcceptancePostMergeOutcome({
          workspaceId: wsId,
          recordId: ready.draft.record.id,
          recordedBy: "user:lead",
          outcome: {
            kind: "incident",
            revisionSha: "4".repeat(40),
            incidentReference: "incidents:foreign-revision",
          },
        })
      ).rejects.toThrow(
        "Post-merge outcome does not reference this Acceptance Record merge SHA"
      );
    });

    it("reads timelines scoped by workspace and ordered by event time", async () => {
      const record = await findOrCreateChangeRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        issueNumber: 88,
        prNumber: 12,
      });
      await appendChangeRecordEvent({
        recordId: record.id,
        eventKey: "later",
        stage: "review",
        actor: "reviewer",
        payloadRef: { kind: "review" },
        at: new Date("2026-08-03T12:00:00.000Z"),
      });
      await appendChangeRecordEvent({
        recordId: record.id,
        eventKey: "earlier",
        stage: "planning",
        actor: "jace",
        payloadRef: { kind: "issue" },
        at: new Date("2026-08-03T09:00:00.000Z"),
      });

      const timeline = await readChangeRecordTimeline({
        workspaceId: wsId,
        recordId: record.id,
      });
      expect(timeline?.record.id).toBe(record.id);
      expect(timeline?.events.map((e) => e.eventKey)).toEqual([
        "earlier",
        "later",
      ]);

      const otherWorkspace = await db
        .insert(workspaces)
        .values({
          name: "other workspace",
          slug: `other-change-records-${randomUUID()}`,
        })
        .returning({ id: workspaces.id });
      try {
        await expect(
          readChangeRecordTimeline({
            workspaceId: otherWorkspace[0]!.id,
            recordId: record.id,
          })
        ).resolves.toBeNull();
      } finally {
        await db
          .delete(workspaces)
          .where(eq(workspaces.id, otherWorkspace[0]!.id));
      }
    });

    it("creates a retry-safe manual Acceptance Record with immutable draft versions", async () => {
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        workKey: "manual-trust-loop-1",
        originChannel: "codex_mcp",
        sourceReferences: [{ kind: "codex_thread", id: "thread-1" }],
        contract: completeContract({
          originalRequest: "Add a red save button",
          acceptanceCriteria: [
            { id: "AC-1", text: "Save button is red", userVisible: true },
          ],
        }),
        createdBy: "user:lead",
      });
      expect(draft.record.issueNumber).toBeNull();
      expect(draft.record.prNumber).toBeNull();
      expect(draft.record.workKey).toBe("manual-trust-loop-1");
      expect(draft.record.originChannel).toBe("codex_mcp");
      expect(draft.contract.version).toBe(1);
      expect(draft.contract.status).toBe("draft");

      const retried = await createDraftAcceptanceRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        workKey: "manual-trust-loop-1",
        originChannel: "codex_mcp",
        contract: completeContract({
          originalRequest: "This retry must not replace the draft",
        }),
        createdBy: "user:lead",
      });
      expect(retried.record.id).toBe(draft.record.id);
      expect(retried.contract.id).toBe(draft.contract.id);
      expect(retried.contract.contract).toEqual(draft.contract.contract);

      const secondDraft = await createDraftAcceptanceContract({
        recordId: draft.record.id,
        contract: completeContract({
          originalRequest: "Add a red save button",
          acceptanceCriteria: [
            { id: "AC-1", text: "Save button is red", userVisible: true },
          ],
          unresolvedQuestions: [{ id: "Q-1", text: "Which theme token?" }],
        }),
        createdBy: "user:lead",
      });
      expect(secondDraft.version).toBe(2);
      const contracts = await readAcceptanceContracts({
        workspaceId: wsId,
        recordId: draft.record.id,
      });
      expect(contracts?.map((contract) => [contract.version, contract.status])).toEqual([
        [1, "draft"],
        [2, "draft"],
      ]);
    });

    it("confirms only the approval-bound draft before exposing the approval as approved", async () => {
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        workKey: "approval-bound-contract",
        originChannel: "codex_mcp",
        contract: completeContract(),
        createdBy: "user:lead",
      });
      const [session] = await db
        .insert(jaceSessions)
        .values({
          workspaceId: wsId,
          channel: "codex_mcp",
          conversationKey: `approval-contract-${randomUUID()}`,
          eveSessionId: `eve-${randomUUID()}`,
        })
        .returning();
      const request = await recordApprovalRequest({
        workspaceId: wsId,
        sessionId: session!.id,
        eveSessionId: session!.eveSessionId!,
        requestId: `confirm-${randomUUID()}`,
        toolName: "confirm_acceptance_contract",
        toolInput: { acceptanceContractId: "untrusted-payload-value" },
        approveOptionId: "approve",
        denyOptionId: "deny",
        acceptanceContractId: draft.contract.id,
      });

      await expect(
        resolveAcceptanceContractApproval({
          workspaceId: wsId,
          approvalId: request.approval.id,
          decision: "approved",
          confirmedBy: "console_user:user-1",
        })
      ).resolves.toMatchObject({
        resolved: true,
        contract: { id: draft.contract.id, status: "confirmed" },
      });

      const [approval] = await db
        .select()
        .from(jaceApprovals)
        .where(eq(jaceApprovals.id, request.approval.id));
      expect(approval?.status).toBe("approved");
      const timeline = await readChangeRecordTimeline({
        workspaceId: wsId,
        recordId: draft.record.id,
      });
      expect(
        timeline?.events.some(
          (event) => event.eventKey === "acceptance-contract:confirmed:1"
        )
      ).toBe(true);
    });

    it("leaves unsafe or incomplete Contract confirmations pending", async () => {
      const draft = await createDraftAcceptanceRecord({
        workspaceId: wsId,
        repo: "acme/widgets",
        workKey: "rejected-contract-confirmations",
        originChannel: "codex_mcp",
        contract: completeContract({
          unresolvedQuestions: [{ id: "Q-1", text: "Which filters?" }],
        }),
        createdBy: "user:lead",
      });
      const [session] = await db
        .insert(jaceSessions)
        .values({
          workspaceId: wsId,
          channel: "codex_mcp",
          conversationKey: `rejected-contract-${randomUUID()}`,
          eveSessionId: `eve-${randomUUID()}`,
        })
        .returning();
      const openQuestionApproval = await recordApprovalRequest({
        workspaceId: wsId,
        sessionId: session!.id,
        eveSessionId: session!.eveSessionId!,
        requestId: `open-question-${randomUUID()}`,
        toolName: "confirm_acceptance_contract",
        toolInput: {},
        approveOptionId: "approve",
        denyOptionId: "deny",
        acceptanceContractId: draft.contract.id,
      });
      await expect(
        resolveAcceptanceContractApproval({
          workspaceId: wsId,
          approvalId: openQuestionApproval.approval.id,
          decision: "approved",
          confirmedBy: "console_user:user-1",
        })
      ).resolves.toEqual({ resolved: false, reason: "open_questions" });

      const [approval] = await db
        .select()
        .from(jaceApprovals)
        .where(eq(jaceApprovals.id, openQuestionApproval.approval.id));
      expect(approval?.status).toBe("pending");

      await expect(
        createDraftAcceptanceRecord({
          workspaceId: wsId,
          repo: "acme/widgets",
          workKey: "missing-contract-criteria",
          originChannel: "codex_mcp",
          contract: { originalRequest: "No criterion", unresolvedQuestions: [] },
          createdBy: "user:lead",
        })
      ).rejects.toThrow(/Acceptance Contract is incomplete/);

      const wrongToolApproval = await recordApprovalRequest({
        workspaceId: wsId,
        sessionId: session!.id,
        eveSessionId: session!.eveSessionId!,
        requestId: `wrong-tool-${randomUUID()}`,
        toolName: "create_issue",
        toolInput: {},
        approveOptionId: "approve",
        denyOptionId: "deny",
        acceptanceContractId: draft.contract.id,
      });
      await expect(
        resolveAcceptanceContractApproval({
          workspaceId: wsId,
          approvalId: wrongToolApproval.approval.id,
          decision: "approved",
          confirmedBy: "console_user:user-1",
        })
      ).resolves.toEqual({ resolved: false, reason: "wrong_tool_name" });
      await expect(
        resolveAcceptanceContractApproval({
          workspaceId: "foreign-workspace",
          approvalId: wrongToolApproval.approval.id,
          decision: "approved",
          confirmedBy: "console_user:user-1",
        })
      ).resolves.toEqual({ resolved: false, reason: "wrong_workspace" });
    });
  }
);
