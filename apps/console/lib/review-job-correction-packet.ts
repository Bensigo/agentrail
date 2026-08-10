import { isDeepStrictEqual } from "node:util";
import {
  reviewJobCorrectionPacketId,
  validateReviewJobCorrectionPacketPayload,
} from "@agentrail/db-postgres";
import {
  resolveReviewJobApiResult,
  type ReviewJobApiExecutionResult,
} from "./review-job-api-execution";
import {
  resolveReviewJobDataResult,
  type ReviewJobDataExecutionResult,
} from "./review-job-data-execution";
import {
  resolveReviewJobResult,
  type ReviewJobExecutionResult,
} from "./review-job-job-execution";
import {
  resolveReviewJobUiResult,
  type ReviewJobUiExecutionResult,
} from "./review-job-ui-execution";
import type {
  CriterionResult,
  CriterionState,
  ExactReviewJobProof,
} from "./review-job-proof-attestation";
import type {
  DataVerificationRequest,
  StoredCriterionVerificationPlan,
  UiVerificationStep,
} from "./review-job-verification-plan";
import { scanForSecrets } from "./secret-scan";

/** One immutable, server-derived correction request for an exact review result. */
export const REVIEW_JOB_CORRECTION_PACKET_KIND = "review_job_correction_packet";
export const REVIEW_JOB_CORRECTION_PACKET_VERSION = 1;
const PREVIEW_BOOT_EVIDENCE_PREFIX = "preview-boot:";
const MAX_PACKET_TEXT = 2_000;
const MAX_PACKET_JSON = 24_000;

type CorrectionState = Extract<CriterionState, "failed" | "not_proven">;
type CorrectionReceipt =
  | ReviewJobUiExecutionResult
  | ReviewJobApiExecutionResult
  | ReviewJobDataExecutionResult
  | ReviewJobExecutionResult;

export type SafeUiReproductionStep =
  | { action: "open"; path: string }
  | { action: "click"; selector: string }
  | { action: "fill"; selector: string; value: "[REDACTED_FILL]" }
  | { action: "press"; key: string }
  | { action: "expect_text"; text: string }
  | { action: "screenshot"; label: string };

export type CorrectionReproduction =
  | { modality: "ui"; steps: SafeUiReproductionStep[] }
  | { modality: "api"; request: { method: "GET"; path: string; expectedStatus: number } }
  | {
      modality: "data";
      request: SafeDataRequestDescriptor;
    }
  | {
      modality: "job";
      request: {
        trigger: { method: "POST"; path: string; expectedStatus: number };
        readback: SafeDataRequestDescriptor;
      };
    };

/** HMAC metadata and JSON pointers only; raw expected values and key bytes cannot enter a packet. */
export interface SafeDataRequestDescriptor {
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
}

export interface ReviewJobCorrectionPacket extends Record<string, unknown> {
  kind: typeof REVIEW_JOB_CORRECTION_PACKET_KIND;
  version: typeof REVIEW_JOB_CORRECTION_PACKET_VERSION;
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
  state: CorrectionState;
  expected: string;
  observed: string;
  affectedContext: {
    modality: "ui" | "api" | "data" | "job";
    environmentKind: "isolated_preview" | null;
    flow: string | null;
    reproduction: CorrectionReproduction | null;
  };
  evidence: {
    evidenceRef: string;
    artifactKey?: string;
    executionId?: string;
    previewBootId?: string;
  };
  scopeBoundary: string;
  impact: string;
  requiredCorrection: string;
  reverification: string;
}

function object(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function nonBlank(value: unknown, max = MAX_PACKET_TEXT): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= max && !/[\x00-\x1f\x7f]/u.test(text) && scanForSecrets(text).clean
    ? text
    : null;
}

function safeIdentifier(value: unknown): string | null {
  return nonBlank(value, 512);
}

export function reviewJobCorrectionPacketEventKey(input: {
  jobId: string;
  criterionId: string;
}): string | null {
  const jobId = safeIdentifier(input.jobId);
  const criterionId = safeIdentifier(input.criterionId);
  return jobId && criterionId
    ? `review:correction:${jobId}:${criterionId}`
    : null;
}

function safeUiSteps(steps: UiVerificationStep[] | null): SafeUiReproductionStep[] | null {
  if (!steps || !Array.isArray(steps) || steps.length === 0) return null;
  const safe: SafeUiReproductionStep[] = [];
  for (const step of steps) {
    switch (step.action) {
      case "open":
        if (!nonBlank(step.path)) return null;
        safe.push({ action: "open", path: step.path });
        break;
      case "click":
        if (!nonBlank(step.selector)) return null;
        safe.push({ action: "click", selector: step.selector });
        break;
      case "fill":
        if (!nonBlank(step.selector) || typeof step.value !== "string") return null;
        safe.push({ action: "fill", selector: step.selector, value: "[REDACTED_FILL]" });
        break;
      case "press":
        if (!nonBlank(step.key)) return null;
        safe.push({ action: "press", key: step.key });
        break;
      case "expect_text":
        if (!nonBlank(step.text)) return null;
        safe.push({ action: "expect_text", text: step.text });
        break;
      case "screenshot":
        if (!nonBlank(step.label)) return null;
        safe.push({ action: "screenshot", label: step.label });
        break;
      default:
        return null;
    }
  }
  return safe;
}

function safeDataRequest(request: DataVerificationRequest | null): SafeDataRequestDescriptor | null {
  if (!request || !nonBlank(request.path) || !safeIdentifier(request.digestKeyId) ||
    !nonBlank(request.digestContext) || request.method !== "GET" ||
    !Number.isInteger(request.expectedStatus) || request.expectedStatus < 100 || request.expectedStatus > 599 ||
    request.digestAlgorithm !== "hmac-sha256-v1" || !Array.isArray(request.expectedJson)) return null;
  const expectedJson: SafeDataRequestDescriptor["expectedJson"] = [];
  for (const assertion of request.expectedJson) {
    if (!nonBlank(assertion.pointer) || !/^[a-f0-9]{64}$/u.test(assertion.equalsHmacSha256)) return null;
    expectedJson.push({
      pointer: assertion.pointer,
      equalsType: assertion.equalsType,
      equalsHmacSha256: assertion.equalsHmacSha256,
    });
  }
  return {
    method: "GET", path: request.path, expectedStatus: request.expectedStatus,
    digestAlgorithm: request.digestAlgorithm, digestKeyId: request.digestKeyId,
    digestContext: request.digestContext, expectedJson,
  };
}

function reproduction(plan: StoredCriterionVerificationPlan): CorrectionReproduction | null {
  if (plan.status !== "planned") return null;
  if (plan.modality === "ui") {
    const steps = safeUiSteps(plan.uiSteps);
    return steps ? { modality: "ui", steps } : null;
  }
  if (plan.modality === "api" && plan.apiRequest && nonBlank(plan.apiRequest.path)) {
    return { modality: "api", request: { ...plan.apiRequest } };
  }
  if (plan.modality === "data") {
    const request = safeDataRequest(plan.dataRequest);
    return request ? { modality: "data", request } : null;
  }
  if (plan.modality === "job" && plan.jobRequest) {
    const readback = safeDataRequest(plan.jobRequest.readback);
    const { trigger } = plan.jobRequest;
    return readback && nonBlank(trigger.path) && Number.isInteger(trigger.expectedStatus) &&
      trigger.expectedStatus >= 100 && trigger.expectedStatus <= 599
      ? { modality: "job", request: { trigger: { ...trigger }, readback } }
      : null;
  }
  return null;
}

type CorrectionReceiptResolution = {
  status: "absent" | "pending" | "invalid" | "valid";
  result: CorrectionReceipt | null;
};

function receiptResolution(input: {
  proof: ExactReviewJobProof;
  plan: StoredCriterionVerificationPlan;
}): CorrectionReceiptResolution {
  switch (input.plan.modality) {
    case "ui": return resolveReviewJobUiResult(input);
    case "api": return resolveReviewJobApiResult(input);
    case "data": return resolveReviewJobDataResult(input);
    case "job": return resolveReviewJobResult(input);
  }
}

function fallbackPreviewBootId(evidenceRefs: string[]): string | null {
  if (evidenceRefs.length !== 1 || !evidenceRefs[0]?.startsWith(PREVIEW_BOOT_EVIDENCE_PREFIX)) return null;
  return safeIdentifier(evidenceRefs[0].slice(PREVIEW_BOOT_EVIDENCE_PREFIX.length));
}

function evidence(input: {
  result: CriterionResult;
  receipt: CorrectionReceipt | null;
}): ReviewJobCorrectionPacket["evidence"] | null {
  if (input.receipt) {
    if (input.result.evidenceRefs.length !== 1 || input.result.evidenceRefs[0] !== input.receipt.evidenceRef ||
      input.result.expected !== input.receipt.expected || input.result.observed !== input.receipt.observed ||
      input.result.state !== input.receipt.state || !nonBlank(input.receipt.artifactKey) ||
      !safeIdentifier(input.receipt.executionId) || !safeIdentifier(input.receipt.previewBootId)) return null;
    return {
      evidenceRef: input.receipt.evidenceRef,
      artifactKey: input.receipt.artifactKey,
      executionId: input.receipt.executionId,
      previewBootId: input.receipt.previewBootId,
    };
  }
  const previewBootId = input.result.state === "not_proven"
    ? fallbackPreviewBootId(input.result.evidenceRefs)
    : null;
  return previewBootId && nonBlank(input.result.evidenceRefs[0])
    ? { evidenceRef: input.result.evidenceRefs[0]!, previewBootId }
    : null;
}

function requiredCorrection(input: {
  plan: StoredCriterionVerificationPlan;
  state: CorrectionState;
  receipt: CorrectionReceipt | null;
}): string | null {
  const { plan } = input;
  const descriptor = reproduction(plan);
  if (!descriptor) return null;
  if (input.state === "not_proven" && !input.receipt) {
    return `Restore or complete the persisted ${plan.modality} execution for criterion ${plan.criterionId} and record its exact-head evidence custody before claiming this criterion is proven.`;
  }
  switch (descriptor.modality) {
    case "ui": return `Make the persisted UI flow for criterion ${plan.criterionId} reach its saved assertion and screenshot without changing this correction packet's scope.`;
    case "api": return `Make the safe GET ${descriptor.request.path} return the planned HTTP ${descriptor.request.expectedStatus} for criterion ${plan.criterionId}.`;
    case "data": return `Make the safe GET ${descriptor.request.path} return HTTP ${descriptor.request.expectedStatus} and satisfy every HMAC-bound assertion for criterion ${plan.criterionId}.`;
    case "job": return `Make the bounded job trigger and readback satisfy their persisted status and HMAC-bound assertions for criterion ${plan.criterionId}.`;
  }
}

/** Build one correction packet only from exact proof, its persisted plan, and a server-attested result. */
export function buildReviewJobCorrectionPacket(input: {
  proof: ExactReviewJobProof;
  criterionResult: CriterionResult;
}): ReviewJobCorrectionPacket | null {
  const { proof, criterionResult: result } = input;
  if (result.state !== "failed" && result.state !== "not_proven") return null;
  const plan = proof.verificationPlan.plans.find((candidate) => candidate.criterionId === result.criterionId);
  if (!plan || !safeIdentifier(proof.job.id) || !safeIdentifier(proof.job.workspaceId) ||
    !safeIdentifier(proof.job.repo) || !Number.isInteger(proof.job.prNumber) || proof.job.prNumber <= 0 ||
    !safeIdentifier(proof.job.headSha) || !safeIdentifier(proof.timeline.record.id) ||
    !safeIdentifier(proof.contract.id) || !Number.isInteger(proof.contract.version) || proof.contract.version <= 0 ||
    !safeIdentifier(plan.criterionId) || !nonBlank(plan.criterionTextSnapshot) ||
    result.criterionId !== plan.criterionId || result.expected !== plan.criterionTextSnapshot ||
    !nonBlank(result.expected) || !nonBlank(result.observed) || !Array.isArray(result.evidenceRefs) ||
    !result.evidenceRefs.every((reference) => nonBlank(reference)) || !nonBlank(plan.flow ?? "", MAX_PACKET_TEXT)) return null;

  const packetReproduction = reproduction(plan);
  const resolution = receiptResolution({ proof, plan });
  if (resolution.status === "invalid" ||
    (result.state === "failed" && resolution.status !== "valid")) return null;
  const receipt = resolution.result;
  const packetEvidence = evidence({ result, receipt });
  const correction = requiredCorrection({ plan, state: result.state, receipt });
  const eventKey = reviewJobCorrectionPacketEventKey({ jobId: proof.job.id, criterionId: plan.criterionId });
  if (!packetReproduction || !packetEvidence || !correction || !eventKey) return null;

  const packetId = reviewJobCorrectionPacketId({
    jobId: proof.job.id, criterionId: plan.criterionId, headSha: proof.job.headSha,
    recordId: proof.timeline.record.id, acceptanceContractId: proof.contract.id,
    acceptanceContractVersion: proof.contract.version,
  });
  const packet: ReviewJobCorrectionPacket = {
    kind: REVIEW_JOB_CORRECTION_PACKET_KIND,
    version: REVIEW_JOB_CORRECTION_PACKET_VERSION,
    packetId,
    workspaceId: proof.job.workspaceId,
    repo: proof.job.repo,
    prNumber: proof.job.prNumber,
    headSha: proof.job.headSha,
    recordId: proof.timeline.record.id,
    jobId: proof.job.id,
    acceptanceContract: { id: proof.contract.id, version: proof.contract.version },
    criterion: { id: plan.criterionId, snapshot: plan.criterionTextSnapshot },
    basis: "acceptance_contract",
    state: result.state,
    expected: result.expected,
    observed: result.observed,
    affectedContext: {
      modality: plan.modality,
      environmentKind: plan.environmentKind,
      flow: plan.flow,
      reproduction: packetReproduction,
    },
    evidence: packetEvidence,
    scopeBoundary: `Only confirmed criterion ${plan.criterionId} for ${proof.job.repo}#${proof.job.prNumber} at exact head ${proof.job.headSha}, Acceptance Contract ${proof.contract.id} v${proof.contract.version}.`,
    impact: result.state === "failed"
      ? `The server-attested ${plan.modality} receipt shows this confirmed criterion failed on the exact head.`
      : `This confirmed criterion lacks sufficient server-custodied proof on the exact head.`,
    requiredCorrection: correction,
    reverification: `Rerun the persisted ${plan.modality} plan for criterion ${plan.criterionId} against the next exact head and attach its custodied receipt before review.`,
  };
  return JSON.stringify(packet).length <= MAX_PACKET_JSON && scanForSecrets(JSON.stringify(packet)).clean
    && validateReviewJobCorrectionPacketPayload(packet)
    ? packet
    : null;
}

/** Build the complete eligible set or fail closed when results are not an exact plan snapshot. */
export function buildReviewJobCorrectionPackets(input: {
  proof: ExactReviewJobProof;
  criterionResults: CriterionResult[];
}): ReviewJobCorrectionPacket[] | null {
  const { proof, criterionResults } = input;
  if (!Array.isArray(criterionResults) || criterionResults.length !== proof.verificationPlan.plans.length) return null;
  const byCriterion = new Map<string, CriterionResult>();
  for (const result of criterionResults) {
    if (byCriterion.has(result.criterionId)) return null;
    byCriterion.set(result.criterionId, result);
  }
  const packets: ReviewJobCorrectionPacket[] = [];
  for (const plan of proof.verificationPlan.plans) {
    const result = byCriterion.get(plan.criterionId);
    if (!result || result.expected !== plan.criterionTextSnapshot) return null;
    if (result.state === "failed" || result.state === "not_proven") {
      const packet = buildReviewJobCorrectionPacket({ proof, criterionResult: result });
      if (!packet) return null;
      packets.push(packet);
    }
  }
  return packets;
}

/** Accept a persisted packet only if it exactly equals the currently derived immutable packet. */
export function parseReviewJobCorrectionPacket(input: {
  payload: unknown;
  proof: ExactReviewJobProof;
  criterionResult: CriterionResult;
}): ReviewJobCorrectionPacket | null {
  if (!object(input.payload)) return null;
  const packet = buildReviewJobCorrectionPacket(input);
  return packet && isDeepStrictEqual(packet, input.payload) ? packet : null;
}

export function findMatchingReviewJobCorrectionPacket(input: {
  proof: ExactReviewJobProof;
  criterionResult: CriterionResult;
}): ReviewJobCorrectionPacket | null {
  const eventKey = reviewJobCorrectionPacketEventKey({
    jobId: input.proof.job.id,
    criterionId: input.criterionResult.criterionId,
  });
  if (!eventKey) return null;
  const events = input.proof.timeline.events.filter((event) => event.eventKey === eventKey);
  return events.length === 1
    ? parseReviewJobCorrectionPacket({
        payload: events[0]?.payloadRef,
        proof: input.proof,
        criterionResult: input.criterionResult,
      })
    : null;
}

/** True only when the timeline contains exactly the complete derived packet set, including zero. */
export function hasExactReviewJobCorrectionPackets(input: {
  proof: ExactReviewJobProof;
  criterionResults: CriterionResult[];
}): boolean {
  const packets = buildReviewJobCorrectionPackets(input);
  const jobId = safeIdentifier(input.proof.job.id);
  if (!packets || !jobId) return false;
  const prefix = `review:correction:${jobId}:`;
  const correctionEvents = input.proof.timeline.events.filter((event) =>
    typeof event.eventKey === "string" && event.eventKey.startsWith(prefix)
  );
  if (correctionEvents.length !== packets.length) return false;
  const expected = new Map<string, ReviewJobCorrectionPacket>();
  for (const packet of packets) {
    const eventKey = reviewJobCorrectionPacketEventKey({
      jobId: packet.jobId,
      criterionId: packet.criterion.id,
    });
    if (!eventKey || expected.has(eventKey)) return false;
    expected.set(eventKey, packet);
  }
  const seen = new Set<string>();
  for (const event of correctionEvents) {
    const packet = expected.get(event.eventKey);
    if (!packet || seen.has(event.eventKey) || !isDeepStrictEqual(event.payloadRef, packet)) {
      return false;
    }
    seen.add(event.eventKey);
  }
  return seen.size === expected.size;
}
