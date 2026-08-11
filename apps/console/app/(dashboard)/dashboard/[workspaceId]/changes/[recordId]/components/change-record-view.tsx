"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { CopyId } from "../../../../../../components/copy-id";
import { PageHeader } from "../../../../../../components/page-header";

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
  | "security_evidence_ambiguous";

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

export type ChangeRecordResponse = {
  record: ChangeRecord;
  events: ChangeRecordEvent[];
  correctionPackets: AcceptanceCorrectionPacketsEnvelope;
  finalDecision: AcceptanceFinalDecisionEnvelope;
  reviewMetrics: AcceptancePrReviewMetricsEnvelope;
  dependencyObservations: AcceptanceDependencyObservationsEnvelope;
  canRecordFinalDecision: boolean;
  canRecordReviewEffort: boolean;
  canApproveDependencyObservation: boolean;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA1 = /^[a-f0-9]{40}$/i;
const SHA256 = /^[a-f0-9]{64}$/i;
const CORRECTION_PACKET_ID = /^correction-[a-f0-9]{48}$/i;
const SAFE_REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SECRET_LIKE = /(?:\b(?:bearer|token|authorization)\s+|\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+))/i;

function isSafeText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max
    && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value) && !SECRET_LIKE.test(value);
}

function isSafeRepo(value: unknown): value is string {
  return typeof value === "string" && SAFE_REPO.test(value)
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
  if (!isObject(value) || !hasExactKeys(value, [
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
const EXACT_SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const UNSAFE_NPM_SPECIFIER = /^(?:file|link|workspace|git\+|git|path|https?):/iu;
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

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

function isOperationalPnpmIdentity(value: AcceptanceDependencyProfileIdentity): boolean {
  return value.ecosystem === "node" && value.manager === "pnpm" && value.profile === "pnpm_lockfile_only_v1";
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
    || value === "security_evidence_unavailable" || value === "security_evidence_ambiguous";
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
    !isOperationalPnpmIdentity(value.candidate.identity)
    || !exactJsonEqual(value.runtime.identity, value.candidate.identity)
    || !exactJsonEqual(value.security.identity, value.candidate.identity)
    || value.status === "refused_unsupported_profile"
    || value.reasons.includes("unsupported_manager_profile")
  )) return false;
  if (value.status !== "observed") return true;
  const expectedArgv = [
    "pnpm", "update", `${value.candidate.package}@${value.candidate.targetVersion}`,
    "--lockfile-only", "--ignore-scripts",
  ];
  return isOperationalPnpmIdentity(value.candidate.identity)
    && exactJsonEqual(value.runtime.identity, value.candidate.identity)
    && exactJsonEqual(value.security.identity, value.candidate.identity)
    && NPM_PACKAGE.test(value.candidate.package)
    && ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]
      .includes(value.candidate.dependencyKind)
    && !UNSAFE_NPM_SPECIFIER.test(value.candidate.specifier)
    && EXACT_SEMVER.test(value.candidate.currentVersion)
    && EXACT_SEMVER.test(value.candidate.targetVersion)
    && value.runtime.disposition === "safe" && EXACT_SEMVER.test(value.runtime.version ?? "")
    && value.packageManager.disposition === "safe"
    && value.packageManager.name === "pnpm"
    && EXACT_SEMVER.test(value.packageManager.version ?? "")
    && value.packageManager.profile === "pnpm_lockfile_only_v1"
    && exactJsonEqual(value.packageManager.updateArgv, expectedArgv)
    && (value.manifest.path === "package.json" || value.manifest.path.endsWith("/package.json"))
    && (value.lockfile.path === "pnpm-lock.yaml" || value.lockfile.path.endsWith("/pnpm-lock.yaml"))
    && value.lockfile.disposition === "present"
    && value.security.disposition === "clear" && value.security.provider === "osv"
    && value.security.reference === `osv:npm:${value.candidate.package}@${value.candidate.targetVersion}`
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

export function isChangeRecordResponse(value: unknown): value is ChangeRecordResponse {
  return isObject(value) && hasExactKeys(value, [
    "record", "events", "correctionPackets", "finalDecision", "reviewMetrics",
    "dependencyObservations", "canRecordFinalDecision", "canRecordReviewEffort",
    "canApproveDependencyObservation",
  ]) && isObject(value.record) && Array.isArray(value.events)
    && isCorrectionPacketsEnvelope(value.correctionPackets)
    && isFinalDecisionEnvelope(value.finalDecision)
    && isReviewMetricsEnvelope(value.reviewMetrics)
    && isDependencyObservationsEnvelope(value.dependencyObservations)
    && typeof value.canRecordFinalDecision === "boolean"
    && typeof value.canRecordReviewEffort === "boolean"
    && typeof value.canApproveDependencyObservation === "boolean";
}

export function changeRecordApiPath(workspaceId: string, recordId: string): string {
  return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/change-records/${encodeURIComponent(recordId)}`;
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
          <CorrectionDatum label="Artifact key" mono>{packet.evidence.artifactKey ?? "Not recorded"}</CorrectionDatum>
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
          Validated immutable packets for the Change Record&apos;s authoritative current PR head and head cycle.
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
            <CorrectionDatum label="Packet payload set SHA-256" mono>
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
