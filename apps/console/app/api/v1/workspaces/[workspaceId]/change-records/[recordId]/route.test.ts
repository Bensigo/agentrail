import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@agentrail/db-postgres", () => ({
  AcceptanceContextPackRegenerationRequestConflictError:
    class AcceptanceContextPackRegenerationRequestConflictError extends Error {},
  AcceptanceDependencyExternalBuilderPackConflictError:
    class AcceptanceDependencyExternalBuilderPackConflictError extends Error {},
  AcceptancePrDecisionConflictError: class AcceptancePrDecisionConflictError extends Error {},
  AcceptancePrReviewEffortConflictError: class AcceptancePrReviewEffortConflictError extends Error {},
  approveAcceptanceDependencyObservationAndMintExternalBuilderPack: vi.fn(),
  getWorkspaceMembership: vi.fn(),
  readAcceptancePrReviewMetrics: vi.fn(),
  readAcceptanceRecordDetail: vi.fn(),
  readCurrentAcceptanceCriterionOutcomeBundle: vi.fn(),
  readCurrentAcceptanceDependencyObservations: vi.fn(),
  readCurrentAcceptancePrDecision: vi.fn(),
  readCurrentAcceptanceCorrectionPackets: vi.fn(),
  readChangeRecordTimeline: vi.fn(),
  readDependencyDraftProposalDetail: vi.fn(),
  recordAcceptancePrDecision: vi.fn(),
  recordAcceptancePrReviewEffort: vi.fn(),
  recordAcceptanceContextPackRegenerationRequest: vi.fn(),
  retryAcceptanceContextPackRegenerationExecution: vi.fn(),
  listAcceptanceContextPackRegenerationExecutions: vi.fn(),
  changeRecordEventId: vi.fn(({ recordId, eventKey }: { recordId: string; eventKey: string }) =>
    eventKey === "context-pack-regeneration:00000000-0000-4000-8000-000000000049:00000000-0000-4000-8000-000000000051"
      ? "00000000-0000-4000-8000-000000000048"
      : recordId),
}));

import { auth } from "@agentrail/auth";
import {
  AcceptanceContextPackRegenerationRequestConflictError,
  AcceptanceDependencyExternalBuilderPackConflictError,
  AcceptancePrDecisionConflictError,
  AcceptancePrReviewEffortConflictError,
  approveAcceptanceDependencyObservationAndMintExternalBuilderPack,
  getWorkspaceMembership,
  readAcceptancePrReviewMetrics,
  readAcceptanceRecordDetail,
  readCurrentAcceptanceCriterionOutcomeBundle,
  readCurrentAcceptanceDependencyObservations,
  readCurrentAcceptancePrDecision,
  readCurrentAcceptanceCorrectionPackets,
  readChangeRecordTimeline,
  readDependencyDraftProposalDetail,
  recordAcceptancePrDecision,
  recordAcceptancePrReviewEffort,
  recordAcceptanceContextPackRegenerationRequest,
  retryAcceptanceContextPackRegenerationExecution,
  listAcceptanceContextPackRegenerationExecutions,
} from "@agentrail/db-postgres";
import { GET, PATCH } from "./route";

const WS = "00000000-0000-4000-8000-000000000001";
const OTHER_WS = "00000000-0000-4000-8000-000000000002";
const RECORD = "00000000-0000-4000-8000-000000000111";
const USER = "00000000-0000-4000-8000-000000000777";
const HEAD = "f".repeat(40);
const PRIOR_HEAD = "d".repeat(40);
const CYCLE = "00000000-0000-4000-8000-000000000099";
const CONTRACT = "00000000-0000-4000-8000-000000000088";
const PACKET_ID = `correction-${"c".repeat(48)}`;
const CREATED = new Date("2026-08-03T12:00:00.000Z");
const UPDATED = new Date("2026-08-03T12:05:00.000Z");
const REVIEW_AT = new Date("2026-08-03T12:04:00.000Z");
const DECIDED_AT = new Date("2026-08-03T12:06:00.000Z");
const DECISION_EVENT_ID = "00000000-0000-4000-8000-000000000077";
const POSTED_ATTESTATION_EVENT_ID = "00000000-0000-4000-8000-000000000066";
const DECISION_BINDING_ID = "00000000-0000-4000-8000-000000000055";
const EFFORT_EVENT_ID = "00000000-0000-4000-8000-000000000054";
const EFFORT_AT = new Date("2026-08-03T12:07:00.000Z");
const DEPENDENCY_OBSERVATION_EVENT_ID = "00000000-0000-4000-8000-000000000053";
const DEPENDENCY_APPROVAL_EVENT_ID = "00000000-0000-4000-8000-000000000052";
const EXTERNAL_BUILDER_PACK_EVENT_ID = "00000000-0000-4000-8000-000000000051";
const EXTERNAL_BUILDER_PACK_ID = "00000000-0000-4000-8000-000000000050";
const COMPILED_PACK_ID = "00000000-0000-4000-8000-000000000049";
const REGENERATION_REQUEST_EVENT_ID = "00000000-0000-4000-8000-000000000048";
const REGENERATION_EXECUTION_ID = "00000000-0000-4000-8000-000000000050";
const REGENERATION_REQUEST_INTENT_ID = "00000000-0000-4000-8000-000000000051";
const CANDIDATE_FINGERPRINT = `sha256:${"9".repeat(64)}`;
const DEPENDENCY_OBSERVED_AT = new Date("2026-08-03T12:03:00.000Z");
const DEPENDENCY_APPROVED_AT = new Date("2026-08-03T12:08:00.000Z");

const currentCorrectionPackets = {
  kind: "current" as const,
  binding: {
    workspaceId: WS,
    recordId: RECORD,
    reviewJobId: CYCLE,
    repo: "ada/widgets",
    prNumber: 98,
    headSha: HEAD,
    headCycleId: CYCLE,
    authorityGeneration: 1,
    acceptanceContract: {
      id: CONTRACT,
      version: 1,
      sha256: "a".repeat(64),
    },
  },
  packetIds: [PACKET_ID],
  packetSetSha256: "b".repeat(64),
  correctionPacketPayloadSetSha256: "c".repeat(64),
  packets: [{
    kind: "review_job_correction_packet",
    version: 1,
    packetId: PACKET_ID,
    workspaceId: WS,
    repo: "ada/widgets",
    prNumber: 98,
    headSha: HEAD,
    recordId: RECORD,
    jobId: CYCLE,
    acceptanceContract: { id: CONTRACT, version: 1 },
    criterion: { id: "criterion-1", snapshot: "The saved page is visible." },
    basis: "acceptance_contract",
    state: "failed",
    expected: "The saved page is visible.",
    observed: "The page returned an error.",
    affectedContext: {
      modality: "ui",
      environmentKind: "isolated_preview",
      flow: "saved-page",
      reproduction: { modality: "ui", steps: [{ action: "open", path: "/saved" }] },
    },
    evidence: { evidenceRef: "criterion:criterion-1:ui-result", previewBootId: "boot-1" },
    scopeBoundary: "Only criterion-1 at the exact PR head.",
    impact: "The saved page cannot be viewed.",
    requiredCorrection: "Make the saved page visible.",
    reverification: "Rerun criterion-1 against the next exact head.",
  }],
};

const currentFinalDecision = {
  kind: "current" as const,
  binding: {
    bindingId: DECISION_BINDING_ID,
    workspaceId: WS,
    recordId: RECORD,
    repo: "ada/widgets",
    prNumber: 98,
    headSha: HEAD,
    headCycleId: CYCLE,
    authorityGeneration: 1,
    reviewJobId: CYCLE,
    reviewVerdict: "failed" as const,
    postedReviewUrl: "https://github.com/ada/widgets/pull/98#pullrequestreview-5",
    postedAttestationEventId: POSTED_ATTESTATION_EVENT_ID,
    acceptanceContract: {
      id: CONTRACT,
      version: 1,
      sha256: "a".repeat(64),
    },
  },
  decision: null,
};

const currentReviewMetrics = {
  kind: "record" as const,
  workspaceId: WS,
  recordId: RECORD,
  repo: "ada/widgets",
  prNumber: 98,
  currentCycle: {
    headSha: HEAD,
    headCycleId: CYCLE,
    authorityGeneration: 1,
  },
  cycles: [{
    binding: {
      workspaceId: WS,
      recordId: RECORD,
      repo: "ada/widgets",
      prNumber: 98,
      headSha: HEAD,
      headCycleId: CYCLE,
      reviewJobId: CYCLE,
      reviewVerdict: "failed" as const,
      postedReviewUrl: "https://github.com/ada/widgets/pull/98#pullrequestreview-5",
      postedAttestationEventId: POSTED_ATTESTATION_EVENT_ID,
      acceptanceContract: { id: CONTRACT, version: 1, sha256: "a".repeat(64) },
    },
    current: true,
    reviewedAt: REVIEW_AT,
    effort: { kind: "unknown" as const },
    decision: { kind: "unknown" as const },
    signedMerge: { kind: "unknown" as const },
    postMergeOutcomes: { kind: "unknown" as const },
  }],
  summary: {
    reviewEffort: {
      eligible: 1,
      known: 0,
      unknown: 1,
      totalMinutes: null,
      averageMinutes: null,
    },
    decisions: { eligible: 1, known: 0, unknown: 1 },
    signedMerges: { eligible: 1, known: 0, unknown: 1 },
    postMergeOutcomes: { eligible: 0, known: 0, unknown: 0 },
  },
};

const dependencyCandidate = {
  package: "@acme/widget",
  dependencyKind: "dependencies" as const,
  specifier: "^1.2.0",
  currentVersion: "1.2.3",
  targetVersion: "1.3.0",
};
const dependencyRuntime = {
  disposition: "safe" as const,
  nodeVersion: "22.14.0",
  evidenceSha256: "1".repeat(64),
};
const dependencyPackageManager = {
  disposition: "safe" as const,
  name: "pnpm",
  version: "10.14.0",
  profile: "pnpm_lockfile_only_v1",
  updateArgv: ["pnpm", "update", "@acme/widget@1.3.0", "--lockfile-only", "--ignore-scripts"],
  evidenceSha256: "2".repeat(64),
};
const dependencyManifest = { path: "packages/widget/package.json", blobSha: "3".repeat(40) };
const dependencyLockfile = {
  disposition: "present" as const,
  path: "pnpm-lock.yaml",
  blobSha: "4".repeat(40),
  evidenceSha256: "5".repeat(64),
};
const dependencyBaseline = { headSha: HEAD };
const dependencySecurity = {
  disposition: "clear" as const,
  provider: "osv" as const,
  reference: "osv:npm:@acme/widget@1.3.0",
  reportSha256: "6".repeat(64),
};
const dependencyBinding = {
  workspaceId: WS,
  recordId: RECORD,
  repo: "ada/widgets",
  prNumber: 98,
  headSha: HEAD,
  headCycleId: CYCLE,
  authorityGeneration: 1,
  reviewJobId: CYCLE,
  acceptanceContract: { id: CONTRACT, version: 1, sha256: "a".repeat(64) },
  compiledPack: {
    id: COMPILED_PACK_ID,
    sha256: "7".repeat(64),
    sourceSnapshotId: "00000000-0000-4000-8000-000000000048",
    sourceCustodyIdentitySha256: "8".repeat(64),
    compilerVersion: "acceptance-context-pack-compiler-v2",
    policyVersion: "acceptance-context-pack-policy-v2",
    exactHeadDependencyTreeProofsSha256: "b".repeat(64),
  },
};
const dependencyObservation = {
  eventId: DEPENDENCY_OBSERVATION_EVENT_ID,
  eventKey: `acceptance-dependency-observation:${CYCLE}:${CANDIDATE_FINGERPRINT.slice("sha256:".length)}`,
  status: "observed" as const,
  reasons: [],
  candidateFingerprint: CANDIDATE_FINGERPRINT,
  candidate: dependencyCandidate,
  runtime: dependencyRuntime,
  packageManager: dependencyPackageManager,
  manifest: dependencyManifest,
  lockfile: dependencyLockfile,
  baseline: dependencyBaseline,
  security: dependencySecurity,
  observedAt: DEPENDENCY_OBSERVED_AT,
};
const dependencyApproval = {
  eventId: DEPENDENCY_APPROVAL_EVENT_ID,
  eventKey: `acceptance-dependency-approval:${CYCLE}:${CANDIDATE_FINGERPRINT.slice("sha256:".length)}`,
  observationEventId: DEPENDENCY_OBSERVATION_EVENT_ID,
  candidateFingerprint: CANDIDATE_FINGERPRINT,
  approvedBy: `user:${USER}`,
  approvedRole: "owner" as const,
  approvedAt: DEPENDENCY_APPROVED_AT,
};
const externalBuilderPack = {
  packId: EXTERNAL_BUILDER_PACK_ID,
  eventId: EXTERNAL_BUILDER_PACK_EVENT_ID,
  eventKey: `acceptance-dependency-external-builder-pack:${CYCLE}:${CANDIDATE_FINGERPRINT.slice("sha256:".length)}`,
  observationEventId: DEPENDENCY_OBSERVATION_EVENT_ID,
  approvalEventId: DEPENDENCY_APPROVAL_EVENT_ID,
  candidateFingerprint: CANDIDATE_FINGERPRINT,
  binding: dependencyBinding,
  candidate: dependencyCandidate,
  runtime: dependencyRuntime,
  packageManager: dependencyPackageManager,
  manifest: dependencyManifest,
  lockfile: dependencyLockfile,
  baseline: dependencyBaseline,
  security: dependencySecurity,
  route: {
    selectionEventId: "00000000-0000-4000-8000-000000000047",
    id: "00000000-0000-4000-8000-000000000046",
    adapter: "github_codex" as const,
    configurationVersion: 2,
    snapshot: {
      builder: { adapter: "github_codex" as const, routeId: "00000000-0000-4000-8000-000000000046" },
      protocol: "github_comment" as const,
      capability: {
        availability: "unverified" as const,
        activation: "github_mention" as const,
        acknowledgement: "vendor_activity" as const,
        repairHead: "github_synchronize" as const,
      },
      scopeBoundary: "correction_delivery_only" as const,
    },
    snapshotSha256: "c".repeat(64),
  },
  deliveryAuthority: "not_granted" as const,
  scopeBoundary: "dependency_external_builder_pack_only" as const,
  reviewRequirement: "exact_head_r7_reentry" as const,
  mintedAt: DEPENDENCY_APPROVED_AT,
};
const currentDependencyObservations = {
  kind: "current" as const,
  binding: {
    workspaceId: WS,
    recordId: RECORD,
    repo: "ada/widgets",
    prNumber: 98,
    headSha: HEAD,
    headCycleId: CYCLE,
    authorityGeneration: 1,
    acceptanceContract: { id: CONTRACT, version: 1, sha256: "a".repeat(64) },
  },
  observations: [{
    binding: dependencyBinding,
    observation: dependencyObservation,
    approval: null,
    externalBuilderPack: null,
  }],
};

function req(workspaceId = WS, recordId = RECORD): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${workspaceId}/change-records/${recordId}`,
    { method: "GET" }
  );
}

function patchReq(
  body: unknown,
  options: { contentType?: string; contentLength?: string } = {},
): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WS}/change-records/${RECORD}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": options.contentType ?? "application/json",
        ...(options.contentLength ? { "Content-Length": options.contentLength } : {}),
      },
      body: JSON.stringify(body),
    },
  );
}

function params(workspaceId = WS, recordId = RECORD) {
  return Promise.resolve({ workspaceId, recordId });
}

const timeline = {
  record: {
    id: RECORD,
    workspaceId: WS,
    repo: "ada/widgets",
    issueNumber: 42,
    prNumber: 98,
    headShas: [PRIOR_HEAD, HEAD],
    currentPrHeadSha: HEAD,
    currentPrHeadCycleId: CYCLE,
    currentPrHeadAuthoritative: true,
    currentPrHeadAuthorityGeneration: 1,
    mergedSha: null,
    state: "open",
    createdAt: CREATED,
    updatedAt: UPDATED,
  },
  events: [
    {
      id: "event-1",
      recordId: RECORD,
      eventKey: "issue:intake:42",
      stage: "requirement",
      at: CREATED,
      actor: "jace",
      payloadRef: { kind: "issue_snapshot", issueNumber: 42 },
      createdAt: CREATED,
    },
    {
      id: "event-2",
      recordId: RECORD,
      eventKey: "review:posted:deadbeef",
      stage: "review",
      at: REVIEW_AT,
      actor: "reviewer-of-record",
      payloadRef: { kind: "review_job", jobId: "job-1" },
      createdAt: REVIEW_AT,
    },
  ],
};

const currentAcceptanceDetail = {
  kind: "record" as const,
  detail: {
    summary: {
      recordId: RECORD,
      workspaceId: WS,
      repo: "ada/widgets",
      issueNumber: 42,
      createdAt: CREATED,
      updatedAt: UPDATED,
      requestedWork: {
        kind: "confirmed" as const,
        originalRequest: "Make the saved page visible.",
        acceptanceContract: { id: CONTRACT, version: 1, sha256: "a".repeat(64) },
      },
      suppliedContext: { kind: "unknown" as const },
      pullRequest: {
        kind: "attached" as const,
        prNumber: 98,
        head: { kind: "current" as const, sha: HEAD, headCycleId: CYCLE, authorityGeneration: 1 },
      },
      proof: { kind: "unknown" as const },
      unknownReasons: ["context_not_recorded", "proof_not_recorded"] as const,
      neededDecision: { kind: "unknown" as const },
      outcome: { kind: "not_recorded" as const },
    },
    contract: {
      identity: { id: CONTRACT, version: 1, sha256: "a".repeat(64) },
      confirmedBy: `user:${USER}`,
      confirmedAt: CREATED,
      contract: {
        originalRequest: "Make the saved page visible.",
        normalizedRequirements: ["The saved page is visible."],
        acceptanceCriteria: [{
          id: "criterion-1",
          text: "The saved page is visible.",
          userVisible: true,
          modality: "ui" as const,
        }],
        nonGoals: [], risks: [], stops: [],
        environment: { preview: true },
        unresolvedQuestions: [],
      },
    },
    pullRequest: {
      kind: "attached" as const,
      prNumber: 98,
      current: {
        kind: "current" as const,
        repo: "ada/widgets",
        prNumber: 98,
        headSha: HEAD,
        headCycleId: CYCLE,
        authorityGeneration: 1,
        reviewJob: { kind: "not_recorded" as const },
      },
      merged: null,
      occurrences: [{
        kind: "current" as const,
        repo: "ada/widgets",
        prNumber: 98,
        headSha: HEAD,
        headCycleId: CYCLE,
        authorityGeneration: 1,
        reviewJob: { kind: "not_recorded" as const },
      }],
    },
    contextPacks: [],
    proofMatrix: [{
      occurrence: { kind: "current" as const, repo: "ada/widgets", prNumber: 98, headSha: HEAD, headCycleId: CYCLE },
      review: { kind: "not_recorded" as const },
      criteria: [{
        criterion: { id: "criterion-1", text: "The saved page is visible.", userVisible: true, modality: "ui" as const },
        proof: { kind: "unknown" as const, reason: "review_not_recorded" as const },
      }],
    }],
    artifactCustody: { kind: "unknown" as const, reason: "artifact_custody_not_available" as const },
    gatedIssue: { kind: "unknown" as const, reason: "gated_issue_custody_not_available" as const },
  },
};

const postedCriterionDetail = {
  ...currentAcceptanceDetail,
  detail: {
    ...currentAcceptanceDetail.detail,
    pullRequest: {
      ...currentAcceptanceDetail.detail.pullRequest,
      current: {
        ...currentAcceptanceDetail.detail.pullRequest.current,
        reviewJob: {
          kind: "recorded" as const,
          id: CYCLE,
          state: "posted" as const,
          createdAt: CREATED,
          updatedAt: UPDATED,
        },
      },
      occurrences: [{
        ...currentAcceptanceDetail.detail.pullRequest.occurrences[0],
        reviewJob: {
          kind: "recorded" as const,
          id: CYCLE,
          state: "posted" as const,
          createdAt: CREATED,
          updatedAt: UPDATED,
        },
      }],
    },
    proofMatrix: [{
      ...currentAcceptanceDetail.detail.proofMatrix[0],
      review: {
        kind: "posted" as const,
        reviewJobId: CYCLE,
        verdict: "failed" as const,
        postedReviewUrl: "https://github.com/ada/widgets/pull/98#pullrequestreview-1",
        postedAttestationEventId: "00000000-0000-4000-8000-000000000077",
        reviewedAt: UPDATED,
      },
    }],
  },
};

const currentCriterionBundle = {
  kind: "current" as const,
  bundle: {
    binding: {
      workspaceId: WS,
      recordId: RECORD,
      repo: "ada/widgets",
      prNumber: 98,
      headSha: HEAD,
      headCycleId: CYCLE,
      reviewJobId: CYCLE,
      acceptanceContract: { id: CONTRACT, version: 1, sha256: "a".repeat(64) },
      postedAttestationEventId: "00000000-0000-4000-8000-000000000077",
      reviewVerdict: "failed" as const,
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1", role: "member" } as never);
  vi.mocked(readChangeRecordTimeline).mockResolvedValue(timeline as never);
  vi.mocked(readCurrentAcceptanceCorrectionPackets).mockResolvedValue(currentCorrectionPackets as never);
  vi.mocked(readCurrentAcceptancePrDecision).mockResolvedValue(currentFinalDecision as never);
  vi.mocked(readAcceptancePrReviewMetrics).mockResolvedValue(currentReviewMetrics as never);
  vi.mocked(readCurrentAcceptanceDependencyObservations).mockResolvedValue(
    currentDependencyObservations as never,
  );
  vi.mocked(readAcceptanceRecordDetail).mockResolvedValue(currentAcceptanceDetail as never);
  vi.mocked(readDependencyDraftProposalDetail).mockResolvedValue({ kind: "not_draft_proposal" } as never);
  vi.mocked(readCurrentAcceptanceCriterionOutcomeBundle).mockResolvedValue({
    kind: "not_ready",
    reason: "criterion_outcome_bundle_not_recorded",
  } as never);
  vi.mocked(recordAcceptancePrDecision).mockResolvedValue({
    kind: "recorded",
    binding: currentFinalDecision.binding,
    decision: {
      eventId: DECISION_EVENT_ID,
      eventKey: `acceptance-pr-decision:${CYCLE}`,
      decision: "changes_requested",
      rationale: "The failed criterion must be repaired.",
      decidedBy: `user:${USER}`,
      decidedRole: "owner",
      decidedAt: DECIDED_AT,
    },
  } as never);
  vi.mocked(recordAcceptancePrReviewEffort).mockResolvedValue({
    kind: "recorded",
    binding: currentFinalDecision.binding,
    effort: {
      eventId: EFFORT_EVENT_ID,
      eventKey: `acceptance-pr-review-effort:${CYCLE}`,
      minutes: 37,
      source: "human_input",
      recordedBy: `user:${USER}`,
      recordedRole: "owner",
      recordedAt: EFFORT_AT,
    },
  } as never);
  vi.mocked(approveAcceptanceDependencyObservationAndMintExternalBuilderPack).mockResolvedValue({
    kind: "approved",
    binding: dependencyBinding,
    observation: dependencyObservation,
    approval: dependencyApproval,
    externalBuilderPack,
  } as never);
  vi.mocked(recordAcceptanceContextPackRegenerationRequest).mockResolvedValue({
    kind: "recorded",
    request: {
      eventId: REGENERATION_REQUEST_EVENT_ID,
      eventKey: `context-pack-regeneration:${COMPILED_PACK_ID}:${REGENERATION_REQUEST_INTENT_ID}`,
      executionId: REGENERATION_EXECUTION_ID,
      workspaceId: WS,
      recordId: RECORD,
      sourceSnapshotId: "00000000-0000-4000-8000-000000000047",
      compiledPackId: COMPILED_PACK_ID,
      repo: "ada/widgets",
      prNumber: 98,
      headSha: HEAD,
      headCycleId: CYCLE,
      authorityGeneration: 1,
      acceptanceContract: { id: CONTRACT, version: 1, sha256: "a".repeat(64) },
      reason: "stale",
      requestIntentId: REGENERATION_REQUEST_INTENT_ID,
      requestedBy: `user:${USER}`,
      requestedRole: "owner",
      requestedAt: EFFORT_AT,
      authority: "request_only",
      status: "request_recorded",
    },
    execution: {
      id: REGENERATION_EXECUTION_ID,
      requestEventId: REGENERATION_REQUEST_EVENT_ID,
      parentExecutionId: null,
      workspaceId: WS,
      recordId: RECORD,
      priorCompiledPackId: COMPILED_PACK_ID,
      headSha: HEAD,
      headCycleId: CYCLE,
      status: "queued",
      attemptCount: 0,
      maxAttempts: 1,
      replacementCompiledPackId: null,
      outcomeReason: null,
      completedAt: null,
      createdAt: EFFORT_AT,
      updatedAt: EFFORT_AT,
      humanRetryable: false,
    },
  } as never);
  vi.mocked(listAcceptanceContextPackRegenerationExecutions).mockResolvedValue([] as never);
  vi.mocked(retryAcceptanceContextPackRegenerationExecution).mockResolvedValue({
    kind: "retried",
    execution: {
      id: "00000000-0000-4000-8000-000000000051",
      requestEventId: "00000000-0000-4000-8000-000000000052",
      parentExecutionId: REGENERATION_EXECUTION_ID,
      workspaceId: WS,
      recordId: RECORD,
      priorCompiledPackId: COMPILED_PACK_ID,
      headSha: HEAD,
      headCycleId: CYCLE,
      status: "queued",
      attemptCount: 0,
      maxAttempts: 1,
      replacementCompiledPackId: null,
      outcomeReason: null,
      completedAt: null,
      createdAt: EFFORT_AT,
      updatedAt: EFFORT_AT,
      humanRetryable: false,
    },
  } as never);
});

describe("GET /api/v1/workspaces/[workspaceId]/change-records/[recordId]", () => {
  it("401 when not authenticated, before any workspace or record lookup", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const res = await GET(req(), { params: params() });

    expect(res.status).toBe(401);
    expect(getWorkspaceMembership).not.toHaveBeenCalled();
    expect(readChangeRecordTimeline).not.toHaveBeenCalled();
    expect(readCurrentAcceptanceCorrectionPackets).not.toHaveBeenCalled();
    expect(readCurrentAcceptancePrDecision).not.toHaveBeenCalled();
    expect(readAcceptancePrReviewMetrics).not.toHaveBeenCalled();
    expect(readCurrentAcceptanceDependencyObservations).not.toHaveBeenCalled();
    expect(readAcceptanceRecordDetail).not.toHaveBeenCalled();
    expect(readDependencyDraftProposalDetail).not.toHaveBeenCalled();
    expect(readCurrentAcceptanceCriterionOutcomeBundle).not.toHaveBeenCalled();
  });

  it("403 when the user is not a workspace member, before reading the timeline", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);

    const res = await GET(req(), { params: params() });

    expect(res.status).toBe(403);
    expect(getWorkspaceMembership).toHaveBeenCalledWith(USER, WS);
    expect(readChangeRecordTimeline).not.toHaveBeenCalled();
    expect(readCurrentAcceptanceCorrectionPackets).not.toHaveBeenCalled();
    expect(readCurrentAcceptancePrDecision).not.toHaveBeenCalled();
    expect(readAcceptancePrReviewMetrics).not.toHaveBeenCalled();
    expect(readCurrentAcceptanceDependencyObservations).not.toHaveBeenCalled();
    expect(readAcceptanceRecordDetail).not.toHaveBeenCalled();
    expect(readDependencyDraftProposalDetail).not.toHaveBeenCalled();
    expect(readCurrentAcceptanceCriterionOutcomeBundle).not.toHaveBeenCalled();
  });

  it("404 when no change record exists in the caller workspace", async () => {
    vi.mocked(readChangeRecordTimeline).mockResolvedValue(null as never);

    const res = await GET(req(), { params: params() });

    expect(res.status).toBe(404);
    expect(readChangeRecordTimeline).toHaveBeenCalledWith({
      workspaceId: WS,
      recordId: RECORD,
    });
    expect(readCurrentAcceptanceCorrectionPackets).not.toHaveBeenCalled();
    expect(readCurrentAcceptancePrDecision).not.toHaveBeenCalled();
    expect(readAcceptancePrReviewMetrics).not.toHaveBeenCalled();
    expect(readCurrentAcceptanceDependencyObservations).not.toHaveBeenCalled();
    expect(readAcceptanceRecordDetail).not.toHaveBeenCalled();
    expect(readDependencyDraftProposalDetail).not.toHaveBeenCalled();
  });

  it("keeps cross-tenant isolation by passing the path workspace to the scoped query", async () => {
    vi.mocked(readChangeRecordTimeline).mockResolvedValue(null as never);

    const res = await GET(req(OTHER_WS, RECORD), {
      params: params(OTHER_WS, RECORD),
    });

    expect(res.status).toBe(404);
    expect(getWorkspaceMembership).toHaveBeenCalledWith(USER, OTHER_WS);
    expect(readChangeRecordTimeline).toHaveBeenCalledWith({
      workspaceId: OTHER_WS,
      recordId: RECORD,
    });
    expect(readCurrentAcceptanceCorrectionPackets).not.toHaveBeenCalled();
    expect(readCurrentAcceptancePrDecision).not.toHaveBeenCalled();
  });

  it("200 with deterministic record and ordered timeline event shape", async () => {
    const res = await GET(req(), { params: params() });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      record: {
        id: RECORD,
        workspaceId: WS,
        repo: "ada/widgets",
        issueNumber: 42,
        prNumber: 98,
        headShas: [PRIOR_HEAD, HEAD],
        currentPrHeadSha: HEAD,
        currentPrHeadCycleId: CYCLE,
        currentPrHeadAuthoritative: true,
        mergedSha: null,
        state: "open",
        createdAt: "2026-08-03T12:00:00.000Z",
        updatedAt: "2026-08-03T12:05:00.000Z",
      },
      events: [
        {
          id: "event-1",
          recordId: RECORD,
          eventKey: "issue:intake:42",
          stage: "requirement",
          actor: "jace",
          payloadRef: { kind: "issue_snapshot", issueNumber: 42 },
          at: "2026-08-03T12:00:00.000Z",
          createdAt: "2026-08-03T12:00:00.000Z",
        },
        {
          id: "event-2",
          recordId: RECORD,
          eventKey: "review:posted:deadbeef",
          stage: "review",
          actor: "reviewer-of-record",
          payloadRef: { kind: "review_job", jobId: "job-1" },
          at: "2026-08-03T12:04:00.000Z",
          createdAt: "2026-08-03T12:04:00.000Z",
        },
      ],
      correctionPackets: currentCorrectionPackets,
      finalDecision: currentFinalDecision,
      reviewMetrics: {
        ...currentReviewMetrics,
        cycles: [{
          ...currentReviewMetrics.cycles[0],
          reviewedAt: REVIEW_AT.toISOString(),
        }],
      },
      dependencyObservations: {
        ...currentDependencyObservations,
        observations: [{
          ...currentDependencyObservations.observations[0],
          observation: {
            ...dependencyObservation,
            observedAt: DEPENDENCY_OBSERVED_AT.toISOString(),
          },
        }],
      },
      acceptanceDetail: JSON.parse(JSON.stringify(currentAcceptanceDetail)),
      dependencyDraftProposal: { kind: "not_draft_proposal" },
      criterionOutcomes: {
        kind: "not_ready",
        reason: "criterion_outcome_bundle_not_recorded",
      },
      contextPackRegenerationRequests: [],
      contextPackRegenerationExecutions: [],
      canRecordFinalDecision: false,
      canRecordReviewEffort: false,
      canApproveDependencyObservation: false,
      canRequestContextPackRegeneration: false,
      canCreateGatedGithubIssue: false,
    });
    expect(readCurrentAcceptanceCorrectionPackets).toHaveBeenCalledWith({
      workspaceId: WS,
      recordId: RECORD,
    });
    expect(readCurrentAcceptancePrDecision).toHaveBeenCalledWith({
      workspaceId: WS,
      recordId: RECORD,
    });
    expect(readAcceptancePrReviewMetrics).toHaveBeenCalledWith({
      workspaceId: WS,
      recordId: RECORD,
    });
    expect(readCurrentAcceptanceDependencyObservations).toHaveBeenCalledWith({
      workspaceId: WS,
      recordId: RECORD,
    });
    expect(readAcceptanceRecordDetail).toHaveBeenCalledWith({
      workspaceId: WS,
      recordId: RECORD,
    });
    expect(listAcceptanceContextPackRegenerationExecutions).toHaveBeenCalledWith({
      workspaceId: WS,
      recordId: RECORD,
    });
    expect(readDependencyDraftProposalDetail).toHaveBeenCalledWith({
      workspaceId: WS,
      recordId: RECORD,
    });
    expect(readCurrentAcceptanceCriterionOutcomeBundle).toHaveBeenCalledWith({
      workspaceId: WS,
      recordId: RECORD,
    });
  });

  it("returns bounded tenant-scoped Context Pack regeneration execution readback", async () => {
    const executionId = "00000000-0000-4000-8000-000000000046";
    vi.mocked(listAcceptanceContextPackRegenerationExecutions).mockResolvedValue([{
      id: executionId,
      requestEventId: REGENERATION_REQUEST_EVENT_ID,
      parentExecutionId: null,
      workspaceId: WS,
      recordId: RECORD,
      priorCompiledPackId: COMPILED_PACK_ID,
      headSha: HEAD,
      headCycleId: CYCLE,
      status: "held",
      attemptCount: 1,
      maxAttempts: 1,
      replacementCompiledPackId: null,
      outcomeReason: "execution_ambiguous",
      completedAt: UPDATED,
      createdAt: CREATED,
      updatedAt: UPDATED,
      humanRetryable: false,
    }] as never);
    const response = await GET(req(), { params: params() });
    const body = await response.json();
    expect(body.contextPackRegenerationExecutions).toEqual([expect.objectContaining({
      id: executionId,
      workspaceId: WS,
      recordId: RECORD,
      status: "held",
      outcomeReason: "execution_ambiguous",
      completedAt: UPDATED.toISOString(),
    })]);
    expect(JSON.stringify(body.contextPackRegenerationExecutions)).not.toMatch(/lease|token|sourceSnapshot|acceptanceContract/iu);
  });

  it("redacts dependency proposal commands from the raw audit timeline", async () => {
    vi.mocked(readChangeRecordTimeline).mockResolvedValue({
      ...timeline,
      events: [{
        id: "event-dependency-proposal",
        recordId: RECORD,
        eventKey: `dependency-observation-proposal:draft:sha256:${"d".repeat(64)}`,
        stage: "dependency_observation_proposal",
        actor: "server:dependency-observation-proposal",
        payloadRef: {
          kind: "dependency_observation_proposal_draft",
          candidate: {
            manager_commands: { update: "pnpm update secret-package" },
            verification_commands: ["pnpm test"],
          },
        },
        at: CREATED,
        createdAt: CREATED,
      }],
    } as never);

    const res = await GET(req(), { params: params() });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.events[0].payloadRef).toEqual({
      kind: "redacted_dependency_observation_proposal",
      version: 1,
      disclosure: "bounded_projection_only",
    });
    expect(JSON.stringify(body)).not.toContain("manager_commands");
    expect(JSON.stringify(body)).not.toContain("verification_commands");
    expect(JSON.stringify(body)).not.toContain("pnpm update secret-package");
  });

  it("fails criterion and correction projections closed and withholds secret-shaped timeline text", async () => {
    const secretText = "authorization: Bearer abcdefghijklmnopqrstuvwxyz";
    vi.mocked(readChangeRecordTimeline).mockResolvedValue({
      ...timeline,
      events: [{
        ...timeline.events[0],
        eventKey: `review:criterion-outcomes:${CYCLE}`,
        stage: "review",
        payloadRef: {
          kind: "acceptance_criterion_outcome_bundle",
          outcomes: [{ observed: secretText }],
        },
      }],
    } as never);
    vi.mocked(readCurrentAcceptanceCriterionOutcomeBundle).mockResolvedValue({
      ...currentCriterionBundle,
      bundle: {
        ...currentCriterionBundle.bundle,
        outcomes: [{ observed: "token=abcdefghijk12345" }],
      },
    } as never);
    vi.mocked(readCurrentAcceptanceCorrectionPackets).mockResolvedValue({
      ...currentCorrectionPackets,
      packets: [{
        ...currentCorrectionPackets.packets[0],
        requiredCorrection: "Remove api_key=abcdefghijk12345 before retrying.",
      }],
    } as never);
    const unsafeDetail = structuredClone(postedCriterionDetail);
    unsafeDetail.detail.proofMatrix[0]!.criteria[0]!.proof = {
      kind: "correction_packet",
      packet: {
        ...structuredClone(currentCorrectionPackets.packets[0]),
        impact: "token=abcdefghijk12345",
      },
    } as never;
    vi.mocked(readAcceptanceRecordDetail).mockResolvedValue(unsafeDetail as never);

    const res = await GET(req(), { params: params() });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.events[0].payloadRef).toEqual({
      kind: "redacted_criterion_custody_payload",
      version: 1,
      disclosure: "secret_shaped_text_withheld",
    });
    expect(body.correctionPackets).toEqual({
      kind: "not_ready",
      reason: "invalid_packet_custody",
    });
    expect(body.acceptanceDetail).toEqual({
      kind: "unavailable",
      reason: "invalid_review_custody",
    });
    expect(body.criterionOutcomes).toEqual({
      kind: "not_ready",
      reason: "invalid_criterion_outcome_custody",
    });
    expect(JSON.stringify(body)).not.toContain(secretText);
    expect(JSON.stringify(body)).not.toContain("abcdefghijk12345");
  });

  it("fails an unattached Record detail with secret-shaped Contract text closed", async () => {
    const secretText = "api_key=abcdefghijk12345";
    vi.mocked(readChangeRecordTimeline).mockResolvedValue({
      ...timeline,
      record: {
        ...timeline.record,
        prNumber: null,
        headShas: [],
        currentPrHeadSha: null,
        currentPrHeadCycleId: null,
        currentPrHeadAuthoritative: false,
        currentPrHeadAuthorityGeneration: 0,
      },
      events: [timeline.events[0]],
    } as never);
    const unattachedDetail = structuredClone(currentAcceptanceDetail);
    unattachedDetail.detail.summary.requestedWork.originalRequest = secretText;
    unattachedDetail.detail.summary.pullRequest = { kind: "not_attached" } as never;
    unattachedDetail.detail.summary.neededDecision = {
      kind: "not_required",
      reason: "pr_not_attached",
    } as never;
    unattachedDetail.detail.contract.contract.originalRequest = secretText;
    unattachedDetail.detail.pullRequest = { kind: "not_attached", occurrences: [] } as never;
    unattachedDetail.detail.proofMatrix = [];
    vi.mocked(readAcceptanceRecordDetail).mockResolvedValue(unattachedDetail as never);

    const response = await GET(req(), { params: params() });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.acceptanceDetail).toEqual({
      kind: "unavailable",
      reason: "invalid_review_custody",
    });
    expect(JSON.stringify(body)).not.toContain(secretText);
  });

  it("redacts every private storage coordinate from the member-facing Record projection", async () => {
    const privateKey = "review-evidence/private/exact.png";
    vi.mocked(readChangeRecordTimeline).mockResolvedValue({
      ...timeline,
      events: [{
        ...timeline.events[0],
        payloadRef: {
          kind: "review_result",
          artifactKey: privateKey,
          evidenceKey: privateKey,
          evidenceKeys: [privateKey],
          bootLogKey: "review-evidence/private/boot.log",
          nested: { artifactKey: privateKey },
          evidenceRef: "criterion:criterion-1:ui-result",
        },
      }],
    } as never);
    vi.mocked(readCurrentAcceptanceCorrectionPackets).mockResolvedValue({
      ...currentCorrectionPackets,
      packets: [{
        ...currentCorrectionPackets.packets[0],
        evidence: {
          ...currentCorrectionPackets.packets[0]!.evidence,
          artifactKey: privateKey,
        },
      }],
    } as never);
    vi.mocked(readAcceptanceRecordDetail).mockResolvedValue({
      ...currentAcceptanceDetail,
      detail: {
        ...currentAcceptanceDetail.detail,
        artifactCustody: {
          ...currentAcceptanceDetail.detail.artifactCustody,
          bootLogKey: "review-evidence/private/boot.log",
        },
      },
    } as never);

    const response = await GET(req(), { params: params() });
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    for (const privateField of ["artifactKey", "evidenceKey", "evidenceKeys", "bootLogKey"]) {
      expect(serialized).not.toContain(privateField);
    }
    expect(serialized).not.toContain("review-evidence/");
    expect(serialized).toContain("criterion:criterion-1:ui-result");
    expect(body.correctionPackets.correctionPacketPayloadSetSha256).toBe(
      currentCorrectionPackets.correctionPacketPayloadSetSha256,
    );
  });

  it("keeps owner/admin human-evidence capabilities separate from Jace-approved issue publication", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1", role: "admin" } as never);

    const res = await GET(req(), { params: params() });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.canRecordFinalDecision).toBe(true);
    expect(body.canRecordReviewEffort).toBe(true);
    expect(body.canApproveDependencyObservation).toBe(true);
    expect(body.canRequestContextPackRegeneration).toBe(true);
    expect(body.canCreateGatedGithubIssue).toBe(false);
  });

  it("projects only the current actor's exact current request-only Context Pack receipt", async () => {
    const sourceSnapshotId = "00000000-0000-4000-8000-000000000047";
    const eventKey = `context-pack-regeneration:${COMPILED_PACK_ID}:${REGENERATION_REQUEST_INTENT_ID}`;
    vi.mocked(readChangeRecordTimeline).mockResolvedValue({
      ...timeline,
      events: [...timeline.events, {
        id: REGENERATION_REQUEST_EVENT_ID,
        recordId: RECORD,
        eventKey,
        stage: "human_context_request",
        at: EFFORT_AT,
        actor: `user:${USER}`,
        payloadRef: {
          kind: "acceptance_context_pack_regeneration_request",
          version: 3,
          workspaceId: WS,
          recordId: RECORD,
          sourceSnapshotId,
          compiledPackId: COMPILED_PACK_ID,
          executionId: REGENERATION_EXECUTION_ID,
          repo: "ada/widgets",
          prNumber: 98,
          headSha: HEAD,
          headCycleId: CYCLE,
          authorityGeneration: 1,
          acceptanceContract: { id: CONTRACT, version: 1, sha256: "a".repeat(64) },
          reason: "stale",
          requestIntentId: REGENERATION_REQUEST_INTENT_ID,
          requestedBy: `user:${USER}`,
          requestedRole: "owner",
          authority: "request_only",
          status: "request_recorded",
        },
        createdAt: EFFORT_AT,
      }, {
        id: RECORD,
        recordId: RECORD,
        eventKey: `context-pack-regeneration:${COMPILED_PACK_ID}:00000000-0000-4000-8000-000000000052`,
        stage: "human_context_request",
        at: EFFORT_AT,
        actor: "user:00000000-0000-4000-8000-000000000778",
        payloadRef: {
          kind: "acceptance_context_pack_regeneration_request",
          version: 3,
          workspaceId: WS,
          recordId: RECORD,
          sourceSnapshotId,
          compiledPackId: COMPILED_PACK_ID,
          executionId: REGENERATION_EXECUTION_ID,
          repo: "ada/widgets",
          prNumber: 98,
          headSha: HEAD,
          headCycleId: CYCLE,
          authorityGeneration: 1,
          acceptanceContract: { id: CONTRACT, version: 1, sha256: "a".repeat(64) },
          reason: "inadequate",
          requestIntentId: "00000000-0000-4000-8000-000000000052",
          requestedBy: "user:00000000-0000-4000-8000-000000000778",
          requestedRole: "admin",
          authority: "request_only",
          status: "request_recorded",
        },
        createdAt: EFFORT_AT,
      }],
    } as never);
    vi.mocked(readAcceptanceRecordDetail).mockResolvedValue({
      ...currentAcceptanceDetail,
      detail: {
        ...currentAcceptanceDetail.detail,
        contextPacks: [{
          occurrence: {
            kind: "current",
            repo: "ada/widgets",
            prNumber: 98,
            headSha: HEAD,
            headCycleId: CYCLE,
          },
          sourceSnapshot: { id: sourceSnapshotId },
          compiledPacks: [{ id: COMPILED_PACK_ID }],
        }],
      },
    } as never);

    const response = await GET(req(), { params: params() });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.contextPackRegenerationRequests).toEqual([{
      eventId: REGENERATION_REQUEST_EVENT_ID,
      eventKey,
      sourceSnapshotId,
      compiledPackId: COMPILED_PACK_ID,
      executionId: REGENERATION_EXECUTION_ID,
      headSha: HEAD,
      headCycleId: CYCLE,
      acceptanceContract: { id: CONTRACT, version: 1, sha256: "a".repeat(64) },
      reason: "stale",
      requestIntentId: REGENERATION_REQUEST_INTENT_ID,
      requestedBy: `user:${USER}`,
      requestedRole: "owner",
      requestedAt: EFFORT_AT.toISOString(),
      authority: "request_only",
      status: "request_recorded",
    }]);
  });

  it("returns only the bounded draft dependency projection", async () => {
    vi.mocked(readDependencyDraftProposalDetail).mockResolvedValue({
      kind: "draft",
      record: { id: RECORD, repo: "ada/widgets", contractId: CONTRACT, contractVersion: 1 },
      proposal: {
        custodyIdentity: `sha256:${"a".repeat(64)}`,
        watch: { id: CYCLE, observationId: DECISION_BINDING_ID, observationKey: "candidate:bounded" },
        candidate: { package: "react", currentVersion: "18.2.0", targetVersion: "18.3.0", dependencyKind: "dependencies" },
        files: {
          manifest: { path: "package.json", sha256: "b".repeat(64) },
          lockfile: { path: "pnpm-lock.yaml", sha256: "c".repeat(64) },
        },
        profile: { ecosystem: "node", manager: "pnpm", profile: "pnpm_lockfile_only_v1", capability: "proposal_observation_only" },
        repositorySourceVerification: "watch_observation_only",
        independentSourceProof: "not_proven",
        evidenceAdmission: "unresolved",
        laterEvidence: {
          confirmation: "not_recorded", contextPack: "not_recorded", builderHandoff: "not_recorded",
          delivery: "not_recorded", result: "not_recorded",
        },
      },
    } as never);

    const response = await GET(req(), { params: params() });
    const proposal = (await response.json()).dependencyDraftProposal;

    expect(response.status).toBe(200);
    expect(proposal.proposal).toMatchObject({
      candidate: { package: "react", targetVersion: "18.3.0" },
      evidenceAdmission: "unresolved",
      laterEvidence: { delivery: "not_recorded", result: "not_recorded" },
    });
    expect(JSON.stringify(proposal)).not.toContain("manager_commands");
    expect(JSON.stringify(proposal)).not.toContain("verification_commands");
  });

  it("downgrades a current packet set when the separately read Record head cycle changed", async () => {
    const nextHead = "e".repeat(40);
    const nextCycle = "00000000-0000-4000-8000-000000000100";
    const nextPacketId = `correction-${"e".repeat(48)}`;
    vi.mocked(readCurrentAcceptanceCorrectionPackets).mockResolvedValue({
      ...currentCorrectionPackets,
      binding: {
        ...currentCorrectionPackets.binding,
        reviewJobId: nextCycle,
        headSha: nextHead,
        headCycleId: nextCycle,
        authorityGeneration: 2,
      },
      packetIds: [nextPacketId],
      packets: [{
        ...currentCorrectionPackets.packets[0],
        packetId: nextPacketId,
        headSha: nextHead,
        jobId: nextCycle,
        requiredCorrection: "Remove token=abcdefghijk12345 before retrying.",
      }],
    } as never);

    const res = await GET(req(), { params: params() });

    expect(res.status).toBe(200);
    expect((await res.json()).correctionPackets).toEqual({ kind: "not_current" });
  });

  it("downgrades a separately read current final decision on an exact-head generation race", async () => {
    vi.mocked(readCurrentAcceptancePrDecision).mockResolvedValue({
      ...currentFinalDecision,
      binding: {
        ...currentFinalDecision.binding,
        headSha: "e".repeat(40),
        headCycleId: "00000000-0000-4000-8000-000000000100",
        reviewJobId: "00000000-0000-4000-8000-000000000100",
        authorityGeneration: 2,
      },
    } as never);

    const res = await GET(req(), { params: params() });

    expect(res.status).toBe(200);
    expect((await res.json()).finalDecision).toEqual({ kind: "not_current" });
  });

  it("downgrades review metrics when their current cycle races the separately read Record head", async () => {
    vi.mocked(readAcceptancePrReviewMetrics).mockResolvedValue({
      ...currentReviewMetrics,
      currentCycle: {
        headSha: "e".repeat(40),
        headCycleId: "00000000-0000-4000-8000-000000000100",
        authorityGeneration: 2,
      },
    } as never);

    const res = await GET(req(), { params: params() });

    expect(res.status).toBe(200);
    expect((await res.json()).reviewMetrics).toEqual({
      kind: "unavailable",
      reason: "invalid_review_custody",
    });
  });

  it("downgrades dependency observations when their separately read current generation races the Record", async () => {
    vi.mocked(readCurrentAcceptanceDependencyObservations).mockResolvedValue({
      ...currentDependencyObservations,
      binding: {
        ...currentDependencyObservations.binding,
        headSha: "e".repeat(40),
        headCycleId: "00000000-0000-4000-8000-000000000100",
        authorityGeneration: 2,
      },
    } as never);

    const response = await GET(req(), { params: params() });

    expect(response.status).toBe(200);
    expect((await response.json()).dependencyObservations).toEqual({ kind: "not_current" });
  });

  it("downgrades strict Acceptance detail when its current head occurrence races the timeline", async () => {
    vi.mocked(readAcceptanceRecordDetail).mockResolvedValue({
      ...currentAcceptanceDetail,
      detail: {
        ...currentAcceptanceDetail.detail,
        summary: {
          ...currentAcceptanceDetail.detail.summary,
          requestedWork: {
            ...currentAcceptanceDetail.detail.summary.requestedWork,
            originalRequest: "token=abcdefghijk12345",
          },
        },
        contract: {
          ...currentAcceptanceDetail.detail.contract,
          contract: {
            ...currentAcceptanceDetail.detail.contract.contract,
            originalRequest: "token=abcdefghijk12345",
          },
        },
        pullRequest: {
          ...currentAcceptanceDetail.detail.pullRequest,
          current: {
            ...currentAcceptanceDetail.detail.pullRequest.current,
            headSha: "e".repeat(40),
          },
          occurrences: [{
            ...currentAcceptanceDetail.detail.pullRequest.occurrences[0],
            headSha: "e".repeat(40),
          }],
        },
      },
    } as never);

    const response = await GET(req(), { params: params() });

    expect(response.status).toBe(200);
    expect((await response.json()).acceptanceDetail).toEqual({
      kind: "unavailable",
      reason: "invalid_record_custody",
    });
  });

  it("downgrades a separately read criterion bundle when its exact head cycle races the timeline", async () => {
    vi.mocked(readCurrentAcceptanceCriterionOutcomeBundle).mockResolvedValue({
      kind: "current",
      bundle: {
        binding: {
          workspaceId: WS,
          recordId: RECORD,
          repo: "ada/widgets",
          prNumber: 98,
          headSha: "e".repeat(40),
          headCycleId: "00000000-0000-4000-8000-000000000100",
        },
        outcomes: [{ observed: "api_key=abcdefghijk12345" }],
      },
    } as never);

    const response = await GET(req(), { params: params() });

    expect(response.status).toBe(200);
    expect((await response.json()).criterionOutcomes).toEqual({ kind: "not_current" });
  });

  it("keeps a criterion bundle only when the strict detail has the same posted receipt", async () => {
    vi.mocked(readAcceptanceRecordDetail).mockResolvedValue(postedCriterionDetail as never);
    vi.mocked(readCurrentAcceptanceCriterionOutcomeBundle).mockResolvedValue(
      currentCriterionBundle as never,
    );

    const response = await GET(req(), { params: params() });

    expect(response.status).toBe(200);
    expect((await response.json()).criterionOutcomes).toEqual(currentCriterionBundle);
  });

  it("downgrades a criterion bundle when detail has not durably reached posted state", async () => {
    vi.mocked(readAcceptanceRecordDetail).mockResolvedValue({
      ...postedCriterionDetail,
      detail: {
        ...postedCriterionDetail.detail,
        pullRequest: {
          ...postedCriterionDetail.detail.pullRequest,
          current: {
            ...postedCriterionDetail.detail.pullRequest.current,
            reviewJob: {
              ...postedCriterionDetail.detail.pullRequest.current.reviewJob,
              state: "running",
            },
          },
        },
      },
    } as never);
    vi.mocked(readCurrentAcceptanceCriterionOutcomeBundle).mockResolvedValue(
      currentCriterionBundle as never,
    );

    const response = await GET(req(), { params: params() });

    expect(response.status).toBe(200);
    expect((await response.json()).criterionOutcomes).toEqual({ kind: "not_current" });
  });

  it("does not combine a non-authoritative timeline with a current detail occurrence", async () => {
    vi.mocked(readChangeRecordTimeline).mockResolvedValue({
      ...timeline,
      record: { ...timeline.record, currentPrHeadAuthoritative: false },
    } as never);

    const response = await GET(req(), { params: params() });

    expect((await response.json()).acceptanceDetail).toEqual({
      kind: "unavailable",
      reason: "invalid_record_custody",
    });
  });

  it("passes closed detail unavailability through without exposing internals", async () => {
    vi.mocked(readAcceptanceRecordDetail).mockResolvedValue({
      kind: "unavailable",
      reason: "invalid_context_custody",
    });

    const response = await GET(req(), { params: params() });

    expect(response.status).toBe(200);
    expect((await response.json()).acceptanceDetail).toEqual({
      kind: "unavailable",
      reason: "invalid_context_custody",
    });
  });

  it("serializes immutable dependency approval and Pack timestamps", async () => {
    vi.mocked(readCurrentAcceptanceDependencyObservations).mockResolvedValue({
      ...currentDependencyObservations,
      observations: [{
        ...currentDependencyObservations.observations[0],
        approval: dependencyApproval,
        externalBuilderPack,
      }],
    } as never);

    const response = await GET(req(), { params: params() });
    const item = (await response.json()).dependencyObservations.observations[0];

    expect(item.observation.observedAt).toBe(DEPENDENCY_OBSERVED_AT.toISOString());
    expect(item.approval.approvedAt).toBe(DEPENDENCY_APPROVED_AT.toISOString());
    expect(item.externalBuilderPack.mintedAt).toBe(DEPENDENCY_APPROVED_AT.toISOString());
    expect(item.externalBuilderPack.deliveryAuthority).toBe("not_granted");
  });

  it("downgrades metrics when current-head authority and the metrics current-cycle marker disagree", async () => {
    vi.mocked(readAcceptancePrReviewMetrics).mockResolvedValue({
      ...currentReviewMetrics,
      currentCycle: null,
      cycles: [{ ...currentReviewMetrics.cycles[0], current: false }],
    } as never);

    const missingCurrent = await GET(req(), { params: params() });
    expect((await missingCurrent.json()).reviewMetrics).toEqual({
      kind: "unavailable",
      reason: "invalid_review_custody",
    });

    vi.mocked(readChangeRecordTimeline).mockResolvedValue({
      ...timeline,
      record: { ...timeline.record, currentPrHeadAuthoritative: false },
    } as never);
    vi.mocked(readAcceptancePrReviewMetrics).mockResolvedValue(currentReviewMetrics as never);

    const unexpectedCurrent = await GET(req(), { params: params() });
    expect((await unexpectedCurrent.json()).reviewMetrics).toEqual({
      kind: "unavailable",
      reason: "invalid_review_custody",
    });
  });

  it("serializes every historical review-metrics timestamp without inferring unknown effort", async () => {
    vi.mocked(readAcceptancePrReviewMetrics).mockResolvedValue({
      ...currentReviewMetrics,
      cycles: [{
        ...currentReviewMetrics.cycles[0],
        effort: {
          kind: "known",
          value: {
            eventId: EFFORT_EVENT_ID,
            eventKey: `acceptance-pr-review-effort:${CYCLE}`,
            minutes: 37,
            source: "human_input",
            recordedBy: `user:${USER}`,
            recordedRole: "admin",
            recordedAt: EFFORT_AT,
          },
        },
        decision: {
          kind: "known",
          value: {
            eventId: DECISION_EVENT_ID,
            eventKey: `acceptance-pr-decision:${CYCLE}`,
            decision: "changes_requested",
            rationale: null,
            decidedBy: `user:${USER}`,
            decidedRole: "owner",
            decidedAt: DECIDED_AT,
          },
        },
        signedMerge: {
          kind: "known",
          value: {
            mergeEventId: "00000000-0000-4000-8000-000000000053",
            deliveryEventId: "00000000-0000-4000-8000-000000000052",
            mergeSha: "b".repeat(40),
            mergedAt: new Date("2026-08-03T12:08:00.000Z"),
            decisionAlignment: "decision_conflicts_merge",
          },
        },
        postMergeOutcomes: {
          kind: "known",
          values: [{
            eventId: "00000000-0000-4000-8000-000000000051",
            eventKey: "acceptance-post-merge:deployed:1",
            outcome: "deployed",
            recordedBy: `user:${USER}`,
            recordedAt: new Date("2026-08-03T12:09:00.000Z"),
          }],
        },
      }],
      summary: {
        ...currentReviewMetrics.summary,
        reviewEffort: {
          eligible: 1,
          known: 1,
          unknown: 0,
          totalMinutes: 37,
          averageMinutes: 37,
        },
        signedMerges: { eligible: 1, known: 1, unknown: 0 },
        postMergeOutcomes: { eligible: 1, known: 1, unknown: 0 },
      },
    } as never);

    const res = await GET(req(), { params: params() });
    const body = await res.json();

    expect(body.reviewMetrics.cycles[0]).toMatchObject({
      reviewedAt: REVIEW_AT.toISOString(),
      effort: { value: { recordedAt: EFFORT_AT.toISOString() } },
      decision: { value: { decidedAt: DECIDED_AT.toISOString() } },
      signedMerge: { value: { mergedAt: "2026-08-03T12:08:00.000Z" } },
      postMergeOutcomes: { values: [{ recordedAt: "2026-08-03T12:09:00.000Z" }] },
    });
  });

  it("serializes an immutable current decision timestamp and role", async () => {
    vi.mocked(readCurrentAcceptancePrDecision).mockResolvedValue({
      ...currentFinalDecision,
      binding: { ...currentFinalDecision.binding, reviewVerdict: "proven" },
      decision: {
        eventId: DECISION_EVENT_ID,
        eventKey: `acceptance-pr-decision:${CYCLE}`,
        decision: "approved",
        rationale: null,
        decidedBy: `user:${USER}`,
        decidedRole: "owner",
        decidedAt: DECIDED_AT,
      },
    } as never);

    const res = await GET(req(), { params: params() });

    expect(res.status).toBe(200);
    expect((await res.json()).finalDecision.decision).toEqual({
      eventId: DECISION_EVENT_ID,
      eventKey: `acceptance-pr-decision:${CYCLE}`,
      decision: "approved",
      rationale: null,
      decidedBy: `user:${USER}`,
      decidedRole: "owner",
      decidedAt: DECIDED_AT.toISOString(),
    });
  });

  it("returns invalid packet custody as a closed not-ready envelope", async () => {
    vi.mocked(readCurrentAcceptanceCorrectionPackets).mockResolvedValue({
      kind: "not_ready",
      reason: "invalid_packet_custody",
    });

    const res = await GET(req(), { params: params() });

    expect(res.status).toBe(200);
    expect((await res.json()).correctionPackets).toEqual({
      kind: "not_ready",
      reason: "invalid_packet_custody",
    });
  });

  it("500 when storage fails", async () => {
    vi.mocked(readChangeRecordTimeline).mockRejectedValue(new Error("db down"));

    const res = await GET(req(), { params: params() });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "Failed to load change record detail",
    });
    expect(readCurrentAcceptanceCorrectionPackets).not.toHaveBeenCalled();
    expect(readCurrentAcceptancePrDecision).not.toHaveBeenCalled();
    expect(readAcceptancePrReviewMetrics).not.toHaveBeenCalled();
  });

  it("500 when current correction packet storage fails", async () => {
    vi.mocked(readCurrentAcceptanceCorrectionPackets).mockRejectedValue(new Error("db down"));

    const res = await GET(req(), { params: params() });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "Failed to load change record detail",
    });
  });

  it("500 when current final-decision storage fails", async () => {
    vi.mocked(readCurrentAcceptancePrDecision).mockRejectedValue(new Error("db down"));

    const res = await GET(req(), { params: params() });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "Failed to load change record detail",
    });
  });

  it("500 when historical review-metrics storage fails", async () => {
    vi.mocked(readAcceptancePrReviewMetrics).mockRejectedValue(new Error("db down"));

    const res = await GET(req(), { params: params() });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to load change record detail" });
  });

  it("500 when current dependency observation storage fails", async () => {
    vi.mocked(readCurrentAcceptanceDependencyObservations).mockRejectedValue(new Error("db down"));

    const response = await GET(req(), { params: params() });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed to load change record detail" });
  });

  it("500 with a sanitized response when strict detail storage fails", async () => {
    vi.mocked(readAcceptanceRecordDetail).mockRejectedValue(new Error("raw storage detail"));

    const response = await GET(req(), { params: params() });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed to load change record detail" });
  });
});

describe("PATCH /api/v1/workspaces/[workspaceId]/change-records/[recordId]", () => {
  beforeEach(() => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1", role: "owner" } as never);
  });

  it("authenticates and owner/admin-authorizes before parsing or writing", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const unauthenticated = await PATCH(patchReq({ nope: true }), { params: params() });
    expect(unauthenticated.status).toBe(401);
    expect(getWorkspaceMembership).not.toHaveBeenCalled();
    expect(recordAcceptancePrDecision).not.toHaveBeenCalled();
    expect(recordAcceptancePrReviewEffort).not.toHaveBeenCalled();
    expect(approveAcceptanceDependencyObservationAndMintExternalBuilderPack).not.toHaveBeenCalled();
    expect(recordAcceptanceContextPackRegenerationRequest).not.toHaveBeenCalled();

    vi.mocked(auth).mockResolvedValue({ user: { id: "not-a-uuid" } } as never);
    const invalidActor = await PATCH(patchReq({ nope: true }), { params: params() });
    expect(invalidActor.status).toBe(401);
    expect(getWorkspaceMembership).not.toHaveBeenCalled();
    expect(recordAcceptancePrDecision).not.toHaveBeenCalled();
    expect(recordAcceptancePrReviewEffort).not.toHaveBeenCalled();
    expect(approveAcceptanceDependencyObservationAndMintExternalBuilderPack).not.toHaveBeenCalled();
    expect(recordAcceptanceContextPackRegenerationRequest).not.toHaveBeenCalled();

    vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1", role: "member" } as never);
    const forbidden = await PATCH(patchReq({ nope: true }), { params: params() });
    expect(forbidden.status).toBe(403);
    expect(recordAcceptancePrDecision).not.toHaveBeenCalled();
    expect(recordAcceptancePrReviewEffort).not.toHaveBeenCalled();
    expect(approveAcceptanceDependencyObservationAndMintExternalBuilderPack).not.toHaveBeenCalled();
    expect(recordAcceptanceContextPackRegenerationRequest).not.toHaveBeenCalled();
  });

  it("rejects non-JSON, declared oversize, unknown decisions, and extra authority fields", async () => {
    const bodies = [
      patchReq({ action: "record_pr_decision", bindingId: DECISION_BINDING_ID, decision: "merge_now" }),
      patchReq({
        action: "record_pr_decision",
        bindingId: DECISION_BINDING_ID,
        decision: "approved",
        headSha: HEAD,
      }),
      patchReq({ action: "record_pr_decision", bindingId: DECISION_BINDING_ID, decision: "approved_with_exception" }),
      patchReq({ action: "record_pr_decision", bindingId: DECISION_BINDING_ID, decision: "approved" }, { contentType: "text/plain" }),
      patchReq(
        { action: "record_pr_decision", bindingId: DECISION_BINDING_ID, decision: "approved" },
        { contentLength: String(20 * 1024 + 1) },
      ),
      patchReq({ action: "record_pr_decision", bindingId: "not-a-uuid", decision: "approved" }),
      patchReq({ bindingId: DECISION_BINDING_ID, decision: "approved" }),
    ];

    for (const request of bodies) {
      const response = await PATCH(request, { params: params() });
      expect(response.status).toBe(400);
    }
    expect(recordAcceptancePrDecision).not.toHaveBeenCalled();
    expect(recordAcceptanceContextPackRegenerationRequest).not.toHaveBeenCalled();
  });

  it("records a request and queues one server-derived execution against the same Pack binding", async () => {
    const requestIntentId = "00000000-0000-4000-8000-000000000051";
    const response = await PATCH(patchReq({
      action: "request_context_pack_regeneration",
      compiledPackId: COMPILED_PACK_ID,
      reason: "stale",
      requestIntentId,
    }), { params: params() });

    expect(response.status).toBe(201);
    expect(recordAcceptanceContextPackRegenerationRequest).toHaveBeenCalledExactlyOnceWith({
      workspaceId: WS,
      recordId: RECORD,
      compiledPackId: COMPILED_PACK_ID,
      reason: "stale",
      requestedBy: `user:${USER}`,
      requestIntentId,
    });
    const body = await response.json();
    expect(body.kind).toBe("recorded");
    expect(body.request.authority).toBe("request_only");
    expect(body.request.status).toBe("request_recorded");
    expect(body.execution).toMatchObject({
      id: "00000000-0000-4000-8000-000000000050",
      requestEventId: REGENERATION_REQUEST_EVENT_ID,
      parentExecutionId: null,
      priorCompiledPackId: COMPILED_PACK_ID,
      status: "queued",
      attemptCount: 0,
      maxAttempts: 1,
    });
  });

  it("records a distinct intent visibly bound to an existing terminal execution", async () => {
    vi.mocked(recordAcceptanceContextPackRegenerationRequest).mockResolvedValueOnce({
      kind: "recorded",
      request: { executionId: REGENERATION_EXECUTION_ID },
      execution: {
        id: REGENERATION_EXECUTION_ID,
        status: "held",
        outcomeReason: "lease_attempts_exhausted",
      },
    } as never);
    const response = await PATCH(patchReq({
      action: "request_context_pack_regeneration",
      compiledPackId: COMPILED_PACK_ID,
      reason: "stale",
      requestIntentId: REGENERATION_REQUEST_INTENT_ID,
    }), { params: params() });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      kind: "recorded",
      request: { executionId: REGENERATION_EXECUTION_ID },
      execution: { id: REGENERATION_EXECUTION_ID, status: "held" },
    });
  });

  it("rejects regeneration bodies that try to supply head or execution authority", async () => {
    for (const body of [
      { action: "request_context_pack_regeneration", compiledPackId: COMPILED_PACK_ID, reason: "missing" },
      { action: "request_context_pack_regeneration", compiledPackId: "not-a-uuid", reason: "stale" },
      { action: "request_context_pack_regeneration", compiledPackId: COMPILED_PACK_ID, reason: "stale" },
      { action: "request_context_pack_regeneration", compiledPackId: COMPILED_PACK_ID, reason: "stale", requestIntentId: "invalid" },
      { action: "request_context_pack_regeneration", compiledPackId: COMPILED_PACK_ID, reason: "stale", requestIntentId: "00000000-0000-4000-8000-000000000051", headSha: HEAD },
      { action: "request_context_pack_regeneration", compiledPackId: COMPILED_PACK_ID, reason: "stale", requestIntentId: "00000000-0000-4000-8000-000000000051", dispatch: true },
    ]) {
      const response = await PATCH(patchReq(body), { params: params() });
      expect(response.status).toBe(400);
    }
    expect(recordAcceptanceContextPackRegenerationRequest).not.toHaveBeenCalled();
  });

  it("records a deliberate retry using only one terminal execution id", async () => {
    const executionId = "00000000-0000-4000-8000-000000000050";
    const response = await PATCH(patchReq({
      action: "retry_context_pack_regeneration",
      executionId,
    }), { params: params() });
    expect(response.status).toBe(201);
    expect(retryAcceptanceContextPackRegenerationExecution).toHaveBeenCalledExactlyOnceWith({
      workspaceId: WS,
      recordId: RECORD,
      executionId,
      requestedBy: `user:${USER}`,
    });
    expect(await response.json()).toMatchObject({ kind: "retried", execution: { status: "queued" } });
  });

  it("rejects widened or invalid deliberate retry bodies", async () => {
    for (const body of [
      { action: "retry_context_pack_regeneration", executionId: "invalid" },
      { action: "retry_context_pack_regeneration", executionId: "00000000-0000-4000-8000-000000000050", dispatch: true },
    ]) expect((await PATCH(patchReq(body), { params: params() })).status).toBe(400);
    expect(retryAcceptanceContextPackRegenerationExecution).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: "not_found" }, 404],
    [{ kind: "not_authorized" }, 403],
    [{ kind: "not_current" }, 409],
  ] as const)("maps the closed Context Pack request result %# without queuing an execution", async (result, status) => {
    vi.mocked(recordAcceptanceContextPackRegenerationRequest).mockResolvedValue(result as never);
    const response = await PATCH(patchReq({
      action: "request_context_pack_regeneration",
      compiledPackId: COMPILED_PACK_ID,
      reason: "inadequate",
      requestIntentId: REGENERATION_REQUEST_INTENT_ID,
    }), { params: params() });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(result);
  });

  it("maps immutable Context Pack request conflicts without exposing storage failures", async () => {
    vi.mocked(recordAcceptanceContextPackRegenerationRequest).mockRejectedValueOnce(
      new AcceptanceContextPackRegenerationRequestConflictError(),
    );
    const conflict = await PATCH(patchReq({
      action: "request_context_pack_regeneration",
      compiledPackId: COMPILED_PACK_ID,
      reason: "stale",
      requestIntentId: REGENERATION_REQUEST_INTENT_ID,
    }), { params: params() });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      error: "Context Pack regeneration request conflicts with immutable custody",
    });

    vi.mocked(recordAcceptanceContextPackRegenerationRequest).mockRejectedValueOnce(
      new Error("postgres://secret@db/internal"),
    );
    const unavailable = await PATCH(patchReq({
      action: "request_context_pack_regeneration",
      compiledPackId: COMPILED_PACK_ID,
      reason: "stale",
      requestIntentId: REGENERATION_REQUEST_INTENT_ID,
    }), { params: params() });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: "Change Record action unavailable" });
  });

  it("derives workspace, Record, actor, and current proof while normalizing bounded rationale", async () => {
    const response = await PATCH(patchReq({
      action: "record_pr_decision",
      bindingId: DECISION_BINDING_ID,
      decision: "changes_requested",
      rationale: "  The failed criterion must be repaired.  ",
    }), { params: params() });

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(recordAcceptancePrDecision).toHaveBeenCalledWith({
      workspaceId: WS,
      recordId: RECORD,
      bindingId: DECISION_BINDING_ID,
      decision: "changes_requested",
      rationale: "The failed criterion must be repaired.",
      decidedBy: `user:${USER}`,
    });
    expect(await response.json()).toEqual({
      kind: "recorded",
      binding: currentFinalDecision.binding,
      decision: {
        eventId: DECISION_EVENT_ID,
        eventKey: `acceptance-pr-decision:${CYCLE}`,
        decision: "changes_requested",
        rationale: "The failed criterion must be repaired.",
        decidedBy: `user:${USER}`,
        decidedRole: "owner",
        decidedAt: DECIDED_AT.toISOString(),
      },
    });
  });

  it("reports exact replay as 200 without claiming another recording", async () => {
    vi.mocked(recordAcceptancePrDecision).mockResolvedValue({
      kind: "replayed",
      binding: { ...currentFinalDecision.binding, reviewVerdict: "proven" },
      decision: {
        eventId: DECISION_EVENT_ID,
        eventKey: `acceptance-pr-decision:${CYCLE}`,
        decision: "approved",
        rationale: null,
        decidedBy: `user:${USER}`,
        decidedRole: "admin",
        decidedAt: DECIDED_AT,
      },
    } as never);

    const response = await PATCH(patchReq({
      action: "record_pr_decision",
      bindingId: DECISION_BINDING_ID,
      decision: "approved",
    }), { params: params() });

    expect(response.status).toBe(200);
    expect((await response.json()).kind).toBe("replayed");
  });

  it("returns not_current when the rendered binding is stale", async () => {
    const staleBindingId = "00000000-0000-4000-8000-000000000044";
    vi.mocked(recordAcceptancePrDecision).mockResolvedValue({ kind: "not_current" });

    const response = await PATCH(patchReq({
      action: "record_pr_decision",
      bindingId: staleBindingId,
      decision: "rejected",
    }), { params: params() });

    expect(recordAcceptancePrDecision).toHaveBeenCalledWith({
      workspaceId: WS,
      recordId: RECORD,
      bindingId: staleBindingId,
      decision: "rejected",
      decidedBy: `user:${USER}`,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ kind: "not_current" });
  });

  it.each([
    [{ kind: "not_found" }, 404],
    [{ kind: "not_authorized" }, 403],
    [{ kind: "not_current" }, 409],
    [{ kind: "not_ready", reason: "review_job_unavailable" }, 409],
    [{ kind: "decision_not_allowed", reason: "approval_requires_proven" }, 409],
  ] as const)("maps the closed DB result %# without inventing success", async (result, status) => {
    vi.mocked(recordAcceptancePrDecision).mockResolvedValue(result as never);

    const response = await PATCH(patchReq({
      action: "record_pr_decision",
      bindingId: DECISION_BINDING_ID,
      decision: "approved",
    }), { params: params() });

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(result);
  });

  it("maps an immutable decision conflict to 409 and sanitizes unexpected storage failures", async () => {
    vi.mocked(recordAcceptancePrDecision).mockRejectedValueOnce(
      new AcceptancePrDecisionConflictError(),
    );
    const conflict = await PATCH(patchReq({
      action: "record_pr_decision",
      bindingId: DECISION_BINDING_ID,
      decision: "rejected",
    }), { params: params() });
    expect(conflict.status).toBe(409);

    vi.mocked(recordAcceptancePrDecision).mockRejectedValueOnce(
      new Error("postgres://secret@db/internal"),
    );
    const unavailable = await PATCH(patchReq({
      action: "record_pr_decision",
      bindingId: DECISION_BINDING_ID,
      decision: "rejected",
    }), { params: params() });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: "Change Record action unavailable" });
  });

  it("records whole-minute review effort using only the rendered binding and server-derived actor", async () => {
    const response = await PATCH(patchReq({
      action: "record_pr_review_effort",
      bindingId: DECISION_BINDING_ID,
      minutes: 37,
    }), { params: params() });

    expect(response.status).toBe(201);
    expect(recordAcceptancePrReviewEffort).toHaveBeenCalledWith({
      workspaceId: WS,
      recordId: RECORD,
      bindingId: DECISION_BINDING_ID,
      minutes: 37,
      recordedBy: `user:${USER}`,
    });
    expect(recordAcceptancePrDecision).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({
      kind: "recorded",
      binding: currentFinalDecision.binding,
      effort: {
        eventId: EFFORT_EVENT_ID,
        eventKey: `acceptance-pr-review-effort:${CYCLE}`,
        minutes: 37,
        source: "human_input",
        recordedBy: `user:${USER}`,
        recordedRole: "owner",
        recordedAt: EFFORT_AT.toISOString(),
      },
    });
  });

  it.each([
    { action: "record_pr_review_effort", bindingId: DECISION_BINDING_ID, minutes: 0 },
    { action: "record_pr_review_effort", bindingId: DECISION_BINDING_ID, minutes: 1_441 },
    { action: "record_pr_review_effort", bindingId: DECISION_BINDING_ID, minutes: 3.5 },
    { action: "record_pr_review_effort", bindingId: DECISION_BINDING_ID, minutes: "37" },
    { action: "record_pr_review_effort", bindingId: "stale-head", minutes: 37 },
    { action: "record_pr_review_effort", bindingId: DECISION_BINDING_ID, minutes: 37, headSha: HEAD },
    { action: "record_pr_review_effort", bindingId: DECISION_BINDING_ID },
  ])("rejects invalid or authority-bearing review-effort input %#", async (body) => {
    const response = await PATCH(patchReq(body), { params: params() });

    expect(response.status).toBe(400);
    expect(recordAcceptancePrReviewEffort).not.toHaveBeenCalled();
  });

  it("reports exact effort replay as 200 without inventing another receipt", async () => {
    vi.mocked(recordAcceptancePrReviewEffort).mockResolvedValue({
      kind: "replayed",
      binding: currentFinalDecision.binding,
      effort: {
        eventId: EFFORT_EVENT_ID,
        eventKey: `acceptance-pr-review-effort:${CYCLE}`,
        minutes: 37,
        source: "human_input",
        recordedBy: `user:${USER}`,
        recordedRole: "admin",
        recordedAt: EFFORT_AT,
      },
    } as never);

    const response = await PATCH(patchReq({
      action: "record_pr_review_effort",
      bindingId: DECISION_BINDING_ID,
      minutes: 37,
    }), { params: params() });

    expect(response.status).toBe(200);
    expect((await response.json()).kind).toBe("replayed");
  });

  it.each([
    [{ kind: "not_found" }, 404],
    [{ kind: "not_authorized" }, 403],
    [{ kind: "not_current" }, 409],
    [{ kind: "not_ready", reason: "invalid_review_custody" }, 409],
  ] as const)("maps the closed review-effort DB result %# without inventing success", async (result, status) => {
    vi.mocked(recordAcceptancePrReviewEffort).mockResolvedValue(result as never);

    const response = await PATCH(patchReq({
      action: "record_pr_review_effort",
      bindingId: DECISION_BINDING_ID,
      minutes: 37,
    }), { params: params() });

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(result);
  });

  it("maps immutable effort conflicts to 409 and sanitizes storage failures", async () => {
    vi.mocked(recordAcceptancePrReviewEffort).mockRejectedValueOnce(
      new AcceptancePrReviewEffortConflictError(),
    );
    const conflict = await PATCH(patchReq({
      action: "record_pr_review_effort",
      bindingId: DECISION_BINDING_ID,
      minutes: 37,
    }), { params: params() });
    expect(conflict.status).toBe(409);

    vi.mocked(recordAcceptancePrReviewEffort).mockRejectedValueOnce(
      new Error("postgres://secret@db/internal"),
    );
    const unavailable = await PATCH(patchReq({
      action: "record_pr_review_effort",
      bindingId: DECISION_BINDING_ID,
      minutes: 37,
    }), { params: params() });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: "Change Record action unavailable" });
  });

  it("approves one server-custodied observation and derives workspace, Record, and actor", async () => {
    const response = await PATCH(patchReq({
      action: "approve_dependency_observation",
      observationEventId: DEPENDENCY_OBSERVATION_EVENT_ID,
    }), { params: params() });

    expect(response.status).toBe(201);
    expect(approveAcceptanceDependencyObservationAndMintExternalBuilderPack).toHaveBeenCalledTimes(1);
    expect(approveAcceptanceDependencyObservationAndMintExternalBuilderPack).toHaveBeenCalledWith({
      workspaceId: WS,
      recordId: RECORD,
      observationEventId: DEPENDENCY_OBSERVATION_EVENT_ID,
      approvedBy: `user:${USER}`,
    });
    expect(recordAcceptancePrDecision).not.toHaveBeenCalled();
    expect(recordAcceptancePrReviewEffort).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body).toMatchObject({
      kind: "approved",
      approval: { approvedAt: DEPENDENCY_APPROVED_AT.toISOString() },
      externalBuilderPack: {
        packId: EXTERNAL_BUILDER_PACK_ID,
        deliveryAuthority: "not_granted",
        mintedAt: DEPENDENCY_APPROVED_AT.toISOString(),
      },
    });
  });

  it.each([
    { action: "approve_dependency_observation" },
    { action: "approve_dependency_observation", observationEventId: "not-a-uuid" },
    {
      action: "approve_dependency_observation",
      observationEventId: DEPENDENCY_OBSERVATION_EVENT_ID,
      headSha: HEAD,
    },
    {
      action: "approve_dependency_observation",
      observationEventId: DEPENDENCY_OBSERVATION_EVENT_ID,
      compiledPackId: COMPILED_PACK_ID,
    },
  ])("rejects invalid or authority-bearing dependency approval input %#", async (body) => {
    const response = await PATCH(patchReq(body), { params: params() });

    expect(response.status).toBe(400);
    expect(approveAcceptanceDependencyObservationAndMintExternalBuilderPack).not.toHaveBeenCalled();
  });

  it("reports exact dependency approval replay as 200", async () => {
    vi.mocked(approveAcceptanceDependencyObservationAndMintExternalBuilderPack).mockResolvedValue({
      kind: "replayed",
      binding: dependencyBinding,
      observation: dependencyObservation,
      approval: dependencyApproval,
      externalBuilderPack,
    } as never);

    const response = await PATCH(patchReq({
      action: "approve_dependency_observation",
      observationEventId: DEPENDENCY_OBSERVATION_EVENT_ID,
    }), { params: params() });

    expect(response.status).toBe(200);
    expect((await response.json()).kind).toBe("replayed");
  });

  it.each([
    [{ kind: "not_found" }, 404],
    [{ kind: "observation_not_found" }, 404],
    [{ kind: "not_authorized" }, 403],
    [{ kind: "not_current" }, 409],
    [{ kind: "observation_not_eligible", reason: "observation_not_observed" }, 409],
    [{ kind: "not_ready", reason: "selected_route_unavailable" }, 409],
  ] as const)("maps the closed dependency approval result %# without inventing success", async (result, status) => {
    vi.mocked(approveAcceptanceDependencyObservationAndMintExternalBuilderPack).mockResolvedValue(result as never);

    const response = await PATCH(patchReq({
      action: "approve_dependency_observation",
      observationEventId: DEPENDENCY_OBSERVATION_EVENT_ID,
    }), { params: params() });

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(result);
  });

  it("maps immutable Pack conflict to 409 and sanitizes dependency storage failures", async () => {
    vi.mocked(approveAcceptanceDependencyObservationAndMintExternalBuilderPack).mockRejectedValueOnce(
      new AcceptanceDependencyExternalBuilderPackConflictError(),
    );
    const conflict = await PATCH(patchReq({
      action: "approve_dependency_observation",
      observationEventId: DEPENDENCY_OBSERVATION_EVENT_ID,
    }), { params: params() });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      error: "Dependency observation approval conflicts with existing Pack custody",
    });

    vi.mocked(approveAcceptanceDependencyObservationAndMintExternalBuilderPack).mockRejectedValueOnce(
      new Error("postgres://secret@db/internal"),
    );
    const unavailable = await PATCH(patchReq({
      action: "approve_dependency_observation",
      observationEventId: DEPENDENCY_OBSERVATION_EVENT_ID,
    }), { params: params() });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: "Change Record action unavailable" });
  });
});
