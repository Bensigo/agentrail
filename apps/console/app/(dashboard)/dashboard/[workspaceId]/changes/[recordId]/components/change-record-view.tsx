"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { CopyId } from "../../../../../../components/copy-id";
import { PageHeader } from "../../../../../../components/page-header";
import type {
  AcceptanceRecordDetailOccurrence as DbAcceptanceRecordDetailOccurrence,
  ReadAcceptanceRecordDetailResult,
} from "@agentrail/db-postgres";
import { containsSecretShapedValue } from "../../../../../../../lib/secret-scan";

export type ChangeRecord = {
  id: string;
  workspaceId: string;
  repo: string;
  issueNumber: number | null;
  prNumber: number | null;
  headShas: string[];
  mergedSha: string | null;
  state: string;
  createdAt: string;
  updatedAt: string;
};

export type ChangeRecordEvent = {
  id: string;
  recordId: string;
  eventKey: string;
  stage: string;
  actor: string;
  payloadRef: Record<string, unknown>;
  at: string;
  createdAt: string;
};

type SafeDataRequestDescriptor = {
  method: "GET";
  path: string;
  expectedStatus: number;
  digestAlgorithm: "hmac-sha256-v1";
  digestKeyId: string;
  digestContext: string;
  expectedJson: Array<{
    pointer: string;
    equalsType: "null" | "boolean" | "number" | "string";
    equalsHmacSha256: string;
  }>;
};

type CorrectionReproduction =
  | {
      modality: "ui";
      steps: Array<
        | { action: "open"; path: string }
        | { action: "click"; selector: string }
        | { action: "fill"; selector: string; value: "[REDACTED_FILL]" }
        | { action: "press"; key: string }
        | { action: "expect_text"; text: string }
        | { action: "screenshot"; label: string }
      >;
    }
  | { modality: "api"; request: { method: "GET"; path: string; expectedStatus: number } }
  | { modality: "data"; request: SafeDataRequestDescriptor }
  | {
      modality: "job";
      request: {
        trigger: { method: "POST"; path: string; expectedStatus: number };
        readback: SafeDataRequestDescriptor;
      };
    };

export type AcceptanceCorrectionPacket = {
  kind: "review_job_correction_packet";
  version: 1;
  packetId: string;
  workspaceId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  recordId: string;
  jobId: string;
  acceptanceContract: { id: string; version: number };
  criterion: { id: string; snapshot: string };
  basis: "acceptance_contract";
  state: "failed" | "not_proven";
  expected: string;
  observed: string;
  affectedContext: {
    modality: "ui" | "api" | "data" | "job";
    environmentKind: "isolated_preview" | null;
    flow: string;
    reproduction: CorrectionReproduction;
  };
  evidence: {
    evidenceRef: string;
    artifactKey?: string;
    executionId?: string;
    previewBootId: string;
  };
  scopeBoundary: string;
  impact: string;
  requiredCorrection: string;
  reverification: string;
};

export type AcceptanceCorrectionPacketsEnvelope =
  | {
      kind: "current";
      binding: {
        workspaceId: string;
        recordId: string;
        reviewJobId: string;
        repo: string;
        prNumber: number;
        headSha: string;
        headCycleId: string;
        authorityGeneration: number;
        acceptanceContract: { id: string; version: number; sha256: string };
      };
      packetIds: string[];
      packetSetSha256: string;
      correctionPacketPayloadSetSha256: string;
      packets: AcceptanceCorrectionPacket[];
    }
  | { kind: "not_found" }
  | { kind: "not_current" }
  | {
      kind: "not_ready";
      reason:
        | "review_job_unavailable"
        | "confirmed_contract_unavailable"
        | "no_correction_packets"
        | "invalid_packet_custody";
    };

export type AcceptancePrDecision =
  | "approved"
  | "changes_requested"
  | "rejected"
  | "approved_with_exception";

export type AcceptanceFinalDecisionEnvelope =
  | {
      kind: "current";
      binding: {
        bindingId: string;
        workspaceId: string;
        recordId: string;
        repo: string;
        prNumber: number;
        headSha: string;
        headCycleId: string;
        authorityGeneration: number;
        reviewJobId: string;
        reviewVerdict: "proven" | "failed" | "not_proven" | "not_testable";
        postedReviewUrl: string;
        postedAttestationEventId: string;
        acceptanceContract: { id: string; version: number; sha256: string };
      };
      decision: null | {
        eventId: string;
        eventKey: string;
        decision: AcceptancePrDecision;
        rationale: string | null;
        decidedBy: string;
        decidedRole: "owner" | "admin";
        decidedAt: string;
      };
    }
  | { kind: "not_found" }
  | { kind: "not_current" }
  | {
      kind: "not_ready";
      reason:
        | "review_job_unavailable"
        | "confirmed_contract_unavailable"
        | "posted_attestation_unavailable"
        | "invalid_review_custody"
        | "invalid_decision_custody";
    };

type AcceptanceReviewCycleBinding = {
  workspaceId: string;
  recordId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  headCycleId: string;
  reviewJobId: string;
  reviewVerdict: "proven" | "failed" | "not_proven" | "not_testable";
  postedReviewUrl: string;
  postedAttestationEventId: string;
  acceptanceContract: { id: string; version: number; sha256: string };
};

type AcceptanceReviewEffortReceipt = {
  eventId: string;
  eventKey: string;
  minutes: number;
  source: "human_input";
  recordedBy: string;
  recordedRole: "owner" | "admin";
  recordedAt: string;
};

type AcceptanceReviewDecisionReceipt = {
  eventId: string;
  eventKey: string;
  decision: AcceptancePrDecision;
  rationale: string | null;
  decidedBy: string;
  decidedRole: "owner" | "admin";
  decidedAt: string;
};

type AcceptanceHistoricalPostMergeOutcome =
  | {
      kind: "deployed";
      revisionSha: string;
      environment: string;
      deploymentReference: string;
    }
  | { kind: "incident"; revisionSha: string; incidentReference: string }
  | {
      kind: "reverted";
      revertedSha: string;
      revertSha: string;
      revertReference: string;
    };

type AcceptanceReviewCycle = {
  binding: AcceptanceReviewCycleBinding;
  current: boolean;
  reviewedAt: string;
  effort: { kind: "known"; value: AcceptanceReviewEffortReceipt } | { kind: "unknown" };
  decision: { kind: "known"; value: AcceptanceReviewDecisionReceipt } | { kind: "unknown" };
  signedMerge:
    | {
        kind: "known";
        value: {
          mergeEventId: string;
          deliveryEventId: string;
          mergeSha: string;
          mergedAt: string;
          decisionAlignment: "aligned" | "decision_conflicts_merge" | "not_recorded";
        };
      }
    | { kind: "unknown" };
  postMergeOutcomes:
    | {
        kind: "known";
        values: Array<{
          eventId: string;
          eventKey: string;
          outcome: AcceptanceHistoricalPostMergeOutcome;
          recordedBy: string;
          recordedAt: string;
        }>;
      }
    | { kind: "unknown" };
};

type ReviewMetricsCountSummary = { eligible: number; known: number; unknown: number };

export type AcceptancePrReviewMetricsEnvelope =
  | {
      kind: "record";
      workspaceId: string;
      recordId: string;
      repo: string;
      prNumber: number;
      currentCycle: null | {
        headSha: string;
        headCycleId: string;
        authorityGeneration: number;
      };
      cycles: AcceptanceReviewCycle[];
      summary: {
        reviewEffort: ReviewMetricsCountSummary & {
          totalMinutes: number | null;
          averageMinutes: number | null;
        };
        decisions: ReviewMetricsCountSummary;
        signedMerges: ReviewMetricsCountSummary;
        postMergeOutcomes: ReviewMetricsCountSummary;
      };
    }
  | { kind: "not_found" }
  | {
      kind: "unavailable";
      reason:
        | "record_not_attached"
        | "invalid_record_custody"
        | "confirmed_contract_unavailable"
        | "invalid_review_custody"
        | "invalid_effort_custody"
        | "invalid_decision_custody"
        | "invalid_merge_custody"
        | "invalid_post_merge_custody";
    };

type AcceptanceDependencyObservationStatus =
  | "observed"
  | "refused_unsupported_profile"
  | "refused_unsafe_runtime"
  | "refused_lockfile"
  | "refused_baseline"
  | "refused_security"
  | "not_proven";

type AcceptanceDependencyObservationReason =
  | "baseline_head_mismatch"
  | "manifest_source_not_proven"
  | "lockfile_source_not_proven"
  | "unsupported_manager_profile"
  | "unsafe_runtime"
  | "unsafe_package_manager"
  | "unsafe_package_manager_profile"
  | "unsafe_package_manager_argv"
  | "runtime_evidence_unavailable"
  | "runtime_evidence_ambiguous"
  | "package_manager_evidence_unavailable"
  | "package_manager_evidence_ambiguous"
  | "lockfile_missing"
  | "lockfile_uncommitted"
  | "lockfile_evidence_unavailable"
  | "lockfile_evidence_ambiguous"
  | "security_affected"
  | "security_evidence_unavailable"
  | "security_evidence_ambiguous"
  | "unsafe_yarn_configuration_present"
  | "yarn_configuration_absence_not_proven";

type AcceptanceDependencyProfileIdentity = { ecosystem: string; manager: string; profile: string };
type AcceptanceDependencyCandidate = {
  identity: AcceptanceDependencyProfileIdentity;
  package: string;
  dependencyKind: string;
  specifier: string;
  currentVersion: string;
  targetVersion: string;
};

type AcceptanceDependencyRuntimeEvidence = {
  identity: AcceptanceDependencyProfileIdentity;
  disposition: "safe" | "unsafe" | "unavailable" | "ambiguous";
  version: string | null;
  evidenceSha256: string;
};

type AcceptanceDependencyPackageManagerEvidence = {
  disposition: "safe" | "unsafe" | "unavailable" | "ambiguous";
  name: string;
  version: string | null;
  profile: string;
  updateArgv: string[];
  evidenceSha256: string;
};

type AcceptanceDependencyManifestEvidence = { path: string; blobSha: string };
type AcceptanceDependencyLockfileEvidence = {
  disposition: "present" | "missing" | "uncommitted" | "unavailable" | "ambiguous";
  path: string;
  blobSha: string | null;
  evidenceSha256: string;
};
type AcceptanceDependencyBaselineEvidence = { headSha: string };
type AcceptanceDependencySecurityEvidence = {
  identity: AcceptanceDependencyProfileIdentity;
  disposition: "clear" | "affected" | "unavailable" | "ambiguous";
  provider: string;
  reference: string;
  reportSha256: string;
};

type AcceptanceDependencyObservationBinding = {
  workspaceId: string;
  recordId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  headCycleId: string;
  authorityGeneration: number;
  reviewJobId: string;
  acceptanceContract: { id: string; version: number; sha256: string };
  compiledPack: {
    id: string;
    sha256: string;
    sourceSnapshotId: string;
    sourceCustodyIdentitySha256: string;
    compilerVersion: string;
    policyVersion: string;
    exactHeadDependencyTreeProofsSha256: string;
  };
};

type AcceptanceDependencyObservation = {
  eventId: string;
  eventKey: string;
  status: AcceptanceDependencyObservationStatus;
  reasons: AcceptanceDependencyObservationReason[];
  candidateFingerprint: string;
  candidate: AcceptanceDependencyCandidate;
  runtime: AcceptanceDependencyRuntimeEvidence;
  packageManager: AcceptanceDependencyPackageManagerEvidence;
  manifest: AcceptanceDependencyManifestEvidence;
  lockfile: AcceptanceDependencyLockfileEvidence;
  baseline: AcceptanceDependencyBaselineEvidence;
  security: AcceptanceDependencySecurityEvidence;
  observedAt: string;
};

type AcceptanceDependencyApproval = {
  eventId: string;
  eventKey: string;
  observationEventId: string;
  candidateFingerprint: string;
  approvedBy: string;
  approvedRole: "owner" | "admin";
  approvedAt: string;
};

export type AcceptanceDependencyExternalBuilderPack = {
  packId: string;
  eventId: string;
  eventKey: string;
  observationEventId: string;
  approvalEventId: string;
  candidateFingerprint: string;
  binding: AcceptanceDependencyObservationBinding;
  candidate: AcceptanceDependencyCandidate;
  runtime: AcceptanceDependencyRuntimeEvidence;
  packageManager: AcceptanceDependencyPackageManagerEvidence;
  manifest: AcceptanceDependencyManifestEvidence;
  lockfile: AcceptanceDependencyLockfileEvidence;
  baseline: AcceptanceDependencyBaselineEvidence;
  security: AcceptanceDependencySecurityEvidence;
  route: {
    selectionEventId: string;
    id: string;
    adapter: "github_codex" | "github_claude";
    configurationVersion: number;
    snapshot: {
      builder: { adapter: "github_codex" | "github_claude"; routeId: string };
      protocol: "github_comment";
      capability: {
        availability: "unverified";
        activation: "github_mention";
        acknowledgement: "vendor_activity";
        repairHead: "github_synchronize";
      };
      scopeBoundary: "correction_delivery_only";
    };
    snapshotSha256: string;
  };
  deliveryAuthority: "not_granted";
  scopeBoundary: "dependency_external_builder_pack_only";
  reviewRequirement: "exact_head_r7_reentry";
  mintedAt: string;
};

export type AcceptanceDependencyObservationsEnvelope =
  | {
      kind: "current";
      binding: {
        workspaceId: string;
        recordId: string;
        repo: string;
        prNumber: number;
        headSha: string;
        headCycleId: string;
        authorityGeneration: number;
        acceptanceContract: { id: string; version: number; sha256: string };
      };
      observations: Array<{
        payloadVersion: 1 | 2;
        binding: AcceptanceDependencyObservationBinding;
        observation: AcceptanceDependencyObservation;
        approval: AcceptanceDependencyApproval | null;
        externalBuilderPack: AcceptanceDependencyExternalBuilderPack | null;
      }>;
    }
  | { kind: "not_found" }
  | { kind: "not_current" }
  | {
      kind: "not_ready";
      reason:
        | "confirmed_contract_unavailable"
        | "compiled_pack_unavailable"
        | "invalid_observation_custody"
        | "invalid_compiled_pack_custody"
        | "selected_route_unavailable"
        | "selected_route_not_external_builder"
        | "invalid_approval_pack_custody";
    };

type SerializedDates<T> = T extends Date
  ? string
  : T extends readonly (infer Item)[]
    ? SerializedDates<Item>[]
    : T extends object
      ? { [Key in keyof T]: SerializedDates<T[Key]> }
      : T;

export type AcceptanceRecordDetailEnvelope = SerializedDates<ReadAcceptanceRecordDetailResult>;

export type AcceptanceDependencyDraftProposal =
  | {
      kind: "draft";
      record: { id: string; repo: string; contractId: string; contractVersion: 1 };
      proposal: {
        custodyIdentity: string;
        watch: { id: string; observationId: string; observationKey: string };
        candidate: {
          package: string;
          currentVersion: string;
          targetVersion: string;
          dependencyKind: "dependencies" | "devDependencies" | "optionalDependencies" | "peerDependencies";
        };
        files: {
          manifest: { path: "package.json"; sha256: string };
          lockfile: { path: "pnpm-lock.yaml" | "package-lock.json"; sha256: string };
        };
        profile:
          | {
              ecosystem: "node";
              manager: "pnpm";
              profile: "pnpm_lockfile_only_v1";
              capability: "proposal_observation_only";
            }
          | {
              ecosystem: "node";
              manager: "npm";
              profile: "npm_package_lock_only_v1";
              capability: "proposal_observation_only";
            };
        repositorySourceVerification: "watch_observation_only";
        independentSourceProof: "not_proven";
        evidenceAdmission: "unresolved";
        laterEvidence: {
          confirmation: "not_recorded";
          contextPack: "not_recorded";
          builderHandoff: "not_recorded";
          delivery: "not_recorded";
          result: "not_recorded";
        };
      };
    }
  | { kind: "not_found" }
  | { kind: "not_draft_proposal" }
  | { kind: "invalid_custody" };

type AcceptanceCriterionArtifact = {
  artifactId: string;
  contentType: "image/png" | "image/jpeg" | "application/json";
  contentSha256: string;
};

type AcceptanceCriterionEvidence =
  | {
      kind: "execution_receipt";
      modality: "ui" | "api" | "data" | "job";
      executionId: string;
      receiptEventId: string;
      evidenceRef: string;
      artifact: AcceptanceCriterionArtifact | null;
    }
  | {
      kind: "preview_receipt";
      previewBootId: string;
      evidenceRef: string;
    }
  | {
      kind: "not_testable_plan";
      planEventId: string;
    };

type AcceptanceCriterionOutcome = {
  criterionId: string;
  criterionText: string;
  state: "proven" | "failed" | "not_proven" | "not_testable";
  expected: string;
  observed: string;
  evidence: AcceptanceCriterionEvidence;
};

export type AcceptanceCriterionOutcomesEnvelope =
  | {
      kind: "current";
      bundle: {
        id: string;
        eventId: string;
        eventKey: string;
        binding: {
          workspaceId: string;
          recordId: string;
          repo: string;
          prNumber: number;
          headSha: string;
          headCycleId: string;
          reviewJobId: string;
          acceptanceContract: { id: string; version: number; sha256: string };
          verificationPlanEventId: string;
          postedAttemptEventId: string;
          postedAttestationEventId: string;
          outcomeDigest: string;
          postPayloadDigest: string;
          reviewVerdict: "proven" | "failed" | "not_proven" | "not_testable";
        };
        outcomes: AcceptanceCriterionOutcome[];
        outcomeSetSha256: string;
        sha256: string;
        recordedAt: string;
      };
    }
  | { kind: "not_found" }
  | { kind: "not_current" }
  | {
      kind: "not_ready";
      reason:
        | "review_job_unavailable"
        | "confirmed_contract_unavailable"
        | "verification_plan_unavailable"
        | "posted_attempt_unavailable"
        | "criterion_evidence_unavailable"
        | "correction_packet_unavailable"
        | "posted_attestation_unavailable"
        | "criterion_outcome_bundle_not_recorded"
        | "invalid_criterion_outcome_custody";
    };

export type ChangeRecordResponse = {
  record: ChangeRecord;
  events: ChangeRecordEvent[];
  correctionPackets: AcceptanceCorrectionPacketsEnvelope;
  finalDecision: AcceptanceFinalDecisionEnvelope;
  reviewMetrics: AcceptancePrReviewMetricsEnvelope;
  dependencyObservations: AcceptanceDependencyObservationsEnvelope;
  acceptanceDetail: AcceptanceRecordDetailEnvelope;
  dependencyDraftProposal: AcceptanceDependencyDraftProposal;
  criterionOutcomes: AcceptanceCriterionOutcomesEnvelope;
  canRecordFinalDecision: boolean;
  canRecordReviewEffort: boolean;
  canApproveDependencyObservation: boolean;
  canCreateGatedGithubIssue: boolean;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function containsDependencyCommandFields(value: unknown, depth = 0): boolean {
  if (depth > 12) return true;
  if (Array.isArray(value)) {
    return value.some((item) => containsDependencyCommandFields(item, depth + 1));
  }
  if (!isObject(value)) return false;
  return Object.entries(value).some(([key, nested]) =>
    key === "manager_commands" || key === "verification_commands"
      || containsDependencyCommandFields(nested, depth + 1));
}

function isCriterionCustodyTimelineEvent(
  eventKey: string,
  payloadRef: Record<string, unknown>,
): boolean {
  const kind = payloadRef.kind;
  return eventKey.startsWith("verification:plan:")
    || eventKey.startsWith("verification:ui-")
    || eventKey.startsWith("verification:api-")
    || eventKey.startsWith("verification:data-")
    || eventKey.startsWith("verification:job-")
    || eventKey.startsWith("review:correction:")
    || eventKey.startsWith("review:criterion-outcomes:")
    || kind === "review_job_verification_plan"
    || kind === "review_job_correction_packet"
    || kind === "acceptance_criterion_outcome_bundle"
    || (typeof kind === "string" && /^review_job_(?:ui_|api_|data_)?execution_/u.test(kind));
}

function isSafeTimelineEvent(value: unknown): value is ChangeRecordEvent {
  if (!isObject(value) || !hasExactKeys(value, [
    "id", "recordId", "eventKey", "stage", "actor", "payloadRef", "at", "createdAt",
  ]) || !isSafeText(value.id, 512) || typeof value.recordId !== "string" || !UUID.test(value.recordId)
    || !isSafeText(value.eventKey, 1_024) || !isSafeText(value.stage, 256)
    || !isSafeText(value.actor, 512) || !isObject(value.payloadRef)
    || !isSafeText(value.at, 128) || !isSafeText(value.createdAt, 128)) return false;
  const dependencyProposal = value.stage === "dependency_observation_proposal"
    || value.eventKey.startsWith("dependency-observation-proposal:")
    || (typeof value.payloadRef.kind === "string"
      && value.payloadRef.kind.startsWith("dependency_observation_proposal"));
  if (dependencyProposal || containsDependencyCommandFields(value.payloadRef)) {
    return hasExactKeys(value.payloadRef, ["kind", "version", "disclosure"])
      && value.payloadRef.kind === "redacted_dependency_observation_proposal"
      && value.payloadRef.version === 1
      && value.payloadRef.disclosure === "bounded_projection_only";
  }
  if (isCriterionCustodyTimelineEvent(value.eventKey, value.payloadRef)
    && containsSecretShapedValue(value.payloadRef)) return false;
  return true;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA1 = /^[a-f0-9]{40}$/i;
const SHA256 = /^[a-f0-9]{64}$/i;
const LOWER_SHA256 = /^[a-f0-9]{64}$/;
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LOWER_UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GATED_ISSUE_USER_ACTOR = /^user:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CORRECTION_PACKET_ID = /^correction-[a-f0-9]{48}$/i;
const SAFE_REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const GATED_ISSUE_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const SECRET_LIKE = /(?:\b(?:bearer|token|authorization)\s+|\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+))/i;

function isSafeText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max
    && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value)
    && !containsSecretShapedValue(value);
}

function isSafeRepo(value: unknown): value is string {
  return typeof value === "string" && SAFE_REPO.test(value)
    && value.split("/").every((segment) => segment !== "." && segment !== "..");
}

function isGatedIssueRepo(value: unknown): value is string {
  return typeof value === "string" && GATED_ISSUE_REPO.test(value)
    && value.split("/").every((segment) => segment !== "." && segment !== "..");
}

function isHttpStatus(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 599;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isOptionalSafeText(value: Record<string, unknown>, key: string, max: number): boolean {
  return !Object.prototype.hasOwnProperty.call(value, key) || isSafeText(value[key], max);
}

function isSafeDataRequestDescriptor(value: unknown): value is SafeDataRequestDescriptor {
  if (!isObject(value) || !hasExactKeys(value, [
    "method", "path", "expectedStatus", "digestAlgorithm", "digestKeyId", "digestContext", "expectedJson",
  ]) || value.method !== "GET" || !isSafeText(value.path, 2_048)
    || !isHttpStatus(value.expectedStatus) || value.digestAlgorithm !== "hmac-sha256-v1"
    || !isSafeText(value.digestKeyId, 64) || typeof value.digestContext !== "string"
    || !SHA256.test(value.digestContext) || !Array.isArray(value.expectedJson)
    || value.expectedJson.length === 0 || value.expectedJson.length > 12) return false;
  return value.expectedJson.every((assertion) => isObject(assertion)
    && hasExactKeys(assertion, ["pointer", "equalsType", "equalsHmacSha256"])
    && isSafeText(assertion.pointer, 1_024)
    && (assertion.equalsType === "null" || assertion.equalsType === "boolean"
      || assertion.equalsType === "number" || assertion.equalsType === "string")
    && typeof assertion.equalsHmacSha256 === "string" && SHA256.test(assertion.equalsHmacSha256));
}

function isUiReproductionStep(value: unknown): boolean {
  if (!isObject(value) || typeof value.action !== "string") return false;
  switch (value.action) {
    case "open":
      return hasExactKeys(value, ["action", "path"]) && isSafeText(value.path, 2_048);
    case "click":
      return hasExactKeys(value, ["action", "selector"]) && isSafeText(value.selector, 2_048);
    case "fill":
      return hasExactKeys(value, ["action", "selector", "value"])
        && isSafeText(value.selector, 2_048) && value.value === "[REDACTED_FILL]";
    case "press":
      return hasExactKeys(value, ["action", "key"]) && isSafeText(value.key, 128);
    case "expect_text":
      return hasExactKeys(value, ["action", "text"]) && isSafeText(value.text, 2_048);
    case "screenshot":
      return hasExactKeys(value, ["action", "label"]) && isSafeText(value.label, 512);
    default:
      return false;
  }
}

function isCorrectionReproduction(value: unknown, modality: unknown): value is CorrectionReproduction {
  if (!isObject(value) || value.modality !== modality) return false;
  if (modality === "ui") {
    return hasExactKeys(value, ["modality", "steps"])
      && Array.isArray(value.steps) && value.steps.length > 0 && value.steps.length <= 12
      && value.steps.every(isUiReproductionStep);
  }
  if (modality === "api") {
    return hasExactKeys(value, ["modality", "request"])
      && isObject(value.request)
      && hasExactKeys(value.request, ["method", "path", "expectedStatus"])
      && value.request.method === "GET"
      && isSafeText(value.request.path, 2_048)
      && isHttpStatus(value.request.expectedStatus);
  }
  if (modality === "data") {
    return hasExactKeys(value, ["modality", "request"])
      && isSafeDataRequestDescriptor(value.request);
  }
  if (modality === "job") {
    return hasExactKeys(value, ["modality", "request"])
      && isObject(value.request)
      && hasExactKeys(value.request, ["trigger", "readback"])
      && isObject(value.request.trigger)
      && hasExactKeys(value.request.trigger, ["method", "path", "expectedStatus"])
      && value.request.trigger.method === "POST"
      && isSafeText(value.request.trigger.path, 2_048)
      && isHttpStatus(value.request.trigger.expectedStatus)
      && isSafeDataRequestDescriptor(value.request.readback);
  }
  return false;
}

function isAcceptanceCorrectionPacket(value: unknown): value is AcceptanceCorrectionPacket {
  if (!isObject(value) || containsSecretShapedValue(value) || !hasExactKeys(value, [
    "kind", "version", "packetId", "workspaceId", "repo", "prNumber", "headSha", "recordId", "jobId",
    "acceptanceContract", "criterion", "basis", "state", "expected", "observed", "affectedContext", "evidence",
    "scopeBoundary", "impact", "requiredCorrection", "reverification",
  ])) return false;
  if (!isObject(value.acceptanceContract)
    || !hasExactKeys(value.acceptanceContract, ["id", "version"])
    || typeof value.acceptanceContract.id !== "string" || !UUID.test(value.acceptanceContract.id)
    || !isPositiveInteger(value.acceptanceContract.version)
    || !isObject(value.criterion)
    || !hasExactKeys(value.criterion, ["id", "snapshot"])
    || !isSafeText(value.criterion.id, 512)
    || !isSafeText(value.criterion.snapshot, 2_000)
    || !isObject(value.affectedContext)
    || !hasExactKeys(value.affectedContext, ["modality", "environmentKind", "flow", "reproduction"])
    || (value.affectedContext.modality !== "ui" && value.affectedContext.modality !== "api"
      && value.affectedContext.modality !== "data" && value.affectedContext.modality !== "job")
    || (value.affectedContext.environmentKind !== null
      && value.affectedContext.environmentKind !== "isolated_preview")
    || !isSafeText(value.affectedContext.flow, 2_000)
    || !isCorrectionReproduction(value.affectedContext.reproduction, value.affectedContext.modality)
    || !isObject(value.evidence)
    || !Object.keys(value.evidence).every((key) =>
      key === "evidenceRef" || key === "artifactKey" || key === "executionId" || key === "previewBootId")
    || !Object.prototype.hasOwnProperty.call(value.evidence, "evidenceRef")
    || !Object.prototype.hasOwnProperty.call(value.evidence, "previewBootId")
    || !isSafeText(value.evidence.evidenceRef, 2_000)
    || !isOptionalSafeText(value.evidence, "artifactKey", 2_000)
    || !isOptionalSafeText(value.evidence, "executionId", 512)
    || !isSafeText(value.evidence.previewBootId, 512)) return false;
  return value.kind === "review_job_correction_packet"
    && value.version === 1
    && typeof value.packetId === "string" && CORRECTION_PACKET_ID.test(value.packetId)
    && typeof value.workspaceId === "string" && UUID.test(value.workspaceId)
    && isSafeRepo(value.repo)
    && isPositiveInteger(value.prNumber)
    && typeof value.headSha === "string" && SHA1.test(value.headSha)
    && typeof value.recordId === "string" && UUID.test(value.recordId)
    && typeof value.jobId === "string" && UUID.test(value.jobId)
    && value.basis === "acceptance_contract"
    && (value.state === "failed" || value.state === "not_proven")
    && isSafeText(value.expected, 2_000)
    && value.expected === value.criterion.snapshot
    && isSafeText(value.observed, 2_000)
    && isSafeText(value.scopeBoundary, 2_000)
    && isSafeText(value.impact, 2_000)
    && isSafeText(value.requiredCorrection, 2_000)
    && isSafeText(value.reverification, 2_000);
}

type AcceptanceRecordDetailRecord = Extract<AcceptanceRecordDetailEnvelope, { kind: "record" }>["detail"];
type AcceptanceRecordDetailOccurrence = SerializedDates<DbAcceptanceRecordDetailOccurrence>;
type AcceptanceRecordDetailProofCycle = AcceptanceRecordDetailRecord["proofMatrix"][number];
type AcceptanceGatedIssueCurrentProjection = Extract<
  AcceptanceRecordDetailRecord["gatedIssue"],
  { kind: "current" }
>;
type AcceptanceGatedIssue = NonNullable<AcceptanceGatedIssueCurrentProjection["issue"]>;
type AcceptanceRecordDetailCorrectionProof = Extract<
  AcceptanceRecordDetailRecord["proofMatrix"][number]["criteria"][number]["proof"],
  { kind: "correction_packet" }
>;
type AcceptanceRecordDetailCorrectionPacket = AcceptanceRecordDetailCorrectionProof["packet"];

const DETAIL_UNAVAILABLE_REASONS = new Set([
  "invalid_record_custody",
  "confirmed_contract_unavailable",
  "event_custody_limit",
  "snapshot_custody_limit",
  "compiled_pack_custody_limit",
  "invalid_occurrence_custody",
  "invalid_review_custody",
  "invalid_context_custody",
  "invalid_compiled_pack_custody",
  "detail_output_limit",
]);

const SUMMARY_UNKNOWN_REASONS = new Set([
  "requested_work_not_confirmed", "invalid_contract_custody",
  "head_occurrence_not_authoritative", "invalid_head_custody",
  "context_not_recorded", "ambiguous_context_custody", "invalid_context_custody",
  "proof_not_recorded", "invalid_review_custody",
  "decision_not_recorded", "invalid_decision_custody",
  "outcome_not_recorded", "invalid_merge_custody", "invalid_post_merge_custody",
  "summary_custody_limit",
]);
const DETAIL_MAX_COMPARE_FILES = 299;
const DETAIL_MAX_HEAD_RANGES = 128;
const DETAIL_MAX_HEAD_LINE = 1_000_000;
const DETAIL_MAX_PATCH_BYTES = 2 * 1024 * 1024;
const DETAIL_MAX_PACK_SOURCES = 64;
const DETAIL_MAX_SOURCE_RECORDS = 128;
const DETAIL_MAX_SOURCE_FILE_BYTES = 256 * 1024;
const DETAIL_MAX_SOURCE_RECORD_BYTES = 1024 * 1024;
const DETAIL_MAX_DIRECT_READS = 16;
const DETAIL_MAX_DIRECT_BYTES = 512 * 1024;
const DETAIL_MAX_SELECTED_RANGES = 64;

function isManifestExclusionReason(value: unknown): value is string {
  return value === "removed_at_exact_head" || value === "missing_patch_ranges"
    || value === "range_byte_limit" || value === "range_byte_or_secret_limit"
    || value === "unsupported_dependency_expression" || value === "dependency_limit"
    || value === "dependency_not_found" || value === "base_index_gap"
    || value === "base_index_stale" || value === "base_index_content_limit"
    || value === "base_index_secret_policy" || value === "base_index_page_limit"
    || value === "pack_budget"
    || (typeof value === "string" && /^dependency_(?:invalid_input|github_unavailable|github_rejected|invalid_tree|tree_limit|call_limit|invalid_blob|path_not_found|content_limit|unsafe_content|unsafe_path)$/u.test(value));
}

function isDirectReadNotProvenReason(value: unknown): value is string {
  return value === "invalid_input" || value === "github_unavailable" || value === "github_rejected"
    || value === "invalid_tree" || value === "tree_limit" || value === "call_limit"
    || value === "invalid_blob" || value === "path_not_found" || value === "content_limit"
    || value === "unsafe_content" || value === "unsafe_path";
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function isSha1(value: unknown): value is string {
  return typeof value === "string" && SHA1.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function isSafePath(value: unknown): value is string {
  return isSafeText(value, 512) && !value.startsWith("/") && !value.includes("\\")
    && value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function isNullableSafePath(value: unknown): value is string | null {
  return value === null || isSafePath(value);
}

function isStringList(value: unknown, maxItems = 100, maxChars = 2_000): value is string[] {
  return Array.isArray(value) && value.length <= maxItems
    && value.every((item) => isSafeText(item, maxChars));
}

function isSortedUniqueStringList(value: unknown, maxItems = 100, maxChars = 2_000): value is string[] {
  return isStringList(value, maxItems, maxChars)
    && value.every((item, index) => index === 0 || value[index - 1]! < item);
}

function isContractIdentity(value: unknown): value is { id: string; version: number; sha256: string } {
  return isObject(value) && hasExactKeys(value, ["id", "version", "sha256"])
    && isUuid(value.id) && isPositiveInteger(value.version) && isSha256(value.sha256);
}

function isContractCriterion(value: unknown): boolean {
  if (!isObject(value)) return false;
  const keys = Object.prototype.hasOwnProperty.call(value, "modality")
    ? ["id", "text", "userVisible", "modality"]
    : ["id", "text", "userVisible"];
  return hasExactKeys(value, keys)
    && isSafeText(value.id, 512) && isSafeText(value.text, 2_000)
    && typeof value.userVisible === "boolean"
    && (!Object.prototype.hasOwnProperty.call(value, "modality")
      || value.modality === "ui" || value.modality === "api"
      || value.modality === "data" || value.modality === "job");
}

function isSafeContractValue(value: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return isSafeText(value, 2_000);
  if (Array.isArray(value)) return value.length <= 64
    && value.every((item) => isSafeContractValue(item, depth + 1));
  if (!isObject(value) || Object.keys(value).length > 32) return false;
  return Object.entries(value).every(([key, nested]) => isSafeText(key, 128)
    && isSafeContractValue(nested, depth + 1));
}

function isConfirmedContractProjection(value: unknown): boolean {
  if (!isObject(value) || !hasExactKeys(value, [
    "originalRequest", "normalizedRequirements", "acceptanceCriteria", "nonGoals",
    "risks", "stops", "environment", "unresolvedQuestions",
  ]) || !isSafeText(value.originalRequest, 4_000)
    || !isStringList(value.normalizedRequirements)
    || !Array.isArray(value.acceptanceCriteria) || value.acceptanceCriteria.length === 0
    || value.acceptanceCriteria.length > 100
    || !isStringList(value.nonGoals) || !isStringList(value.risks) || !isStringList(value.stops)
    || !isObject(value.environment) || !isSafeContractValue(value.environment)
    || !Array.isArray(value.unresolvedQuestions) || value.unresolvedQuestions.length > 100) return false;
  const criterionIds = new Set<string>();
  for (const criterion of value.acceptanceCriteria) {
    if (!isContractCriterion(criterion) || !isObject(criterion)
      || typeof criterion.id !== "string" || criterionIds.has(criterion.id)) return false;
    criterionIds.add(criterion.id);
  }
  const questionIds = new Set<string>();
  return value.unresolvedQuestions.every((question) => {
    if (!isObject(question) || !hasExactKeys(question, ["id", "text"])
      || !isSafeText(question.id, 512) || !isSafeText(question.text, 2_000)
      || questionIds.has(question.id)) return false;
    questionIds.add(question.id);
    return true;
  });
}

function isSummarySourceSnapshot(value: unknown): boolean {
  return isObject(value) && hasExactKeys(value, [
    "id", "headSha", "headCycleId", "compilerVersion", "packetSetSha256",
  ]) && isUuid(value.id) && isSha1(value.headSha) && isUuid(value.headCycleId)
    && isSafeText(value.compilerVersion, 256) && isSha256(value.packetSetSha256);
}

function isSummaryCompiledPack(value: unknown): boolean {
  return isObject(value) && hasExactKeys(value, [
    "id", "sha256", "sourceCustodyIdentitySha256", "compilerVersion", "policyVersion",
  ]) && isUuid(value.id) && isSha256(value.sha256)
    && isSha256(value.sourceCustodyIdentitySha256)
    && isSafeText(value.compilerVersion, 256) && isSafeText(value.policyVersion, 256);
}

function isSummaryPullRequest(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.kind === "not_attached") return hasExactKeys(value, ["kind"]);
  if (value.kind !== "attached" || !hasExactKeys(value, ["kind", "prNumber", "head"])
    || !isPositiveInteger(value.prNumber) || !isObject(value.head)) return false;
  if (value.head.kind === "unknown") return hasExactKeys(value.head, ["kind"]);
  return (value.head.kind === "current" || value.head.kind === "merged")
    && hasExactKeys(value.head, ["kind", "sha", "headCycleId", "authorityGeneration"])
    && isSha1(value.head.sha) && isUuid(value.head.headCycleId)
    && isNonNegativeInteger(value.head.authorityGeneration);
}

function isSummaryProof(value: unknown, repo: string, prNumber: number | null): boolean {
  if (!isObject(value)) return false;
  if (value.kind === "unknown") return hasExactKeys(value, ["kind"]);
  return value.kind === "recorded" && prNumber !== null
    && hasExactKeys(value, [
      "kind", "reviewJobId", "verdict", "postedReviewUrl", "postedAttestationEventId",
    ]) && isUuid(value.reviewJobId)
    && (value.verdict === "proven" || value.verdict === "failed"
      || value.verdict === "not_proven" || value.verdict === "not_testable")
    && isGithubReviewUrl(value.postedReviewUrl, repo, prNumber)
    && isUuid(value.postedAttestationEventId);
}

function isSummaryNeededDecision(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.kind === "unknown") return hasExactKeys(value, ["kind"]);
  if (value.kind === "required") {
    return hasExactKeys(value, ["kind", "choices"]) && Array.isArray(value.choices)
      && value.choices.length > 0 && value.choices.length <= 4
      && new Set(value.choices).size === value.choices.length
      && value.choices.every(isAcceptancePrDecision);
  }
  if (value.kind === "recorded") {
    return hasExactKeys(value, ["kind", "eventId", "decision", "decidedAt"])
      && isUuid(value.eventId) && isAcceptancePrDecision(value.decision)
      && isIsoTimestamp(value.decidedAt);
  }
  return value.kind === "not_required" && hasExactKeys(value, ["kind", "reason"])
    && (value.reason === "pr_not_attached" || value.reason === "merged" || value.reason === "reverted");
}

function isSummaryOutcome(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.kind === "unknown" || value.kind === "not_recorded") {
    return hasExactKeys(value, ["kind"]);
  }
  return value.kind === "signed_merge" && hasExactKeys(value, [
    "kind", "mergeEventId", "mergeSha", "mergedAt", "decisionAlignment", "postMerge",
  ]) && isUuid(value.mergeEventId) && isSha1(value.mergeSha) && isIsoTimestamp(value.mergedAt)
    && (value.decisionAlignment === "aligned"
      || value.decisionAlignment === "decision_conflicts_merge"
      || value.decisionAlignment === "not_recorded"
      || value.decisionAlignment === "not_current"
      || value.decisionAlignment === "custody_unavailable")
    && isObject(value.postMerge)
    && hasExactKeys(value.postMerge, ["deployment", "incident", "revert"])
    && [value.postMerge.deployment, value.postMerge.incident, value.postMerge.revert]
      .every((item) => item === "recorded" || item === "not_recorded");
}

function isAcceptanceRecordSummary(value: unknown): boolean {
  if (!isObject(value) || !hasExactKeys(value, [
    "recordId", "workspaceId", "repo", "issueNumber", "createdAt", "updatedAt",
    "requestedWork", "suppliedContext", "pullRequest", "proof", "unknownReasons",
    "neededDecision", "outcome",
  ]) || !isUuid(value.recordId) || !isUuid(value.workspaceId) || !isSafeRepo(value.repo)
    || (value.issueNumber !== null && !isPositiveInteger(value.issueNumber))
    || !isIsoTimestamp(value.createdAt) || !isIsoTimestamp(value.updatedAt)
    || !isObject(value.requestedWork) || !isObject(value.suppliedContext)
    || !isSummaryPullRequest(value.pullRequest)
    || !Array.isArray(value.unknownReasons) || value.unknownReasons.length > SUMMARY_UNKNOWN_REASONS.size
    || !value.unknownReasons.every((reason) => typeof reason === "string" && SUMMARY_UNKNOWN_REASONS.has(reason))
    || new Set(value.unknownReasons).size !== value.unknownReasons.length
    || !isSummaryNeededDecision(value.neededDecision) || !isSummaryOutcome(value.outcome)) return false;
  if (value.requestedWork.kind === "unknown") {
    if (!hasExactKeys(value.requestedWork, ["kind"])) return false;
  } else if (value.requestedWork.kind !== "confirmed"
    || !hasExactKeys(value.requestedWork, ["kind", "originalRequest", "acceptanceContract"])
    || !isSafeText(value.requestedWork.originalRequest, 4_000)
    || !isContractIdentity(value.requestedWork.acceptanceContract)) return false;
  if (value.suppliedContext.kind === "unknown") {
    if (!hasExactKeys(value.suppliedContext, ["kind"])) return false;
  } else if (value.suppliedContext.kind === "compiled") {
    if (!hasExactKeys(value.suppliedContext, ["kind", "sourceSnapshot", "compiledPack"])
      || !isSummarySourceSnapshot(value.suppliedContext.sourceSnapshot)
      || !isSummaryCompiledPack(value.suppliedContext.compiledPack)) return false;
  } else if ((value.suppliedContext.kind !== "admitted" && value.suppliedContext.kind !== "not_proven")
    || !hasExactKeys(value.suppliedContext, ["kind", "sourceSnapshot"])
    || !isSummarySourceSnapshot(value.suppliedContext.sourceSnapshot)) return false;
  const summaryPrNumber = isObject(value.pullRequest) && value.pullRequest.kind === "attached"
    && typeof value.pullRequest.prNumber === "number" ? value.pullRequest.prNumber : null;
  return isSummaryProof(value.proof, value.repo, summaryPrNumber);
}

function isDetailReviewJob(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.kind === "not_recorded") return hasExactKeys(value, ["kind"]);
  return value.kind === "recorded" && hasExactKeys(value, [
    "kind", "id", "state", "createdAt", "updatedAt",
  ]) && isUuid(value.id)
    && (value.state === "queued" || value.state === "running" || value.state === "posted"
      || value.state === "failed" || value.state === "superseded" || value.state === "skipped")
    && isIsoTimestamp(value.createdAt) && isIsoTimestamp(value.updatedAt);
}

function isOccurrenceIdentity(value: unknown): boolean {
  return isObject(value) && isSafeRepo(value.repo) && isPositiveInteger(value.prNumber)
    && isSha1(value.headSha) && isUuid(value.headCycleId);
}

function isDetailOccurrence(value: unknown): value is AcceptanceRecordDetailOccurrence {
  if (!isObject(value) || !isOccurrenceIdentity(value) || !isDetailReviewJob(value.reviewJob)) return false;
  if (value.kind === "historical") {
    return hasExactKeys(value, ["repo", "prNumber", "headSha", "headCycleId", "kind", "reviewJob"]);
  }
  if (value.kind === "current") {
    return hasExactKeys(value, [
      "repo", "prNumber", "headSha", "headCycleId", "kind", "authorityGeneration", "reviewJob",
    ]) && isNonNegativeInteger(value.authorityGeneration);
  }
  return value.kind === "merged" && hasExactKeys(value, [
    "repo", "prNumber", "headSha", "headCycleId", "kind", "authorityGeneration",
    "mergeEventId", "mergeSha", "mergedAt", "reviewJob",
  ]) && isNonNegativeInteger(value.authorityGeneration) && isUuid(value.mergeEventId)
    && isSha1(value.mergeSha) && isIsoTimestamp(value.mergedAt);
}

function isDetailPullRequest(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.kind === "not_attached") {
    return hasExactKeys(value, ["kind", "occurrences"])
      && Array.isArray(value.occurrences) && value.occurrences.length === 0;
  }
  if (value.kind !== "attached" || !hasExactKeys(value, [
    "kind", "prNumber", "current", "merged", "occurrences",
  ]) || !isPositiveInteger(value.prNumber)
    || (value.current !== null && (!isDetailOccurrence(value.current) || value.current.kind !== "current"))
    || (value.merged !== null && (!isDetailOccurrence(value.merged) || value.merged.kind !== "merged"))
    || !Array.isArray(value.occurrences) || value.occurrences.length > 128) return false;
  const ids = new Set<string>();
  let previousRank = -1;
  for (const occurrence of value.occurrences) {
    if (!isDetailOccurrence(occurrence) || occurrence.prNumber !== value.prNumber
      || ids.has(occurrence.headCycleId)) return false;
    const rank = occurrence.kind === "current" ? 0 : occurrence.kind === "merged" ? 1 : 2;
    if (rank < previousRank) return false;
    ids.add(occurrence.headCycleId);
    previousRank = rank;
  }
  const currentMatches = value.current === null
    ? value.occurrences.every((item) => item.kind !== "current")
    : value.occurrences.some((item) => exactJsonEqual(item, value.current));
  const mergedMatches = value.merged === null
    ? value.occurrences.every((item) => item.kind !== "merged")
    : value.occurrences.some((item) => exactJsonEqual(item, value.merged));
  return currentMatches && mergedMatches;
}

function isBaseIndexIdentity(value: unknown): boolean {
  if (!isObject(value) || !hasExactKeys(value, [
    "schemaVersion", "revisionSha256", "backgroundOnly", "pages", "gaps",
  ]) || value.schemaVersion !== 2 || value.backgroundOnly !== true
    || !isSha256(value.revisionSha256) || !Array.isArray(value.pages)
    || value.pages.length > 100 || !isStringList(value.gaps, 100, 1_024)
    || (value.pages.length === 0 && value.gaps.length === 0)
    || new Set(value.gaps).size !== value.gaps.length
    || !value.gaps.every((gap, index, gaps) => index === 0 || gaps[index - 1]! < gap)) return false;
  const pages = value.pages;
  const pageIds = new Set<string>();
  return pages.every((page, index) => {
    if (!isObject(page) || !hasExactKeys(page, [
      "id", "repositoryId", "slug", "commitSha", "inputsHashSha256", "pageBodySha256", "stale",
    ]) || !isUuid(page.id) || !isUuid(page.repositoryId)
      || !isSafePath(page.slug) || !isSha1(page.commitSha)
      || !isSha256(page.inputsHashSha256) || !isSha256(page.pageBodySha256)
      || typeof page.stale !== "boolean" || pageIds.has(page.id)
      || (index > 0 && isObject(pages[index - 1])
        && `${pages[index - 1].slug}\u0000${pages[index - 1].id}` >= `${page.slug}\u0000${page.id}`)) return false;
    pageIds.add(page.id);
    return true;
  });
}

function isLineRange(value: unknown, coordinate = false): boolean {
  return isObject(value)
    && hasExactKeys(value, coordinate ? ["startLine", "endLine", "coordinateSha256"] : ["startLine", "endLine"])
    && isPositiveInteger(value.startLine) && isPositiveInteger(value.endLine)
    && (value.startLine as number) <= DETAIL_MAX_HEAD_LINE
    && (value.endLine as number) <= DETAIL_MAX_HEAD_LINE
    && (value.startLine as number) <= (value.endLine as number)
    && (!coordinate || isSha256(value.coordinateSha256));
}

function isOrderedLineRanges(value: unknown, coordinate = false): value is Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > DETAIL_MAX_HEAD_RANGES) return false;
  let previousEnd = 0;
  for (const range of value) {
    if (!isLineRange(range, coordinate) || !isObject(range)
      || typeof range.startLine !== "number" || typeof range.endLine !== "number"
      || range.startLine <= previousEnd) return false;
    previousEnd = range.endLine;
  }
  return true;
}

function isOverlayIdentity(value: unknown): boolean {
  if (!isObject(value) || !hasExactKeys(value, [
    "schemaVersion", "manifestSha256", "baseSha", "mergeBaseSha", "headSha", "files",
  ]) || value.schemaVersion !== 2 || !isSha256(value.manifestSha256)
    || !isSha1(value.baseSha) || !isSha1(value.mergeBaseSha) || !isSha1(value.headSha)
    || !Array.isArray(value.files) || value.files.length === 0
    || value.files.length > DETAIL_MAX_COMPARE_FILES) return false;
  const files = value.files;
  const paths = new Set<string>();
  return files.every((file, index) => {
    if (!isObject(file) || !hasExactKeys(file, [
      "path", "status", "blobSha", "previousPath", "patchSha256", "patchByteCount", "headRanges",
    ]) || !isSafePath(file.path)
      || (file.status !== "added" && file.status !== "modified" && file.status !== "removed"
        && file.status !== "renamed" && file.status !== "copied" && file.status !== "changed")
      || (file.status === "removed"
        ? file.blobSha !== null && !isSha1(file.blobSha)
        : !isSha1(file.blobSha))
      || (file.status === "renamed"
        ? !isSafePath(file.previousPath) || file.previousPath === file.path
        : file.previousPath !== null)
      || (file.patchSha256 !== null && !isSha256(file.patchSha256))
      || (file.patchByteCount !== null && (!isPositiveInteger(file.patchByteCount)
        || (file.patchByteCount as number) > DETAIL_MAX_PATCH_BYTES))
      || (file.patchSha256 === null) !== (file.patchByteCount === null)
      || !isOrderedLineRanges(file.headRanges, true)
      || (file.patchSha256 === null ? file.headRanges.length !== 0 : file.headRanges.length === 0)
      || paths.has(file.path)
      || (index > 0 && isObject(files[index - 1])
        && String(files[index - 1].path) >= file.path)) return false;
    paths.add(file.path);
    return true;
  });
}

function isContextProvenance(value: unknown): boolean {
  if (!isObject(value) || !hasExactKeys(value, ["schemaVersion", "included", "excluded"])
    || value.schemaVersion !== 1 || !Array.isArray(value.included) || !Array.isArray(value.excluded)
    || value.included.length > 1_000 || value.excluded.length > 1_000) return false;
  return value.included.every((item) => isObject(item)
    && hasExactKeys(item, ["path", "source", "reason"]) && isSafePath(item.path)
    && (item.source === "base_index" || item.source === "overlay") && isSafeText(item.reason, 2_000))
    && value.excluded.every((item) => isObject(item)
      && hasExactKeys(item, ["path", "source", "reason"])
      && (item.path === null || isSafePath(item.path))
      && (item.source === "base_index" || item.source === "overlay") && isSafeText(item.reason, 2_000));
}

function occurrenceCoreMatches(left: unknown, right: AcceptanceRecordDetailOccurrence): boolean {
  return isObject(left) && left.repo === right.repo && left.prNumber === right.prNumber
    && left.headSha === right.headSha && left.headCycleId === right.headCycleId
    && left.kind === right.kind;
}

function isDetailSourceSnapshot(
  value: unknown,
  occurrence: AcceptanceRecordDetailOccurrence,
  workspaceId: string,
  recordId: string,
  contract: { id: string; version: number; sha256: string },
): boolean {
  if (!isObject(value) || !hasExactKeys(value, [
    "id", "occurrence", "binding", "baseSha", "mergeBaseSha", "headTreeSha", "packetIds",
    "packetSetSha256", "correctionPacketPayloadSetSha256", "compilerVersion", "baseIndex",
    "overlay", "provenance", "status", "reason", "createdAt", "updatedAt",
  ]) || !isUuid(value.id) || !occurrenceCoreMatches(value.occurrence, occurrence)
    || !isObject(value.binding) || !hasExactKeys(value.binding, [
      "workspaceId", "recordId", "reviewJobId", "acceptanceContract", "repo", "prNumber", "expectedHeadSha",
    ]) || value.binding.workspaceId !== workspaceId || value.binding.recordId !== recordId
    || !isUuid(value.binding.reviewJobId) || value.binding.reviewJobId !== occurrence.headCycleId
    || !isContractIdentity(value.binding.acceptanceContract)
    || !exactJsonEqual(value.binding.acceptanceContract, contract)
    || value.binding.repo !== occurrence.repo || value.binding.prNumber !== occurrence.prNumber
    || value.binding.expectedHeadSha !== occurrence.headSha
    || (value.baseSha !== null && !isSha1(value.baseSha))
    || (value.mergeBaseSha !== null && !isSha1(value.mergeBaseSha))
    || (value.headTreeSha !== null && !isSha1(value.headTreeSha))
    || !Array.isArray(value.packetIds) || value.packetIds.length === 0 || value.packetIds.length > 100
    || !value.packetIds.every((id) => typeof id === "string" && CORRECTION_PACKET_ID.test(id))
    || !value.packetIds.every((id, index, ids) => index === 0 || ids[index - 1]! < id)
    || !isSha256(value.packetSetSha256) || !isSha256(value.correctionPacketPayloadSetSha256)
    || !isSafeText(value.compilerVersion, 256)
    || (value.baseIndex !== null && !isBaseIndexIdentity(value.baseIndex))
    || (value.overlay !== null && !isOverlayIdentity(value.overlay))
    || !isContextProvenance(value.provenance)
    || (value.status !== "admitted" && value.status !== "not_proven")
    || (value.reason !== null && !isSafeText(value.reason, 2_000))
    || !isIsoTimestamp(value.createdAt) || !isIsoTimestamp(value.updatedAt)) return false;
  return value.status === "not_proven"
    ? value.reason !== null
    : value.reason === null && value.baseSha !== null && value.mergeBaseSha !== null
      && value.headTreeSha !== null && value.baseIndex !== null && value.overlay !== null;
}

function isCompiledPackSource(value: unknown): boolean {
  if (!isObject(value) || typeof value.kind !== "string") return false;
  if (value.kind === "base_index_background") {
    return hasExactKeys(value, [
      "kind", "pageId", "slug", "commitSha", "inputsHashSha256", "pageBodySha256", "stale",
      "startLine", "endLine", "rangeSha256", "byteCount", "reason", "citation",
    ]) && isUuid(value.pageId) && isSafePath(value.slug)
      && isSha1(value.commitSha) && isSha256(value.inputsHashSha256) && isSha256(value.pageBodySha256)
      && value.stale === false && isPositiveInteger(value.startLine) && isPositiveInteger(value.endLine)
      && (value.startLine as number) <= DETAIL_MAX_HEAD_LINE
      && (value.endLine as number) <= DETAIL_MAX_HEAD_LINE
      && (value.startLine as number) <= (value.endLine as number)
      && isSha256(value.rangeSha256) && isPositiveInteger(value.byteCount)
      && (value.byteCount as number) <= 12 * 1024
      && value.reason === "background_only"
      && value.citation === `wiki:${value.slug}@${value.commitSha}#L${value.startLine}-L${value.endLine}`;
  }
  return (value.kind === "exact_head_overlay" || value.kind === "exact_head_dependency")
    && hasExactKeys(value, [
      "kind", "path", "blobSha", "fullContentSha256", "startLine", "endLine", "rangeSha256",
      "byteCount", "reason", "citation",
    ]) && isSafePath(value.path) && isSha1(value.blobSha) && isSha256(value.fullContentSha256)
    && isPositiveInteger(value.startLine) && isPositiveInteger(value.endLine)
    && (value.startLine as number) <= DETAIL_MAX_HEAD_LINE
    && (value.endLine as number) <= DETAIL_MAX_HEAD_LINE
    && (value.startLine as number) <= (value.endLine as number)
    && isSha256(value.rangeSha256) && isPositiveInteger(value.byteCount)
    && (value.byteCount as number) <= 12 * 1024
    && (value.kind === "exact_head_overlay"
      ? value.reason === "exact_patch_head_range"
      : value.reason === "static_relative_import" || value.reason === "static_python_import"
        || value.reason === "static_shell_source")
    && value.citation === `${value.path}@${value.blobSha}#L${value.startLine}-L${value.endLine}`;
}

function compiledPackSourceKey(value: unknown): string | null {
  if (!isObject(value) || typeof value.kind !== "string") return null;
  const identity = value.kind === "base_index_background" ? value.slug : value.path;
  return typeof identity === "string" && typeof value.startLine === "number" && typeof value.endLine === "number"
    ? `${value.kind}\u0000${identity}\u0000${String(value.startLine).padStart(10, "0")}\u0000${String(value.endLine).padStart(10, "0")}`
    : null;
}

function compiledPackExclusionKey(value: unknown): string | null {
  return isObject(value) && typeof value.source === "string" && typeof value.reason === "string"
    ? `${value.source}\u0000${value.path ?? ""}\u0000${value.reason}\u0000${value.identitySha256 ?? ""}`
    : null;
}

function isCompiledPackExclusion(value: unknown): boolean {
  if (!isObject(value)) return false;
  const hasIdentity = Object.prototype.hasOwnProperty.call(value, "identitySha256");
  return hasExactKeys(value, hasIdentity
    ? ["source", "path", "reason", "identitySha256"] : ["source", "path", "reason"])
    && (value.source === "exact_head_overlay" || value.source === "exact_head_dependency"
      || value.source === "base_index_background")
    && (value.path === null || isSafePath(value.path)) && isManifestExclusionReason(value.reason)
    && (!hasIdentity || isSha256(value.identitySha256));
}

function isSourceCustodyFile(value: unknown): boolean {
  return isObject(value) && hasExactKeys(value, [
    "path", "blobSha", "previousPath", "contentSha256", "byteCount", "lineCount", "source", "reason",
  ]) && isSafePath(value.path) && isSha1(value.blobSha) && value.previousPath === null
    && isSha256(value.contentSha256) && isNonNegativeInteger(value.byteCount)
    && (value.byteCount as number) <= DETAIL_MAX_SOURCE_FILE_BYTES
    && isPositiveInteger(value.lineCount) && (value.lineCount as number) <= DETAIL_MAX_HEAD_LINE
    && (value.source === "exact_head_overlay" || value.source === "exact_head_tree_fallback")
    && (value.reason === "exact_base_to_head_compare" || value.reason === "exact_head_tree_path");
}

function isSourceCustodyExclusion(value: unknown): boolean {
  if (!isObject(value) || !hasExactKeys(value, [
    "path", "source", "blobSha", "byteCount", "reason", "secretKinds", "findingCount",
  ]) || !isSafePath(value.path)
    || (value.source !== "exact_head_overlay" && value.source !== "exact_head_tree_fallback")
    || (value.blobSha !== null && !isSha1(value.blobSha))
    || (value.byteCount !== null && (!isNonNegativeInteger(value.byteCount)
      || (value.byteCount as number) > DETAIL_MAX_SOURCE_FILE_BYTES))
    || (value.reason !== "removed_at_exact_head" && value.reason !== "secret_path_policy"
      && value.reason !== "secret_content_policy")
    || !isStringList(value.secretKinds, 16, 128)
    || new Set(value.secretKinds).size !== value.secretKinds.length
    || !value.secretKinds.every((kind, index, kinds) => index === 0 || kinds[index - 1]! < kind)
    || !isNonNegativeInteger(value.findingCount) || (value.findingCount as number) > 1_024) return false;
  if (value.reason === "removed_at_exact_head") {
    return value.source === "exact_head_overlay" && value.blobSha === null && value.byteCount === null
      && value.secretKinds.length === 0 && value.findingCount === 0;
  }
  if (value.reason === "secret_path_policy") {
    return value.byteCount === null && value.secretKinds.length === 0 && value.findingCount === 0;
  }
  return value.blobSha !== null && value.byteCount !== null
    && value.secretKinds.length > 0 && (value.findingCount as number) > 0;
}

function isSelectedExactRange(value: unknown): boolean {
  return isObject(value) && hasExactKeys(value, [
    "kind", "path", "blobSha", "fullContentSha256", "startLine", "endLine", "rangeSha256", "byteCount",
  ]) && (value.kind === "exact_head_overlay" || value.kind === "exact_head_dependency")
    && isSafePath(value.path) && isSha1(value.blobSha) && isSha256(value.fullContentSha256)
    && isPositiveInteger(value.startLine) && isPositiveInteger(value.endLine)
    && (value.startLine as number) <= DETAIL_MAX_HEAD_LINE
    && (value.endLine as number) <= DETAIL_MAX_HEAD_LINE
    && (value.startLine as number) <= (value.endLine as number)
    && isSha256(value.rangeSha256) && isPositiveInteger(value.byteCount)
    && (value.byteCount as number) <= 12 * 1024;
}

function isDirectReadReceipt(value: unknown, headSha: string, headTreeSha: string): boolean {
  if (!isObject(value) || !isSafePath(value.requestedPath)
    || value.headSha !== headSha || value.headTreeSha !== headTreeSha) return false;
  if (value.outcome === "record") {
    return hasExactKeys(value, ["requestedPath", "headSha", "headTreeSha", "outcome", "record"])
      && isSourceCustodyFile(value.record) && isObject(value.record)
      && value.record.path === value.requestedPath
      && value.record.source === "exact_head_tree_fallback"
      && value.record.reason === "exact_head_tree_path";
  }
  const hasExclusion = Object.prototype.hasOwnProperty.call(value, "exclusion");
  return value.outcome === "not_proven"
    && hasExactKeys(value, hasExclusion
      ? ["requestedPath", "headSha", "headTreeSha", "outcome", "reason", "exclusion"]
      : ["requestedPath", "headSha", "headTreeSha", "outcome", "reason"])
    && isDirectReadNotProvenReason(value.reason)
    && (!hasExclusion || (isSourceCustodyExclusion(value.exclusion)
      && isObject(value.exclusion) && value.exclusion.source === "exact_head_tree_fallback"));
}

function isChangedManifestEntry(value: unknown): boolean {
  return isObject(value) && hasExactKeys(value, [
    "path", "status", "blobSha", "previousPath", "headRanges", "patchSha256", "patchByteCount",
  ]) && isSafePath(value.path)
    && (value.status === "added" || value.status === "modified" || value.status === "removed"
      || value.status === "renamed" || value.status === "copied" || value.status === "changed")
    && (value.blobSha === null || isSha1(value.blobSha)) && isNullableSafePath(value.previousPath)
    && Array.isArray(value.headRanges) && value.headRanges.length <= DETAIL_MAX_HEAD_RANGES
    && value.headRanges.every((range) => isLineRange(range))
    && (value.patchSha256 === null || isSha256(value.patchSha256))
    && (value.patchByteCount === null || (isPositiveInteger(value.patchByteCount)
      && (value.patchByteCount as number) <= DETAIL_MAX_PATCH_BYTES))
    && (value.patchSha256 === null) === (value.patchByteCount === null)
    && (value.patchSha256 === null ? value.headRanges.length === 0 : value.headRanges.length > 0);
}

function isDependencyTreeProof(value: unknown): boolean {
  return isObject(value) && hasExactKeys(value, ["path", "blobSha", "proofIdentitySha256"])
    && isSafePath(value.path) && isSha1(value.blobSha) && isSha256(value.proofIdentitySha256);
}

function isDetailCompiledPack(
  value: unknown,
  snapshot: Record<string, unknown>,
  occurrence: AcceptanceRecordDetailOccurrence,
  contract: Record<string, unknown>,
): boolean {
  if (!isObject(contract.identity) || !isContractIdentity(contract.identity)) return false;
  const contractIdentity = contract.identity;
  if (!isObject(value) || !hasExactKeys(value, [
    "id", "sourceSnapshotId", "compilerVersion", "policyVersion", "packSha256",
    "sourceCustodyIdentitySha256", "representations", "binding", "manifest", "sourceCustody",
    "exactHeadDependencyTreeProofs", "createdAt",
  ]) || !isUuid(value.id) || value.sourceSnapshotId !== snapshot.id
    || !isSafeText(value.compilerVersion, 256) || !isSafeText(value.policyVersion, 256)
    || !isSha256(value.packSha256) || !isSha256(value.sourceCustodyIdentitySha256)
    || !isObject(value.representations) || !hasExactKeys(value.representations, [
      "jsonSha256", "markdownSha256", "renderedByteCount",
    ]) || !isSha256(value.representations.jsonSha256) || !isSha256(value.representations.markdownSha256)
    || !isPositiveInteger(value.representations.renderedByteCount)
    || !isObject(value.binding) || !hasExactKeys(value.binding, [
      "sourceSnapshotId", "workspaceId", "recordId", "reviewJobId", "acceptanceContractId",
      "acceptanceContractVersion", "acceptanceContractSha256", "repo", "prNumber", "baseSha",
      "mergeBaseSha", "headSha", "headTreeSha", "packetSetSha256",
      "correctionPacketPayloadSetSha256", "sourceSnapshotCompilerVersion",
      "baseIndexRevisionSha256", "overlayManifestSha256",
    ]) || !isObject(snapshot.binding) || !isObject(snapshot.baseIndex)
    || !isObject(snapshot.overlay)) return false;
  const binding = value.binding;
  const snapshotBinding = snapshot.binding;
  const snapshotBaseIndex = snapshot.baseIndex;
  const snapshotOverlay = snapshot.overlay;
  if (binding.sourceSnapshotId !== snapshot.id || binding.workspaceId !== snapshotBinding.workspaceId
    || binding.recordId !== snapshotBinding.recordId || binding.reviewJobId !== snapshotBinding.reviewJobId
    || binding.acceptanceContractId !== contractIdentity.id
    || binding.acceptanceContractVersion !== contractIdentity.version
    || binding.acceptanceContractSha256 !== contractIdentity.sha256 || binding.repo !== occurrence.repo
    || binding.prNumber !== occurrence.prNumber || binding.baseSha !== snapshot.baseSha
    || binding.mergeBaseSha !== snapshot.mergeBaseSha || binding.headSha !== occurrence.headSha
    || binding.headTreeSha !== snapshot.headTreeSha || binding.packetSetSha256 !== snapshot.packetSetSha256
    || binding.correctionPacketPayloadSetSha256 !== snapshot.correctionPacketPayloadSetSha256
    || binding.sourceSnapshotCompilerVersion !== snapshot.compilerVersion
    || binding.baseIndexRevisionSha256 !== snapshotBaseIndex.revisionSha256
    || binding.overlayManifestSha256 !== snapshotOverlay.manifestSha256) return false;

  if (!isObject(value.manifest) || !hasExactKeys(value.manifest, [
    "acceptanceCriterionIds", "unresolvedQuestionIds", "packetIds", "sources", "exclusions",
    "sourceCount", "exclusionCount", "architectureBoundaries", "tests", "decisions", "custody",
  ]) || !isStringList(value.manifest.acceptanceCriterionIds, 100, 512)
    || !isStringList(value.manifest.unresolvedQuestionIds, 100, 512)
    || !Array.isArray(value.manifest.packetIds)
    || !value.manifest.packetIds.every((id) => typeof id === "string" && CORRECTION_PACKET_ID.test(id))
    || !exactJsonEqual(value.manifest.packetIds, snapshot.packetIds)
    || !Array.isArray(value.manifest.sources) || value.manifest.sources.length === 0
    || value.manifest.sources.length > DETAIL_MAX_PACK_SOURCES
    || !value.manifest.sources.every(isCompiledPackSource)
    || !value.manifest.sources.every((source, index, sources) => index === 0
      || (compiledPackSourceKey(sources[index - 1]) ?? "") < (compiledPackSourceKey(source) ?? ""))
    || !Array.isArray(value.manifest.exclusions)
    || value.manifest.exclusions.length > DETAIL_MAX_PACK_SOURCES
    || !value.manifest.exclusions.every(isCompiledPackExclusion)
    || !value.manifest.exclusions.every((exclusion, index, exclusions) => index === 0
      || (compiledPackExclusionKey(exclusions[index - 1]) ?? "") < (compiledPackExclusionKey(exclusion) ?? ""))
    || value.manifest.sourceCount !== value.manifest.sources.length
    || value.manifest.exclusionCount !== value.manifest.exclusions.length
    || !isSortedUniqueStringList(value.manifest.architectureBoundaries)
    || !isSortedUniqueStringList(value.manifest.tests)
    || !isSortedUniqueStringList(value.manifest.decisions)
    || !isObject(value.manifest.custody)
    || !hasExactKeys(value.manifest.custody, [
      "fullSourceUploadAllowed", "rawSourcePersisted", "snippetsPersisted",
    ]) || value.manifest.custody.fullSourceUploadAllowed !== false
    || value.manifest.custody.rawSourcePersisted !== false
    || value.manifest.custody.snippetsPersisted !== false) return false;
  if (!isObject(contract.contract)) return false;
  const contractProjection = contract.contract;
  if (!Array.isArray(contractProjection.acceptanceCriteria)
    || !Array.isArray(contractProjection.unresolvedQuestions)) return false;
  const acceptanceCriteria = contractProjection.acceptanceCriteria;
  const unresolvedQuestions = contractProjection.unresolvedQuestions;
  const criterionIds = acceptanceCriteria.map((item) => isObject(item) ? item.id : null);
  const questionIds = unresolvedQuestions.map((item) => isObject(item) ? item.id : null);
  if (!exactJsonEqual(value.manifest.acceptanceCriterionIds, criterionIds)
    || !exactJsonEqual(value.manifest.unresolvedQuestionIds, questionIds)) return false;

  if (!isObject(value.sourceCustody)) return false;
  const sourceCustody = value.sourceCustody;
  if (!isSha1(sourceCustody.headSha) || !isSha1(sourceCustody.headTreeSha)) return false;
  const custodyHeadSha = sourceCustody.headSha;
  const custodyHeadTreeSha = sourceCustody.headTreeSha;
  if (!hasExactKeys(sourceCustody, [
    "kind", "schemaVersion", "repo", "prNumber", "baseSha", "mergeBaseSha", "headSha",
    "headTreeSha", "manifestSha256", "identitySha256", "changedManifest", "records", "exclusions",
    "directReadReceipts", "selectedExactRanges", "changedFileCount", "recordCount", "exclusionCount",
    "directReadReceiptCount", "selectedExactRangeCount",
  ]) || sourceCustody.kind !== "exact_head_source_custody"
    || sourceCustody.schemaVersion !== 2 || sourceCustody.repo !== occurrence.repo
    || sourceCustody.prNumber !== occurrence.prNumber || sourceCustody.baseSha !== binding.baseSha
    || sourceCustody.mergeBaseSha !== binding.mergeBaseSha
    || sourceCustody.headSha !== occurrence.headSha || sourceCustody.headTreeSha !== binding.headTreeSha
    || !isSha256(sourceCustody.manifestSha256)
    || sourceCustody.identitySha256 !== value.sourceCustodyIdentitySha256
    || !Array.isArray(sourceCustody.changedManifest) || sourceCustody.changedManifest.length === 0
    || sourceCustody.changedManifest.length > DETAIL_MAX_COMPARE_FILES
    || !sourceCustody.changedManifest.every(isChangedManifestEntry)
    || !sourceCustody.changedManifest.every((item, index, items) => index === 0
      || (isObject(items[index - 1]) && isObject(item)
        && String(items[index - 1].path) < String(item.path)))
    || !Array.isArray(sourceCustody.records) || sourceCustody.records.length > DETAIL_MAX_SOURCE_RECORDS
    || !sourceCustody.records.every((record) => isSourceCustodyFile(record) && isObject(record)
      && record.source === "exact_head_overlay" && record.reason === "exact_base_to_head_compare")
    || !sourceCustody.records.every((record, index, records) => index === 0
      || (isObject(records[index - 1]) && isObject(record)
        && String(records[index - 1].path) < String(record.path)))
    || sourceCustody.records.reduce((total, record) => total + (
      isObject(record) && typeof record.byteCount === "number" ? record.byteCount : 0
    ), 0) > DETAIL_MAX_SOURCE_RECORD_BYTES
    || !Array.isArray(sourceCustody.exclusions)
    || sourceCustody.exclusions.length > DETAIL_MAX_COMPARE_FILES
    || !sourceCustody.exclusions.every((exclusion) => isSourceCustodyExclusion(exclusion)
      && isObject(exclusion) && exclusion.source === "exact_head_overlay")
    || !Array.isArray(sourceCustody.directReadReceipts)
    || sourceCustody.directReadReceipts.length > DETAIL_MAX_DIRECT_READS
    || !sourceCustody.directReadReceipts.every((receipt) =>
      isDirectReadReceipt(receipt, custodyHeadSha, custodyHeadTreeSha))
    || new Set(sourceCustody.directReadReceipts.map((receipt) =>
      isObject(receipt) ? receipt.requestedPath : null)).size !== sourceCustody.directReadReceipts.length
    || sourceCustody.directReadReceipts.reduce((total, receipt) => {
      if (!isObject(receipt) || !isObject(receipt.record) || typeof receipt.record.byteCount !== "number") return total;
      return total + receipt.record.byteCount;
    }, 0) > DETAIL_MAX_DIRECT_BYTES
    || !Array.isArray(sourceCustody.selectedExactRanges)
    || sourceCustody.selectedExactRanges.length > DETAIL_MAX_SELECTED_RANGES
    || !sourceCustody.selectedExactRanges.every(isSelectedExactRange)
    || !sourceCustody.selectedExactRanges.some((range) => isObject(range)
      && range.kind === "exact_head_overlay")
    || sourceCustody.changedFileCount !== sourceCustody.changedManifest.length
    || sourceCustody.recordCount !== sourceCustody.records.length
    || sourceCustody.exclusionCount !== sourceCustody.exclusions.length
    || sourceCustody.directReadReceiptCount !== sourceCustody.directReadReceipts.length
    || sourceCustody.selectedExactRangeCount !== sourceCustody.selectedExactRanges.length) return false;

  return Array.isArray(value.exactHeadDependencyTreeProofs)
    && value.exactHeadDependencyTreeProofs.length <= DETAIL_MAX_DIRECT_READS
    && value.exactHeadDependencyTreeProofs.every(isDependencyTreeProof)
    && value.exactHeadDependencyTreeProofs.every((proof, index, proofs) => {
      if (index === 0 || !isObject(proof) || !isObject(proofs[index - 1])) return index === 0;
      return `${proofs[index - 1].path}\u0000${proofs[index - 1].blobSha}`
        < `${proof.path}\u0000${proof.blobSha}`;
    })
    && isIsoTimestamp(value.createdAt);
}

function isDetailReview(value: unknown, occurrence: AcceptanceRecordDetailOccurrence): boolean {
  if (!isObject(value)) return false;
  if (value.kind === "not_recorded") return hasExactKeys(value, ["kind"]);
  if (value.kind === "not_posted") {
    return hasExactKeys(value, ["kind", "reviewJobId", "state"])
      && isUuid(value.reviewJobId) && value.reviewJobId === occurrence.headCycleId
      && (value.state === "queued" || value.state === "running" || value.state === "failed"
        || value.state === "superseded" || value.state === "skipped");
  }
  return value.kind === "posted" && hasExactKeys(value, [
    "kind", "reviewJobId", "verdict", "postedReviewUrl", "postedAttestationEventId", "reviewedAt",
  ]) && isUuid(value.reviewJobId) && value.reviewJobId === occurrence.headCycleId
    && (value.verdict === "proven" || value.verdict === "failed"
      || value.verdict === "not_proven" || value.verdict === "not_testable")
    && isGithubReviewUrl(value.postedReviewUrl, occurrence.repo, occurrence.prNumber)
    && isUuid(value.postedAttestationEventId) && isIsoTimestamp(value.reviewedAt);
}

function isDetailProofCycle(
  value: unknown,
  occurrence: AcceptanceRecordDetailOccurrence,
  contract: Record<string, unknown>,
  workspaceId: string,
  recordId: string,
): value is AcceptanceRecordDetailProofCycle {
  if (!isObject(value) || !hasExactKeys(value, ["occurrence", "review", "criteria"])
    || !occurrenceCoreMatches(value.occurrence, occurrence)
    || !isDetailReview(value.review, occurrence) || !Array.isArray(value.criteria)
    || !isObject(contract.contract)) return false;
  const contractProjection = contract.contract;
  if (!Array.isArray(contractProjection.acceptanceCriteria)
    || value.criteria.length !== contractProjection.acceptanceCriteria.length) return false;
  const acceptanceCriteria = contractProjection.acceptanceCriteria;
  const reviewKind = isObject(value.review) ? value.review.kind : null;
  return value.criteria.every((item, index) => {
    const expectedCriterion = acceptanceCriteria[index];
    if (!isObject(item) || !hasExactKeys(item, ["criterion", "proof"])
      || !isContractCriterion(item.criterion) || !exactJsonEqual(item.criterion, expectedCriterion)
      || !isObject(item.proof)) return false;
    if (item.proof.kind === "unknown") {
      if (!hasExactKeys(item.proof, ["kind", "reason"])) return false;
      return reviewKind === "not_recorded"
        ? item.proof.reason === "review_not_recorded"
        : reviewKind === "not_posted"
          ? item.proof.reason === "review_not_posted"
          : item.proof.reason === "criterion_result_not_durably_rederivable";
    }
    if (item.proof.kind !== "correction_packet"
      || !hasExactKeys(item.proof, ["kind", "state", "packet"])
      || (item.proof.state !== "failed" && item.proof.state !== "not_proven")
      || !isAcceptanceCorrectionPacket(item.proof.packet) || !isObject(item.criterion)
      || item.proof.packet.state !== item.proof.state
      || item.proof.packet.workspaceId !== workspaceId || item.proof.packet.recordId !== recordId
      || item.proof.packet.repo !== occurrence.repo || item.proof.packet.prNumber !== occurrence.prNumber
      || item.proof.packet.headSha !== occurrence.headSha || item.proof.packet.jobId !== occurrence.headCycleId
      || item.proof.packet.criterion.id !== item.criterion.id
      || item.proof.packet.criterion.snapshot !== item.criterion.text) return false;
    return isObject(contract.identity)
      && item.proof.packet.acceptanceContract.id === contract.identity.id
      && item.proof.packet.acceptanceContract.version === contract.identity.version;
  });
}

const GATED_ISSUE_NOT_READY_REASONS = new Set([
  "review_job_unavailable",
  "confirmed_contract_unavailable",
  "no_correction_packets",
  "invalid_packet_custody",
  "verification_plan_unavailable",
  "posted_attempt_unavailable",
  "criterion_evidence_unavailable",
  "correction_packet_unavailable",
  "posted_attestation_unavailable",
  "criterion_outcome_bundle_not_recorded",
  "invalid_criterion_outcome_custody",
  "invalid_gated_issue_rendering",
  "gated_issue_body_too_large",
  "invalid_gated_issue_custody",
]);

function isGatedIssueBinding(value: unknown): value is Extract<
  AcceptanceRecordDetailRecord["gatedIssue"],
  { kind: "current" }
>["binding"] {
  if (!isObject(value) || !hasExactKeys(value, [
    "workspaceId", "recordId", "repo", "prNumber", "headSha", "headCycleId", "reviewJobId",
    "authorityGeneration", "acceptanceContract", "criterionOutcomeBundle", "packets", "packetSetSha256",
    "correctionPacketPayloadSetSha256", "bindingId",
  ]) || !LOWER_UUID_V5.test(String(value.bindingId)) || !isUuid(value.workspaceId)
    || !isUuid(value.recordId) || !isGatedIssueRepo(value.repo) || !isPositiveInteger(value.prNumber)
    || !isSha1(value.headSha) || !isUuid(value.headCycleId) || !isUuid(value.reviewJobId)
    || value.reviewJobId !== value.headCycleId || !isNonNegativeInteger(value.authorityGeneration)
    || !isContractIdentity(value.acceptanceContract) || !isObject(value.criterionOutcomeBundle)
    || !hasExactKeys(value.criterionOutcomeBundle, [
      "id", "eventId", "sha256", "postedAttestationEventId",
    ]) || !isUuid(value.criterionOutcomeBundle.id) || !isUuid(value.criterionOutcomeBundle.eventId)
    || value.criterionOutcomeBundle.id !== value.criterionOutcomeBundle.eventId
    || !isSha256(value.criterionOutcomeBundle.sha256)
    || !isUuid(value.criterionOutcomeBundle.postedAttestationEventId)
    || !Array.isArray(value.packets) || value.packets.length === 0 || value.packets.length > 100
    || !isSha256(value.packetSetSha256) || !isSha256(value.correctionPacketPayloadSetSha256)) return false;
  return value.packets.every((packet, index, packets) => isObject(packet)
    && hasExactKeys(packet, ["packetId", "sha256"])
    && typeof packet.packetId === "string" && /^correction-[a-f0-9]{48}$/u.test(packet.packetId)
    && isSha256(packet.sha256)
    && (index === 0 || (isObject(packets[index - 1])
      && String(packets[index - 1].packetId) < packet.packetId)));
}

function isGatedIssueReceipt(
  value: unknown,
  input: { repo: string; titleSha256: string; bodySha256: string },
): boolean {
  if (!isObject(value) || typeof value.kind !== "string") return false;
  if (value.kind === "github_201") {
    if (!hasExactKeys(value, [
      "kind", "httpStatus", "githubIssueId", "githubIssueNumber", "githubApiUrl", "githubIssueUrl",
      "githubRequestId", "responseTitleSha256", "responseBodySha256", "state",
    ]) || value.httpStatus !== 201 || typeof value.githubIssueId !== "string"
      || !/^[1-9][0-9]{0,39}$/u.test(value.githubIssueId)
      || !isPositiveInteger(value.githubIssueNumber) || value.state !== "open"
      || typeof value.githubRequestId !== "string" || !/^[A-Za-z0-9:-]{1,128}$/u.test(value.githubRequestId)
      || value.responseTitleSha256 !== input.titleSha256
      || value.responseBodySha256 !== input.bodySha256) return false;
    return value.githubApiUrl
        === `https://api.github.com/repos/${input.repo}/issues/${value.githubIssueNumber}`
      && value.githubIssueUrl
        === `https://github.com/${input.repo}/issues/${value.githubIssueNumber}`;
  }
  if (value.kind === "bounded_failed") {
    return hasExactKeys(value, ["kind", "reason"])
      && (value.reason === "github_rejected" || value.reason === "invalid_db_issued_request");
  }
  return value.kind === "ambiguous_hold" && hasExactKeys(value, ["kind", "reason"])
    && (value.reason === "github_unavailable" || value.reason === "ambiguous_response");
}

function isGatedIssue(value: unknown, repo: string): value is AcceptanceGatedIssue {
  if (!isObject(value) || !hasExactKeys(value, [
    "id", "status", "requestIdentitySha256", "titleSha256", "bodySha256", "reservedBy", "reservedRole",
    "reservedAt", "receipt", "reportedAt",
  ]) || !LOWER_UUID_V5.test(String(value.id)) || !isSha256(value.requestIdentitySha256)
    || !isSha256(value.titleSha256) || !isSha256(value.bodySha256)
    || typeof value.reservedBy !== "string" || !GATED_ISSUE_USER_ACTOR.test(value.reservedBy)
    || (value.reservedRole !== "owner" && value.reservedRole !== "admin")
    || !isIsoTimestamp(value.reservedAt)) return false;
  if (value.status === "reserved") return value.receipt === null && value.reportedAt === null;
  if (value.status !== "published" && value.status !== "bounded_failed"
    && value.status !== "ambiguous_hold") return false;
  return isIsoTimestamp(value.reportedAt) && isGatedIssueReceipt(value.receipt, {
    repo,
    titleSha256: value.titleSha256,
    bodySha256: value.bodySha256,
  }) && isObject(value.receipt) && (
    (value.status === "published" && value.receipt.kind === "github_201")
    || (value.status === "bounded_failed" && value.receipt.kind === "bounded_failed")
    || (value.status === "ambiguous_hold" && value.receipt.kind === "ambiguous_hold")
  );
}

type GatedGithubIssueMutationResponse =
  | { kind: "reported" | "replayed"; current: boolean; issue: AcceptanceGatedIssue }
  | { kind: "held" | "terminal"; binding: AcceptanceGatedIssueCurrentProjection["binding"]; issue: AcceptanceGatedIssue }
  | { kind: "held"; reason: "publication_outcome_not_persisted" };

export function isGatedGithubIssueMutationResponse(
  value: unknown,
  expectedBinding: AcceptanceGatedIssueCurrentProjection["binding"],
): value is GatedGithubIssueMutationResponse {
  if (!isObject(value) || typeof value.kind !== "string") return false;
  if (value.kind === "reported" || value.kind === "replayed") {
    return hasExactKeys(value, ["kind", "current", "issue"])
      && typeof value.current === "boolean"
      && isGatedIssue(value.issue, expectedBinding.repo)
      && value.issue.status !== "reserved";
  }
  if (value.kind === "held" && hasExactKeys(value, ["kind", "reason"])) {
    return value.reason === "publication_outcome_not_persisted";
  }
  if ((value.kind !== "held" && value.kind !== "terminal")
    || !hasExactKeys(value, ["kind", "binding", "issue"])
    || !isGatedIssueBinding(value.binding)
    || !exactJsonEqual(value.binding, expectedBinding)
    || !isGatedIssue(value.issue, expectedBinding.repo)) return false;
  return value.kind === "held"
    ? value.issue.status === "reserved"
    : value.issue.status !== "reserved";
}

export function gatedGithubIssueMutationStatusMatches(
  status: number,
  result: GatedGithubIssueMutationResponse,
): boolean {
  if (result.kind === "held" && "reason" in result) return status === 503;
  if (result.kind === "held" || result.kind === "terminal" || result.kind === "replayed") {
    return status === 200;
  }
  return status === (result.issue.status === "published" ? 201 : 200);
}

function isGatedIssueProjection(
  value: unknown,
): value is AcceptanceRecordDetailRecord["gatedIssue"] {
  if (!isObject(value) || typeof value.kind !== "string") return false;
  if (value.kind === "unknown") return hasExactKeys(value, ["kind", "reason"])
    && value.reason === "gated_issue_custody_not_available";
  if (value.kind === "not_applicable") return hasExactKeys(value, ["kind", "reason"])
    && value.reason === "no_correction_packets";
  if (value.kind === "unavailable") return hasExactKeys(value, ["kind", "reason"])
    && typeof value.reason === "string" && GATED_ISSUE_NOT_READY_REASONS.has(value.reason);
  return value.kind === "current" && hasExactKeys(value, ["kind", "binding", "issue"])
    && isGatedIssueBinding(value.binding) && isObject(value.binding)
    && (value.issue === null || isGatedIssue(value.issue, String(value.binding.repo)));
}

export function isAcceptanceRecordDetailEnvelope(
  value: unknown,
): value is AcceptanceRecordDetailEnvelope {
  if (!isObject(value)) return false;
  if (value.kind === "not_found") return hasExactKeys(value, ["kind"]);
  if (value.kind === "unavailable") {
    return hasExactKeys(value, ["kind", "reason"])
      && typeof value.reason === "string" && DETAIL_UNAVAILABLE_REASONS.has(value.reason);
  }
  if (value.kind !== "record" || !hasExactKeys(value, ["kind", "detail"])
    || !isObject(value.detail) || containsSecretShapedValue(value.detail)
    || !hasExactKeys(value.detail, [
      "summary", "contract", "pullRequest", "contextPacks", "proofMatrix", "artifactCustody", "gatedIssue",
    ]) || !isAcceptanceRecordSummary(value.detail.summary)
    || !isObject(value.detail.contract) || !hasExactKeys(value.detail.contract, [
      "identity", "confirmedBy", "confirmedAt", "contract",
    ]) || !isContractIdentity(value.detail.contract.identity)
    || !isSafeText(value.detail.contract.confirmedBy, 512)
    || !isIsoTimestamp(value.detail.contract.confirmedAt)
    || !isConfirmedContractProjection(value.detail.contract.contract)
    || !isDetailPullRequest(value.detail.pullRequest)
    || !Array.isArray(value.detail.contextPacks) || value.detail.contextPacks.length > 128
    || !Array.isArray(value.detail.proofMatrix)
    || !isObject(value.detail.artifactCustody)
    || !hasExactKeys(value.detail.artifactCustody, ["kind", "reason"])
    || value.detail.artifactCustody.kind !== "unknown"
    || value.detail.artifactCustody.reason !== "artifact_custody_not_available"
    || !isGatedIssueProjection(value.detail.gatedIssue)) return false;

  const { summary, contract, pullRequest, contextPacks, proofMatrix } = value.detail;
  if (!isObject(summary) || !isObject(contract) || !isObject(contract.identity)
    || !isObject(contract.contract) || summary.workspaceId === undefined || summary.recordId === undefined
    || summary.requestedWork === undefined || !isObject(summary.requestedWork)
    || summary.requestedWork.kind !== "confirmed"
    || summary.requestedWork.originalRequest !== contract.contract.originalRequest
    || !exactJsonEqual(summary.requestedWork.acceptanceContract, contract.identity)) return false;

  const occurrences: AcceptanceRecordDetailOccurrence[] = isObject(pullRequest)
    && pullRequest.kind === "attached" && Array.isArray(pullRequest.occurrences)
    ? pullRequest.occurrences.filter(isDetailOccurrence) : [];
  if (isObject(summary.pullRequest) && summary.pullRequest.kind === "not_attached") {
    if (!isObject(pullRequest) || pullRequest.kind !== "not_attached") return false;
  } else if (!isObject(summary.pullRequest) || summary.pullRequest.kind !== "attached"
    || !isObject(pullRequest) || pullRequest.kind !== "attached"
    || summary.pullRequest.prNumber !== pullRequest.prNumber) return false;
  if (isObject(summary.pullRequest) && summary.pullRequest.kind === "attached"
    && isObject(pullRequest) && pullRequest.kind === "attached") {
    const summaryHead = summary.pullRequest.head;
    if (!isObject(summaryHead)) return false;
    if (summaryHead.kind === "current") {
      if (!isObject(pullRequest.current) || pullRequest.current.kind !== "current"
        || pullRequest.current.headSha !== summaryHead.sha
        || pullRequest.current.headCycleId !== summaryHead.headCycleId
        || pullRequest.current.authorityGeneration !== summaryHead.authorityGeneration) return false;
    } else if (summaryHead.kind === "merged") {
      if (!isObject(pullRequest.merged) || pullRequest.merged.kind !== "merged"
        || pullRequest.merged.headSha !== summaryHead.sha
        || pullRequest.merged.headCycleId !== summaryHead.headCycleId
        || pullRequest.merged.authorityGeneration !== summaryHead.authorityGeneration) return false;
    } else if (summaryHead.kind !== "unknown"
      || pullRequest.current !== null || pullRequest.merged !== null) return false;
  }

  const occurrenceByCycle = new Map(occurrences.map((occurrence) => [occurrence.headCycleId, occurrence]));
  const snapshotIds = new Set<string>();
  let compiledPackCount = 0;
  let priorSnapshotSortKey: string | null = null;
  for (const contextPack of contextPacks) {
    if (!isObject(contextPack) || !hasExactKeys(contextPack, ["occurrence", "sourceSnapshot", "compiledPacks"])
      || !isObject(contextPack.occurrence) || !isUuid(contextPack.occurrence.headCycleId)) return false;
    const occurrence = occurrenceByCycle.get(contextPack.occurrence.headCycleId);
    if (!occurrence || !occurrenceCoreMatches(contextPack.occurrence, occurrence)
      || !isDetailSourceSnapshot(contextPack.sourceSnapshot, occurrence,
        summary.workspaceId as string, summary.recordId as string,
        contract.identity as { id: string; version: number; sha256: string })
      || !isObject(contextPack.sourceSnapshot) || !isUuid(contextPack.sourceSnapshot.id)
      || snapshotIds.has(contextPack.sourceSnapshot.id)
      || !Array.isArray(contextPack.compiledPacks) || contextPack.compiledPacks.length > 8
      || (contextPack.sourceSnapshot.status === "not_proven" && contextPack.compiledPacks.length !== 0)
      || !contextPack.compiledPacks.every((pack) => isDetailCompiledPack(
        pack, contextPack.sourceSnapshot as Record<string, unknown>, occurrence, contract,
      )) || !contextPack.compiledPacks.every((pack, index, packs) => {
        if (!isObject(pack) || typeof pack.createdAt !== "string" || typeof pack.id !== "string") return false;
        if (index === 0 || !isObject(packs[index - 1])) return index === 0;
        return `${packs[index - 1].createdAt}\u0000${packs[index - 1].id}`
          < `${pack.createdAt}\u0000${pack.id}`;
      })) return false;
    const snapshotSortKey = `${contextPack.sourceSnapshot.createdAt}\u0000${contextPack.sourceSnapshot.id}`;
    if (priorSnapshotSortKey !== null && priorSnapshotSortKey >= snapshotSortKey) return false;
    priorSnapshotSortKey = snapshotSortKey;
    compiledPackCount += contextPack.compiledPacks.length;
    if (compiledPackCount > 64) return false;
    snapshotIds.add(contextPack.sourceSnapshot.id);
  }
  const suppliedContext = summary.suppliedContext;
  if (isObject(suppliedContext) && suppliedContext.kind !== "unknown") {
    if (!isObject(suppliedContext.sourceSnapshot)) return false;
    const summarySnapshot = suppliedContext.sourceSnapshot;
    const contextPack = contextPacks.find((candidate) => isObject(candidate)
      && isObject(candidate.sourceSnapshot) && candidate.sourceSnapshot.id === summarySnapshot.id);
    if (!isObject(contextPack) || !isObject(contextPack.sourceSnapshot)
      || contextPack.sourceSnapshot.occurrence === undefined
      || contextPack.sourceSnapshot.id !== summarySnapshot.id
      || contextPack.sourceSnapshot.binding === undefined
      || contextPack.sourceSnapshot.compilerVersion !== summarySnapshot.compilerVersion
      || contextPack.sourceSnapshot.packetSetSha256 !== summarySnapshot.packetSetSha256
      || !isObject(contextPack.occurrence)
      || contextPack.occurrence.headSha !== summarySnapshot.headSha
      || contextPack.occurrence.headCycleId !== summarySnapshot.headCycleId) return false;
    if (suppliedContext.kind === "compiled") {
      if (!isObject(suppliedContext.compiledPack)) return false;
      const summaryPack = suppliedContext.compiledPack;
      if (!Array.isArray(contextPack.compiledPacks)
        || !contextPack.compiledPacks.some((pack) => isObject(pack)
          && pack.id === summaryPack.id
          && pack.packSha256 === summaryPack.sha256
          && pack.sourceCustodyIdentitySha256 === summaryPack.sourceCustodyIdentitySha256
          && pack.compilerVersion === summaryPack.compilerVersion
          && pack.policyVersion === summaryPack.policyVersion)) return false;
    } else if (contextPack.sourceSnapshot.status !== suppliedContext.kind) return false;
  }

  if (proofMatrix.length !== occurrences.length) return false;
  const proofCycles = new Set<string>();
  for (const [index, proofCycle] of proofMatrix.entries()) {
    if (!isObject(proofCycle) || !isObject(proofCycle.occurrence)
      || !isUuid(proofCycle.occurrence.headCycleId)) return false;
    const occurrence = occurrenceByCycle.get(proofCycle.occurrence.headCycleId);
    if (!occurrence || occurrence !== occurrences[index] || proofCycles.has(occurrence.headCycleId)
      || !isDetailProofCycle(proofCycle, occurrence, contract,
        summary.workspaceId as string, summary.recordId as string)) return false;
    proofCycles.add(occurrence.headCycleId);
  }
  const summaryProof = summary.proof;
  if (isObject(summaryProof) && summaryProof.kind === "recorded") {
    if (typeof summaryProof.reviewJobId !== "string" || typeof summaryProof.verdict !== "string"
      || typeof summaryProof.postedReviewUrl !== "string"
      || typeof summaryProof.postedAttestationEventId !== "string") return false;
    const { reviewJobId, verdict, postedReviewUrl, postedAttestationEventId } = summaryProof;
    const posted = proofMatrix.some((cycle) => isObject(cycle) && isObject(cycle.review)
      && cycle.review.kind === "posted"
      && cycle.review.reviewJobId === reviewJobId
      && cycle.review.verdict === verdict
      && cycle.review.postedReviewUrl === postedReviewUrl
      && cycle.review.postedAttestationEventId === postedAttestationEventId);
    if (!posted) return false;
  }
  if (isObject(summary.outcome) && summary.outcome.kind === "signed_merge") {
    if (!isObject(pullRequest) || pullRequest.kind !== "attached" || !isObject(pullRequest.merged)
      || pullRequest.merged.mergeEventId !== summary.outcome.mergeEventId
      || pullRequest.merged.mergeSha !== summary.outcome.mergeSha
      || pullRequest.merged.mergedAt !== summary.outcome.mergedAt) return false;
  }
  const gatedIssue = value.detail.gatedIssue;
  if (isObject(gatedIssue) && gatedIssue.kind === "current") {
    if (!isObject(gatedIssue.binding) || !isObject(pullRequest) || pullRequest.kind !== "attached"
      || !isObject(pullRequest.current) || pullRequest.current.kind !== "current"
      || gatedIssue.binding.workspaceId !== summary.workspaceId
      || gatedIssue.binding.recordId !== summary.recordId
      || gatedIssue.binding.repo !== summary.repo || gatedIssue.binding.prNumber !== pullRequest.prNumber
      || gatedIssue.binding.headSha !== pullRequest.current.headSha
      || gatedIssue.binding.headCycleId !== pullRequest.current.headCycleId
      || gatedIssue.binding.authorityGeneration !== pullRequest.current.authorityGeneration
      || !exactJsonEqual(gatedIssue.binding.acceptanceContract, contract.identity)) return false;
    const proofCycleCandidate = proofMatrix.find((cycle) => isObject(cycle)
      && isObject(cycle.occurrence)
      && cycle.occurrence.headCycleId === gatedIssue.binding.headCycleId);
    const gatedOccurrence = occurrenceByCycle.get(gatedIssue.binding.headCycleId);
    if (!gatedOccurrence || !isDetailProofCycle(
      proofCycleCandidate,
      gatedOccurrence,
      contract,
      String(summary.workspaceId),
      String(summary.recordId),
    )) return false;
    const proofCycle = proofCycleCandidate;
    if (!isObject(proofCycle.review) || proofCycle.review.kind !== "posted"
      || proofCycle.review.reviewJobId !== gatedIssue.binding.reviewJobId
      || proofCycle.review.postedAttestationEventId
        !== gatedIssue.binding.criterionOutcomeBundle.postedAttestationEventId) {
      return false;
    }
    const correctionPacketIds = proofCycle.criteria.flatMap((item) => isObject(item)
      && isObject(item.proof) && item.proof.kind === "correction_packet"
      && isObject(item.proof.packet) && typeof item.proof.packet.packetId === "string"
      ? [item.proof.packet.packetId] : []).sort();
    const boundPacketIds = gatedIssue.binding.packets.map((packet) => packet.packetId);
    if (correctionPacketIds.length !== boundPacketIds.length
      || correctionPacketIds.some((packetId, index) => packetId !== boundPacketIds[index])) return false;
  }
  return true;
}

const CRITERION_OUTCOME_NOT_READY_REASONS = new Set([
  "review_job_unavailable",
  "confirmed_contract_unavailable",
  "verification_plan_unavailable",
  "posted_attempt_unavailable",
  "criterion_evidence_unavailable",
  "correction_packet_unavailable",
  "posted_attestation_unavailable",
  "criterion_outcome_bundle_not_recorded",
  "invalid_criterion_outcome_custody",
]);

function isCriterionArtifact(value: unknown): value is AcceptanceCriterionArtifact {
  return isObject(value) && hasExactKeys(value, [
    "artifactId", "contentType", "contentSha256",
  ]) && typeof value.artifactId === "string" && LOWER_UUID_V5.test(value.artifactId)
    && (value.contentType === "image/png" || value.contentType === "image/jpeg"
      || value.contentType === "application/json")
    && typeof value.contentSha256 === "string" && LOWER_SHA256.test(value.contentSha256);
}

function isCriterionEvidence(
  value: unknown,
  state: AcceptanceCriterionOutcome["state"],
): value is AcceptanceCriterionEvidence {
  if (!isObject(value) || typeof value.kind !== "string") return false;
  if (value.kind === "execution_receipt") {
    if (!hasExactKeys(value, [
      "kind", "modality", "executionId", "receiptEventId", "evidenceRef", "artifact",
    ]) || (value.modality !== "ui" && value.modality !== "api"
      && value.modality !== "data" && value.modality !== "job")
      || typeof value.executionId !== "string"
      || value.executionId !== `${value.modality}-${value.executionId.slice(value.modality.length + 1)}`
      || !new RegExp(`^${value.modality}-[a-f0-9]{48}$`).test(value.executionId)
      || typeof value.receiptEventId !== "string" || !LOWER_UUID.test(value.receiptEventId)
      || value.evidenceRef !== `review-${value.modality}-execution:${value.executionId}`) return false;
    if (state === "proven" || state === "failed") {
      return isCriterionArtifact(value.artifact) && (
        value.modality === "ui"
          ? value.artifact.contentType === "image/png" || value.artifact.contentType === "image/jpeg"
          : value.artifact.contentType === "application/json"
      );
    }
    return state === "not_proven" && value.artifact === null;
  }
  if (value.kind === "preview_receipt") {
    return hasExactKeys(value, ["kind", "previewBootId", "evidenceRef"])
      && (state === "not_proven" || state === "not_testable")
      && typeof value.previewBootId === "string" && LOWER_UUID.test(value.previewBootId)
      && value.evidenceRef === `preview-boot:${value.previewBootId}`;
  }
  return value.kind === "not_testable_plan"
    && hasExactKeys(value, ["kind", "planEventId"])
    && state === "not_testable"
    && typeof value.planEventId === "string" && LOWER_UUID.test(value.planEventId);
}

function isCriterionOutcome(value: unknown): value is AcceptanceCriterionOutcome {
  if (!isObject(value) || containsSecretShapedValue(value) || !hasExactKeys(value, [
    "criterionId", "criterionText", "state", "expected", "observed", "evidence",
  ]) || !isSafeText(value.criterionId, 512)
    || !isSafeText(value.criterionText, 2_000)
    || (value.state !== "proven" && value.state !== "failed"
      && value.state !== "not_proven" && value.state !== "not_testable")
    || !isSafeText(value.expected, 2_000) || value.expected !== value.criterionText
    || !isSafeText(value.observed, 2_000)) return false;
  return isCriterionEvidence(value.evidence, value.state);
}

export function isCriterionOutcomesEnvelope(
  value: unknown,
): value is AcceptanceCriterionOutcomesEnvelope {
  if (!isObject(value)) return false;
  if (value.kind === "not_found" || value.kind === "not_current") {
    return hasExactKeys(value, ["kind"]);
  }
  if (value.kind === "not_ready") {
    return hasExactKeys(value, ["kind", "reason"])
      && typeof value.reason === "string"
      && CRITERION_OUTCOME_NOT_READY_REASONS.has(value.reason);
  }
  if (value.kind !== "current" || !hasExactKeys(value, ["kind", "bundle"])
    || !isObject(value.bundle) || !hasExactKeys(value.bundle, [
      "id", "eventId", "eventKey", "binding", "outcomes", "outcomeSetSha256", "sha256",
      "recordedAt",
    ])) return false;
  const bundle = value.bundle;
  if (typeof bundle.id !== "string" || !LOWER_UUID_V5.test(bundle.id)
    || bundle.eventId !== bundle.id
    || !isObject(bundle.binding) || !hasExactKeys(bundle.binding, [
      "workspaceId", "recordId", "repo", "prNumber", "headSha", "headCycleId", "reviewJobId",
      "acceptanceContract", "verificationPlanEventId", "postedAttemptEventId",
      "postedAttestationEventId", "outcomeDigest", "postPayloadDigest", "reviewVerdict",
    ])) return false;
  const binding = bundle.binding;
  if (typeof binding.workspaceId !== "string" || !LOWER_UUID.test(binding.workspaceId)
    || typeof binding.recordId !== "string" || !LOWER_UUID.test(binding.recordId)
    || !isSafeRepo(binding.repo) || !isPositiveInteger(binding.prNumber)
    || typeof binding.headSha !== "string" || !/^[a-f0-9]{40}$/.test(binding.headSha)
    || typeof binding.headCycleId !== "string" || !LOWER_UUID.test(binding.headCycleId)
    || typeof binding.reviewJobId !== "string" || !LOWER_UUID.test(binding.reviewJobId)
    || binding.headCycleId !== binding.reviewJobId
    || !isObject(binding.acceptanceContract)
    || !hasExactKeys(binding.acceptanceContract, ["id", "version", "sha256"])
    || typeof binding.acceptanceContract.id !== "string"
    || !LOWER_UUID.test(binding.acceptanceContract.id)
    || !isPositiveInteger(binding.acceptanceContract.version)
    || typeof binding.acceptanceContract.sha256 !== "string"
    || !LOWER_SHA256.test(binding.acceptanceContract.sha256)
    || typeof binding.verificationPlanEventId !== "string"
    || !LOWER_UUID.test(binding.verificationPlanEventId)
    || typeof binding.postedAttemptEventId !== "string"
    || !LOWER_UUID.test(binding.postedAttemptEventId)
    || typeof binding.postedAttestationEventId !== "string"
    || !LOWER_UUID.test(binding.postedAttestationEventId)
    || typeof binding.outcomeDigest !== "string" || !LOWER_SHA256.test(binding.outcomeDigest)
    || typeof binding.postPayloadDigest !== "string" || !LOWER_SHA256.test(binding.postPayloadDigest)
    || (binding.reviewVerdict !== "proven" && binding.reviewVerdict !== "failed"
      && binding.reviewVerdict !== "not_proven" && binding.reviewVerdict !== "not_testable")
    || bundle.eventKey !== `review:criterion-outcomes:${binding.headCycleId}`
    || !Array.isArray(bundle.outcomes) || bundle.outcomes.length === 0
    || bundle.outcomes.length > 100
    || typeof bundle.outcomeSetSha256 !== "string" || !LOWER_SHA256.test(bundle.outcomeSetSha256)
    || typeof bundle.sha256 !== "string" || !LOWER_SHA256.test(bundle.sha256)
    || !isIsoTimestamp(bundle.recordedAt)) return false;

  const criterionIds = new Set<string>();
  const validOutcomes = bundle.outcomes.every((outcome) => {
    if (!isCriterionOutcome(outcome) || criterionIds.has(outcome.criterionId)
      || (outcome.evidence.kind === "not_testable_plan"
        && outcome.evidence.planEventId !== binding.verificationPlanEventId)) return false;
    criterionIds.add(outcome.criterionId);
    return true;
  });
  if (!validOutcomes) return false;
  const expectedVerdict = bundle.outcomes.some((outcome) => outcome.state === "failed")
    ? "failed"
    : bundle.outcomes.some((outcome) => outcome.state === "not_proven")
      ? "not_proven"
      : bundle.outcomes.some((outcome) => outcome.state === "not_testable")
        ? "not_testable"
        : "proven";
  return binding.reviewVerdict === expectedVerdict;
}

function criterionOutcomesMatchDetail(
  outcomes: AcceptanceCriterionOutcomesEnvelope,
  envelope: AcceptanceRecordDetailEnvelope,
): boolean {
  if (outcomes.kind !== "current") return true;
  if (envelope.kind !== "record") return false;
  const { detail } = envelope;
  if (detail.pullRequest.kind !== "attached"
    || detail.pullRequest.current === null) return false;
  const { binding } = outcomes.bundle;
  const currentReviewJob = detail.pullRequest.current.reviewJob;
  const currentProof = detail.proofMatrix.find((cycle) =>
    cycle.occurrence.headCycleId === binding.headCycleId
  );
  if (binding.workspaceId !== detail.summary.workspaceId
    || binding.recordId !== detail.summary.recordId
    || binding.repo !== detail.summary.repo
    || binding.prNumber !== detail.pullRequest.prNumber
    || binding.headSha !== detail.pullRequest.current.headSha
    || binding.headCycleId !== detail.pullRequest.current.headCycleId
    || currentReviewJob.kind !== "recorded"
    || currentReviewJob.state !== "posted"
    || binding.reviewJobId !== currentReviewJob.id
    || currentProof?.review.kind !== "posted"
    || currentProof.review.reviewJobId !== binding.reviewJobId
    || currentProof.review.verdict !== binding.reviewVerdict
    || currentProof.review.postedAttestationEventId !== binding.postedAttestationEventId
    || !exactJsonEqual(binding.acceptanceContract, detail.contract.identity)
    || outcomes.bundle.outcomes.length !== detail.contract.contract.acceptanceCriteria.length) {
    return false;
  }
  return outcomes.bundle.outcomes.every((outcome, index) => {
    const criterion = detail.contract.contract.acceptanceCriteria[index];
    return criterion !== undefined
      && outcome.criterionId === criterion.id
      && outcome.criterionText === criterion.text
      && outcome.expected === criterion.text;
  });
}

export function isCorrectionPacketsEnvelope(value: unknown): value is AcceptanceCorrectionPacketsEnvelope {
  if (!isObject(value)) return false;
  if (value.kind === "not_found" || value.kind === "not_current") {
    return hasExactKeys(value, ["kind"]);
  }
  if (value.kind === "not_ready") {
    return hasExactKeys(value, ["kind", "reason"]) && (
      value.reason === "review_job_unavailable"
      || value.reason === "confirmed_contract_unavailable"
      || value.reason === "no_correction_packets"
      || value.reason === "invalid_packet_custody"
    );
  }
  if (value.kind !== "current" || !hasExactKeys(value, [
    "kind", "binding", "packetIds", "packetSetSha256", "correctionPacketPayloadSetSha256", "packets",
  ]) || !isObject(value.binding) || !hasExactKeys(value.binding, [
    "workspaceId", "recordId", "reviewJobId", "repo", "prNumber", "headSha", "headCycleId",
    "authorityGeneration", "acceptanceContract",
  ])) return false;
  if (!(typeof value.binding.workspaceId === "string" && UUID.test(value.binding.workspaceId)
    && typeof value.binding.recordId === "string" && UUID.test(value.binding.recordId)
    && typeof value.binding.reviewJobId === "string" && UUID.test(value.binding.reviewJobId)
    && isSafeRepo(value.binding.repo)
    && isPositiveInteger(value.binding.prNumber)
    && typeof value.binding.headSha === "string" && SHA1.test(value.binding.headSha)
    && typeof value.binding.headCycleId === "string" && UUID.test(value.binding.headCycleId)
    && value.binding.headCycleId === value.binding.reviewJobId
    && isNonNegativeInteger(value.binding.authorityGeneration)
    && isObject(value.binding.acceptanceContract)
    && hasExactKeys(value.binding.acceptanceContract, ["id", "version", "sha256"])
    && typeof value.binding.acceptanceContract.id === "string" && UUID.test(value.binding.acceptanceContract.id)
    && isPositiveInteger(value.binding.acceptanceContract.version)
    && typeof value.binding.acceptanceContract.sha256 === "string"
    && SHA256.test(value.binding.acceptanceContract.sha256)
    && Array.isArray(value.packetIds)
    && value.packetIds.length > 0 && value.packetIds.length <= 100
    && value.packetIds.every((packetId) => typeof packetId === "string" && CORRECTION_PACKET_ID.test(packetId))
    && typeof value.packetSetSha256 === "string" && SHA256.test(value.packetSetSha256)
    && typeof value.correctionPacketPayloadSetSha256 === "string"
    && SHA256.test(value.correctionPacketPayloadSetSha256)
    && Array.isArray(value.packets)
    && value.packets.length > 0
    && value.packetIds.length === value.packets.length
    && new Set(value.packetIds).size === value.packetIds.length)) return false;
  const packets = value.packets;
  const packetIds = value.packetIds;
  const binding = value.binding;
  if (!isObject(binding.acceptanceContract)) return false;
  const acceptanceContract = binding.acceptanceContract;
  return packetIds.every((packetId, index) => index === 0 || packetIds[index - 1]! < packetId)
    && packets.every((packet, index) => isAcceptanceCorrectionPacket(packet)
    && packet.packetId === packetIds[index]
    && packet.workspaceId === binding.workspaceId
    && packet.recordId === binding.recordId
    && packet.jobId === binding.reviewJobId
    && packet.repo === binding.repo
    && packet.prNumber === binding.prNumber
    && packet.headSha === binding.headSha
    && packet.acceptanceContract.id === acceptanceContract.id
    && packet.acceptanceContract.version === acceptanceContract.version);
}

function isAcceptancePrDecision(value: unknown): value is AcceptancePrDecision {
  return value === "approved" || value === "changes_requested"
    || value === "rejected" || value === "approved_with_exception";
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function isGithubReviewUrl(value: unknown, repo: unknown, prNumber: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048 || value !== value.trim()) return false;
  if (!isSafeRepo(repo) || !isPositiveInteger(prNumber)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com"
      && url.port === "" && url.username === "" && url.password === ""
      && url.search === ""
      && url.pathname === `/${repo}/pull/${prNumber}`
      && /^#pullrequestreview-[1-9][0-9]*$/u.test(url.hash);
  } catch {
    return false;
  }
}

function isDecisionRationale(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0
    && value.length <= 4_000 && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value) && !SECRET_LIKE.test(value));
}

export function isFinalDecisionEnvelope(value: unknown): value is AcceptanceFinalDecisionEnvelope {
  if (!isObject(value)) return false;
  if (value.kind === "not_found" || value.kind === "not_current") {
    return hasExactKeys(value, ["kind"]);
  }
  if (value.kind === "not_ready") {
    return hasExactKeys(value, ["kind", "reason"]) && (
      value.reason === "review_job_unavailable"
      || value.reason === "confirmed_contract_unavailable"
      || value.reason === "posted_attestation_unavailable"
      || value.reason === "invalid_review_custody"
      || value.reason === "invalid_decision_custody"
    );
  }
  if (value.kind !== "current" || !hasExactKeys(value, ["kind", "binding", "decision"])
    || !isObject(value.binding) || !hasExactKeys(value.binding, [
      "bindingId", "workspaceId", "recordId", "repo", "prNumber", "headSha", "headCycleId",
      "authorityGeneration", "reviewJobId", "reviewVerdict", "postedReviewUrl",
      "postedAttestationEventId", "acceptanceContract",
    ])) return false;
  const binding = value.binding;
  if (!(typeof binding.bindingId === "string" && UUID.test(binding.bindingId)
    && typeof binding.workspaceId === "string" && UUID.test(binding.workspaceId)
    && typeof binding.recordId === "string" && UUID.test(binding.recordId)
    && isSafeRepo(binding.repo)
    && isPositiveInteger(binding.prNumber)
    && typeof binding.headSha === "string" && SHA1.test(binding.headSha)
    && typeof binding.headCycleId === "string" && UUID.test(binding.headCycleId)
    && isNonNegativeInteger(binding.authorityGeneration)
    && typeof binding.reviewJobId === "string" && UUID.test(binding.reviewJobId)
    && binding.headCycleId === binding.reviewJobId
    && (binding.reviewVerdict === "proven" || binding.reviewVerdict === "failed"
      || binding.reviewVerdict === "not_proven" || binding.reviewVerdict === "not_testable")
    && isGithubReviewUrl(binding.postedReviewUrl, binding.repo, binding.prNumber)
    && typeof binding.postedAttestationEventId === "string"
    && UUID.test(binding.postedAttestationEventId)
    && isObject(binding.acceptanceContract)
    && hasExactKeys(binding.acceptanceContract, ["id", "version", "sha256"])
    && typeof binding.acceptanceContract.id === "string" && UUID.test(binding.acceptanceContract.id)
    && isPositiveInteger(binding.acceptanceContract.version)
    && typeof binding.acceptanceContract.sha256 === "string"
    && SHA256.test(binding.acceptanceContract.sha256))) return false;
  if (value.decision === null) return true;
  if (!isObject(value.decision) || !hasExactKeys(value.decision, [
    "eventId", "eventKey", "decision", "rationale", "decidedBy", "decidedRole", "decidedAt",
  ])) return false;
  const decision = value.decision;
  return typeof decision.eventId === "string" && UUID.test(decision.eventId)
    && decision.eventKey === `acceptance-pr-decision:${binding.reviewJobId}`
    && isAcceptancePrDecision(decision.decision)
    && (decision.decision !== "approved" || binding.reviewVerdict === "proven")
    && isDecisionRationale(decision.rationale)
    && (decision.decision !== "approved_with_exception" || decision.rationale !== null)
    && typeof decision.decidedBy === "string"
    && /^user:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(decision.decidedBy)
    && (decision.decidedRole === "owner" || decision.decidedRole === "admin")
    && isIsoTimestamp(decision.decidedAt);
}

function isUserActor(value: unknown): value is string {
  return typeof value === "string"
    && /^user:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function isReviewCycleBinding(value: unknown): value is AcceptanceReviewCycleBinding {
  if (!isObject(value) || !hasExactKeys(value, [
    "workspaceId", "recordId", "repo", "prNumber", "headSha", "headCycleId",
    "reviewJobId", "reviewVerdict", "postedReviewUrl", "postedAttestationEventId",
    "acceptanceContract",
  ])) return false;
  return typeof value.workspaceId === "string" && UUID.test(value.workspaceId)
    && typeof value.recordId === "string" && UUID.test(value.recordId)
    && isSafeRepo(value.repo)
    && isPositiveInteger(value.prNumber)
    && typeof value.headSha === "string" && SHA1.test(value.headSha)
    && typeof value.headCycleId === "string" && UUID.test(value.headCycleId)
    && typeof value.reviewJobId === "string" && UUID.test(value.reviewJobId)
    && value.headCycleId === value.reviewJobId
    && (value.reviewVerdict === "proven" || value.reviewVerdict === "failed"
      || value.reviewVerdict === "not_proven" || value.reviewVerdict === "not_testable")
    && isGithubReviewUrl(value.postedReviewUrl, value.repo, value.prNumber)
    && typeof value.postedAttestationEventId === "string"
    && UUID.test(value.postedAttestationEventId)
    && isObject(value.acceptanceContract)
    && hasExactKeys(value.acceptanceContract, ["id", "version", "sha256"])
    && typeof value.acceptanceContract.id === "string" && UUID.test(value.acceptanceContract.id)
    && isPositiveInteger(value.acceptanceContract.version)
    && typeof value.acceptanceContract.sha256 === "string"
    && SHA256.test(value.acceptanceContract.sha256);
}

function isReviewEffortEvidence(value: unknown, reviewJobId: string): value is AcceptanceReviewCycle["effort"] {
  if (!isObject(value)) return false;
  if (value.kind === "unknown") return hasExactKeys(value, ["kind"]);
  if (value.kind !== "known" || !hasExactKeys(value, ["kind", "value"])
    || !isObject(value.value) || !hasExactKeys(value.value, [
      "eventId", "eventKey", "minutes", "source", "recordedBy", "recordedRole", "recordedAt",
    ])) return false;
  const receipt = value.value;
  return typeof receipt.eventId === "string" && UUID.test(receipt.eventId)
    && receipt.eventKey === `acceptance-pr-review-effort:${reviewJobId}`
    && Number.isSafeInteger(receipt.minutes) && (receipt.minutes as number) >= 1
    && (receipt.minutes as number) <= 1_440
    && receipt.source === "human_input"
    && isUserActor(receipt.recordedBy)
    && (receipt.recordedRole === "owner" || receipt.recordedRole === "admin")
    && isIsoTimestamp(receipt.recordedAt);
}

function isReviewDecisionEvidence(
  value: unknown,
  binding: AcceptanceReviewCycleBinding,
): value is AcceptanceReviewCycle["decision"] {
  if (!isObject(value)) return false;
  if (value.kind === "unknown") return hasExactKeys(value, ["kind"]);
  if (value.kind !== "known" || !hasExactKeys(value, ["kind", "value"])
    || !isObject(value.value) || !hasExactKeys(value.value, [
      "eventId", "eventKey", "decision", "rationale", "decidedBy", "decidedRole", "decidedAt",
    ])) return false;
  const decision = value.value;
  return typeof decision.eventId === "string" && UUID.test(decision.eventId)
    && decision.eventKey === `acceptance-pr-decision:${binding.reviewJobId}`
    && isAcceptancePrDecision(decision.decision)
    && (decision.decision !== "approved" || binding.reviewVerdict === "proven")
    && isDecisionRationale(decision.rationale)
    && (decision.decision !== "approved_with_exception" || decision.rationale !== null)
    && isUserActor(decision.decidedBy)
    && (decision.decidedRole === "owner" || decision.decidedRole === "admin")
    && isIsoTimestamp(decision.decidedAt);
}

function isSignedMergeEvidence(value: unknown): value is AcceptanceReviewCycle["signedMerge"] {
  if (!isObject(value)) return false;
  if (value.kind === "unknown") return hasExactKeys(value, ["kind"]);
  if (value.kind !== "known" || !hasExactKeys(value, ["kind", "value"])
    || !isObject(value.value) || !hasExactKeys(value.value, [
      "mergeEventId", "deliveryEventId", "mergeSha", "mergedAt", "decisionAlignment",
    ])) return false;
  const receipt = value.value;
  return typeof receipt.mergeEventId === "string" && UUID.test(receipt.mergeEventId)
    && typeof receipt.deliveryEventId === "string" && UUID.test(receipt.deliveryEventId)
    && typeof receipt.mergeSha === "string" && SHA1.test(receipt.mergeSha)
    && isIsoTimestamp(receipt.mergedAt)
    && (receipt.decisionAlignment === "aligned"
      || receipt.decisionAlignment === "decision_conflicts_merge"
      || receipt.decisionAlignment === "not_recorded");
}

function isPostMergeOutcomesEvidence(value: unknown): value is AcceptanceReviewCycle["postMergeOutcomes"] {
  if (!isObject(value)) return false;
  if (value.kind === "unknown") return hasExactKeys(value, ["kind"]);
  if (value.kind !== "known" || !hasExactKeys(value, ["kind", "values"])
    || !Array.isArray(value.values) || value.values.length === 0) return false;
  const eventIds = new Set<string>();
  const eventKeys = new Set<string>();
  return value.values.every((event) => {
    if (!isObject(event) || !hasExactKeys(event, [
      "eventId", "eventKey", "outcome", "recordedBy", "recordedAt",
    ]) || typeof event.eventId !== "string" || !UUID.test(event.eventId)
      || eventIds.has(event.eventId) || typeof event.eventKey !== "string"
      || !isPostMergeOutcome(event.outcome)
      || !isBoundedReference(event.recordedBy, 256) || !isIsoTimestamp(event.recordedAt)) return false;
    const expectedEventKey = event.outcome.kind === "deployed"
      ? `acceptance-post-merge:deployed:${event.outcome.deploymentReference}`
      : event.outcome.kind === "incident"
        ? `acceptance-post-merge:incident:${event.outcome.incidentReference}`
        : `acceptance-post-merge:reverted:${event.outcome.revertSha}`;
    if (event.eventKey !== expectedEventKey || eventKeys.has(event.eventKey)) return false;
    eventIds.add(event.eventId);
    eventKeys.add(event.eventKey);
    return true;
  });
}

function isBoundedReference(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max
    && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isPostMergeOutcome(value: unknown): value is AcceptanceHistoricalPostMergeOutcome {
  if (!isObject(value) || typeof value.kind !== "string") return false;
  const gitSha = (candidate: unknown) => typeof candidate === "string"
    && /^[0-9a-f]{7,64}$/iu.test(candidate);
  if (value.kind === "deployed") {
    return hasExactKeys(value, ["kind", "revisionSha", "environment", "deploymentReference"])
      && gitSha(value.revisionSha) && isBoundedReference(value.environment, 160)
      && isBoundedReference(value.deploymentReference, 1_024);
  }
  if (value.kind === "incident") {
    return hasExactKeys(value, ["kind", "revisionSha", "incidentReference"])
      && gitSha(value.revisionSha) && isBoundedReference(value.incidentReference, 1_024);
  }
  if (value.kind === "reverted") {
    return hasExactKeys(value, ["kind", "revertedSha", "revertSha", "revertReference"])
      && gitSha(value.revertedSha) && gitSha(value.revertSha)
      && isBoundedReference(value.revertReference, 1_024);
  }
  return false;
}

function isReviewMetricsCountSummary(value: unknown): value is ReviewMetricsCountSummary {
  return isObject(value) && hasExactKeys(value, ["eligible", "known", "unknown"])
    && isNonNegativeInteger(value.eligible) && isNonNegativeInteger(value.known)
    && isNonNegativeInteger(value.unknown)
    && value.eligible === (value.known as number) + (value.unknown as number);
}

export function isReviewMetricsEnvelope(value: unknown): value is AcceptancePrReviewMetricsEnvelope {
  if (!isObject(value)) return false;
  if (value.kind === "not_found") return hasExactKeys(value, ["kind"]);
  if (value.kind === "unavailable") {
    return hasExactKeys(value, ["kind", "reason"]) && (
      value.reason === "record_not_attached"
      || value.reason === "invalid_record_custody"
      || value.reason === "confirmed_contract_unavailable"
      || value.reason === "invalid_review_custody"
      || value.reason === "invalid_effort_custody"
      || value.reason === "invalid_decision_custody"
      || value.reason === "invalid_merge_custody"
      || value.reason === "invalid_post_merge_custody"
    );
  }
  if (value.kind !== "record" || !hasExactKeys(value, [
    "kind", "workspaceId", "recordId", "repo", "prNumber", "currentCycle", "cycles", "summary",
  ]) || typeof value.workspaceId !== "string" || !UUID.test(value.workspaceId)
    || typeof value.recordId !== "string" || !UUID.test(value.recordId)
    || !isSafeRepo(value.repo) || !isPositiveInteger(value.prNumber)
    || !Array.isArray(value.cycles) || !isObject(value.summary)
    || !hasExactKeys(value.summary, ["reviewEffort", "decisions", "signedMerges", "postMergeOutcomes"])) {
    return false;
  }

  if (value.currentCycle !== null && (!isObject(value.currentCycle)
    || !hasExactKeys(value.currentCycle, ["headSha", "headCycleId", "authorityGeneration"])
    || typeof value.currentCycle.headSha !== "string" || !SHA1.test(value.currentCycle.headSha)
    || typeof value.currentCycle.headCycleId !== "string" || !UUID.test(value.currentCycle.headCycleId)
    || !isNonNegativeInteger(value.currentCycle.authorityGeneration))) return false;

  const cycles = value.cycles as unknown[];
  let priorSortKey: string | null = null;
  let currentCount = 0;
  const cycleIds = new Set<string>();
  const validatedCycles: AcceptanceReviewCycle[] = [];
  for (const candidate of cycles) {
    if (!isObject(candidate) || !hasExactKeys(candidate, [
      "binding", "current", "reviewedAt", "effort", "decision", "signedMerge", "postMergeOutcomes",
    ]) || !isReviewCycleBinding(candidate.binding) || typeof candidate.current !== "boolean"
      || !isIsoTimestamp(candidate.reviewedAt)
      || !isReviewEffortEvidence(candidate.effort, candidate.binding.reviewJobId)
      || !isReviewDecisionEvidence(candidate.decision, candidate.binding)
      || !isSignedMergeEvidence(candidate.signedMerge)
      || !isPostMergeOutcomesEvidence(candidate.postMergeOutcomes)
      || (candidate.signedMerge.kind === "unknown" && candidate.postMergeOutcomes.kind !== "unknown")
      || candidate.binding.workspaceId !== value.workspaceId
      || candidate.binding.recordId !== value.recordId
      || candidate.binding.repo !== value.repo
      || candidate.binding.prNumber !== value.prNumber
      || cycleIds.has(candidate.binding.headCycleId)) return false;
    const sortKey = `${candidate.reviewedAt}:${candidate.binding.headCycleId}`;
    if (priorSortKey !== null && priorSortKey > sortKey) return false;
    priorSortKey = sortKey;
    cycleIds.add(candidate.binding.headCycleId);
    const matchesCurrent = value.currentCycle !== null
      && candidate.binding.headSha === value.currentCycle.headSha
      && candidate.binding.headCycleId === value.currentCycle.headCycleId;
    if (candidate.current !== matchesCurrent) return false;
    if (candidate.current) {
      currentCount += 1;
    }
    validatedCycles.push(candidate as AcceptanceReviewCycle);
  }
  if ((value.currentCycle === null && currentCount !== 0) || currentCount > 1) return false;

  const reviewEffort = value.summary.reviewEffort;
  const decisions = value.summary.decisions;
  const signedMerges = value.summary.signedMerges;
  const postMergeOutcomes = value.summary.postMergeOutcomes;
  if (!isObject(reviewEffort) || !hasExactKeys(reviewEffort, [
    "eligible", "known", "unknown", "totalMinutes", "averageMinutes",
  ]) || !isNonNegativeInteger(reviewEffort.eligible)
    || !isNonNegativeInteger(reviewEffort.known) || !isNonNegativeInteger(reviewEffort.unknown)
    || reviewEffort.eligible !== (reviewEffort.known as number) + (reviewEffort.unknown as number)
    || !isReviewMetricsCountSummary(decisions)
    || !isReviewMetricsCountSummary(signedMerges)
    || !isReviewMetricsCountSummary(postMergeOutcomes)) return false;

  const effortValues = validatedCycles.flatMap((cycle) =>
    cycle.effort.kind === "known" ? [cycle.effort.value.minutes] : []);
  const expectedCounts = {
    reviewEffort: effortValues.length,
    decisions: validatedCycles.filter((cycle) => cycle.decision.kind === "known").length,
    signedMerges: validatedCycles.filter((cycle) => cycle.signedMerge.kind === "known").length,
    postMergeOutcomes: validatedCycles.filter((cycle) =>
      cycle.signedMerge.kind === "known" && cycle.postMergeOutcomes.kind === "known").length,
  };
  if (reviewEffort.eligible !== validatedCycles.length
    || reviewEffort.known !== expectedCounts.reviewEffort
    || reviewEffort.unknown !== validatedCycles.length - expectedCounts.reviewEffort
    || decisions.eligible !== validatedCycles.length || decisions.known !== expectedCounts.decisions
    || decisions.unknown !== validatedCycles.length - expectedCounts.decisions
    || signedMerges.eligible !== validatedCycles.length || signedMerges.known !== expectedCounts.signedMerges
    || signedMerges.unknown !== validatedCycles.length - expectedCounts.signedMerges
    || postMergeOutcomes.eligible !== expectedCounts.signedMerges
    || postMergeOutcomes.known !== expectedCounts.postMergeOutcomes
    || postMergeOutcomes.unknown !== expectedCounts.signedMerges - expectedCounts.postMergeOutcomes) return false;

  if (effortValues.length === 0) {
    return reviewEffort.totalMinutes === null && reviewEffort.averageMinutes === null;
  }
  const totalMinutes = effortValues.reduce((sum, minutes) => sum + minutes, 0);
  return reviewEffort.totalMinutes === totalMinutes
    && reviewEffort.averageMinutes === totalMinutes / effortValues.length;
}

const DEPENDENCY_FINGERPRINT = /^sha256:[a-f0-9]{64}$/iu;
const NPM_PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const NORMALIZED_PYPI_PACKAGE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const EXACT_SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const UNSAFE_NPM_SPECIFIER = /^(?:file|link|workspace|git\+|git|path|https?):/iu;
const NPM_ALIAS_SPECIFIER = /^npm:/iu;
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const NODE_DEPENDENCY_KINDS = [
  "dependencies", "devDependencies", "optionalDependencies", "peerDependencies",
] as const;
const NPM_SAVE_FLAG_BY_DEPENDENCY_KIND: Readonly<Record<string, string>> = {
  dependencies: "--save-prod",
  devDependencies: "--save-dev",
  optionalDependencies: "--save-optional",
  peerDependencies: "--save-peer",
};
const YARN_FLAG_BY_DEPENDENCY_KIND: Readonly<Record<string, string | null>> = {
  dependencies: null,
  devDependencies: "--dev",
  optionalDependencies: "--optional",
  peerDependencies: "--peer",
};

type AcceptanceDependencyReceiptProfile = {
  readonly identity: AcceptanceDependencyProfileIdentity;
  candidateIsValid(candidate: AcceptanceDependencyCandidate): boolean;
  runtimeVersionIsValid(version: string): boolean;
  packageManagerVersionIsValid(version: string): boolean;
  manifestPathIsValid(path: string): boolean;
  lockfilePathIsValid(path: string): boolean;
  securityIsValid(
    security: AcceptanceDependencySecurityEvidence,
    candidate: AcceptanceDependencyCandidate,
  ): boolean;
  expectedArgv(candidate: AcceptanceDependencyCandidate): string[];
};

function isSafeRepoPath(value: unknown): value is string {
  return isSafeText(value, 1_024) && !value.startsWith("/") && !value.includes("\\")
    && !value.split("/").some((segment) => !segment || segment === "." || segment === "..");
}

function exactJsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => exactJsonEqual(value, right[index]));
  }
  if (!isObject(left) || !isObject(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && exactJsonEqual(left[key], right[key]));
}

function isDependencyIdentity(value: unknown): value is AcceptanceDependencyProfileIdentity {
  return isObject(value) && hasExactKeys(value, ["ecosystem", "manager", "profile"])
    && typeof value.ecosystem === "string" && SAFE_NAME.test(value.ecosystem)
    && typeof value.manager === "string" && SAFE_NAME.test(value.manager)
    && typeof value.profile === "string" && SAFE_NAME.test(value.profile);
}

function nodeDependencyCandidateIsValid(candidate: AcceptanceDependencyCandidate): boolean {
  return NPM_PACKAGE.test(candidate.package)
    && NODE_DEPENDENCY_KINDS.includes(
      candidate.dependencyKind as typeof NODE_DEPENDENCY_KINDS[number]
    )
    && !UNSAFE_NPM_SPECIFIER.test(candidate.specifier)
    && EXACT_SEMVER.test(candidate.currentVersion)
    && EXACT_SEMVER.test(candidate.targetVersion);
}

function npmDependencyCandidateIsValid(candidate: AcceptanceDependencyCandidate): boolean {
  return nodeDependencyCandidateIsValid(candidate)
    && !NPM_ALIAS_SPECIFIER.test(candidate.specifier);
}

function yarnDependencyCandidateIsValid(candidate: AcceptanceDependencyCandidate): boolean {
  const specifier = candidate.specifier.startsWith("^") || candidate.specifier.startsWith("~")
    ? candidate.specifier.slice(1)
    : candidate.specifier;
  return nodeDependencyCandidateIsValid(candidate)
    && !NPM_ALIAS_SPECIFIER.test(candidate.specifier)
    && EXACT_SEMVER.test(specifier);
}

function stableSemverParts(value: string): [number, number, number] | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger)
    ? [parts[0]!, parts[1]!, parts[2]!]
    : null;
}

function stableNodeAtLeast1812(version: string): boolean {
  const parts = stableSemverParts(version);
  return parts !== null && (parts[0] > 18 || (parts[0] === 18 && parts[1] >= 12));
}

function stableYarn4(version: string): boolean {
  return stableSemverParts(version)?.[0] === 4;
}

function compareStableSemver(
  left: [number, number, number],
  right: [number, number, number],
): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]! > right[index]!) return 1;
    if (left[index]! < right[index]!) return -1;
  }
  return 0;
}

function uvDependencyCandidateIsValid(candidate: AcceptanceDependencyCandidate): boolean {
  if (candidate.dependencyKind !== "dependencies"
    || !NORMALIZED_PYPI_PACKAGE.test(candidate.package)) return false;
  const lowerBound = /^>=(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u
    .exec(candidate.specifier);
  const current = stableSemverParts(candidate.currentVersion);
  const target = stableSemverParts(candidate.targetVersion);
  if (!lowerBound || !current || !target) return false;
  const bound = lowerBound.slice(1).map(Number) as [number, number, number];
  return bound.every(Number.isSafeInteger)
    && compareStableSemver(current, bound) >= 0
    && compareStableSemver(target, bound) >= 0
    && compareStableSemver(target, current) > 0;
}

function stablePython3(version: string): boolean {
  return stableSemverParts(version)?.[0] === 3;
}

function stableUv012(version: string): boolean {
  const parts = stableSemverParts(version);
  return parts?.[0] === 0 && parts[1] === 12;
}

function osvNpmReceiptIsValid(
  security: AcceptanceDependencySecurityEvidence,
  candidate: AcceptanceDependencyCandidate,
): boolean {
  return security.provider === "osv"
    && security.reference === `osv:npm:${candidate.package}@${candidate.targetVersion}`;
}

function osvPyPiReceiptIsValid(
  security: AcceptanceDependencySecurityEvidence,
  candidate: AcceptanceDependencyCandidate,
): boolean {
  return security.provider === "osv"
    && security.reference === `osv:PyPI:${candidate.package}@${candidate.targetVersion}`;
}

const ACCEPTANCE_DEPENDENCY_RECEIPT_PROFILES = new Map<string, AcceptanceDependencyReceiptProfile>([
  ["node:pnpm:pnpm_lockfile_only_v1", {
    identity: { ecosystem: "node", manager: "pnpm", profile: "pnpm_lockfile_only_v1" },
    candidateIsValid: nodeDependencyCandidateIsValid,
    runtimeVersionIsValid: (version) => EXACT_SEMVER.test(version),
    packageManagerVersionIsValid: (version) => EXACT_SEMVER.test(version),
    manifestPathIsValid: (path) => path === "package.json" || path.endsWith("/package.json"),
    lockfilePathIsValid: (path) => path === "pnpm-lock.yaml" || path.endsWith("/pnpm-lock.yaml"),
    securityIsValid: osvNpmReceiptIsValid,
    expectedArgv: (candidate) => [
      "pnpm", "update", `${candidate.package}@${candidate.targetVersion}`,
      "--lockfile-only", "--ignore-scripts",
    ],
  }],
  ["node:npm:npm_package_lock_only_v1", {
    identity: { ecosystem: "node", manager: "npm", profile: "npm_package_lock_only_v1" },
    candidateIsValid: npmDependencyCandidateIsValid,
    runtimeVersionIsValid: (version) => EXACT_SEMVER.test(version),
    packageManagerVersionIsValid: (version) => EXACT_SEMVER.test(version),
    manifestPathIsValid: (path) => path === "package.json",
    lockfilePathIsValid: (path) => path === "package-lock.json",
    securityIsValid: osvNpmReceiptIsValid,
    expectedArgv: (candidate) => [
      "npm", "install", `${candidate.package}@${candidate.targetVersion}`,
      "--package-lock-only", "--ignore-scripts", "--no-audit",
      NPM_SAVE_FLAG_BY_DEPENDENCY_KIND[candidate.dependencyKind] ?? "",
    ],
  }],
  ["node:yarn:yarn_berry_v4_root_lockfile_only_v1", {
    identity: {
      ecosystem: "node",
      manager: "yarn",
      profile: "yarn_berry_v4_root_lockfile_only_v1",
    },
    candidateIsValid: yarnDependencyCandidateIsValid,
    runtimeVersionIsValid: stableNodeAtLeast1812,
    packageManagerVersionIsValid: stableYarn4,
    manifestPathIsValid: (path) => path === "package.json",
    lockfilePathIsValid: (path) => path === "yarn.lock",
    securityIsValid: osvNpmReceiptIsValid,
    expectedArgv: (candidate) => {
      const argv = [
        "yarn", "add", `${candidate.package}@${candidate.targetVersion}`,
        "--mode=update-lockfile",
      ];
      const dependencyFlag = YARN_FLAG_BY_DEPENDENCY_KIND[candidate.dependencyKind];
      return dependencyFlag ? [...argv, dependencyFlag] : argv;
    },
  }],
  ["python:uv:uv_project_lockfile_only_v1", {
    identity: {
      ecosystem: "python",
      manager: "uv",
      profile: "uv_project_lockfile_only_v1",
    },
    candidateIsValid: uvDependencyCandidateIsValid,
    runtimeVersionIsValid: stablePython3,
    packageManagerVersionIsValid: stableUv012,
    manifestPathIsValid: (path) => path === "pyproject.toml",
    lockfilePathIsValid: (path) => path === "uv.lock",
    securityIsValid: osvPyPiReceiptIsValid,
    expectedArgv: (candidate) => [
      "uv", "lock", "--no-cache", "--no-config", "--no-python-downloads",
      "--no-sources", "--no-build", "--upgrade-package",
      `${candidate.package}==${candidate.targetVersion}`,
    ],
  }],
]);

function dependencyReceiptProfile(
  identity: AcceptanceDependencyProfileIdentity
): AcceptanceDependencyReceiptProfile | null {
  const profile = ACCEPTANCE_DEPENDENCY_RECEIPT_PROFILES.get(
    `${identity.ecosystem}:${identity.manager}:${identity.profile}`
  );
  return profile && exactJsonEqual(profile.identity, identity) ? profile : null;
}

function isLegacyPnpmIdentity(value: AcceptanceDependencyProfileIdentity): boolean {
  return value.ecosystem === "node" && value.manager === "pnpm"
    && value.profile === "pnpm_lockfile_only_v1";
}

function isDependencyCandidate(value: unknown): value is AcceptanceDependencyCandidate {
  return isObject(value) && hasExactKeys(value, [
    "identity", "package", "dependencyKind", "specifier", "currentVersion", "targetVersion",
  ]) && typeof value.package === "string" && value.package.length <= 214
    && isDependencyIdentity(value.identity)
    && isSafeText(value.package, 214) && isSafeText(value.dependencyKind, 64)
    && isSafeText(value.specifier, 256)
    && isSafeText(value.currentVersion, 128)
    && isSafeText(value.targetVersion, 128)
    && value.currentVersion !== value.targetVersion;
}

function isDependencyRuntime(value: unknown): value is AcceptanceDependencyRuntimeEvidence {
  if (!isObject(value) || !hasExactKeys(value, ["identity", "disposition", "version", "evidenceSha256"])
    || (value.disposition !== "safe" && value.disposition !== "unsafe"
      && value.disposition !== "unavailable" && value.disposition !== "ambiguous")
    || !isDependencyIdentity(value.identity) || (value.version !== null && !isSafeText(value.version, 64))
    || typeof value.evidenceSha256 !== "string" || !SHA256.test(value.evidenceSha256)) return false;
  return value.disposition === "safe"
    ? typeof value.version === "string"
    : value.disposition === "unsafe"
      ? true
      : value.version === null;
}

function isDependencyPackageManager(
  value: unknown
): value is AcceptanceDependencyPackageManagerEvidence {
  if (!isObject(value) || !hasExactKeys(value, [
    "disposition", "name", "version", "profile", "updateArgv", "evidenceSha256",
  ]) || (value.disposition !== "safe" && value.disposition !== "unsafe"
      && value.disposition !== "unavailable" && value.disposition !== "ambiguous")
    || typeof value.name !== "string" || !SAFE_NAME.test(value.name)
    || (value.version !== null && !isSafeText(value.version, 64))
    || !isSafeText(value.profile, 64) || !Array.isArray(value.updateArgv)
    || value.updateArgv.length < 1 || value.updateArgv.length > 16
    || !value.updateArgv.every((token) => isSafeText(token, 256))
    || typeof value.evidenceSha256 !== "string" || !SHA256.test(value.evidenceSha256)) return false;
  return value.disposition === "safe"
    ? typeof value.version === "string"
    : value.disposition === "unsafe"
      ? true
      : value.version === null;
}

function isDependencyManifest(value: unknown): value is AcceptanceDependencyManifestEvidence {
  return isObject(value) && hasExactKeys(value, ["path", "blobSha"])
    && isSafeRepoPath(value.path)
    && typeof value.blobSha === "string" && SHA1.test(value.blobSha);
}

function isDependencyLockfile(value: unknown): value is AcceptanceDependencyLockfileEvidence {
  if (!isObject(value) || !hasExactKeys(value, ["disposition", "path", "blobSha", "evidenceSha256"])
    || (value.disposition !== "present" && value.disposition !== "missing"
      && value.disposition !== "uncommitted" && value.disposition !== "unavailable"
      && value.disposition !== "ambiguous")
    || !isSafeRepoPath(value.path)
    || typeof value.evidenceSha256 !== "string" || !SHA256.test(value.evidenceSha256)) return false;
  return value.disposition === "present"
    ? typeof value.blobSha === "string" && SHA1.test(value.blobSha)
    : value.blobSha === null;
}

function isDependencyBaseline(value: unknown): value is AcceptanceDependencyBaselineEvidence {
  return isObject(value) && hasExactKeys(value, ["headSha"])
    && typeof value.headSha === "string" && SHA1.test(value.headSha);
}

function isDependencySecurity(
  value: unknown,
): value is AcceptanceDependencySecurityEvidence {
  return isObject(value) && hasExactKeys(value, ["identity", "disposition", "provider", "reference", "reportSha256"])
    && (value.disposition === "clear" || value.disposition === "affected"
      || value.disposition === "unavailable" || value.disposition === "ambiguous")
    && isDependencyIdentity(value.identity) && isSafeText(value.provider, 64) && isSafeText(value.reference, 512)
    && typeof value.reportSha256 === "string" && SHA256.test(value.reportSha256);
}

function isDependencyObservationBinding(value: unknown): value is AcceptanceDependencyObservationBinding {
  if (!isObject(value) || !hasExactKeys(value, [
    "workspaceId", "recordId", "repo", "prNumber", "headSha", "headCycleId",
    "authorityGeneration", "reviewJobId", "acceptanceContract", "compiledPack",
  ]) || typeof value.workspaceId !== "string" || !UUID.test(value.workspaceId)
    || typeof value.recordId !== "string" || !UUID.test(value.recordId)
    || !isSafeRepo(value.repo) || !isPositiveInteger(value.prNumber)
    || typeof value.headSha !== "string" || !SHA1.test(value.headSha)
    || typeof value.headCycleId !== "string" || !UUID.test(value.headCycleId)
    || typeof value.reviewJobId !== "string" || !UUID.test(value.reviewJobId)
    || value.reviewJobId !== value.headCycleId
    || !isNonNegativeInteger(value.authorityGeneration)
    || !isObject(value.acceptanceContract)
    || !hasExactKeys(value.acceptanceContract, ["id", "version", "sha256"])
    || typeof value.acceptanceContract.id !== "string" || !UUID.test(value.acceptanceContract.id)
    || !isPositiveInteger(value.acceptanceContract.version)
    || typeof value.acceptanceContract.sha256 !== "string" || !SHA256.test(value.acceptanceContract.sha256)
    || !isObject(value.compiledPack) || !hasExactKeys(value.compiledPack, [
      "id", "sha256", "sourceSnapshotId", "sourceCustodyIdentitySha256", "compilerVersion",
      "policyVersion", "exactHeadDependencyTreeProofsSha256",
    ])) return false;
  return typeof value.compiledPack.id === "string" && UUID.test(value.compiledPack.id)
    && typeof value.compiledPack.sha256 === "string" && SHA256.test(value.compiledPack.sha256)
    && typeof value.compiledPack.sourceSnapshotId === "string" && UUID.test(value.compiledPack.sourceSnapshotId)
    && typeof value.compiledPack.sourceCustodyIdentitySha256 === "string"
    && SHA256.test(value.compiledPack.sourceCustodyIdentitySha256)
    && isSafeText(value.compiledPack.compilerVersion, 128)
    && isSafeText(value.compiledPack.policyVersion, 128)
    && typeof value.compiledPack.exactHeadDependencyTreeProofsSha256 === "string"
    && SHA256.test(value.compiledPack.exactHeadDependencyTreeProofsSha256);
}

function isDependencyObservationReason(value: unknown): value is AcceptanceDependencyObservationReason {
  return value === "baseline_head_mismatch" || value === "manifest_source_not_proven"
    || value === "lockfile_source_not_proven" || value === "unsupported_manager_profile" || value === "unsafe_runtime"
    || value === "unsafe_package_manager" || value === "unsafe_package_manager_profile"
    || value === "unsafe_package_manager_argv" || value === "runtime_evidence_unavailable"
    || value === "runtime_evidence_ambiguous" || value === "package_manager_evidence_unavailable"
    || value === "package_manager_evidence_ambiguous" || value === "lockfile_missing"
    || value === "lockfile_uncommitted" || value === "lockfile_evidence_unavailable"
    || value === "lockfile_evidence_ambiguous" || value === "security_affected"
    || value === "security_evidence_unavailable" || value === "security_evidence_ambiguous"
    || value === "unsafe_yarn_configuration_present"
    || value === "yarn_configuration_absence_not_proven";
}

function isDependencyObservation(
  value: unknown,
  binding: AcceptanceDependencyObservationBinding,
  payloadVersion: 1 | 2,
): value is AcceptanceDependencyObservation {
  if (!isObject(value) || !hasExactKeys(value, [
    "eventId", "eventKey", "status", "reasons", "candidateFingerprint", "candidate", "runtime",
    "packageManager", "manifest", "lockfile", "baseline", "security", "observedAt",
  ]) || typeof value.eventId !== "string" || !UUID.test(value.eventId)
    || (value.status !== "observed" && value.status !== "refused_unsupported_profile" && value.status !== "refused_unsafe_runtime"
      && value.status !== "refused_lockfile" && value.status !== "refused_baseline"
      && value.status !== "refused_security" && value.status !== "not_proven")
    || typeof value.candidateFingerprint !== "string" || !DEPENDENCY_FINGERPRINT.test(value.candidateFingerprint)
    || value.eventKey !== (payloadVersion === 1
      ? `acceptance-dependency-observation:${binding.headCycleId}:${value.candidateFingerprint.slice("sha256:".length)}`
      : `acceptance-dependency-observation:v2:${binding.headCycleId}:${value.candidateFingerprint.slice("sha256:".length)}`)
    || !Array.isArray(value.reasons) || value.reasons.length > 20
    || !value.reasons.every(isDependencyObservationReason)
    || new Set(value.reasons).size !== value.reasons.length
    || (value.status === "observed" ? value.reasons.length !== 0 : value.reasons.length === 0)
    || !isDependencyCandidate(value.candidate)
    || !isDependencyRuntime(value.runtime)
    || !isDependencyPackageManager(value.packageManager)
    || !isDependencyManifest(value.manifest)
    || !isDependencyLockfile(value.lockfile)
    || !isDependencyBaseline(value.baseline)
    || !isDependencySecurity(value.security)
    || !isIsoTimestamp(value.observedAt)) return false;
  if (payloadVersion === 1 && (
    !isLegacyPnpmIdentity(value.candidate.identity)
    || !exactJsonEqual(value.runtime.identity, value.candidate.identity)
    || !exactJsonEqual(value.security.identity, value.candidate.identity)
    || value.status === "refused_unsupported_profile"
    || value.reasons.includes("unsupported_manager_profile")
  )) return false;
  // Unsupported/refused observations are immutable historical facts. Validate
  // their bounded shape above, but never reinterpret them through today's
  // operational profile registry.
  if (value.status !== "observed") return true;
  const profile = dependencyReceiptProfile(value.candidate.identity);
  return profile !== null
    && exactJsonEqual(value.runtime.identity, value.candidate.identity)
    && exactJsonEqual(value.security.identity, value.candidate.identity)
    && profile.candidateIsValid(value.candidate)
    && value.runtime.disposition === "safe"
    && profile.runtimeVersionIsValid(value.runtime.version ?? "")
    && value.packageManager.disposition === "safe"
    && value.packageManager.name === profile.identity.manager
    && profile.packageManagerVersionIsValid(value.packageManager.version ?? "")
    && value.packageManager.profile === profile.identity.profile
    && exactJsonEqual(value.packageManager.updateArgv, profile.expectedArgv(value.candidate))
    && profile.manifestPathIsValid(value.manifest.path)
    && profile.lockfilePathIsValid(value.lockfile.path)
    && value.lockfile.disposition === "present"
    && value.security.disposition === "clear"
    && profile.securityIsValid(value.security, value.candidate)
    && value.baseline.headSha === binding.headSha;
}

function isDependencyApproval(
  value: unknown,
  binding: AcceptanceDependencyObservationBinding,
  observation: AcceptanceDependencyObservation,
): value is AcceptanceDependencyApproval {
  return isObject(value) && hasExactKeys(value, [
    "eventId", "eventKey", "observationEventId", "candidateFingerprint", "approvedBy",
    "approvedRole", "approvedAt",
  ]) && typeof value.eventId === "string" && UUID.test(value.eventId)
    && value.eventKey === `acceptance-dependency-approval:${binding.headCycleId}:${observation.candidateFingerprint.slice("sha256:".length)}`
    && value.observationEventId === observation.eventId
    && value.candidateFingerprint === observation.candidateFingerprint
    && isUserActor(value.approvedBy)
    && (value.approvedRole === "owner" || value.approvedRole === "admin")
    && isIsoTimestamp(value.approvedAt);
}

function isDependencyExternalBuilderPack(
  value: unknown,
  binding: AcceptanceDependencyObservationBinding,
  observation: AcceptanceDependencyObservation,
  approval: AcceptanceDependencyApproval,
): value is AcceptanceDependencyExternalBuilderPack {
  if (!isObject(value) || !hasExactKeys(value, [
    "packId", "eventId", "eventKey", "observationEventId", "approvalEventId", "candidateFingerprint",
    "binding", "candidate", "runtime", "packageManager", "manifest", "lockfile", "baseline", "security",
    "route", "deliveryAuthority", "scopeBoundary", "reviewRequirement", "mintedAt",
  ]) || typeof value.packId !== "string" || !UUID.test(value.packId)
    || typeof value.eventId !== "string" || !UUID.test(value.eventId)
    || value.eventKey !== `acceptance-dependency-external-builder-pack:${binding.headCycleId}:${observation.candidateFingerprint.slice("sha256:".length)}`
    || value.observationEventId !== observation.eventId || value.approvalEventId !== approval.eventId
    || value.candidateFingerprint !== observation.candidateFingerprint
    || !isDependencyObservationBinding(value.binding) || !exactJsonEqual(value.binding, binding)
    || !exactJsonEqual(value.candidate, observation.candidate)
    || !exactJsonEqual(value.runtime, observation.runtime)
    || !exactJsonEqual(value.packageManager, observation.packageManager)
    || !exactJsonEqual(value.manifest, observation.manifest)
    || !exactJsonEqual(value.lockfile, observation.lockfile)
    || !exactJsonEqual(value.baseline, observation.baseline)
    || !exactJsonEqual(value.security, observation.security)
    || !isObject(value.route) || !hasExactKeys(value.route, [
      "selectionEventId", "id", "adapter", "configurationVersion", "snapshot", "snapshotSha256",
    ]) || typeof value.route.selectionEventId !== "string" || !UUID.test(value.route.selectionEventId)
    || typeof value.route.id !== "string" || !UUID.test(value.route.id)
    || (value.route.adapter !== "github_codex" && value.route.adapter !== "github_claude")
    || !isPositiveInteger(value.route.configurationVersion)
    || typeof value.route.snapshotSha256 !== "string" || !SHA256.test(value.route.snapshotSha256)
    || !isObject(value.route.snapshot) || !hasExactKeys(value.route.snapshot, [
      "builder", "protocol", "capability", "scopeBoundary",
    ]) || !isObject(value.route.snapshot.builder)
    || !hasExactKeys(value.route.snapshot.builder, ["adapter", "routeId"])
    || value.route.snapshot.builder.adapter !== value.route.adapter
    || value.route.snapshot.builder.routeId !== value.route.id
    || value.route.snapshot.protocol !== "github_comment"
    || !isObject(value.route.snapshot.capability)
    || !hasExactKeys(value.route.snapshot.capability, [
      "availability", "activation", "acknowledgement", "repairHead",
    ]) || value.route.snapshot.capability.availability !== "unverified"
    || value.route.snapshot.capability.activation !== "github_mention"
    || value.route.snapshot.capability.acknowledgement !== "vendor_activity"
    || value.route.snapshot.capability.repairHead !== "github_synchronize"
    || value.route.snapshot.scopeBoundary !== "correction_delivery_only"
    || value.deliveryAuthority !== "not_granted"
    || value.scopeBoundary !== "dependency_external_builder_pack_only"
    || value.reviewRequirement !== "exact_head_r7_reentry"
    || !isIsoTimestamp(value.mintedAt)) return false;
  return true;
}

export function isDependencyObservationsEnvelope(
  value: unknown
): value is AcceptanceDependencyObservationsEnvelope {
  if (!isObject(value)) return false;
  if (value.kind === "not_found" || value.kind === "not_current") {
    return hasExactKeys(value, ["kind"]);
  }
  if (value.kind === "not_ready") {
    return hasExactKeys(value, ["kind", "reason"]) && (
      value.reason === "confirmed_contract_unavailable"
      || value.reason === "compiled_pack_unavailable"
      || value.reason === "invalid_observation_custody"
      || value.reason === "invalid_compiled_pack_custody"
      || value.reason === "selected_route_unavailable"
      || value.reason === "selected_route_not_external_builder"
      || value.reason === "invalid_approval_pack_custody"
    );
  }
  if (value.kind !== "current" || !hasExactKeys(value, ["kind", "binding", "observations"])
    || !isObject(value.binding) || !hasExactKeys(value.binding, [
      "workspaceId", "recordId", "repo", "prNumber", "headSha", "headCycleId",
      "authorityGeneration", "acceptanceContract",
    ]) || typeof value.binding.workspaceId !== "string" || !UUID.test(value.binding.workspaceId)
    || typeof value.binding.recordId !== "string" || !UUID.test(value.binding.recordId)
    || !isSafeRepo(value.binding.repo) || !isPositiveInteger(value.binding.prNumber)
    || typeof value.binding.headSha !== "string" || !SHA1.test(value.binding.headSha)
    || typeof value.binding.headCycleId !== "string" || !UUID.test(value.binding.headCycleId)
    || !isNonNegativeInteger(value.binding.authorityGeneration)
    || !isObject(value.binding.acceptanceContract)
    || !hasExactKeys(value.binding.acceptanceContract, ["id", "version", "sha256"])
    || typeof value.binding.acceptanceContract.id !== "string"
    || !UUID.test(value.binding.acceptanceContract.id)
    || !isPositiveInteger(value.binding.acceptanceContract.version)
    || typeof value.binding.acceptanceContract.sha256 !== "string"
    || !SHA256.test(value.binding.acceptanceContract.sha256)
    || !Array.isArray(value.observations) || value.observations.length > 100) return false;

  const binding = value.binding;
  const eventIds = new Set<string>();
  const fingerprints = new Set<string>();
  let priorEventKey: string | null = null;
  return value.observations.every((item) => {
    if (!isObject(item) || !hasExactKeys(item, [
      "payloadVersion", "binding", "observation", "approval", "externalBuilderPack",
    ]) || (item.payloadVersion !== 1 && item.payloadVersion !== 2)
      || !isDependencyObservationBinding(item.binding)
      || item.binding.workspaceId !== binding.workspaceId
      || item.binding.recordId !== binding.recordId
      || item.binding.repo !== binding.repo
      || item.binding.prNumber !== binding.prNumber
      || item.binding.headSha !== binding.headSha
      || item.binding.headCycleId !== binding.headCycleId
      || item.binding.authorityGeneration !== binding.authorityGeneration
      || !exactJsonEqual(item.binding.acceptanceContract, binding.acceptanceContract)
      || !isDependencyObservation(item.observation, item.binding, item.payloadVersion)
      || eventIds.has(item.observation.eventId)
      || fingerprints.has(item.observation.candidateFingerprint)
      || (priorEventKey !== null && priorEventKey >= item.observation.eventKey)) return false;
    eventIds.add(item.observation.eventId);
    fingerprints.add(item.observation.candidateFingerprint);
    priorEventKey = item.observation.eventKey;
    if (item.approval === null || item.externalBuilderPack === null) {
      return item.approval === null && item.externalBuilderPack === null;
    }
    return item.observation.status === "observed"
      && isDependencyApproval(item.approval, item.binding, item.observation)
      && isDependencyExternalBuilderPack(
        item.externalBuilderPack,
        item.binding,
        item.observation,
        item.approval,
      );
  });
}

export function isDependencyDraftProposal(value: unknown): value is AcceptanceDependencyDraftProposal {
  if (!isObject(value)) return false;
  if (value.kind === "not_found" || value.kind === "not_draft_proposal" || value.kind === "invalid_custody") {
    return hasExactKeys(value, ["kind"]);
  }
  if (value.kind !== "draft" || !hasExactKeys(value, ["kind", "record", "proposal"])
    || !isObject(value.record) || !hasExactKeys(value.record, ["id", "repo", "contractId", "contractVersion"])
    || typeof value.record.id !== "string" || !UUID.test(value.record.id) || !isSafeRepo(value.record.repo)
    || typeof value.record.contractId !== "string" || !UUID.test(value.record.contractId)
    || value.record.contractVersion !== 1 || !isObject(value.proposal)
    || !hasExactKeys(value.proposal, [
      "custodyIdentity", "watch", "candidate", "files", "profile", "repositorySourceVerification",
      "independentSourceProof", "evidenceAdmission", "laterEvidence",
    ]) || typeof value.proposal.custodyIdentity !== "string" || !DEPENDENCY_FINGERPRINT.test(value.proposal.custodyIdentity)
    || !isObject(value.proposal.watch) || !hasExactKeys(value.proposal.watch, ["id", "observationId", "observationKey"])
    || typeof value.proposal.watch.id !== "string" || !UUID.test(value.proposal.watch.id)
    || typeof value.proposal.watch.observationId !== "string" || !UUID.test(value.proposal.watch.observationId)
    || !isSafeText(value.proposal.watch.observationKey, 512)
    || !isObject(value.proposal.candidate) || !hasExactKeys(value.proposal.candidate, [
      "package", "currentVersion", "targetVersion", "dependencyKind",
    ]) || !isSafeText(value.proposal.candidate.package, 214)
    || !isSafeText(value.proposal.candidate.currentVersion, 128)
    || !isSafeText(value.proposal.candidate.targetVersion, 128)
    || value.proposal.candidate.currentVersion === value.proposal.candidate.targetVersion
    || !["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]
      .includes(value.proposal.candidate.dependencyKind as string)
    || !isObject(value.proposal.files) || !hasExactKeys(value.proposal.files, ["manifest", "lockfile"])
    || !isObject(value.proposal.files.manifest) || !hasExactKeys(value.proposal.files.manifest, ["path", "sha256"])
    || value.proposal.files.manifest.path !== "package.json" || typeof value.proposal.files.manifest.sha256 !== "string"
    || !SHA256.test(value.proposal.files.manifest.sha256)
    || !isObject(value.proposal.files.lockfile) || !hasExactKeys(value.proposal.files.lockfile, ["path", "sha256"])
    || (value.proposal.files.lockfile.path !== "pnpm-lock.yaml"
      && value.proposal.files.lockfile.path !== "package-lock.json")
    || typeof value.proposal.files.lockfile.sha256 !== "string"
    || !SHA256.test(value.proposal.files.lockfile.sha256)
    || !isObject(value.proposal.profile) || !hasExactKeys(value.proposal.profile, ["ecosystem", "manager", "profile", "capability"])
    || value.proposal.profile.ecosystem !== "node"
    || value.proposal.profile.capability !== "proposal_observation_only"
    || value.proposal.repositorySourceVerification !== "watch_observation_only"
    || value.proposal.independentSourceProof !== "not_proven" || value.proposal.evidenceAdmission !== "unresolved"
    || !isObject(value.proposal.laterEvidence) || !hasExactKeys(value.proposal.laterEvidence, [
      "confirmation", "contextPack", "builderHandoff", "delivery", "result",
    ])) return false;
  const pnpmProfile = value.proposal.profile.manager === "pnpm"
    && value.proposal.profile.profile === "pnpm_lockfile_only_v1";
  const npmProfile = value.proposal.profile.manager === "npm"
    && value.proposal.profile.profile === "npm_package_lock_only_v1";
  if ((!pnpmProfile && !npmProfile)
    || (pnpmProfile && value.proposal.files.lockfile.path !== "pnpm-lock.yaml")
    || (pnpmProfile && value.proposal.candidate.dependencyKind !== "dependencies"
      && value.proposal.candidate.dependencyKind !== "devDependencies")
    || (npmProfile && value.proposal.files.lockfile.path !== "package-lock.json")) return false;
  return value.proposal.laterEvidence.confirmation === "not_recorded"
    && value.proposal.laterEvidence.contextPack === "not_recorded"
    && value.proposal.laterEvidence.builderHandoff === "not_recorded"
    && value.proposal.laterEvidence.delivery === "not_recorded"
    && value.proposal.laterEvidence.result === "not_recorded";
}

export function isChangeRecordResponse(value: unknown): value is ChangeRecordResponse {
  return isObject(value) && hasExactKeys(value, [
    "record", "events", "correctionPackets", "finalDecision", "reviewMetrics",
    "dependencyObservations", "acceptanceDetail", "dependencyDraftProposal",
    "criterionOutcomes", "canRecordFinalDecision", "canRecordReviewEffort",
    "canApproveDependencyObservation", "canCreateGatedGithubIssue",
  ]) && isObject(value.record) && Array.isArray(value.events)
    && value.events.every(isSafeTimelineEvent)
    && isCorrectionPacketsEnvelope(value.correctionPackets)
    && isFinalDecisionEnvelope(value.finalDecision)
    && isReviewMetricsEnvelope(value.reviewMetrics)
    && isDependencyObservationsEnvelope(value.dependencyObservations)
    && isAcceptanceRecordDetailEnvelope(value.acceptanceDetail)
    && isDependencyDraftProposal(value.dependencyDraftProposal)
    && isCriterionOutcomesEnvelope(value.criterionOutcomes)
    && criterionOutcomesMatchDetail(value.criterionOutcomes, value.acceptanceDetail)
    && typeof value.canRecordFinalDecision === "boolean"
    && typeof value.canRecordReviewEffort === "boolean"
    && typeof value.canApproveDependencyObservation === "boolean"
    && typeof value.canCreateGatedGithubIssue === "boolean";
}

export function changeRecordApiPath(workspaceId: string, recordId: string): string {
  return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/change-records/${encodeURIComponent(recordId)}`;
}

export function gatedGithubIssueApiPath(workspaceId: string, recordId: string): string {
  return `${changeRecordApiPath(workspaceId, recordId)}/gated-issue`;
}

export function gatedGithubIssuePostBody(bindingId: string): { bindingId: string } {
  return { bindingId };
}

export function dependencyObservationApprovalPatchBody(observationEventId: string): {
  action: "approve_dependency_observation";
  observationEventId: string;
} {
  return { action: "approve_dependency_observation", observationEventId };
}

export function reviewEffortPatchBody(bindingId: string, minutes: number): {
  action: "record_pr_review_effort";
  bindingId: string;
  minutes: number;
} {
  return { action: "record_pr_review_effort", bindingId, minutes };
}

export function finalDecisionPatchBody(
  bindingId: string,
  decision: AcceptancePrDecision,
  rationale?: string,
): {
  action: "record_pr_decision";
  bindingId: string;
  decision: AcceptancePrDecision;
  rationale?: string;
} {
  return {
    action: "record_pr_decision",
    bindingId,
    decision,
    ...(rationale === undefined ? {} : { rationale: rationale.trim() }),
  };
}

export function formatChangeRecordDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown time";
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function ChangeRecordBackLink({ workspaceId }: { workspaceId: string }) {
  return (
    <a
      href={`/dashboard/${workspaceId}/changes`}
      className="mb-4 inline-flex items-center gap-1 text-xs text-[var(--gray-09)] hover:text-[var(--gray-12)]"
    >
      <ArrowLeft size={14} /> Back to Changes
    </a>
  );
}

function githubUrl(repo: string, kind: "issues" | "pull", number: number): string {
  return `https://github.com/${repo}/${kind}/${number}`;
}

export function ChangeRecordAnchors({ record }: { record: ChangeRecord }) {
  return (
    <section className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)]">
      <div className="border-b border-[var(--gray-05)] px-4 py-3">
        <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">
          Change anchors
        </h2>
      </div>
      <dl className="grid gap-x-6 gap-y-3 px-4 py-4 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-[var(--gray-09)]">Repository</dt>
          <dd className="mt-1 font-mono text-[var(--gray-12)]">{record.repo}</dd>
        </div>
        <div>
          <dt className="text-[var(--gray-09)]">State</dt>
          <dd className="mt-1 capitalize text-[var(--gray-12)]">{record.state}</dd>
        </div>
        <div>
          <dt className="text-[var(--gray-09)]">Issue</dt>
          <dd className="mt-1">
            {record.issueNumber == null ? (
              <span className="text-[var(--gray-08)]">Not attached</span>
            ) : (
              <a
                href={githubUrl(record.repo, "issues", record.issueNumber)}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[var(--blue-11)] hover:underline"
              >
                #{record.issueNumber}
              </a>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-[var(--gray-09)]">Pull request</dt>
          <dd className="mt-1">
            {record.prNumber == null ? (
              <span className="text-[var(--gray-08)]">Not attached</span>
            ) : (
              <a
                href={githubUrl(record.repo, "pull", record.prNumber)}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[var(--blue-11)] hover:underline"
              >
                #{record.prNumber}
              </a>
            )}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-[var(--gray-09)]">Head commits</dt>
          <dd className="mt-1 flex flex-wrap gap-1.5">
            {record.headShas.length === 0 ? (
              <span className="text-[var(--gray-08)]">Not attached</span>
            ) : (
              record.headShas.map((sha) => (
                <code key={sha} title={sha} className="rounded-sm bg-[var(--gray-03)] px-1.5 py-0.5 font-mono text-[var(--gray-11)]">
                  {sha.slice(0, 12)}
                </code>
              ))
            )}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-[var(--gray-09)]">Merged commit</dt>
          <dd className="mt-1">
            {record.mergedSha ? (
              <code title={record.mergedSha} className="font-mono text-[var(--gray-11)]">
                {record.mergedSha.slice(0, 12)}
              </code>
            ) : (
              <span className="text-[var(--gray-08)]">Not attached</span>
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function CorrectionDatum({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-[var(--gray-09)]">{label}</dt>
      <dd className={`mt-1 break-words text-[var(--gray-12)]${mono ? " font-mono" : ""}`}>
        {children}
      </dd>
    </div>
  );
}

function CorrectionPacketCard({ packet }: { packet: AcceptanceCorrectionPacket }) {
  return (
    <article className="rounded border border-[var(--gray-05)] bg-[var(--gray-01)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-mono text-xs text-[var(--gray-09)]">{packet.criterion.id}</p>
          <h3 className="mt-1 text-sm font-medium text-[var(--gray-12)]">
            {packet.criterion.snapshot}
          </h3>
        </div>
        <span className="rounded-sm border border-[var(--gray-06)] bg-[var(--gray-03)] px-2 py-1 text-xs font-medium text-[var(--gray-11)]">
          {packet.state === "not_proven" ? "Not proven" : "Failed"}
        </span>
      </div>

      <dl className="mt-4 grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2">
        <CorrectionDatum label="Expected">{packet.expected}</CorrectionDatum>
        <CorrectionDatum label="Observed">{packet.observed}</CorrectionDatum>
        <CorrectionDatum label="Impact">{packet.impact}</CorrectionDatum>
        <CorrectionDatum label="Required correction">{packet.requiredCorrection}</CorrectionDatum>
        <CorrectionDatum label="Scope boundary">{packet.scopeBoundary}</CorrectionDatum>
        <CorrectionDatum label="Re-verification">{packet.reverification}</CorrectionDatum>
      </dl>

      <div className="mt-4 border-t border-[var(--gray-05)] pt-4">
        <h4 className="text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">
          Affected context and reproduction
        </h4>
        <dl className="mt-3 grid gap-x-6 gap-y-3 text-xs sm:grid-cols-3">
          <CorrectionDatum label="Modality" mono>{packet.affectedContext.modality}</CorrectionDatum>
          <CorrectionDatum label="Environment" mono>
            {packet.affectedContext.environmentKind ?? "Not recorded"}
          </CorrectionDatum>
          <CorrectionDatum label="Flow" mono>{packet.affectedContext.flow ?? "Not recorded"}</CorrectionDatum>
        </dl>
        {packet.affectedContext.reproduction == null ? (
          <p className="mt-3 text-xs text-[var(--gray-09)]">No bounded reproduction was recorded.</p>
        ) : (
          <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-3 font-mono text-xs text-[var(--gray-11)]">
            {JSON.stringify(packet.affectedContext.reproduction, null, 2)}
          </pre>
        )}
      </div>

      <div className="mt-4 border-t border-[var(--gray-05)] pt-4">
        <h4 className="text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">
          Evidence custody
        </h4>
        <dl className="mt-3 grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2">
          <CorrectionDatum label="Evidence reference" mono>{packet.evidence.evidenceRef}</CorrectionDatum>
          <CorrectionDatum label="Execution ID" mono>{packet.evidence.executionId ?? "Not recorded"}</CorrectionDatum>
          <CorrectionDatum label="Preview boot ID" mono>{packet.evidence.previewBootId ?? "Not recorded"}</CorrectionDatum>
        </dl>
      </div>

      <details className="mt-4 border-t border-[var(--gray-05)] pt-4">
        <summary className="cursor-pointer text-xs text-[var(--blue-11)] hover:underline">
          Packet identity
        </summary>
        <dl className="mt-3 grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2">
          <CorrectionDatum label="Packet ID" mono>{packet.packetId}</CorrectionDatum>
          <CorrectionDatum label="Format" mono>{packet.kind} v{packet.version}</CorrectionDatum>
          <CorrectionDatum label="Workspace ID" mono>{packet.workspaceId}</CorrectionDatum>
          <CorrectionDatum label="Record ID" mono>{packet.recordId}</CorrectionDatum>
          <CorrectionDatum label="Repository / PR" mono>{packet.repo}#{packet.prNumber}</CorrectionDatum>
          <CorrectionDatum label="Exact head" mono>{packet.headSha}</CorrectionDatum>
          <CorrectionDatum label="Review job ID" mono>{packet.jobId}</CorrectionDatum>
          <CorrectionDatum label="Acceptance Contract" mono>
            {packet.acceptanceContract.id} v{packet.acceptanceContract.version}
          </CorrectionDatum>
          <CorrectionDatum label="Basis" mono>{packet.basis}</CorrectionDatum>
        </dl>
      </details>
    </article>
  );
}

function DetailCorrectionPacketCard({
  packet,
}: {
  packet: AcceptanceRecordDetailCorrectionPacket;
}) {
  if (!isAcceptanceCorrectionPacket(packet)) {
    return <p className="text-xs text-[var(--red-11)]">Correction packet custody is invalid.</p>;
  }
  return <CorrectionPacketCard packet={packet} />;
}

function detailUnavailableCopy(
  value: Exclude<AcceptanceRecordDetailEnvelope, { kind: "record" }>,
): string {
  if (value.kind === "not_found") return "Canonical Acceptance detail was not found for this Record.";
  return `Canonical Acceptance detail is unavailable: ${value.reason.replaceAll("_", " ")}. No detail is inferred from the raw timeline.`;
}

function DetailStringList({ values, empty }: { values: string[]; empty: string }) {
  if (values.length === 0) return <p className="mt-2 text-xs text-[var(--gray-09)]">{empty}</p>;
  return (
    <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-[var(--gray-11)]">
      {values.map((value, index) => <li key={`${index}:${value}`}>{value}</li>)}
    </ul>
  );
}

function occurrenceLabel(kind: "current" | "merged" | "historical"): string {
  return kind === "current" ? "Current authoritative occurrence"
    : kind === "merged" ? "Signed merged occurrence" : "Historical occurrence";
}

export function criterionArtifactApiPath(
  workspaceId: string,
  recordId: string,
  artifactId: string,
): string {
  return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/change-records/${encodeURIComponent(recordId)}/criterion-outcomes/artifacts/${encodeURIComponent(artifactId)}`;
}

function criterionStateLabel(state: AcceptanceCriterionOutcome["state"]): string {
  return state === "proven" ? "Proven"
    : state === "failed" ? "Failed"
      : state === "not_proven" ? "Not proven" : "Not testable";
}

function CriterionOutcomeReceipt({
  outcome,
  workspaceId,
  recordId,
}: {
  outcome: AcceptanceCriterionOutcome;
  workspaceId: string;
  recordId: string;
}) {
  const { evidence } = outcome;
  return (
    <div className="mt-3 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-3">
      <p className="text-xs font-semibold text-[var(--gray-12)]">
        Current recorded outcome: {criterionStateLabel(outcome.state)}
      </p>
      <dl className="mt-2 grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
        <CorrectionDatum label="Expected">{outcome.expected}</CorrectionDatum>
        <CorrectionDatum label="Observed">{outcome.observed}</CorrectionDatum>
        <CorrectionDatum label="Evidence custody">
          {evidence.kind === "execution_receipt"
            ? `${evidence.modality} execution receipt · ${evidence.receiptEventId}`
            : evidence.kind === "preview_receipt"
              ? `exact preview receipt · ${evidence.previewBootId}`
              : `not-testable verification plan · ${evidence.planEventId}`}
        </CorrectionDatum>
        {evidence.kind === "execution_receipt" && evidence.artifact !== null ? (
          <CorrectionDatum label="Artifact">
            <a
              href={criterionArtifactApiPath(workspaceId, recordId, evidence.artifact.artifactId)}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              Open receipt artifact ({evidence.artifact.contentType})
            </a>
            <span className="mt-1 block break-all font-mono text-[var(--gray-09)]">
              SHA-256 {evidence.artifact.contentSha256}
            </span>
          </CorrectionDatum>
        ) : (
          <CorrectionDatum label="Artifact">
            No artifact is claimed for this evidence type and outcome.
          </CorrectionDatum>
        )}
      </dl>
    </div>
  );
}

export function AcceptanceRecordDetailPanel({
  acceptanceDetail,
  criterionOutcomes,
  workspaceId,
  recordId,
  canCreateGatedGithubIssue,
  onCreateGatedGithubIssue,
  creatingGatedGithubIssue,
  gatedGithubIssueError,
}: {
  acceptanceDetail: AcceptanceRecordDetailEnvelope;
  criterionOutcomes: AcceptanceCriterionOutcomesEnvelope;
  workspaceId: string;
  recordId: string;
  canCreateGatedGithubIssue: boolean;
  onCreateGatedGithubIssue: (bindingId: string) => void;
  creatingGatedGithubIssue: boolean;
  gatedGithubIssueError: string | null;
}) {
  if (acceptanceDetail.kind !== "record") {
    return (
      <section className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4">
        <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">
          Acceptance detail
        </h2>
        <p className="mt-3 text-sm text-[var(--gray-11)]">{detailUnavailableCopy(acceptanceDetail)}</p>
      </section>
    );
  }

  const { detail } = acceptanceDetail;
  const contract = detail.contract.contract;
  const occurrences = detail.pullRequest.kind === "attached" ? detail.pullRequest.occurrences : [];
  const currentBundle = criterionOutcomes.kind === "current" ? criterionOutcomes.bundle : null;
  const currentOutcomesByCriterion = new Map(
    currentBundle?.outcomes.map((outcome) => [outcome.criterionId, outcome]) ?? [],
  );
  const currentArtifactCount = currentBundle?.outcomes.filter((outcome) =>
    outcome.evidence.kind === "execution_receipt" && outcome.evidence.artifact !== null
  ).length ?? 0;
  const gatedIssueMatchesCurrentBundle = gatedIssueMatchesCriterionBundle(
    detail.gatedIssue,
    criterionOutcomes,
  );
  return (
    <section className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)]">
      <div className="border-b border-[var(--gray-05)] px-4 py-3">
        <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">
          Acceptance Contract, Context, and proof
        </h2>
        <p className="mt-1 text-xs text-[var(--gray-09)]">
          Server-validated Record custody. Raw lifecycle payloads below remain audit-only.
        </p>
      </div>

      <div className="space-y-6 p-4">
        <article>
          <h3 className="text-sm font-semibold text-[var(--gray-12)]">Confirmed Acceptance Contract</h3>
          <dl className="mt-3 grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2">
            <CorrectionDatum label="Contract identity" mono>
              {detail.contract.identity.id} v{detail.contract.identity.version}
            </CorrectionDatum>
            <CorrectionDatum label="Contract SHA-256" mono>{detail.contract.identity.sha256}</CorrectionDatum>
            <CorrectionDatum label="Confirmed by" mono>{detail.contract.confirmedBy}</CorrectionDatum>
            <CorrectionDatum label="Confirmed at">{formatChangeRecordDate(detail.contract.confirmedAt)}</CorrectionDatum>
            <CorrectionDatum label="Original request">{contract.originalRequest}</CorrectionDatum>
          </dl>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <h4 className="text-xs font-medium text-[var(--gray-12)]">Normalized requirements</h4>
              <DetailStringList values={contract.normalizedRequirements} empty="No normalized requirements recorded." />
            </div>
            <div>
              <h4 className="text-xs font-medium text-[var(--gray-12)]">Non-goals</h4>
              <DetailStringList values={contract.nonGoals} empty="No non-goals recorded." />
            </div>
            <div>
              <h4 className="text-xs font-medium text-[var(--gray-12)]">Risks</h4>
              <DetailStringList values={contract.risks} empty="No risks recorded." />
            </div>
            <div>
              <h4 className="text-xs font-medium text-[var(--gray-12)]">Stops</h4>
              <DetailStringList values={contract.stops} empty="No stop conditions recorded." />
            </div>
          </div>
          <div className="mt-4">
            <h4 className="text-xs font-medium text-[var(--gray-12)]">Acceptance criteria</h4>
            <ol className="mt-2 space-y-2">
              {contract.acceptanceCriteria.map((criterion) => (
                <li key={criterion.id} className="rounded border border-[var(--gray-05)] bg-[var(--gray-01)] p-3 text-xs">
                  <p className="font-mono text-[var(--gray-09)]">{criterion.id}</p>
                  <p className="mt-1 text-[var(--gray-12)]">{criterion.text}</p>
                  <p className="mt-1 text-[var(--gray-09)]">
                    {criterion.userVisible ? "User-visible" : "Internal"} · {criterion.modality ?? "Modality not recorded"}
                  </p>
                </li>
              ))}
            </ol>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <h4 className="text-xs font-medium text-[var(--gray-12)]">Environment</h4>
              <pre className="mt-2 overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--gray-05)] bg-[var(--gray-01)] p-3 font-mono text-xs text-[var(--gray-11)]">
                {JSON.stringify(contract.environment, null, 2)}
              </pre>
            </div>
            <div>
              <h4 className="text-xs font-medium text-[var(--gray-12)]">Unresolved questions</h4>
              {contract.unresolvedQuestions.length === 0 ? (
                <p className="mt-2 text-xs text-[var(--gray-09)]">No unresolved questions recorded.</p>
              ) : (
                <ul className="mt-2 space-y-2 text-xs text-[var(--gray-11)]">
                  {contract.unresolvedQuestions.map((question) => (
                    <li key={question.id}><code>{question.id}</code>: {question.text}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </article>

        <article className="border-t border-[var(--gray-05)] pt-5">
          <h3 className="text-sm font-semibold text-[var(--gray-12)]">Exact PR head occurrences</h3>
          {occurrences.length === 0 ? (
            <p className="mt-2 text-xs text-[var(--gray-09)]">No PR head occurrence is attached.</p>
          ) : (
            <div className="mt-3 space-y-3">
              {occurrences.map((occurrence) => (
                <div key={occurrence.headCycleId} className="rounded border border-[var(--gray-05)] bg-[var(--gray-01)] p-3">
                  <p className="text-xs font-medium text-[var(--gray-12)]">{occurrenceLabel(occurrence.kind)}</p>
                  <dl className="mt-2 grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
                    <CorrectionDatum label="Exact head SHA" mono>{occurrence.headSha}</CorrectionDatum>
                    <CorrectionDatum label="Head-cycle ID" mono>{occurrence.headCycleId}</CorrectionDatum>
                    {occurrence.kind !== "historical" ? (
                      <CorrectionDatum label="Authority generation" mono>{occurrence.authorityGeneration}</CorrectionDatum>
                    ) : (
                      <CorrectionDatum label="Authority generation">Not durably recorded for this historical cycle</CorrectionDatum>
                    )}
                    <CorrectionDatum label="Review job">
                      {occurrence.reviewJob.kind === "recorded"
                        ? `${occurrence.reviewJob.state} · ${occurrence.reviewJob.id}`
                        : "Not recorded"}
                    </CorrectionDatum>
                    {occurrence.kind === "merged" ? (
                      <>
                        <CorrectionDatum label="Merge SHA" mono>{occurrence.mergeSha}</CorrectionDatum>
                        <CorrectionDatum label="Merged at">{formatChangeRecordDate(occurrence.mergedAt)}</CorrectionDatum>
                      </>
                    ) : null}
                  </dl>
                </div>
              ))}
            </div>
          )}
        </article>

        <article className="border-t border-[var(--gray-05)] pt-5">
          <h3 className="text-sm font-semibold text-[var(--gray-12)]">Context Pack custody</h3>
          {detail.contextPacks.length === 0 ? (
            <p className="mt-2 text-xs text-[var(--gray-09)]">No validated Context Pack metadata is recorded.</p>
          ) : (
            <div className="mt-3 space-y-4">
              {detail.contextPacks.map((contextPack) => (
                <div key={contextPack.sourceSnapshot.id} className="rounded border border-[var(--gray-05)] bg-[var(--gray-01)] p-4">
                  <dl className="grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2">
                    <CorrectionDatum label="Source snapshot" mono>{contextPack.sourceSnapshot.id}</CorrectionDatum>
                    <CorrectionDatum label="Occurrence" mono>
                      {contextPack.occurrence.headSha} · {contextPack.occurrence.headCycleId}
                    </CorrectionDatum>
                    <CorrectionDatum label="Snapshot status">
                      {contextPack.sourceSnapshot.status === "admitted" ? "Admitted" : `Not proven · ${contextPack.sourceSnapshot.reason}`}
                    </CorrectionDatum>
                    <CorrectionDatum label="Packet-set SHA-256" mono>{contextPack.sourceSnapshot.packetSetSha256}</CorrectionDatum>
                    <CorrectionDatum label="Compiler" mono>{contextPack.sourceSnapshot.compilerVersion}</CorrectionDatum>
                    <CorrectionDatum label="Compiled variants">{contextPack.compiledPacks.length}</CorrectionDatum>
                  </dl>
                  {contextPack.compiledPacks.map((pack) => (
                    <div key={pack.id} className="mt-4 border-t border-[var(--gray-05)] pt-4">
                      <h4 className="text-xs font-medium text-[var(--gray-12)]">Compiled Pack receipt</h4>
                      <dl className="mt-3 grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2">
                        <CorrectionDatum label="Pack ID" mono>{pack.id}</CorrectionDatum>
                        <CorrectionDatum label="Pack SHA-256" mono>{pack.packSha256}</CorrectionDatum>
                        <CorrectionDatum label="Source-custody identity" mono>{pack.sourceCustodyIdentitySha256}</CorrectionDatum>
                        <CorrectionDatum label="Compiler / policy" mono>{pack.compilerVersion} · {pack.policyVersion}</CorrectionDatum>
                        <CorrectionDatum label="Base / merge base" mono>{pack.binding.baseSha} · {pack.binding.mergeBaseSha}</CorrectionDatum>
                        <CorrectionDatum label="Head / tree" mono>{pack.binding.headSha} · {pack.binding.headTreeSha}</CorrectionDatum>
                        <CorrectionDatum label="Persisted source bodies">
                          None — raw source and snippets are not persisted
                        </CorrectionDatum>
                        <CorrectionDatum label="Source / exclusion counts">
                          {pack.manifest.sourceCount} selected · {pack.manifest.exclusionCount} excluded
                        </CorrectionDatum>
                      </dl>
                      <div className="mt-4">
                        <h5 className="text-xs font-medium text-[var(--gray-12)]">Selected context citations</h5>
                        {pack.manifest.sources.length === 0 ? (
                          <p className="mt-2 text-xs text-[var(--gray-09)]">No selected citation metadata recorded.</p>
                        ) : (
                          <ul className="mt-2 space-y-2 text-xs text-[var(--gray-11)]">
                            {pack.manifest.sources.map((source, index) => (
                              <li key={`${source.rangeSha256}:${index}`} className="rounded bg-[var(--gray-02)] p-2">
                                <code>{source.kind === "base_index_background" ? source.slug : source.path}</code>
                                {` · lines ${source.startLine}-${source.endLine} · ${source.reason} · ${source.citation}`}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                      <div className="mt-4 grid gap-4 sm:grid-cols-2">
                        <div>
                          <h5 className="text-xs font-medium text-[var(--gray-12)]">Excluded context</h5>
                          {pack.manifest.exclusions.length === 0 ? (
                            <p className="mt-2 text-xs text-[var(--gray-09)]">No exclusions recorded.</p>
                          ) : (
                            <ul className="mt-2 space-y-1 text-xs text-[var(--gray-11)]">
                              {pack.manifest.exclusions.map((exclusion, index) => (
                                <li key={`${index}:${exclusion.identitySha256 ?? exclusion.reason}`}>
                                  <code>{exclusion.path ?? exclusion.source}</code> · {exclusion.reason}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                        <div>
                          <h5 className="text-xs font-medium text-[var(--gray-12)]">Exact-head source custody</h5>
                          <p className="mt-2 text-xs text-[var(--gray-11)]">
                            {pack.sourceCustody.changedFileCount} changed · {pack.sourceCustody.recordCount} records · {pack.sourceCustody.exclusionCount} exclusions · {pack.sourceCustody.directReadReceiptCount} direct reads · {pack.sourceCustody.selectedExactRangeCount} selected ranges
                          </p>
                          <DetailStringList
                            values={pack.sourceCustody.changedManifest.map((file) => `${file.path} (${file.status})`)}
                            empty="No changed-file metadata recorded."
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </article>

        <article className="border-t border-[var(--gray-05)] pt-5">
          <h3 className="text-sm font-semibold text-[var(--gray-12)]">Criterion proof matrix</h3>
          {currentBundle ? (
            <p className="mt-2 text-xs text-[var(--gray-09)]">
              Current immutable bundle <code>{currentBundle.sha256}</code> · recorded {formatChangeRecordDate(currentBundle.recordedAt)}.
              Current outcomes below supersede the detail projection&apos;s unknown placeholder for this exact cycle.
            </p>
          ) : (
            <p className="mt-2 text-xs text-[var(--gray-09)]">
              Current criterion outcomes are not available. No result is inferred from the aggregate review or raw timeline.
            </p>
          )}
          {detail.proofMatrix.length === 0 ? (
            <p className="mt-2 text-xs text-[var(--gray-09)]">No PR occurrence exists for criterion proof.</p>
          ) : (
            <div className="mt-3 space-y-4">
              {detail.proofMatrix.map((cycle) => (
                <div key={cycle.occurrence.headCycleId} className="rounded border border-[var(--gray-05)] bg-[var(--gray-01)] p-4">
                  <p className="font-mono text-xs text-[var(--gray-09)]">
                    {cycle.occurrence.headSha} · {cycle.occurrence.headCycleId}
                  </p>
                  <p className="mt-1 text-xs text-[var(--gray-11)]">
                    Review: {cycle.review.kind === "posted"
                      ? `${cycle.review.verdict} · posted receipt ${cycle.review.postedAttestationEventId}`
                      : cycle.review.kind === "not_posted"
                        ? `${cycle.review.state} · not posted`
                        : "not recorded"}
                  </p>
                  <div className="mt-3 space-y-3">
                    {cycle.criteria.map(({ criterion, proof }) => {
                      const currentOutcome = currentBundle?.binding.headCycleId === cycle.occurrence.headCycleId
                        ? currentOutcomesByCriterion.get(criterion.id) ?? null
                        : null;
                      return (
                        <div key={criterion.id} className="rounded border border-[var(--gray-05)] p-3">
                          <p className="font-mono text-xs text-[var(--gray-09)]">{criterion.id}</p>
                          <p className="mt-1 text-sm text-[var(--gray-12)]">{criterion.text}</p>
                          {currentOutcome ? (
                            <CriterionOutcomeReceipt
                              outcome={currentOutcome}
                              workspaceId={workspaceId}
                              recordId={recordId}
                            />
                          ) : proof.kind === "unknown" ? (
                            <p className="mt-2 text-xs font-medium text-[var(--gray-11)]">
                              Criterion evidence unknown: {proof.reason.replaceAll("_", " ")}. Aggregate review verdicts are not treated as criterion proof.
                            </p>
                          ) : null}
                          {proof.kind === "correction_packet" ? (
                            <details className="mt-3">
                              <summary className="cursor-pointer text-xs font-medium text-[var(--gray-11)]">
                                {`Correction context (${proof.state === "failed" ? "failed" : "not proven"})`}
                              </summary>
                              <div className="mt-2">
                                <DetailCorrectionPacketCard packet={proof.packet} />
                              </div>
                            </details>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </article>

        <div className="grid gap-3 border-t border-[var(--gray-05)] pt-5 sm:grid-cols-2">
          <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-01)] p-3">
            <p className="text-xs font-medium text-[var(--gray-12)]">
              Current artifact receipts: {currentBundle ? currentArtifactCount : "Unknown"}
            </p>
            <p className="mt-1 text-xs text-[var(--gray-09)]">
              {currentBundle
                ? `${currentArtifactCount} receipt-bound artifact${currentArtifactCount === 1 ? "" : "s"} in the current bundle. Historical artifact access is not inferred.`
                : "Artifact access is unavailable; no artifact receipt is inferred."}
            </p>
          </div>
          <GatedGithubIssueCard
            gatedIssue={detail.gatedIssue}
            canCreate={canCreateGatedGithubIssue && gatedIssueMatchesCurrentBundle}
            onCreate={onCreateGatedGithubIssue}
            creating={creatingGatedGithubIssue}
            error={gatedGithubIssueError}
          />
        </div>
      </div>
    </section>
  );
}

function gatedIssueMatchesCriterionBundle(
  gatedIssue: AcceptanceRecordDetailRecord["gatedIssue"],
  criterionOutcomes: AcceptanceCriterionOutcomesEnvelope,
): gatedIssue is Extract<AcceptanceRecordDetailRecord["gatedIssue"], { kind: "current" }> {
  if (gatedIssue.kind !== "current" || criterionOutcomes.kind !== "current") return false;
  const { binding } = gatedIssue;
  const { bundle } = criterionOutcomes;
  return binding.workspaceId === bundle.binding.workspaceId
    && binding.recordId === bundle.binding.recordId
    && binding.repo === bundle.binding.repo
    && binding.prNumber === bundle.binding.prNumber
    && binding.headSha === bundle.binding.headSha
    && binding.headCycleId === bundle.binding.headCycleId
    && binding.reviewJobId === bundle.binding.reviewJobId
    && binding.criterionOutcomeBundle.id === bundle.id
    && binding.criterionOutcomeBundle.eventId === bundle.eventId
    && binding.criterionOutcomeBundle.sha256 === bundle.sha256
    && binding.criterionOutcomeBundle.postedAttestationEventId
      === bundle.binding.postedAttestationEventId;
}

export function GatedGithubIssueCard({
  gatedIssue,
  canCreate,
  onCreate,
  creating,
  error,
}: {
  gatedIssue: AcceptanceRecordDetailRecord["gatedIssue"];
  canCreate: boolean;
  onCreate: (bindingId: string) => void;
  creating: boolean;
  error: string | null;
}) {
  let title = "Gated issue custody: Unknown";
  let message = "No gated-issue custody is available; no issue state is inferred.";
  if (gatedIssue.kind === "not_applicable") {
    title = "Gated issue: Not applicable";
    message = "The current exact review has no correction packets, so no gated issue is available.";
  } else if (gatedIssue.kind === "unavailable") {
    title = "Gated issue custody: Unavailable";
    message = `Current gated-issue custody is unavailable: ${gatedIssue.reason.replaceAll("_", " ")}.`;
  } else if (gatedIssue.kind === "current" && gatedIssue.issue === null) {
    title = "Gated issue: Not recorded";
    message = "The exact posted outcome bundle and correction packet set are eligible, but no issue publication is recorded.";
  } else if (gatedIssue.kind === "current" && gatedIssue.issue?.status === "reserved") {
    title = "Gated issue publication: Held";
    message = "A one-shot reservation exists without a verified GitHub result. It will not be retried automatically.";
  } else if (gatedIssue.kind === "current" && gatedIssue.issue?.status === "published"
    && gatedIssue.issue.receipt?.kind === "github_201") {
    title = "Gated issue custody: Created";
    message = "GitHub accepted the exact DB-issued issue and its receipt is durably recorded.";
  } else if (gatedIssue.kind === "current" && gatedIssue.issue?.status === "bounded_failed") {
    title = "Gated issue publication: Failed";
    message = `GitHub did not create a verified issue: ${gatedIssue.issue.receipt?.kind === "bounded_failed"
      ? gatedIssue.issue.receipt.reason.replaceAll("_", " ") : "invalid receipt custody"}.`;
  } else if (gatedIssue.kind === "current" && gatedIssue.issue?.status === "ambiguous_hold") {
    title = "Gated issue publication: Held";
    message = "The GitHub write outcome is ambiguous. It is held without retry to prevent a duplicate issue.";
  }

  const publishedReceipt = gatedIssue.kind === "current"
    && gatedIssue.issue?.status === "published" && gatedIssue.issue.receipt?.kind === "github_201"
    ? gatedIssue.issue.receipt : null;
  return (
    <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-01)] p-3">
      <p className="text-xs font-medium text-[var(--gray-12)]">{title}</p>
      <p className="mt-1 text-xs text-[var(--gray-09)]">{message}</p>
      {publishedReceipt ? (
        <a
          href={publishedReceipt.githubIssueUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-block text-xs underline underline-offset-2"
        >
          Open GitHub issue #{publishedReceipt.githubIssueNumber}
        </a>
      ) : null}
      {gatedIssue.kind === "current" && gatedIssue.issue === null ? (
        canCreate ? (
          <button
            type="button"
            disabled={creating}
            onClick={() => onCreate(gatedIssue.binding.bindingId)}
            className="mt-3 rounded bg-[var(--gray-12)] px-3 py-1.5 text-xs font-medium text-[var(--gray-01)] disabled:opacity-50"
          >
            {creating ? "Creating gated issue…" : "Create unlabeled GitHub issue"}
          </button>
        ) : (
          <p className="mt-2 text-xs text-[var(--gray-09)]">
            Creation requires this exact current bundle and a current workspace owner or admin.
          </p>
        )
      ) : null}
      <p className="mt-2 text-xs text-[var(--gray-09)]">
        This creation sends no trigger label and does not enqueue factory work, activate an agent,
        merge, or prove delivery. A later label would be a separate human action.
      </p>
      {error ? <p className="mt-2 text-xs text-[var(--red-11)]">{error}</p> : null}
    </div>
  );
}

function correctionUnavailableCopy(
  correctionPackets: Exclude<AcceptanceCorrectionPacketsEnvelope, { kind: "current" }>
): { label: string; message: string } {
  if (correctionPackets.kind === "not_found") {
    return {
      label: "Unavailable",
      message: "Correction custody was not found for this Change Record.",
    };
  }
  if (correctionPackets.kind === "not_current") {
    return {
      label: "Unavailable for the current head",
      message: "A stable authoritative current PR head and head cycle could not be read. Historical packet events remain in the lifecycle timeline.",
    };
  }
  switch (correctionPackets.reason) {
    case "no_correction_packets":
      return {
        label: "No current corrections",
        message: "No failed or not-proven correction packet is recorded for the current exact head and head cycle.",
      };
    case "review_job_unavailable":
      return {
        label: "Not ready",
        message: "The current exact-head cycle does not have a matching review job yet.",
      };
    case "confirmed_contract_unavailable":
      return {
        label: "Not ready",
        message: "The required single confirmed Acceptance Contract is unavailable for the current head cycle.",
      };
    case "invalid_packet_custody":
      return {
        label: "Unavailable",
        message: "Stored correction packet custody could not be validated, so no current packet set is presented.",
      };
  }
}

export function CorrectionsSection({
  correctionPackets,
}: {
  correctionPackets: AcceptanceCorrectionPacketsEnvelope;
}) {
  if (correctionPackets.kind !== "current") {
    const state = correctionUnavailableCopy(correctionPackets);
    return (
      <section className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4">
        <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">Corrections</h2>
        <p className="mt-3 text-sm font-medium text-[var(--gray-12)]">{state.label}</p>
        <p className="mt-1 text-xs text-[var(--gray-09)]">{state.message}</p>
      </section>
    );
  }

  const { binding } = correctionPackets;
  return (
    <section className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)]">
      <div className="border-b border-[var(--gray-05)] px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">
            Corrections ({correctionPackets.packets.length})
          </h2>
          <span className="rounded-sm border border-[var(--gray-06)] bg-[var(--gray-03)] px-2 py-1 text-xs font-medium text-[var(--gray-11)]">
            Current exact head and cycle
          </span>
        </div>
        <p className="mt-2 text-xs text-[var(--gray-09)]">
          Validated immutable packet projections for the Change Record&apos;s authoritative current PR head and head cycle. Private artifact storage coordinates are withheld.
        </p>
      </div>

      <div className="px-4 py-4">
        <dl className="grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2 lg:grid-cols-3">
          <CorrectionDatum label="Repository / PR" mono>{binding.repo}#{binding.prNumber}</CorrectionDatum>
          <CorrectionDatum label="Exact head" mono>{binding.headSha}</CorrectionDatum>
          <CorrectionDatum label="Head cycle ID" mono>{binding.headCycleId}</CorrectionDatum>
          <CorrectionDatum label="Authority generation" mono>{binding.authorityGeneration}</CorrectionDatum>
          <CorrectionDatum label="Review job ID" mono>{binding.reviewJobId}</CorrectionDatum>
          <CorrectionDatum label="Acceptance Contract" mono>
            {binding.acceptanceContract.id} v{binding.acceptanceContract.version}
          </CorrectionDatum>
        </dl>

        <details className="mt-4">
          <summary className="cursor-pointer text-xs text-[var(--blue-11)] hover:underline">
            Set custody identity
          </summary>
          <dl className="mt-3 grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2">
            <CorrectionDatum label="Workspace ID" mono>{binding.workspaceId}</CorrectionDatum>
            <CorrectionDatum label="Record ID" mono>{binding.recordId}</CorrectionDatum>
            <CorrectionDatum label="Contract SHA-256" mono>{binding.acceptanceContract.sha256}</CorrectionDatum>
            <CorrectionDatum label="Packet set SHA-256" mono>{correctionPackets.packetSetSha256}</CorrectionDatum>
            <CorrectionDatum label="Canonical packet payload-set custody SHA-256" mono>
              {correctionPackets.correctionPacketPayloadSetSha256}
            </CorrectionDatum>
            <CorrectionDatum label="Packet IDs" mono>{correctionPackets.packetIds.join(", ")}</CorrectionDatum>
          </dl>
        </details>

        <div className="mt-5 flex flex-col gap-3">
          {correctionPackets.packets.map((packet) => (
            <CorrectionPacketCard key={packet.packetId} packet={packet} />
          ))}
        </div>
      </div>
    </section>
  );
}

function finalDecisionLabel(decision: AcceptancePrDecision): string {
  switch (decision) {
    case "approved": return "Approved";
    case "changes_requested": return "Changes requested";
    case "rejected": return "Rejected";
    case "approved_with_exception": return "Approved with exception";
  }
}

export function FinalDecisionPanel({
  finalDecision,
  canRecordFinalDecision,
  onDecide,
  deciding,
  decisionError,
  exceptionRationale,
  onExceptionRationaleChange,
}: {
  finalDecision: AcceptanceFinalDecisionEnvelope;
  canRecordFinalDecision: boolean;
  onDecide: (decision: AcceptancePrDecision, rationale?: string) => void;
  deciding: boolean;
  decisionError: string | null;
  exceptionRationale: string;
  onExceptionRationaleChange: (value: string) => void;
}) {
  if (finalDecision.kind !== "current") {
    const message = finalDecision.kind === "not_current"
      ? "No decision can be recorded because an authoritative current PR head and cycle are unavailable. Historical decision events remain audit-only in the timeline."
      : finalDecision.kind === "not_found"
        ? "This Change Record is unavailable."
        : "The current exact-head review is not ready for a human decision.";
    return (
      <section className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4">
        <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">
          Final human decision
        </h2>
        <p className="mt-3 text-sm text-[var(--gray-09)]">{message}</p>
      </section>
    );
  }

  const { binding, decision } = finalDecision;
  const proven = binding.reviewVerdict === "proven";
  return (
    <section className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)]">
      <div className="border-b border-[var(--gray-05)] px-4 py-3">
        <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">
          Final human decision
        </h2>
        <p className="mt-2 text-xs text-[var(--gray-09)]">
          This records the human decision. Jace does not merge.
        </p>
      </div>
      <div className="space-y-4 px-4 py-4">
        <dl className="grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2">
          <CorrectionDatum label="Repository / PR" mono>{binding.repo}#{binding.prNumber}</CorrectionDatum>
          <CorrectionDatum label="Exact head" mono>{binding.headSha}</CorrectionDatum>
          <CorrectionDatum label="Head cycle" mono>{binding.headCycleId}</CorrectionDatum>
          <CorrectionDatum label="Review verdict" mono>{binding.reviewVerdict}</CorrectionDatum>
          <CorrectionDatum label="Authority generation" mono>{binding.authorityGeneration}</CorrectionDatum>
          <CorrectionDatum label="Acceptance Contract" mono>
            {binding.acceptanceContract.id} v{binding.acceptanceContract.version}
          </CorrectionDatum>
        </dl>
        <a
          href={binding.postedReviewUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex text-xs text-[var(--blue-11)] hover:underline"
        >
          Open the attested GitHub review
        </a>

        {decision ? (
          <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-01)] p-3 text-xs">
            <p className="font-medium text-[var(--gray-12)]">
              Recorded current decision: {finalDecisionLabel(decision.decision)}
            </p>
            <p className="mt-2 text-[var(--gray-09)]">
              {decision.decidedRole} · {decision.decidedBy} · {formatChangeRecordDate(decision.decidedAt)}
            </p>
            {decision.rationale ? (
              <p className="mt-2 whitespace-pre-wrap text-[var(--gray-11)]">{decision.rationale}</p>
            ) : null}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm font-medium text-[var(--gray-12)]">
              Not recorded for this current exact head
            </p>
            {!canRecordFinalDecision ? (
              <p className="text-xs text-[var(--gray-09)]">
                A workspace owner or admin can record the final decision.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  {proven ? (
                    <button
                      type="button"
                      disabled={deciding}
                      onClick={() => onDecide("approved")}
                      className="rounded bg-[var(--green-09)] px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-60"
                    >
                      {deciding ? "Recording…" : "Approve PR"}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={deciding}
                    onClick={() => onDecide("changes_requested")}
                    className="rounded bg-[var(--blue-09)] px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-60"
                  >
                    Request changes
                  </button>
                  <button
                    type="button"
                    disabled={deciding}
                    onClick={() => onDecide("rejected")}
                    className="rounded border border-[var(--gray-06)] px-2.5 py-1.5 text-xs font-medium text-[var(--gray-12)] disabled:opacity-60"
                  >
                    Reject PR
                  </button>
                </div>
                {!proven ? (
                  <div className="rounded border border-[var(--yellow-06)] bg-[var(--yellow-03)] p-3">
                    <label
                      className="block text-xs font-medium text-[var(--gray-12)]"
                      htmlFor={`decision-exception-${binding.reviewJobId}`}
                    >
                      Explicit exception rationale
                    </label>
                    <textarea
                      id={`decision-exception-${binding.reviewJobId}`}
                      value={exceptionRationale}
                      onChange={(event) => onExceptionRationaleChange(event.target.value)}
                      maxLength={4_000}
                      rows={3}
                      className="mt-2 w-full rounded border border-[var(--gray-06)] bg-[var(--gray-01)] p-2 text-xs text-[var(--gray-12)]"
                    />
                    <button
                      type="button"
                      disabled={deciding || !exceptionRationale.trim()}
                      onClick={() => onDecide("approved_with_exception", exceptionRationale)}
                      className="mt-2 rounded border border-[var(--yellow-08)] px-2.5 py-1.5 text-xs font-medium text-[var(--yellow-11)] disabled:opacity-60"
                    >
                      Record approval with exception
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </div>
        )}
        {decisionError ? <p className="text-sm text-[var(--red-11)]">{decisionError}</p> : null}
      </div>
    </section>
  );
}

function currentEffortCycle(
  reviewMetrics: AcceptancePrReviewMetricsEnvelope,
  finalDecision: AcceptanceFinalDecisionEnvelope,
): AcceptanceReviewCycle | null {
  if (reviewMetrics.kind !== "record" || reviewMetrics.currentCycle === null
    || finalDecision.kind !== "current") return null;
  const cycle = reviewMetrics.cycles.find((candidate) => candidate.current) ?? null;
  if (!cycle) return null;
  const decisionBinding = finalDecision.binding;
  return cycle.binding.workspaceId === decisionBinding.workspaceId
    && cycle.binding.recordId === decisionBinding.recordId
    && cycle.binding.repo === decisionBinding.repo
    && cycle.binding.prNumber === decisionBinding.prNumber
    && cycle.binding.headSha === decisionBinding.headSha
    && cycle.binding.headCycleId === decisionBinding.headCycleId
    && cycle.binding.reviewJobId === decisionBinding.reviewJobId
    ? cycle
    : null;
}

function evidenceCountCopy(summary: ReviewMetricsCountSummary): string {
  return `${summary.known}/${summary.eligible} recorded · ${summary.unknown}/${summary.eligible} unknown`;
}

export function ReviewMetricsPanel({
  reviewMetrics,
  finalDecision,
  canRecordReviewEffort,
  onRecordEffort,
  recordingEffort,
  effortError,
  effortMinutes,
  onEffortMinutesChange,
}: {
  reviewMetrics: AcceptancePrReviewMetricsEnvelope;
  finalDecision: AcceptanceFinalDecisionEnvelope;
  canRecordReviewEffort: boolean;
  onRecordEffort: (minutes: number) => void;
  recordingEffort: boolean;
  effortError: string | null;
  effortMinutes: string;
  onEffortMinutesChange: (value: string) => void;
}) {
  if (reviewMetrics.kind !== "record") {
    const message = reviewMetrics.kind === "not_found"
      ? "No Acceptance Record metrics were found."
      : "Review metrics could not be validated, so no historical cycle summary is shown.";
    return (
      <section className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4">
        <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">
          PR review metrics
        </h2>
        <p className="mt-3 text-sm text-[var(--gray-09)]">{message}</p>
      </section>
    );
  }

  const currentCycle = currentEffortCycle(reviewMetrics, finalDecision);
  const mayRecordCurrentEffort = canRecordReviewEffort
    && currentCycle?.effort.kind === "unknown";
  const parsedMinutes = /^\d+$/u.test(effortMinutes) ? Number(effortMinutes) : null;
  const validMinutes = parsedMinutes !== null && Number.isSafeInteger(parsedMinutes)
    && parsedMinutes >= 1 && parsedMinutes <= 1_440;
  const { summary } = reviewMetrics;

  return (
    <section className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)]">
      <div className="border-b border-[var(--gray-05)] px-4 py-3">
        <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">
          PR review metrics
        </h2>
        <p className="mt-2 text-xs text-[var(--gray-09)]">
          Historical exact-head cycles. Unknown means no receipt was recorded; it does not mean 0 minutes.
        </p>
      </div>
      <div className="space-y-4 px-4 py-4">
        <dl className="grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2">
          <CorrectionDatum label="Review effort">
            {evidenceCountCopy(summary.reviewEffort)}
            {summary.reviewEffort.known > 0
              ? ` · ${summary.reviewEffort.totalMinutes} total minutes · ${summary.reviewEffort.averageMinutes} average across recorded cycles`
              : " · no recorded-minute average"}
          </CorrectionDatum>
          <CorrectionDatum label="Human decisions">{evidenceCountCopy(summary.decisions)}</CorrectionDatum>
          <CorrectionDatum label="Signed merges">{evidenceCountCopy(summary.signedMerges)}</CorrectionDatum>
          <CorrectionDatum label="Post-merge outcomes">
            {evidenceCountCopy(summary.postMergeOutcomes)}
          </CorrectionDatum>
        </dl>

        {reviewMetrics.cycles.length === 0 ? (
          <p className="text-sm text-[var(--gray-09)]">No attested review cycles are recorded.</p>
        ) : (
          <ol className="space-y-2">
            {reviewMetrics.cycles.map((cycle) => (
              <li
                key={cycle.binding.headCycleId}
                className="rounded border border-[var(--gray-05)] bg-[var(--gray-01)] p-3 text-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium text-[var(--gray-12)]">
                    {cycle.current ? "Current exact-head cycle" : "Historical exact-head cycle"}
                  </p>
                  <time className="text-[var(--gray-09)]" dateTime={cycle.reviewedAt}>
                    {formatChangeRecordDate(cycle.reviewedAt)}
                  </time>
                </div>
                <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
                  <CorrectionDatum label="Exact head" mono>{cycle.binding.headSha}</CorrectionDatum>
                  <CorrectionDatum label="Head cycle" mono>{cycle.binding.headCycleId}</CorrectionDatum>
                  <CorrectionDatum label="Review effort">
                    {cycle.effort.kind === "known"
                      ? `Recorded: ${cycle.effort.value.minutes} whole minutes`
                      : "Unknown — not recorded; not zero"}
                  </CorrectionDatum>
                  <CorrectionDatum label="Human decision">
                    {cycle.decision.kind === "known"
                      ? `Recorded: ${finalDecisionLabel(cycle.decision.value.decision)}`
                      : "Unknown — not recorded"}
                  </CorrectionDatum>
                  <CorrectionDatum label="Signed merge">
                    {cycle.signedMerge.kind === "known"
                      ? `Recorded: ${cycle.signedMerge.value.decisionAlignment}`
                      : "Unknown — not recorded"}
                  </CorrectionDatum>
                  <CorrectionDatum label="Post-merge outcomes">
                    {cycle.postMergeOutcomes.kind === "known"
                      ? `Recorded: ${cycle.postMergeOutcomes.values.map((event) => event.outcome.kind).join(", ")}`
                      : "Unknown — not recorded"}
                  </CorrectionDatum>
                </dl>
              </li>
            ))}
          </ol>
        )}

        {mayRecordCurrentEffort ? (
          <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-01)] p-3">
            <label
              className="block text-xs font-medium text-[var(--gray-12)]"
              htmlFor={`review-effort-${currentCycle.binding.headCycleId}`}
            >
              Current cycle review effort (whole minutes)
            </label>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                id={`review-effort-${currentCycle.binding.headCycleId}`}
                type="number"
                min={1}
                max={1_440}
                step={1}
                value={effortMinutes}
                onChange={(event) => onEffortMinutesChange(event.target.value)}
                className="w-32 rounded border border-[var(--gray-06)] bg-[var(--gray-01)] px-2 py-1.5 text-xs text-[var(--gray-12)]"
              />
              <button
                type="button"
                disabled={recordingEffort || !validMinutes}
                onClick={() => validMinutes && onRecordEffort(parsedMinutes)}
                className="rounded bg-[var(--blue-09)] px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-60"
              >
                {recordingEffort ? "Recording…" : "Record review effort"}
              </button>
            </div>
            <p className="mt-2 text-xs text-[var(--gray-09)]">
              One immutable human-input receipt for this exact head and cycle.
            </p>
          </div>
        ) : null}
        {effortError ? <p className="text-sm text-[var(--red-11)]">{effortError}</p> : null}
      </div>
    </section>
  );
}

function dependencyObservationStatusLabel(status: AcceptanceDependencyObservationStatus): string {
  switch (status) {
    case "observed": return "Observed";
    case "refused_unsupported_profile": return "Refused: unsupported profile";
    case "refused_unsafe_runtime": return "Refused: unsafe runtime";
    case "refused_lockfile": return "Refused: lockfile";
    case "refused_baseline": return "Refused: baseline";
    case "refused_security": return "Refused: security";
    case "not_proven": return "Not proven";
  }
}

export function DependencyDraftProposalPanel({
  dependencyDraftProposal,
}: {
  dependencyDraftProposal: AcceptanceDependencyDraftProposal;
}) {
  if (dependencyDraftProposal.kind === "not_found" || dependencyDraftProposal.kind === "not_draft_proposal") {
    return null;
  }
  if (dependencyDraftProposal.kind === "invalid_custody") {
    return (
      <section className="rounded border border-[var(--red-06)] bg-[var(--red-02)] p-4">
        <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--red-11)]">Dependency proposal</h2>
        <p className="mt-2 text-sm text-[var(--red-11)]">
          Draft dependency proposal custody is malformed or incomplete. Nothing is admitted or authorized.
        </p>
      </section>
    );
  }
  const { proposal, record } = dependencyDraftProposal;
  return (
    <section className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">Draft dependency proposal</h2>
          <p className="mt-2 text-sm text-[var(--gray-11)]">
            Observation custody only. It has not confirmed work, admitted evidence, created a Context Pack, handed off to an agent, or delivered a result.
          </p>
        </div>
        <span className="rounded-sm border border-[var(--gray-06)] bg-[var(--gray-03)] px-2 py-1 font-mono text-xs text-[var(--gray-11)]">
          delivery authority: not granted
        </span>
      </div>
      <dl className="mt-4 grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2">
        <CorrectionDatum label="Package" mono>{proposal.candidate.package}</CorrectionDatum>
        <CorrectionDatum label="Observed change" mono>
          {proposal.candidate.currentVersion} → {proposal.candidate.targetVersion} ({proposal.candidate.dependencyKind})
        </CorrectionDatum>
        <CorrectionDatum label="Profile" mono>
          {proposal.profile.ecosystem}/{proposal.profile.manager}/{proposal.profile.profile} · {proposal.profile.capability}
        </CorrectionDatum>
        <CorrectionDatum label="Evidence admission" mono>{proposal.evidenceAdmission}</CorrectionDatum>
        <CorrectionDatum label="Manifest custody" mono>
          {proposal.files.manifest.path} · {proposal.files.manifest.sha256}
        </CorrectionDatum>
        <CorrectionDatum label="Lockfile custody" mono>
          {proposal.files.lockfile.path} · {proposal.files.lockfile.sha256}
        </CorrectionDatum>
        <CorrectionDatum label="Repository source" mono>{proposal.repositorySourceVerification}</CorrectionDatum>
        <CorrectionDatum label="Independent source proof" mono>{proposal.independentSourceProof}</CorrectionDatum>
      </dl>
      <p className="mt-4 border-t border-[var(--gray-05)] pt-4 text-xs text-[var(--gray-09)]">
        Confirmation, Context Pack, builder handoff, delivery, and result are not recorded.
      </p>
      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-[var(--blue-11)] hover:underline">Draft identities</summary>
        <dl className="mt-3 grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2">
          <CorrectionDatum label="Record" mono>{record.id}</CorrectionDatum>
          <CorrectionDatum label="Draft Contract" mono>{record.contractId} v{record.contractVersion}</CorrectionDatum>
          <CorrectionDatum label="Proposal custody" mono>{proposal.custodyIdentity}</CorrectionDatum>
          <CorrectionDatum label="Watch / observation" mono>{proposal.watch.id} / {proposal.watch.observationId}</CorrectionDatum>
        </dl>
      </details>
    </section>
  );
}

export function DependencyObservationsPanel({
  dependencyObservations,
  canApproveDependencyObservation,
  onApprove,
  approvingObservationEventId,
  approvalError,
}: {
  dependencyObservations: AcceptanceDependencyObservationsEnvelope;
  canApproveDependencyObservation: boolean;
  onApprove: (observationEventId: string) => void;
  approvingObservationEventId: string | null;
  approvalError: string | null;
}) {
  if (dependencyObservations.kind !== "current") {
    const message = dependencyObservations.kind === "not_found"
      ? "No Acceptance Record dependency evidence was found."
      : dependencyObservations.kind === "not_current"
        ? "Current dependency evidence is unavailable because the authoritative PR head changed."
        : "Current dependency evidence could not be validated.";
    return (
      <section className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4">
        <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">
          Dependency observations
        </h2>
        <p className="mt-3 text-sm text-[var(--gray-09)]">{message}</p>
      </section>
    );
  }

  const { binding, observations } = dependencyObservations;
  return (
    <section className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)]">
      <div className="border-b border-[var(--gray-05)] px-4 py-3">
        <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">
          Dependency observations ({observations.length})
        </h2>
        <p className="mt-2 text-xs text-[var(--gray-09)]">
          Current exact-head evidence. Approval records immutable evidence and Pack custody only;
          it grants no external authority.
        </p>
      </div>
      <div className="space-y-4 px-4 py-4">
        <dl className="grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2">
          <CorrectionDatum label="Repository / PR" mono>{binding.repo}#{binding.prNumber}</CorrectionDatum>
          <CorrectionDatum label="Exact head" mono>{binding.headSha}</CorrectionDatum>
          <CorrectionDatum label="Head cycle" mono>{binding.headCycleId}</CorrectionDatum>
          <CorrectionDatum label="Authority generation" mono>{binding.authorityGeneration}</CorrectionDatum>
          <CorrectionDatum label="Acceptance Contract" mono>
            {binding.acceptanceContract.id} v{binding.acceptanceContract.version}
          </CorrectionDatum>
          <CorrectionDatum label="Contract SHA-256" mono>{binding.acceptanceContract.sha256}</CorrectionDatum>
        </dl>

        {observations.length === 0 ? (
          <p className="text-sm text-[var(--gray-09)]">No dependency observations are recorded for this head.</p>
        ) : (
          <ol className="space-y-3">
            {observations.map(({ binding: itemBinding, observation, approval, externalBuilderPack }) => {
              const approving = approvingObservationEventId === observation.eventId;
              return (
                <li
                  key={observation.eventId}
                  className="rounded border border-[var(--gray-05)] bg-[var(--gray-01)] p-3 text-xs"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium text-[var(--gray-12)]">
                      {observation.candidate.package} {observation.candidate.currentVersion}
                      {" → "}{observation.candidate.targetVersion}
                    </p>
                    <span className="rounded border border-[var(--gray-06)] px-2 py-0.5 text-[var(--gray-10)]">
                      {dependencyObservationStatusLabel(observation.status)}
                    </span>
                  </div>
                  <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
                    <CorrectionDatum label="Observation" mono>{observation.eventId}</CorrectionDatum>
                    <CorrectionDatum label="Candidate fingerprint" mono>{observation.candidateFingerprint}</CorrectionDatum>
                    <CorrectionDatum label="Manifest" mono>
                      {observation.manifest.path} · {observation.manifest.blobSha}
                    </CorrectionDatum>
                    <CorrectionDatum label="Lockfile" mono>
                      {observation.lockfile.disposition} · {observation.lockfile.path}
                    </CorrectionDatum>
                    <CorrectionDatum label="Runtime">
                      {observation.runtime.disposition} · {observation.runtime.identity.ecosystem}/
                      {observation.runtime.identity.manager} · {observation.runtime.version ?? "version unavailable"}
                    </CorrectionDatum>
                    <CorrectionDatum label="Package manager">
                      {observation.packageManager.disposition} · {observation.packageManager.name}
                      {observation.packageManager.version ? ` ${observation.packageManager.version}` : ""}
                      {` · ${observation.packageManager.profile}`}
                    </CorrectionDatum>
                    <CorrectionDatum label="Security evidence">
                      {observation.security.identity.ecosystem}/{observation.security.identity.manager} · {observation.security.provider} · {observation.security.disposition}
                    </CorrectionDatum>
                    <CorrectionDatum label="Observed at">{formatChangeRecordDate(observation.observedAt)}</CorrectionDatum>
                    <CorrectionDatum label="Compiled Context Pack" mono>{itemBinding.compiledPack.id}</CorrectionDatum>
                    <CorrectionDatum label="Compiled Pack SHA-256" mono>{itemBinding.compiledPack.sha256}</CorrectionDatum>
                  </dl>
                  {observation.reasons.length > 0 ? (
                    <p className="mt-3 text-[var(--gray-09)]">
                      Reasons: {observation.reasons.join(", ")}
                    </p>
                  ) : null}

                  {approval && externalBuilderPack ? (
                    <div className="mt-4 rounded border border-[var(--green-06)] bg-[var(--green-03)] p-3">
                      <p className="font-medium text-[var(--gray-12)]">Immutable external-builder Pack receipt</p>
                      <p className="mt-2 text-[var(--gray-09)]">
                        Approved by {approval.approvedRole} · {approval.approvedBy} · {formatChangeRecordDate(approval.approvedAt)}
                      </p>
                      <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
                        <CorrectionDatum label="Pack ID" mono>{externalBuilderPack.packId}</CorrectionDatum>
                        <CorrectionDatum label="Pack event" mono>{externalBuilderPack.eventId}</CorrectionDatum>
                        <CorrectionDatum label="Approval event" mono>{approval.eventId}</CorrectionDatum>
                        <CorrectionDatum label="Source custody SHA-256" mono>
                          {externalBuilderPack.binding.compiledPack.sourceCustodyIdentitySha256}
                        </CorrectionDatum>
                        <CorrectionDatum label="Dependency-tree proof SHA-256" mono>
                          {externalBuilderPack.binding.compiledPack.exactHeadDependencyTreeProofsSha256}
                        </CorrectionDatum>
                        <CorrectionDatum label="Builder adapter" mono>{externalBuilderPack.route.adapter}</CorrectionDatum>
                        <CorrectionDatum label="Builder selection" mono>{externalBuilderPack.route.selectionEventId}</CorrectionDatum>
                        <CorrectionDatum label="Configuration version" mono>
                          {externalBuilderPack.route.configurationVersion}
                        </CorrectionDatum>
                        <CorrectionDatum label="Snapshot SHA-256" mono>{externalBuilderPack.route.snapshotSha256}</CorrectionDatum>
                        <CorrectionDatum label="External authority" mono>{externalBuilderPack.deliveryAuthority}</CorrectionDatum>
                        <CorrectionDatum label="Required review" mono>{externalBuilderPack.reviewRequirement}</CorrectionDatum>
                      </dl>
                    </div>
                  ) : observation.status !== "observed" ? (
                    <p className="mt-3 text-[var(--gray-09)]">
                      This observation is not eligible for approval.
                    </p>
                  ) : canApproveDependencyObservation ? (
                    <button
                      type="button"
                      disabled={approvingObservationEventId !== null}
                      onClick={() => onApprove(observation.eventId)}
                      className="mt-3 rounded bg-[var(--blue-09)] px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-60"
                    >
                      {approving
                        ? "Approving & minting…"
                        : "Approve & mint external-builder Pack"}
                    </button>
                  ) : (
                    <p className="mt-3 text-[var(--gray-09)]">
                      A workspace owner or admin can approve this observation.
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        {approvalError ? <p className="text-sm text-[var(--red-11)]">{approvalError}</p> : null}
      </div>
    </section>
  );
}

export function LifecycleTimeline({ events }: { events: ChangeRecordEvent[] }) {
  return (
    <section>
      <h2 className="mb-3 text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">
        Lifecycle events ({events.length})
      </h2>
      {events.length === 0 ? (
        <p className="text-sm text-[var(--gray-09)]">No lifecycle evidence attached yet.</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {events.map((event, index) => (
            <li
              key={event.id}
              className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium capitalize text-[var(--gray-12)]">
                    {event.stage}
                  </span>
                  <span className="rounded-sm bg-[var(--gray-03)] px-1.5 py-0.5 font-mono text-xs text-[var(--gray-09)]">
                    {event.actor}
                  </span>
                  {event.stage === "human_pr_decision" ? (
                    <span className="rounded-sm border border-[var(--gray-06)] px-1.5 py-0.5 text-xs text-[var(--gray-09)]">
                      Audit history only
                    </span>
                  ) : null}
                </div>
                <time dateTime={event.at} title={new Date(event.at).toLocaleString()} className="font-mono text-xs text-[var(--gray-09)]">
                  {formatChangeRecordDate(event.at)}
                </time>
              </div>
              <p className="mt-2 font-mono text-xs text-[var(--gray-09)]">
                {index + 1}. {event.eventKey}
              </p>
              <details className="mt-3">
                <summary className="cursor-pointer text-xs text-[var(--blue-11)] hover:underline">
                  Evidence reference
                </summary>
                <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--gray-05)] bg-[var(--gray-01)] p-3 font-mono text-xs text-[var(--gray-11)]">
                  {JSON.stringify(event.payloadRef, null, 2)}
                </pre>
              </details>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function ChangeRecordView({ workspaceId, recordId }: { workspaceId: string; recordId: string }) {
  const [data, setData] = useState<ChangeRecordResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [deciding, setDeciding] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [exceptionRationale, setExceptionRationale] = useState("");
  const [recordingEffort, setRecordingEffort] = useState(false);
  const [effortError, setEffortError] = useState<string | null>(null);
  const [effortMinutes, setEffortMinutes] = useState("");
  const [approvingObservationEventId, setApprovingObservationEventId] = useState<string | null>(null);
  const [dependencyApprovalError, setDependencyApprovalError] = useState<string | null>(null);
  const [creatingGatedGithubIssue, setCreatingGatedGithubIssue] = useState(false);
  const [gatedGithubIssueError, setGatedGithubIssueError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(changeRecordApiPath(workspaceId, recordId), {
          cache: "no-store",
          signal: controller.signal,
        });
        const body = (await response.json().catch(() => ({}))) as Partial<ChangeRecordResponse> & { error?: string };
        if (!response.ok) {
          throw new Error(body.error ?? `HTTP ${response.status}`);
        }
        if (!isChangeRecordResponse(body)) {
          throw new Error("Change record response was incomplete");
        }
        setData(body as ChangeRecordResponse);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : "Failed to load change record");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    load();
    return () => controller.abort();
  }, [workspaceId, recordId, reloadVersion]);

  async function recordFinalDecision(
    decision: AcceptancePrDecision,
    rationale?: string,
  ) {
    if (!data || data.finalDecision.kind !== "current") {
      setDecisionError("The current decision binding is no longer available");
      return;
    }
    setDeciding(true);
    setDecisionError(null);
    try {
      const response = await fetch(changeRecordApiPath(workspaceId, recordId), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(finalDecisionPatchBody(
          data.finalDecision.binding.bindingId,
          decision,
          rationale,
        )),
      });
      const body = (await response.json().catch(() => ({}))) as {
        kind?: string;
        error?: string;
        reason?: string;
      };
      if (!response.ok || (body.kind !== "recorded" && body.kind !== "replayed")) {
        throw new Error(body.error ?? body.reason ?? `HTTP ${response.status}`);
      }
      setExceptionRationale("");
      setReloadVersion((current) => current + 1);
    } catch (caught) {
      setDecisionError(
        caught instanceof Error ? caught.message : "Failed to record final decision",
      );
    } finally {
      setDeciding(false);
    }
  }

  async function recordReviewEffort(minutes: number) {
    if (!data || data.finalDecision.kind !== "current"
      || currentEffortCycle(data.reviewMetrics, data.finalDecision)?.effort.kind !== "unknown") {
      setEffortError("The current exact-head effort binding is no longer available");
      return;
    }
    if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1_440) {
      setEffortError("Review effort must be 1 to 1440 whole minutes");
      return;
    }
    setRecordingEffort(true);
    setEffortError(null);
    try {
      const response = await fetch(changeRecordApiPath(workspaceId, recordId), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reviewEffortPatchBody(
          data.finalDecision.binding.bindingId,
          minutes,
        )),
      });
      const body = (await response.json().catch(() => ({}))) as {
        kind?: string;
        error?: string;
        reason?: string;
      };
      if (!response.ok || (body.kind !== "recorded" && body.kind !== "replayed")) {
        throw new Error(body.error ?? body.reason ?? `HTTP ${response.status}`);
      }
      setEffortMinutes("");
      setReloadVersion((current) => current + 1);
    } catch (caught) {
      setEffortError(
        caught instanceof Error ? caught.message : "Failed to record review effort",
      );
    } finally {
      setRecordingEffort(false);
    }
  }

  async function approveDependencyObservation(observationEventId: string) {
    if (!data || data.dependencyObservations.kind !== "current") {
      setDependencyApprovalError("The current dependency observation is no longer available");
      return;
    }
    const item = data.dependencyObservations.observations.find(
      (candidate) => candidate.observation.eventId === observationEventId,
    );
    if (!item || item.observation.status !== "observed"
      || item.approval !== null || item.externalBuilderPack !== null) {
      setDependencyApprovalError("The dependency observation is not eligible for approval");
      return;
    }
    setApprovingObservationEventId(observationEventId);
    setDependencyApprovalError(null);
    try {
      const response = await fetch(changeRecordApiPath(workspaceId, recordId), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(dependencyObservationApprovalPatchBody(observationEventId)),
      });
      const body = (await response.json().catch(() => ({}))) as {
        kind?: string;
        error?: string;
        reason?: string;
      };
      if (!response.ok || (body.kind !== "approved" && body.kind !== "replayed")) {
        throw new Error(body.error ?? body.reason ?? `HTTP ${response.status}`);
      }
      setReloadVersion((current) => current + 1);
    } catch (caught) {
      setDependencyApprovalError(
        caught instanceof Error ? caught.message : "Failed to approve dependency observation",
      );
    } finally {
      setApprovingObservationEventId(null);
    }
  }

  async function createGatedGithubIssue(bindingId: string) {
    const gatedIssue = data?.acceptanceDetail.kind === "record"
      ? data.acceptanceDetail.detail.gatedIssue : null;
    if (!data || !gatedIssue
      || !gatedIssueMatchesCriterionBundle(
        gatedIssue,
        data.criterionOutcomes,
      )
      || gatedIssue.issue !== null || gatedIssue.binding.bindingId !== bindingId) {
      setGatedGithubIssueError("The current exact gated-issue binding is no longer available");
      return;
    }
    const expectedBinding = gatedIssue.binding;
    setCreatingGatedGithubIssue(true);
    setGatedGithubIssueError(null);
    try {
      const response = await fetch(gatedGithubIssueApiPath(workspaceId, recordId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(gatedGithubIssuePostBody(bindingId)),
      });
      const body = (await response.json().catch(() => null)) as unknown;
      if (isGatedGithubIssueMutationResponse(body, expectedBinding)) {
        if (!gatedGithubIssueMutationStatusMatches(response.status, body)) {
          throw new Error("Gated issue publication returned an invalid status");
        }
        if (body.kind === "held" && "reason" in body) {
          setGatedGithubIssueError(
            "Issue publication is held because its terminal outcome was not durably recorded",
          );
        }
        setReloadVersion((current) => current + 1);
        return;
      }
      throw new Error("Gated issue publication was not accepted for the current binding");
    } catch (caught) {
      setGatedGithubIssueError(
        caught instanceof Error
          ? caught.message
          : "Gated issue publication was unavailable",
      );
    } finally {
      setCreatingGatedGithubIssue(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-[900px]">
        <ChangeRecordBackLink workspaceId={workspaceId} />
        <p className="animate-pulse py-8 text-sm text-[var(--gray-09)]">Loading change record...</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="mx-auto max-w-[900px]">
        <ChangeRecordBackLink workspaceId={workspaceId} />
        <p className="py-8 text-sm text-[var(--red-11)]">{error ?? "Change record not found"}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-6">
      <div>
        <ChangeRecordBackLink workspaceId={workspaceId} />
        <PageHeader
          title="Change Record"
          subtitle={`${data.record.repo} · ${data.record.state}`}
          actions={<CopyId id={data.record.id} label="Record" />}
        />
        <p className="text-xs text-[var(--gray-09)]">
          Created {formatChangeRecordDate(data.record.createdAt)} · Updated {formatChangeRecordDate(data.record.updatedAt)}
        </p>
      </div>
      <ChangeRecordAnchors record={data.record} />
      <AcceptanceRecordDetailPanel
        acceptanceDetail={data.acceptanceDetail}
        criterionOutcomes={data.criterionOutcomes}
        workspaceId={workspaceId}
        recordId={recordId}
        canCreateGatedGithubIssue={data.canCreateGatedGithubIssue}
        onCreateGatedGithubIssue={createGatedGithubIssue}
        creatingGatedGithubIssue={creatingGatedGithubIssue}
        gatedGithubIssueError={gatedGithubIssueError}
      />
      <CorrectionsSection correctionPackets={data.correctionPackets} />
      <FinalDecisionPanel
        finalDecision={data.finalDecision}
        canRecordFinalDecision={data.canRecordFinalDecision}
        onDecide={recordFinalDecision}
        deciding={deciding}
        decisionError={decisionError}
        exceptionRationale={exceptionRationale}
        onExceptionRationaleChange={setExceptionRationale}
      />
      <ReviewMetricsPanel
        reviewMetrics={data.reviewMetrics}
        finalDecision={data.finalDecision}
        canRecordReviewEffort={data.canRecordReviewEffort}
        onRecordEffort={recordReviewEffort}
        recordingEffort={recordingEffort}
        effortError={effortError}
        effortMinutes={effortMinutes}
        onEffortMinutesChange={setEffortMinutes}
      />
      <DependencyDraftProposalPanel dependencyDraftProposal={data.dependencyDraftProposal} />
      <DependencyObservationsPanel
        dependencyObservations={data.dependencyObservations}
        canApproveDependencyObservation={data.canApproveDependencyObservation}
        onApprove={approveDependencyObservation}
        approvingObservationEventId={approvingObservationEventId}
        approvalError={dependencyApprovalError}
      />
      <LifecycleTimeline events={data.events} />
    </div>
  );
}
